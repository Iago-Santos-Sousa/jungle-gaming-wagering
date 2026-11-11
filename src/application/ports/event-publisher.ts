import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishResult {
  published: OutboxMessage[];
  failed: { message: OutboxMessage; error: string }[];
}

// Publicação de eventos de integração no broker. Entrega at-least-once: o consumidor deduplica por eventId.
export abstract class EventPublisher {
  abstract publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
