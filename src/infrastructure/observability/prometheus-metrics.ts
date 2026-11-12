import { Inject, Injectable } from '@nestjs/common';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { UnitOfWork } from '../../application/ports/repositories';
import { Clock, WageringMetrics, type MetricSource } from '../../application/ports/system';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SQS_CLIENT, SqsQueueResolver } from '../messaging/sqs.module';

// Registro próprio por instância da aplicação (evita colisão entre apps no mesmo processo de teste)
@Injectable()
export class PrometheusWageringMetrics extends WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações decididas, por kind e status',
    labelNames: ['kind', 'status'] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'duplicates_detected_total',
    help: 'Duplicatas detectadas (replay idempotente ou mensagem repetida no inbox)',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'retries_total',
    help: 'Novas tentativas por componente',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });

  private readonly dlqMessages = new Counter({
    name: 'dlq_messages_total',
    help: 'Mensagens movidas para a DLQ',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Conflitos de lock (timeout, deadlock ou versão concorrente)',
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: 'processing_duration_seconds',
    help: 'Latência de processamento de transações',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly divergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliações com divergência entre saldo materializado e ledger',
    registers: [this.registry],
  });

  constructor(
    uow: UnitOfWork,
    clock: Clock,
    queues: SqsQueueResolver,
    @Inject(SQS_CLIENT) sqs: SQSClient,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    super();
    collectDefaultMetrics({ register: this.registry });

    // Calculado no momento da coleta: idade da mensagem pendente mais antiga da outbox
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade em segundos do evento mais antigo ainda não publicado',
      registers: [this.registry],
      async collect() {
        try {
          this.set(await uow.read((scope) => scope.outbox.pendingLagSeconds(clock.now())));
        } catch {
          // Banco indisponível não deve derrubar o endpoint de métricas
        }
      },
    });

    new Gauge({
      name: 'dlq_depth',
      help: 'Mensagens aproximadas na DLQ de transações',
      registers: [this.registry],
      async collect() {
        try {
          const QueueUrl = await queues.getUrl(config.sqs.wagerDlqName);
          const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
          this.set(Number(Attributes?.ApproximateNumberOfMessages ?? 0));
        } catch {
          // SQS indisponível não deve derrubar o endpoint de métricas
        }
      },
    });
  }

  transactionDecided(kind: string, status: string): void {
    this.transactions.inc({ kind, status });
  }

  duplicateDetected(source: MetricSource | 'inbox' | 'inbox_conflict'): void {
    this.duplicates.inc({ source });
  }

  retry(component: string): void {
    this.retries.inc({ component });
  }

  dlqMessage(reason: string): void {
    this.dlqMessages.inc({ reason });
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  processingDuration(source: MetricSource, seconds: number): void {
    this.duration.observe({ source }, seconds);
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}
