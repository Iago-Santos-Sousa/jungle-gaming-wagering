import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { PinoLogger } from 'nestjs-pino';
import { ConcurrencyConflictError, IdempotencyConflictError } from '../../application/errors';
import { WageringMetrics } from '../../application/ports/system';
import { SubmitWagerTransactionUseCase } from '../../application/use-cases/wager-use-cases';
import { Money } from '../../domain/money/money';
import { InvalidArgumentError, InvalidTransactionStateError } from '../../domain/shared/domain-error';
import { RetryPolicy } from '../../domain/shared/retry-policy';
import { computeInboxPayloadHash } from '../../domain/wager-transaction/wager-transaction';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { isPermanentDatabaseError, isTransientDatabaseError } from '../../infrastructure/database/database-errors';
import { SQS_CLIENT, SqsQueueResolver } from '../../infrastructure/messaging/sqs.module';
import { parseWagerMessage, type WagerTransactionMessageDto } from './wager-message.dto';

type DeadLetterReason = 'invalid_message' | 'permanent_error' | 'retries_exhausted';

// Consumidor de wager-transactions.fifo. Reaproveita o mesmo use case da entrada HTTP.
// Negócio: ack. Transitório: devolve com backoff. Permanente ou tentativas esgotadas: DLQ.
@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  // Shutdown pedido: nada novo começa, e o que for recebido daqui em diante volta para a fila na hora
  private stopping = false;
  private loop: Promise<void> | undefined;
  // Mensagens em processamento, para devolver a visibilidade se o shutdown estourar o tempo
  private readonly inFlight = new Set<Message>();
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly metrics: WageringMetrics,
    private readonly queues: SqsQueueResolver,
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(SqsWagerConsumer.name);
    this.retryPolicy = new RetryPolicy(config.sqs.retryBaseDelaySeconds, config.sqs.retryMaxDelaySeconds);
  }

  onApplicationBootstrap(): void {
    if (!this.config.workersEnabled) return;
    this.running = true;
    this.loop = this.run();
  }

  // SIGTERM: para de receber, conclui o que já começou e devolve a visibilidade do que não começou.
  // O receive em andamento não é abortado: abortar a resposta poderia descartar mensagens já entregues pelo broker,
  // que ficariam invisíveis até o visibility timeout. Ele termina em até SQS_WAIT_TIME_SECONDS e o lote volta para a fila.
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (!this.running) return;
    this.running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.config.shutdownTimeoutMs);
    });
    const result = await Promise.race([this.loop, timeout]);
    clearTimeout(timer);
    if (result !== 'timeout') return;

    // Ainda com o cliente SQS vivo: devolve o que está em andamento. Se o commit acontecer depois, o inbox descarta a reentrega.
    const pending = [...this.inFlight];
    await Promise.all(pending.map((message) => this.release(message)));
    this.logger.warn({ released: pending.length }, 'shutdown timeout reached; in-flight messages released for redelivery');
  }

  // Um ciclo de recebimento e processamento; usado pelo laço e pelos testes
  async pollOnce(waitTimeSeconds = this.config.sqs.waitTimeSeconds): Promise<number> {
    const messages = await this.receive(waitTimeSeconds);
    await this.processBatch(messages);
    return messages.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        this.logger.warn({ err: error }, 'sqs receive failed, retrying');
        await Bun.sleep(1_000);
      }
    }
  }

  private async receive(waitTimeSeconds: number): Promise<Message[]> {
    const QueueUrl = await this.queues.getUrl(this.config.sqs.wagerQueueName);
    const { Messages } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: this.config.sqs.batchSize,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
    );
    return Messages ?? [];
  }

  // Grupos FIFO em paralelo; mensagens do mesmo grupo em ordem
  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) {
            await this.release(message);
            continue;
          }
          this.inFlight.add(message);
          try {
            await this.handle(message);
          } finally {
            this.inFlight.delete(message);
          }
        }
      }),
    );
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let envelope: WagerTransactionMessageDto;
    try {
      envelope = await parseWagerMessage(message.Body);
    } catch (error) {
      await this.deadLetter(message, 'invalid_message', error);
      return;
    }

    const { data } = envelope;
    const logContext = { messageId: envelope.messageId, correlationId: envelope.messageId, walletId: data.walletId, providerId: data.providerId };
    try {
      const command = { ...data, money: Money.from(data.money) };
      const outcome = await this.submit.execute(command, {
        source: 'sqs',
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        inbox: { consumerName: this.config.sqs.consumerName, messageId: envelope.messageId, payloadHash: computeInboxPayloadHash(command) },
      });
      // Ack somente depois do commit (o use case já retornou)
      await this.ack(message);
      this.logger.info(
        { ...logContext, transactionId: outcome.transactionId, status: outcome.status, failureCode: outcome.failureCode, duplicate: outcome.duplicateMessage },
        'wager message processed',
      );
    } catch (error) {
      await this.handleFailure(message, receiveCount, error, logContext);
    }
  }

  private async handleFailure(message: Message, receiveCount: number, error: unknown, logContext: Record<string, string>): Promise<void> {
    // Conflito de idempotência é decisão de negócio terminal: reenviar não muda o resultado
    if (error instanceof IdempotencyConflictError) {
      await this.ack(message);
      this.logger.warn({ ...logContext, code: error.code }, 'wager message rejected by idempotency conflict');
      return;
    }
    // Contrato violado detectado pelo domínio: permanente
    if (error instanceof InvalidArgumentError) {
      await this.deadLetter(message, 'invalid_message', error);
      return;
    }
    // Dado inválido para o banco, violação de integridade ou transição ilegal: reenviar nunca resolve
    if (isPermanentDatabaseError(error) || error instanceof InvalidTransactionStateError) {
      await this.deadLetter(message, 'permanent_error', error);
      return;
    }
    if (receiveCount >= this.config.sqs.maxReceives) {
      await this.deadLetter(message, 'retries_exhausted', error);
      return;
    }
    const transient = error instanceof ConcurrencyConflictError || isTransientDatabaseError(error);
    const delay = this.retryPolicy.delayFor(receiveCount);
    await this.changeVisibility(message, delay);
    this.metrics.retry('sqs');
    this.logger.warn({ ...logContext, err: error, transient, receiveCount, retryInSeconds: delay }, 'wager message will be retried');
  }

  private async ack(message: Message): Promise<void> {
    const QueueUrl = await this.queues.getUrl(this.config.sqs.wagerQueueName);
    try {
      await this.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      // Efeito já confirmado: a reentrega será descartada pelo inbox
      this.logger.warn({ err: error, sqsMessageId: message.MessageId }, 'ack failed after commit; redelivery will be deduplicated');
    }
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    const QueueUrl = await this.queues.getUrl(this.config.sqs.wagerQueueName);
    await this.client
      .send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }))
      .catch((error: unknown) => this.logger.warn({ err: error, sqsMessageId: message.MessageId }, 'change visibility failed'));
  }

  // Devolve a mensagem para a fila imediatamente (shutdown antes de começar a processá-la)
  private release(message: Message): Promise<void> {
    return this.changeVisibility(message, 0);
  }

  private async deadLetter(message: Message, reason: DeadLetterReason, error: unknown): Promise<void> {
    const DlqUrl = await this.queues.getUrl(this.config.sqs.wagerDlqName);
    const detail = error instanceof Error ? error.message : String(error);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: DlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        // Reenvio após crash entre envio e ack não duplica a mensagem na DLQ
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
          error: { DataType: 'String', StringValue: detail.slice(0, 256) || 'unknown' },
        },
      }),
    );
    await this.ack(message);
    this.metrics.dlqMessage(reason);
    this.logger.error({ sqsMessageId: message.MessageId, reason, error: detail }, 'wager message moved to dlq');
  }
}
