import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishResult {
  published: OutboxMessage[];
  // Falha real ao enviar: entra em retry com backoff
  failed: { message: OutboxMessage; error: string }[];
  // Não enviadas porque um evento anterior do mesmo agregado falhou neste ciclo: só voltam para a fila
  skipped: OutboxMessage[];
}

// Publicação de eventos de integração no broker. Entrega at-least-once: o consumidor deduplica por eventId.
// Contrato de ordem: as mensagens chegam em ordem de publicação. Um evento só é enviado depois que o anterior do
// mesmo agregado foi confirmado, e depois da primeira falha de um agregado os seguintes dele voltam como skipped.
export abstract class EventPublisher {
  abstract publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
