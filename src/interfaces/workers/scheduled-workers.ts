import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ConcurrencyConflictError } from '../../application/errors';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case';
import { ReprocessPendingReferenceUseCase } from '../../application/use-cases/wager-use-cases';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { isTransientDatabaseError } from '../../infrastructure/database/database-errors';
import { PollingLoop } from './polling-loop';

// Transações pendentes reprocessadas em paralelo por ciclo (cada uma trava só a própria wallet)
const PENDING_REFERENCE_CONCURRENCY = 5;

// Publica a outbox em ciclos. Várias instâncias podem rodar juntas sem publicar o mesmo lote ao mesmo tempo.
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    logger: PinoLogger,
  ) {
    logger.setContext(OutboxPublisherWorker.name);
    this.loop = new PollingLoop('outbox-publisher', config.outbox.pollIntervalMs, () => this.runOnce(), logger);
  }

  onApplicationBootstrap(): void {
    if (this.config.workersEnabled) this.loop.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.loop.stop();
  }

  // Retorna true se o lote veio cheio (provavelmente há mais trabalho)
  async runOnce(): Promise<boolean> {
    const { batchSize, leaseMs } = this.config.outbox;
    const published = await this.publishOutbox.publishBatch({ batchSize, leaseMs });
    return published === batchSize;
  }
}

// Reprocessa transações PENDING_REFERENCE vencidas, com backoff exponencial definido no domínio
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    private readonly reprocess: ReprocessPendingReferenceUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(PendingReferenceWorker.name);
    this.loop = new PollingLoop('pending-reference', config.pendingReference.pollIntervalMs, () => this.runOnce(), logger);
  }

  onApplicationBootstrap(): void {
    if (this.config.workersEnabled) this.loop.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.loop.stop();
  }

  async runOnce(): Promise<boolean> {
    const { batchSize } = this.config.pendingReference;
    const ids = await this.reprocess.findDue(batchSize);
    for (let start = 0; start < ids.length; start += PENDING_REFERENCE_CONCURRENCY) {
      await Promise.all(ids.slice(start, start + PENDING_REFERENCE_CONCURRENCY).map((id) => this.reprocessOne(id)));
    }
    return ids.length === batchSize;
  }

  private async reprocessOne(transactionId: string): Promise<void> {
    try {
      await this.reprocess.execute(transactionId);
    } catch (error) {
      // Transitório: fica para o próximo ciclo. Permanente: FAILED auditável em vez de tentar para sempre.
      if (error instanceof ConcurrencyConflictError || isTransientDatabaseError(error)) {
        this.logger.warn({ transactionId, err: error }, 'pending reference reprocess deferred by transient error');
        return;
      }
      this.logger.error({ transactionId, err: error }, 'pending reference reprocess failed permanently');
      await this.reprocess.failPermanently(transactionId);
    }
  }
}
