import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { RetryPolicy } from '../../domain/shared/retry-policy';
import { EventPublisher } from '../ports/event-publisher';
import { UnitOfWork } from '../ports/repositories';
import { Clock, WageringMetrics } from '../ports/system';

export const OUTBOX_RETRY_POLICY = Symbol('OUTBOX_RETRY_POLICY');

export interface OutboxPublishOptions {
  batchSize: number;
  leaseMs: number;
}

// Publica eventos confirmados da outbox. Vários publishers podem rodar ao mesmo tempo:
// o claim com lease e SKIP LOCKED entrega lotes disjuntos, e um lease vencido volta a ficar disponível.
@Injectable()
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    @Inject(OUTBOX_RETRY_POLICY) private readonly retryPolicy: RetryPolicy,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(PublishOutboxUseCase.name);
  }

  // Retorna quantos eventos foram publicados neste ciclo
  async publishBatch(options: OutboxPublishOptions): Promise<number> {
    const claimed = await this.uow.read((scope) => scope.outbox.claimDue(this.clock.now(), options.batchSize, options.leaseMs));
    if (claimed.length === 0) return 0;

    // Publicação fora de transação: nenhuma conexão fica presa esperando o broker
    const { published, failed } = await this.publisher.publish(claimed);
    const now = this.clock.now();
    for (const message of published) message.markPublished(now);

    await this.uow.read(async (scope) => {
      await scope.outbox.markPublished(published);
      for (const { message, error } of failed) {
        message.scheduleRetry(now, this.retryPolicy);
        await scope.outbox.scheduleRetry(message, error);
      }
    });

    if (failed.length > 0) {
      for (let i = 0; i < failed.length; i++) this.metrics.retry('outbox');
      this.logger.warn({ failed: failed.length, published: published.length, error: failed[0]?.error }, 'outbox publish partially failed');
    }
    return published.length;
  }
}
