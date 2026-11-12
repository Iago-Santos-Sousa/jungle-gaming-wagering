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

describe('SqsEventPublisher', () => {
  test('depois da primeira falha de um agregado, os eventos seguintes dele não são enviados', async () => {
    // 12 mensagens: o primeiro lote (10) leva a falha de a-1; a-2 cai no segundo lote e precisa ficar retida
    const messages = [message('a-1', 'a'), ...Array.from({ length: 9 }, (_, i) => message(`b-${i}`, 'b')), message('a-2', 'a'), message('c-1', 'c')];
    const { client, sent } = fakeClient(new Set(['a-1']));
    const result = await new SqsEventPublisher(client, queues, loadConfig({})).publish(messages);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(['c-1']);
    expect(result.failed.map(({ message: failed }) => failed.id)).toEqual(['a-1', 'a-2']);
    expect(result.published.map((published) => published.id)).toEqual([...Array.from({ length: 9 }, (_, i) => `b-${i}`), 'c-1']);
  });
});
