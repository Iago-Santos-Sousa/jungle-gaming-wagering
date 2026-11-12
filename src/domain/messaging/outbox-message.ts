import type { IntegrationEvent } from "../events/integration-event";
import { InvalidTransactionStateError } from "../shared/domain-error";
import type { RetryPolicy } from "../shared/retry-policy";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

// Evento pendente de publicação, gravado na mesma transação SQL do efeito financeiro
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  // O id da mensagem é o eventId: publicações duplicadas carregam o mesmo id para o consumidor deduplicar
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined ||
        this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending())
      throw new InvalidTransactionStateError(
        `Outbox message ${this.id} already published`,
      );

    this._publishedAt = at;
  }

  scheduleRetry(now: Date, policy: RetryPolicy): void {
    if (!this.isPending())
      throw new InvalidTransactionStateError(
        `Outbox message ${this.id} already published`,
      );

    this._attempts += 1;
    this._nextAttemptAt = policy.nextAttemptAt(now, this._attempts);
  }
}
