import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand, SendMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { newId } from './api-client';

// Sufixo único por arquivo de teste: filas isoladas entre execuções e entre arquivos
export function isolatedQueues(prefix: string): Record<string, string> {
  const suffix = `${prefix}-${Date.now()}`;
  return {
    SQS_WAGER_QUEUE_NAME: `${suffix}-wager.fifo`,
    SQS_WAGER_DLQ_NAME: `${suffix}-wager-dlq.fifo`,
    SQS_EVENTS_QUEUE_NAME: `${suffix}-events.fifo`,
  };
}

export async function queueUrl(client: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!QueueUrl) throw new Error(`queue ${name} not found`);
  return QueueUrl;
}

export function wagerEnvelope(data: Record<string, unknown>, messageId = `msg-${newId()}`) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
}

// Envia com deduplicação própria: o mesmo envelope pode ser entregue várias vezes (simula at-least-once)
export async function sendRaw(client: SQSClient, url: string, body: string, groupId: string): Promise<void> {
  await client.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: newId() }));
}

// Lê e remove todas as mensagens visíveis de uma fila
export async function drain(client: SQSClient, url: string, waitTimeSeconds = 1): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const { Messages } = await client.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: waitTimeSeconds, MessageAttributeNames: ['All'] }),
    );
    if (!Messages?.length) return all;
    all.push(...Messages);
    for (const message of Messages) await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
  }
}

// Acumula mensagens até a condição valer ou o tempo estourar (aí devolve o que tiver, para a asserção mostrar a diferença).
// Não confia no primeiro receive vazio: o emulador pode devolver vazio com mensagens ainda na fila, por exemplo quando
// o relógio da VM do Docker é ressincronizado e a visibilidade calculada pelo broker salta.
export async function drainUntil(client: SQSClient, url: string, done: (all: Message[]) => boolean, timeoutMs = 20_000): Promise<Message[]> {
  const all: Message[] = [];
  const deadline = Date.now() + timeoutMs;
  while (!done(all) && Date.now() < deadline) {
    all.push(...(await drain(client, url)));
  }
  return all;
}

// Repete a verificação até passar ou estourar o tempo
export async function eventually<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 20_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(intervalMs);
  }
}
