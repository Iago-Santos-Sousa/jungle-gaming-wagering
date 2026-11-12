import { Module, ValidationPipe, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EventPublisher } from './application/ports/event-publisher';
import { UnitOfWork } from './application/ports/repositories';
import { OUTBOX_RETRY_POLICY, PublishOutboxUseCase } from './application/use-cases/publish-outbox.use-case';
import { Clock, IdGenerator, WageringMetrics } from './application/ports/system';
import { CreateWalletUseCase, GetWalletUseCase, ListLedgerUseCase, ReconcileWalletUseCase } from './application/use-cases/wallet-use-cases';
import {
  GetWagerTransactionUseCase,
  REFERENCE_RETRY_POLICY,
  ReprocessPendingReferenceUseCase,
  SubmitWagerTransactionUseCase,
  WagerSettlementWriter,
} from './application/use-cases/wager-use-cases';
import { RetryPolicy } from './domain/shared/retry-policy';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/app-config';
import { MikroOrmUnitOfWork } from './infrastructure/database/mikro-orm-unit-of-work';
import { buildOrmConfig } from './infrastructure/database/mikro-orm.config';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { LoggerModule } from './infrastructure/observability/logger.module';
import { PrometheusWageringMetrics } from './infrastructure/observability/prometheus-metrics';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system-adapters';
import { AuthGuard } from './interfaces/http/auth/auth.guard';
import { HttpErrorFilter, validationExceptionFactory } from './interfaces/http/errors/http-error.filter';
import { HealthController } from './interfaces/http/health/health.controller';
import { MetricsController } from './interfaces/http/metrics.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { OutboxPublisherWorker, PendingReferenceWorker } from './interfaces/workers/scheduled-workers';
import { SqsWagerConsumer } from './interfaces/workers/sqs-wager-consumer';

// Módulo raiz construído a partir da configuração, para testes subirem instâncias isoladas
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule,
        MikroOrmModule.forRoot({ ...buildOrmConfig(config), registerRequestContext: false }),
        SqsModule,
      ],
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            exceptionFactory: validationExceptionFactory,
          }),
        },
        { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
        { provide: Clock, useClass: SystemClock },
        { provide: IdGenerator, useClass: UuidV7Generator },
        PrometheusWageringMetrics,
        { provide: WageringMetrics, useExisting: PrometheusWageringMetrics },
        {
          provide: REFERENCE_RETRY_POLICY,
          useValue: new RetryPolicy(config.pendingReference.baseDelayMs, config.pendingReference.maxDelayMs, config.pendingReference.maxAttempts),
        },
        { provide: EventPublisher, useClass: SqsEventPublisher },
        {
          provide: OUTBOX_RETRY_POLICY,
          useValue: new RetryPolicy(config.outbox.baseDelayMs, config.outbox.maxDelayMs),
        },
        PublishOutboxUseCase,
        WagerSettlementWriter,
        CreateWalletUseCase,
        GetWalletUseCase,
        ListLedgerUseCase,
        ReconcileWalletUseCase,
        SubmitWagerTransactionUseCase,
        ReprocessPendingReferenceUseCase,
        GetWagerTransactionUseCase,
        // Workers (ligados por WORKERS_ENABLED): consumer SQS, publisher da outbox e referências pendentes
        SqsWagerConsumer,
        OutboxPublisherWorker,
        PendingReferenceWorker,
      ],
      exports: [APP_CONFIG],
    };
  }
}
