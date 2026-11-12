export abstract class Clock {
  abstract now(): Date;
}

export abstract class IdGenerator {
  abstract next(): string;
}

export type MetricSource = 'http' | 'sqs' | 'worker';

export abstract class WageringMetrics {
  abstract transactionDecided(kind: string, status: string): void;
  abstract duplicateDetected(source: MetricSource | 'inbox' | 'inbox_conflict'): void;
  abstract retry(component: string): void;
  abstract dlqMessage(reason: string): void;
  abstract lockConflict(): void;
  abstract processingDuration(source: MetricSource, seconds: number): void;
  abstract reconciliationDivergence(): void;
}
