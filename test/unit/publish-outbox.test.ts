import { describe, expect, test } from 'bun:test';
import type { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { PinoLogger } from 'nestjs-pino';
import type { RepositoryScope, UnitOfWork } from '../../src/application/ports/repositories';
import type { Clock, WageringMetrics } from '../../src/application/ports/system';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox.use-case';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { RetryPolicy } from '../../src/domain/shared/retry-policy';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import type { SqsQueueResolver } from '../../src/infrastructure/messaging/sqs.module';
import { NOW } from '../support/domain-builders';

function message(id: string): OutboxMessage {
  return OutboxMessage.rehydrate({ id, aggregateId: 'wallet-1', eventType: 'WalletBalanceChanged', payload: {}, occurredAt: NOW, attempts: 0, nextAttemptAt: NOW, publishedAt: undefined });
}

describe('PublishOutboxUseCase', () => {
  test('não abre rodada depois da metade do lease e devolve o resto do agregado', async () => {
    let now = NOW.getTime();
    const clock = { now: () => new Date(now) } as Clock;
    // Broker lento: cada chamada leva 1s, e o agregado único publica um evento por chamada
    const client = {
      send: (command: SendMessageBatchCommand) => {
        now += 1000;
        return Promise.resolve({ Failed: [], Successful: command.input.Entries });
      },
    } as unknown as SQSClient;
    const queues = { getUrl: () => Promise.resolve('http://queue') } as unknown as SqsQueueResolver;
    const publisher = new SqsEventPublisher(client, queues, loadConfig({}));

    const claimed = ['m1', 'm2', 'm3', 'm4', 'm5'].map(message);
    const calls: Record<string, string[]> = {};
    const record = (name: string) => (messages: readonly OutboxMessage[]) => {
      calls[name] = messages.map((m) => m.id);
      return Promise.resolve();
    };
    const scope = {
      outbox: {
        claimDue: (at: Date, _limit: number, leaseMs: number) => Promise.resolve({ leaseUntil: new Date(at.getTime() + leaseMs), messages: claimed }),
        markPublished: record('published'),
        scheduleRetries: record('retries'),
        releaseLease: record('released'),
      },
    } as unknown as RepositoryScope;
    const uow = { transactional: <T>(work: (s: RepositoryScope) => Promise<T>) => work(scope) } as unknown as UnitOfWork;
    const metrics = { retry: () => {} } as unknown as WageringMetrics;
    const logger = { setContext: () => {}, warn: () => {} } as unknown as PinoLogger;
    const useCase = new PublishOutboxUseCase(uow, publisher, clock, metrics, new RetryPolicy(1000, 60000), logger);

    const cycle = await useCase.publishBatch({ batchSize: 50, leaseMs: 4000 });

    // Rodadas em t=0s e t=1s; em t=2s metade do lease de 4s passou e o resto volta sem tentativa nem backoff
    expect(cycle).toEqual({ claimed: 5, published: 2, failed: 0 });
    expect(calls.published).toEqual(['m1', 'm2']);
    expect(calls.released).toEqual(['m3', 'm4', 'm5']);
    expect(calls.retries).toEqual([]);
  });
});
