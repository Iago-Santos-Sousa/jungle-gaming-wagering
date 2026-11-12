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

  test('lotes da mesma rodada saem em paralelo e a rodada seguinte só começa depois', async () => {
    // 12 agregados com 2 eventos cada: 2 rodadas de 2 lotes (10 + 2)
    const messages = Array.from({ length: 12 }, (_, i) => [message(`g${i}-1`, `g${i}`), message(`g${i}-2`, `g${i}`)]).flat();
    let inFlight = 0;
    let maxInFlight = 0;
    const roundsSeen: string[][] = [];
    const client = {
      send: async (command: SendMessageBatchCommand) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(20);
        roundsSeen.push((command.input.Entries ?? []).map((entry) => String(entry.MessageDeduplicationId)));
        inFlight -= 1;
        return { Failed: [], Successful: [] };
      },
    } as unknown as SQSClient;
    await new SqsEventPublisher(client, queues, loadConfig({})).publish(messages);

    expect(maxInFlight).toBe(2);
    // Todos os primeiros eventos (rodada 1) foram enviados antes de qualquer segundo evento (rodada 2)
    const order = roundsSeen.flat();
    const lastFirst = Math.max(...order.map((id, index) => (id.endsWith('-1') ? index : -1)));
    const firstSecond = order.findIndex((id) => id.endsWith('-2'));
    expect(lastFirst).toBeLessThan(firstSecond);
  });

  test('shouldStop entre rodadas: o que não saiu volta como skipped', async () => {
    const messages = [message('a-1', 'a'), message('a-2', 'a'), message('a-3', 'a'), message('b-1', 'b')];
    const { client, sent } = fakeClient(new Set());
    let rounds = 0;
    const result = await new SqsEventPublisher(client, queues, loadConfig({})).publish(messages, { shouldStop: () => rounds++ >= 1 });

    expect(sent.flat()).toEqual(['a-1', 'b-1']);
    expect(result.published.map((published) => published.id)).toEqual(['a-1', 'b-1']);
    expect(result.skipped.map((skipped) => skipped.id)).toEqual(['a-2', 'a-3']);
  });

  test('mais de 10 agregados numa rodada são divididos em lotes de até 10', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => message(`g${i}-1`, `g${i}`));
    const { client, sent } = fakeClient(new Set());
    await new SqsEventPublisher(client, queues, loadConfig({})).publish(messages);
    expect(sent.map((batch) => batch.length)).toEqual([10, 2]);
  });
});
