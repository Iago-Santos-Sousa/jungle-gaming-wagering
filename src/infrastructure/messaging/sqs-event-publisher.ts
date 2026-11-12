import { Inject, Injectable } from '@nestjs/common';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher, type PublishResult } from '../../application/ports/event-publisher';
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

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const result: PublishResult = { published: [], failed: [] };
    // Agregados com falha neste ciclo: os eventos seguintes deles esperam a próxima tentativa
    const blocked = new Set<string>();
    let pending: OutboxMessage[] = [];

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const chunk = pending;
      pending = [];
      const failedBefore = result.failed.length;
      await this.publishChunk(chunk, result);
      for (const { message } of result.failed.slice(failedBefore)) blocked.add(message.aggregateId);
    };

    for (const message of messages) {
      if (blocked.has(message.aggregateId)) {
        result.failed.push({ message, error: 'blocked: an earlier event of this aggregate failed' });
        continue;
      }
      pending.push(message);
      if (pending.length === SQS_BATCH_LIMIT) await flush();
    }
    await flush();
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
