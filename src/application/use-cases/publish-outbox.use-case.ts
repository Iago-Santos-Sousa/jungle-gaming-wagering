import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import type { RetryPolicy } from "../../domain/shared/retry-policy";
import { EventPublisher } from "../ports/event-publisher";
import { UnitOfWork } from "../ports/repositories";
import { Clock, WageringMetrics } from "../ports/system";

export const OUTBOX_RETRY_POLICY = Symbol("OUTBOX_RETRY_POLICY");

export interface OutboxPublishOptions {
  batchSize: number;
  leaseMs: number;
}

export interface OutboxPublishCycle {
  claimed: number;
  published: number;
  failed: number;
}

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

  async publishBatch(
    options: OutboxPublishOptions,
    shouldStop?: () => boolean,
  ): Promise<OutboxPublishCycle> {
    const { leaseUntil, messages: claimed } = await this.uow.transactional(
      (scope) =>
        scope.outbox.claimDue(
          this.clock.now(),
          options.batchSize,
          options.leaseMs,
        ),
    );
    if (claimed.length === 0) return { claimed: 0, published: 0, failed: 0 };

    const roundDeadline = leaseUntil.getTime() - options.leaseMs / 2;

    const stop = () =>
      shouldStop?.() === true || this.clock.now().getTime() >= roundDeadline;

    const { published, failed, skipped } = await this.publisher.publish(
      claimed,
      { shouldStop: stop },
    );

    const now = this.clock.now();
    for (const message of published) message.markPublished(now);

    for (const { message } of failed)
      message.scheduleRetry(now, this.retryPolicy);

    await this.uow.transactional(async (scope) => {
      await scope.outbox.markPublished(published, leaseUntil);
      await scope.outbox.scheduleRetries(failed, leaseUntil);
      await scope.outbox.releaseLease(skipped, leaseUntil);
    });

    if (failed.length > 0) {
      for (let i = 0; i < failed.length; i++) this.metrics.retry("outbox");
      this.logger.warn(
        {
          failed: failed.length,
          skipped: skipped.length,
          published: published.length,
          error: failed[0]?.error,
        },
        "outbox publish partially failed",
      );
    }

    return {
      claimed: claimed.length,
      published: published.length,
      failed: failed.length,
    };
  }
}
