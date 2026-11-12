import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishResult {
  published: OutboxMessage[];
  failed: { message: OutboxMessage; error: string }[];
}

// Publicação de eventos de integração no broker. Entrega at-least-once: o consumidor deduplica por eventId.
// Contrato de ordem: as mensagens chegam em ordem de publicação e, depois da primeira falha de um agregado,
// as seguintes dele não são enviadas (voltam como falha), para nunca publicar um evento antes do anterior.
export abstract class EventPublisher {
  abstract publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
