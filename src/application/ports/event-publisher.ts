import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface PublishResult {
  published: OutboxMessage[];
  failed: { message: OutboxMessage; error: string }[];
  skipped: OutboxMessage[];
}

export interface PublishOptions {
  shouldStop?: () => boolean;
}

export abstract class EventPublisher {
  abstract publish(
    messages: readonly OutboxMessage[],
    options?: PublishOptions,
  ): Promise<PublishResult>;
}
