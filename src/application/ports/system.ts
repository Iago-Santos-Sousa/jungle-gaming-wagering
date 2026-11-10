// Fonte de tempo injetável, para testes determinísticos
export abstract class Clock {
  abstract now(): Date;
}

// Gerador de identificadores ordenáveis no tempo (UUIDv7)
export abstract class IdGenerator {
  abstract next(): string;
}

export type MetricSource = 'http' | 'sqs' | 'worker';

// Métricas de negócio e operação, desacopladas da biblioteca de exposição
export abstract class WageringMetrics {
  abstract transactionDecided(kind: string, status: string): void;
  abstract duplicateDetected(source: MetricSource | 'inbox'): void;
  abstract retry(component: string): void;
  abstract dlqMessage(reason: string): void;
  abstract lockConflict(): void;
  abstract processingDuration(source: MetricSource, seconds: number): void;
  abstract reconciliationDivergence(): void;
}
