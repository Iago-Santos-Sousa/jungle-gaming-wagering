import { Inject, Injectable } from '@nestjs/common';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher, type PublishOptions, type PublishResult } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SQS_CLIENT, SqsQueueResolver } from './sqs.module';

// Limite do SQS por chamada de SendMessageBatch
const SQS_BATCH_LIMIT = 10;

// Publica na fila FIFO de eventos: grupo por agregado e deduplicação pelo eventId.
// A deduplicação do broker é otimização; a garantia final é o consumidor deduplicar por eventId.
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    private readonly queues: SqsQueueResolver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  // Publica em rodadas: cada rodada envia o próximo evento de cada agregado ainda ativo, em lotes de até 10.
  // Nenhum lote tem dois eventos do mesmo agregado, então uma falha parcial por entrada do SendMessageBatch
  // nunca deixa um evento posterior passar na frente de um anterior. Uma wallet com muitos eventos publica um por
  // chamada; o claim limita o lote, então o pior caso cabe no lease.
  // Os lotes de uma mesma rodada vão em paralelo: não há dois eventos do mesmo agregado na rodada, e agregados
  // diferentes não têm ordem entre si. As rodadas seguem em sequência.
  async publish(messages: readonly OutboxMessage[], options: PublishOptions = {}): Promise<PublishResult> {
    const result: PublishResult = { published: [], failed: [], skipped: [] };
    const queues = new Map<string, OutboxMessage[]>();
    for (const message of messages) {
      const queue = queues.get(message.aggregateId);
      if (queue) queue.push(message);
      else queues.set(message.aggregateId, [message]);
    }

    while (queues.size > 0) {
      // Shutdown pedido: não inicia nova rodada; o resto volta para a fila e o ciclo confirma o que já saiu
      if (options.shouldStop?.()) {
        for (const queue of queues.values()) result.skipped.push(...queue);
        break;
      }
      const round = [...queues.values()].map((queue) => queue[0]!);
      const failedBefore = result.failed.length;
      const chunks: OutboxMessage[][] = [];
      for (let start = 0; start < round.length; start += SQS_BATCH_LIMIT) chunks.push(round.slice(start, start + SQS_BATCH_LIMIT));
      await Promise.all(chunks.map((chunk) => this.publishChunk(chunk, result)));
      // Agregado com falha nesta rodada: os seguintes dele não são enviados neste ciclo
      const blocked = new Set(result.failed.slice(failedBefore).map(({ message }) => message.aggregateId));
      for (const [aggregateId, queue] of queues) {
        queue.shift();
        if (blocked.has(aggregateId)) result.skipped.push(...queue);
        if (blocked.has(aggregateId) || queue.length === 0) queues.delete(aggregateId);
      }
    }
    return result;
  }

  private async publishChunk(chunk: readonly OutboxMessage[], result: PublishResult): Promise<void> {
    try {
      const QueueUrl = await this.queues.getUrl(this.config.sqs.eventsQueueName);
      const response = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl,
          Entries: chunk.map((message, index) => ({
            Id: `e${index}`,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
          })),
        }),
      );
      const failedById = new Map((response.Failed ?? []).map((entry) => [entry.Id, entry.Message ?? entry.Code ?? 'unknown error']));
      chunk.forEach((message, index) => {
        const error = failedById.get(`e${index}`);
        if (error) result.failed.push({ message, error });
        else result.published.push(message);
      });
    } catch (error) {
      // Broker indisponível: o lote inteiro volta para nova tentativa com backoff
      const reason = error instanceof Error ? error.message : String(error);
      for (const message of chunk) result.failed.push({ message, error: reason });
    }
  }
}
