import { addMilliseconds } from 'date-fns';

// Backoff exponencial com teto: delay = min(base × 2^(attempt-1), max)
export class RetryPolicy {
  constructor(
    public readonly baseDelayMs: number,
    public readonly maxDelayMs: number,
    public readonly maxAttempts: number = Number.POSITIVE_INFINITY,
  ) {}

  delayFor(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    // Evita overflow de 2^n em tentativas muito altas
    if (exponent >= 31) return this.maxDelayMs;
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return addMilliseconds(now, this.delayFor(attempt));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}
