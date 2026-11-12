import { describe, expect, test } from 'bun:test';
import type { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import type { SqsQueueResolver } from '../../src/infrastructure/messaging/sqs.module';
import { NOW } from '../support/domain-builders';

function message(id: string, aggregateId: string): OutboxMessage {
  return OutboxMessage.rehydrate({ id, aggregateId, eventType: 'WalletBalanceChanged', payload: {}, occurredAt: NOW, attempts: 0, nextAttemptAt: NOW, publishedAt: undefined });
}

// Cliente SQS falso: registra cada lote enviado e falha as entradas cujo id de mensagem está em failIds
function fakeClient(failIds: Set<string>) {
  const sent: string[][] = [];
  const client = {
    send: (command: SendMessageBatchCommand) => {
      const entries = command.input.Entries ?? [];
      sent.push(entries.map((entry) => String(entry.MessageDeduplicationId)));
      const Failed = entries
        .filter((entry) => failIds.has(String(entry.MessageDeduplicationId)))
        .map((entry) => ({ Id: entry.Id, Code: 'InternalError', Message: 'boom', SenderFault: false }));
      return Promise.resolve({ Failed, Successful: [] });
    },
  } as unknown as SQSClient;
  return { client, sent };
}

const queues = { getUrl: () => Promise.resolve('http://queue') } as unknown as SqsQueueResolver;

const aggregateOf = (id: string) => id.split('-')[0]!;

describe('SqsEventPublisher', () => {
  test('nenhum lote leva dois eventos do mesmo agregado, e cada agregado sai em ordem', async () => {
    const messages = [message('a-1', 'a'), message('b-1', 'b'), message('a-2', 'a'), message('a-3', 'a'), message('b-2', 'b')];
    const { client, sent } = fakeClient(new Set());
    const result = await new SqsEventPublisher(client, queues, loadConfig({})).publish(messages);

    for (const batch of sent) expect(new Set(batch.map(aggregateOf)).size).toBe(batch.length);
    expect(sent.flat().filter((id) => id.startsWith('a-'))).toEqual(['a-1', 'a-2', 'a-3']);
    expect(sent.flat().filter((id) => id.startsWith('b-'))).toEqual(['b-1', 'b-2']);
    expect(result.published).toHaveLength(5);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test('falha de um agregado retém os eventos seguintes dele como skipped, sem enviá-los', async () => {
    const messages = [message('a-1', 'a'), message('b-1', 'b'), message('a-2', 'a'), message('a-3', 'a'), message('b-2', 'b')];
    const { client, sent } = fakeClient(new Set(['a-1']));
    const result = await new SqsEventPublisher(client, queues, loadConfig({})).publish(messages);

    expect(sent.flat()).not.toContain('a-2');
    expect(sent.flat()).not.toContain('a-3');
    expect(result.failed.map(({ message: failed }) => failed.id)).toEqual(['a-1']);
    expect(result.skipped.map((skipped) => skipped.id)).toEqual(['a-2', 'a-3']);
    expect(result.published.map((published) => published.id)).toEqual(['b-1', 'b-2']);
  });

  test('mais de 10 agregados numa rodada são divididos em lotes de até 10', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => message(`g${i}-1`, `g${i}`));
    const { client, sent } = fakeClient(new Set());
    await new SqsEventPublisher(client, queues, loadConfig({})).publish(messages);
    expect(sent.map((batch) => batch.length)).toEqual([10, 2]);
  });
});
