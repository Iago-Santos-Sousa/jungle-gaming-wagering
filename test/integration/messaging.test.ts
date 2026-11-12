import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { EventPublisher } from '../../src/application/ports/event-publisher';
import { UnitOfWork } from '../../src/application/ports/repositories';
import { ReprocessPendingReferenceUseCase, SubmitWagerTransactionUseCase } from '../../src/application/use-cases/wager-use-cases';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { computeInboxPayloadHash, computeWagerPayloadHash, type SubmittableKind } from '../../src/domain/wager-transaction/wager-transaction';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.module';
import { OutboxPublisherWorker, PendingReferenceWorker } from '../../src/interfaces/workers/scheduled-workers';
import { SqsWagerConsumer } from '../../src/interfaces/workers/sqs-wager-consumer';
import { apiClient, createWallet, expectLedgerConsistent, newId, readWalletState, submitWager, wagerBody, type ApiClient } from '../support/api-client';
import { drain, drainUntil, eventually, isolatedQueues, queueUrl, sendRaw, wagerEnvelope } from '../support/sqs-helpers';
import { startTestApp, type TestApp } from '../support/test-app';

const queues = isolatedQueues('messaging');
// Lock timeout curto para provocar erro transitório de forma determinística
const overrides = { ...queues, DB_LOCK_TIMEOUT_MS: '300', SQS_RETRY_BASE_DELAY_SECONDS: '1', SQS_RETRY_MAX_DELAY_SECONDS: '2' };

let ctx: TestApp;
let api: ApiClient;
let em: EntityManager;
let sqs: SQSClient;
let consumer: SqsWagerConsumer;
let wagerUrl: string;
let dlqUrl: string;
let eventsUrl: string;

beforeAll(async () => {
  ctx = await startTestApp(overrides);
  api = apiClient(ctx.baseUrl);
  em = ctx.orm.em.fork();
  sqs = createSqsClient(ctx.config);
  consumer = ctx.app.get(SqsWagerConsumer);
  [wagerUrl, dlqUrl, eventsUrl] = await Promise.all([
    queueUrl(sqs, queues.SQS_WAGER_QUEUE_NAME!),
    queueUrl(sqs, queues.SQS_WAGER_DLQ_NAME!),
    queueUrl(sqs, queues.SQS_EVENTS_QUEUE_NAME!),
  ]);
});

afterAll(async () => {
  await ctx?.close();
  sqs?.destroy();
});

function messageData(wallet: { walletId: string; playerId: string }, overrides: { kind?: string; amount?: string; externalTransactionId?: string; referenceExternalTransactionId?: string } = {}) {
  const body = wagerBody({ ...wallet, ...overrides });
  return { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` };
}

async function send(data: Record<string, unknown>, messageId?: string): Promise<string> {
  const envelope = wagerEnvelope(data, messageId);
  await sendRaw(sqs, wagerUrl, JSON.stringify(envelope), String(data.walletId));
  return envelope.messageId;
}

// Processa até a fila principal ficar quieta por quietMs (mensagens com backoff reaparecem depois do atraso).
// Short polling: o long polling do MiniStack tem granularidade de ~5s e deixaria a suíte lenta.
async function consumeUntilEmpty(timeoutMs = 20_000, quietMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastActivity = Date.now();
  while (Date.now() < deadline && Date.now() - lastActivity < quietMs) {
    const received = await consumer.pollOnce(0);
    if (received > 0) lastActivity = Date.now();
    else await Bun.sleep(100);
  }
}

async function inboxCount(messageId: string): Promise<number> {
  const rows = await em.fork().execute<{ count: string }[]>(`select count(*) from inbox_messages where message_id = ?`, [messageId]);
  return Number(rows[0]?.count);
}

describe('consumer SQS', () => {
  test('processa pela mesma regra do HTTP, registra no inbox e faz ack', async () => {
    const wallet = await createWallet(api, '100.00');
    const messageId = await send(messageData(wallet, { amount: '25.00' }));
    await consumeUntilEmpty();
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '75.00', debits: 1 });
    expect(await inboxCount(messageId)).toBe(1);
    expect(await drain(sqs, wagerUrl)).toHaveLength(0);
  });

  test('redelivery da mesma mensagem não duplica efeito (inbox persistente)', async () => {
    const wallet = await createWallet(api, '100.00');
    const data = messageData(wallet, { amount: '10.00' });
    const messageId = `msg-${newId()}`;
    await Promise.all(Array.from({ length: 5 }, () => send(data, messageId)));
    await consumeUntilEmpty();
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '90.00', debits: 1 });
    expect(await inboxCount(messageId)).toBe(1);
  });

  test('mensagens diferentes com a mesma idempotency key aplicam uma vez', async () => {
    const wallet = await createWallet(api, '100.00');
    const data = messageData(wallet, { amount: '10.00' });
    await send(data);
    await send(data);
    await consumeUntilEmpty();
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '90.00', debits: 1 });
  });

  test('messageId reutilizado com outra operação é conflito: ack sem efeito, nunca replay', async () => {
    const wallet = await createWallet(api, '100.00');
    const messageId = `msg-${newId()}`;
    await send(messageData(wallet, { amount: '10.00' }), messageId);
    await consumeUntilEmpty();

    const conflicting = messageData(wallet, { amount: '20.00' });
    await send(conflicting, messageId);
    await consumeUntilEmpty();

    // A segunda operação não foi persistida nem moveu saldo, e a mensagem saiu da fila sem ir para a DLQ
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '90.00', debits: 1 });
    const stored = await em.fork().execute(`select id from wager_transactions where idempotency_key = ?`, [conflicting.idempotencyKey]);
    expect(stored).toHaveLength(0);
    expect(await inboxCount(messageId)).toBe(1);
    expect(await drain(sqs, wagerUrl, 0)).toHaveLength(0);
    expect(await drain(sqs, dlqUrl, 0)).toHaveLength(0);
    const metrics = await (await fetch(`${ctx.baseUrl}/metrics`)).text();
    expect(metrics).toMatch(/duplicates_detected_total\{source="inbox_conflict"\} [1-9]/);
  });

  test('inbox gravado com o hash legado (sem Idempotency-Key): reentrega é duplicata, não conflito', async () => {
    const inboxConflicts = async () => {
      const metrics = await (await fetch(`${ctx.baseUrl}/metrics`)).text();
      return Number(/duplicates_detected_total\{source="inbox_conflict"\} (\d+)/.exec(metrics)?.[1] ?? 0);
    };
    const wallet = await createWallet(api, '100.00');
    const data = messageData(wallet, { amount: '10.00' });
    const messageId = `msg-${newId()}`;
    await send(data, messageId);
    await consumeUntilEmpty();

    // Simula uma linha gravada pela versão anterior, que guardava só o hash de negócio
    const command = { ...data, kind: data.kind as SubmittableKind, money: Money.from(data.money) };
    await em.fork().execute(`update inbox_messages set payload_hash = ? where message_id = ?`, [computeWagerPayloadHash(command), messageId]);
    const conflictsBefore = await inboxConflicts();

    await send(data, messageId);
    await consumeUntilEmpty();
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '90.00', debits: 1 });
    expect(await inboxConflicts()).toBe(conflictsBefore);
    expect(await drain(sqs, wagerUrl, 0)).toHaveLength(0);
  });

  test('worker morto depois do commit e antes do ack: a reentrega é deduplicada', async () => {
    const wallet = await createWallet(api, '100.00');
    const data = messageData(wallet, { amount: '30.00' });
    const messageId = await send(data);

    // Instância A recebe, confirma no banco e "morre" sem fazer ack
    const { Messages } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: wagerUrl, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
    expect(Messages).toHaveLength(1);
    const command = { ...data, kind: data.kind as SubmittableKind, money: Money.from(data.money) };
    await ctx.app.get(SubmitWagerTransactionUseCase).execute(command, {
      source: 'sqs',
      correlationId: messageId,
      inbox: { consumerName: ctx.config.sqs.consumerName, messageId, payloadHash: computeInboxPayloadHash(command) },
    });

    // Após o visibility timeout, outra instância recebe a mesma mensagem, detecta a duplicata e faz ack
    await eventually(async () => (await consumer.pollOnce(0)) > 0, 30_000);
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '70.00', debits: 1 });
    expect(await drain(sqs, wagerUrl, 0)).toHaveLength(0);
  });

  test('mensagem inválida vai direto para a DLQ (erro permanente)', async () => {
    const wallet = await createWallet(api, '100.00');
    await sendRaw(sqs, wagerUrl, 'not json', 'bad-1');
    await send({ ...messageData(wallet), kind: 'OPENING' });
    await send({ ...messageData(wallet), money: { amount: '1e3', currency: 'BRL' } });
    await consumeUntilEmpty();
    const dead = await drain(sqs, dlqUrl);
    expect(dead).toHaveLength(3);
    expect(dead.every((m) => m.MessageAttributes?.reason?.StringValue === 'invalid_message')).toBe(true);
    expect(await readWalletState(em, wallet.walletId)).toMatchObject({ balance: '100.00', entries: 1 });
  });

  test('erro transitório: retry com backoff e sucesso quando o lock é liberado', async () => {
    const wallet = await createWallet(api, '100.00');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // Outra transação segura o lock da wallet: o consumer bate no lock_timeout
    const holder = em.fork().transactional(async (tx) => {
      await tx.execute('select id from wallets where id = ? for update', [wallet.walletId]);
      await released;
    });
    await Bun.sleep(50);
    await send(messageData(wallet, { amount: '5.00' }));
    expect(await consumer.pollOnce(1)).toBe(1);
    expect((await readWalletState(em, wallet.walletId)).debits).toBe(0);

    release();
    await holder;
    // A mensagem volta após o backoff de visibilidade e é aplicada uma única vez
    await eventually(async () => {
      await consumer.pollOnce(0);
      return (await readWalletState(em, wallet.walletId)).debits === 1;
    }, 30_000);
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '95.00', debits: 1 });
    expect(await drain(sqs, wagerUrl, 0)).toHaveLength(0);
    const metrics = await (await fetch(`${ctx.baseUrl}/metrics`)).text();
    expect(metrics).toMatch(/retries_total\{component="sqs"\} [1-9]/);
    expect(metrics).toMatch(/lock_conflicts_total [1-9]/);
  });

  test('erro transitório persistente: DLQ ao atingir o limite de tentativas', async () => {
    const wallet = await createWallet(api, '100.00');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = em.fork().transactional(async (tx) => {
      await tx.execute('select id from wallets where id = ? for update', [wallet.walletId]);
      await released;
    });
    await Bun.sleep(50);
    await send(messageData(wallet, { amount: '5.00' }));
    let dead;
    try {
      // Cada entrega falha por lock timeout; na entrega de número SQS_MAX_RECEIVES a mensagem vai para a DLQ
      dead = await eventually(async () => {
        await consumer.pollOnce(0);
        const moved = await drain(sqs, dlqUrl, 0);
        return moved.length > 0 ? moved : undefined;
      }, 30_000);
    } finally {
      release();
      await holder;
    }
    expect(dead).toHaveLength(1);
    expect(await drain(sqs, wagerUrl, 0)).toHaveLength(0);
    expect(dead[0]?.MessageAttributes?.reason?.StringValue).toBe('retries_exhausted');
    expect(await readWalletState(em, wallet.walletId)).toMatchObject({ balance: '100.00', debits: 0 });
  }, 40_000);
});

describe('referências fora de ordem via SQS', () => {
  test('ROLLBACK entregue antes da BET é aplicado quando a BET chega', async () => {
    const wallet = await createWallet(api, '100.00');
    const betId = `bet-${newId()}`;
    await send(messageData(wallet, { kind: 'ROLLBACK', amount: '20.00', referenceExternalTransactionId: betId }));
    await consumeUntilEmpty();
    const pending = await em.fork().execute(`select status from wager_transactions where wallet_id = ? and kind = 'ROLLBACK'`, [wallet.walletId]);
    expect(pending).toEqual([{ status: 'PENDING_REFERENCE' }]);

    await send(messageData(wallet, { amount: '20.00', externalTransactionId: betId }));
    await consumeUntilEmpty();
    const worker = ctx.app.get(PendingReferenceWorker);
    await eventually(async () => {
      await worker.runOnce();
      const rows = await em.fork().execute<{ status: string }[]>(`select status from wager_transactions where wallet_id = ? and kind = 'ROLLBACK'`, [wallet.walletId]);
      return rows[0]?.status === 'PROCESSED';
    });
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '100.00', debits: 1, credits: 2 });
  });

  test('referência que nunca chega: REJECTED com REFERENCE_NOT_FOUND e evento publicado', async () => {
    const wallet = await createWallet(api, '100.00');
    await send(messageData(wallet, { kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: `missing-${newId()}` }));
    await consumeUntilEmpty();
    const worker = ctx.app.get(PendingReferenceWorker);
    const rows = await eventually(async () => {
      await worker.runOnce();
      const found = await em.fork().execute<{ id: string; status: string; failure_code: string; reference_attempts: number }[]>(
        `select id, status, failure_code, reference_attempts from wager_transactions where wallet_id = ? and kind = 'REFUND'`,
        [wallet.walletId],
      );
      return found[0]?.status === 'REJECTED' ? found : undefined;
    }, 15_000);
    expect(rows[0]).toMatchObject({ failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: ctx.config.pendingReference.maxAttempts - 1 });
    const events = await em.fork().execute<{ event_type: string }[]>(`select event_type from outbox_messages where aggregate_id = ? order by occurred_at`, [rows[0]!.id]);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });

  test('instâncias concorrentes reservam conjuntos disjuntos e um claim vencido não processa', async () => {
    const wallet = await createWallet(api, '100.00');
    const pendingIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await submitWager(api, wagerBody({ ...wallet, kind: 'REFUND', amount: '1.00', referenceExternalTransactionId: `missing-${newId()}` }));
      expect(response.status).toBe(202);
      pendingIds.push(String(response.body.transactionId));
    }
    // Torna todas vencidas sem esperar o backoff. A data fica bem no passado porque o relógio da VM do Docker
    // pode saltar alguns segundos para trás entre este UPDATE e o claim (que usa o Clock da aplicação).
    await em.fork().execute(`update wager_transactions set next_attempt_at = ? where id = any(?::uuid[])`, [new Date(Date.now() - 3_600_000), `{${pendingIds.join(',')}}`]);

    const other = await startTestApp(overrides);
    try {
      const leaseMs = ctx.config.pendingReference.leaseMs;
      const [mine, theirs] = await Promise.all([
        ctx.app.get(ReprocessPendingReferenceUseCase).claimDue(100, leaseMs),
        other.app.get(ReprocessPendingReferenceUseCase).claimDue(100, leaseMs),
      ]);
      const mineIds = mine.map((claim) => claim.transactionId).filter((id) => pendingIds.includes(id));
      const theirIds = theirs.map((claim) => claim.transactionId).filter((id) => pendingIds.includes(id));
      expect(mineIds.filter((id) => theirIds.includes(id))).toEqual([]);
      expect([...mineIds, ...theirIds].sort()).toEqual([...pendingIds].sort());

      // Token antigo: o lease foi reemitido para outra instância, então o claim original não processa
      const stale = [...mine, ...theirs].find((claim) => pendingIds.includes(claim.transactionId))!;
      await em.fork().execute(`update wager_transactions set next_attempt_at = ? where id = ?`, [new Date(Date.now() + 60_000), stale.transactionId]);
      expect(await ctx.app.get(ReprocessPendingReferenceUseCase).execute(stale)).toBeNull();
    } finally {
      await other.close();
    }
  });
});

describe('transactional outbox', () => {
  async function pendingOutbox(): Promise<number> {
    const rows = await em.fork().execute<{ count: string }[]>(`select count(*) from outbox_messages where published_at is null`);
    return Number(rows[0]?.count);
  }

  async function publishAll(publishers: OutboxPublisherWorker[]): Promise<void> {
    await eventually(async () => {
      await Promise.all(publishers.map((publisher) => publisher.runOnce()));
      return (await pendingOutbox()) === 0;
    });
  }

  test('wallet, ledger e outbox são atômicos e o publisher publica todos os eventos confirmados', async () => {
    const wallet = await createWallet(api, '100.00');
    await send(messageData(wallet, { amount: '10.00' }));
    await consumeUntilEmpty();
    await publishAll([ctx.app.get(OutboxPublisherWorker)]);
    const parse = (m: { Body?: string }) => JSON.parse(m.Body ?? '{}') as { eventType: string; aggregateId: string; eventId: string; data: { walletId?: string } };
    const ofWallet = (all: { Body?: string }[]) => all.map(parse).filter((event) => event.data.walletId === wallet.walletId);
    const published = await drainUntil(sqs, eventsUrl, (all) => ofWallet(all).length >= 4);
    const types = published.map(parse);
    const forWallet = ofWallet(published);
    expect(forWallet.map((event) => event.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
    expect(new Set(types.map((event) => event.eventId)).size).toBe(types.length);
  });

  test('dois publishers concorrentes sobre a mesma outbox publicam cada evento uma vez', async () => {
    const other = await startTestApp(overrides);
    try {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(api, '50.00')));
      await Promise.all(wallets.map((wallet) => api.post('/wagering/transactions', wagerBody({ ...wallet, amount: '1.00' }), { 'Idempotency-Key': newId() })));
      const pendingRows = await em.fork().execute<{ id: string }[]>(`select id from outbox_messages where published_at is null`);
      const expected = new Set(pendingRows.map((row) => row.id));
      expect(expected.size).toBeGreaterThanOrEqual(40);

      await publishAll([ctx.app.get(OutboxPublisherWorker), other.app.get(OutboxPublisherWorker), ctx.app.get(OutboxPublisherWorker)]);
      const expectedIdsIn = (all: { Body?: string }[]) => all.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId).filter((id) => expected.has(id));
      const published = await drainUntil(sqs, eventsUrl, (all) => new Set(expectedIdsIn(all)).size === expected.size);
      const eventIds = expectedIdsIn(published);
      // Cada evento confirmado publicado exatamente uma vez
      expect(new Set(eventIds).size).toBe(expected.size);
      expect(eventIds).toHaveLength(expected.size);
    } finally {
      await other.close();
    }
  });

  test('publishers concorrentes reservam agregados inteiros e publicam os eventos de cada wallet em ordem', async () => {
    const other = await startTestApp(overrides);
    try {
      const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(api, '100.00')));
      // Várias movimentações por wallet: os eventos de saldo precisam sair em ordem de walletVersion
      for (let i = 0; i < 4; i++) {
        await Promise.all(wallets.map((wallet) => submitWager(api, wagerBody({ ...wallet, amount: '1.00' }))));
      }

      // Claims concorrentes: nenhum agregado fica dividido entre dois publishers
      const claimWith = (uow: UnitOfWork) => uow.transactional((scope) => scope.outbox.claimDue(new Date(), 2, 500));
      const [a, b] = await Promise.all([claimWith(ctx.app.get(UnitOfWork)), claimWith(other.app.get(UnitOfWork))]);
      const aggregatesOf = (claimed: OutboxMessage[]) => new Set(claimed.map((message) => message.aggregateId));
      expect([...aggregatesOf(a)].filter((id) => aggregatesOf(b).has(id))).toEqual([]);
      await Bun.sleep(600);

      await publishAll([ctx.app.get(OutboxPublisherWorker), other.app.get(OutboxPublisherWorker)]);
      const parse = (m: { Body?: string }) => JSON.parse(m.Body ?? '{}') as { eventType: string; data: { walletId?: string; walletVersion?: number } };
      const balanceEvents = (all: { Body?: string }[], walletId: string) =>
        all.map(parse).filter((event) => event.eventType === 'WalletBalanceChanged' && event.data.walletId === walletId);
      const events = (await drainUntil(sqs, eventsUrl, (all) => wallets.every((wallet) => balanceEvents(all, wallet.walletId).length >= 5))).map(parse);
      for (const wallet of wallets) {
        const versions = events
          .filter((event) => event.eventType === 'WalletBalanceChanged' && event.data.walletId === wallet.walletId)
          .map((event) => event.data.walletVersion);
        expect(versions).toEqual([1, 2, 3, 4, 5]);
      }
    } finally {
      await other.close();
    }
  });

  test('commit confirmado e processo morto antes de publicar: outra instância publica após o lease', async () => {
    const wallet = await createWallet(api, '100.00');
    // Instância A reserva o lote (lease) e morre antes de publicar
    const claimed = await ctx.app.get(UnitOfWork).transactional((scope) => scope.outbox.claimDue(new Date(), 100, ctx.config.outbox.leaseMs));
    expect(claimed.some((message) => message.aggregateId === wallet.walletId)).toBe(true);

    const other = await startTestApp(overrides);
    try {
      const publisher = other.app.get(OutboxPublisherWorker);
      await publisher.runOnce();
      expect(await pendingOutbox()).toBe(claimed.length);
      await publishAll([publisher]);
      const claimedIds = new Set(claimed.map((m) => m.id));
      const claimedIdsIn = (all: { Body?: string }[]) => all.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId).filter((id) => claimedIds.has(id));
      const published = await drainUntil(sqs, eventsUrl, (all) => new Set(claimedIdsIn(all)).size === claimedIds.size);
      expect(claimedIdsIn(published).sort()).toEqual([...claimedIds].sort());
    } finally {
      await other.close();
    }
  });

  test('publicação duplicada carrega o mesmo eventId e é deduplicável pelo consumidor', async () => {
    const wallet = await createWallet(api, '100.00');
    const [message] = (await ctx.app.get(UnitOfWork).transactional((scope) => scope.outbox.claimDue(new Date(), 100, 1))).filter((m) => m.aggregateId === wallet.walletId);
    expect(message).toBeDefined();
    // Publica, "perde" a confirmação e publica de novo após o lease vencer
    await ctx.app.get(EventPublisher).publish([message!]);
    await Bun.sleep(20);
    await publishAll([ctx.app.get(OutboxPublisherWorker)]);
    const published = await drainUntil(sqs, eventsUrl, (all) => all.some((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId === message!.id));
    const ids = published.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId).filter((id) => id === message!.id);
    // FIFO deduplica pelo MessageDeduplicationId; se não deduplicasse, as cópias teriam o mesmo eventId
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ids)).toEqual(new Set([message!.id]));
  });
});

describe('shutdown do consumer', () => {
  test('mensagem recebida depois do SIGTERM volta para a fila na hora, sem efeito e sem esperar o visibility timeout', async () => {
    // Fila própria com visibility timeout longo: se a mensagem não fosse devolvida, ficaria invisível por 60s
    const shutdownQueues = isolatedQueues('shutdown');
    const instance = await startTestApp({ ...overrides, ...shutdownQueues, SQS_VISIBILITY_TIMEOUT_SECONDS: '60' });
    try {
      const url = await queueUrl(sqs, shutdownQueues.SQS_WAGER_QUEUE_NAME!);
      const wallet = await createWallet(api, '100.00');
      await sendRaw(sqs, url, JSON.stringify(wagerEnvelope(messageData(wallet, { amount: '10.00' }))), wallet.walletId);

      const stopped = instance.app.get(SqsWagerConsumer);
      await stopped.beforeApplicationShutdown();
      expect(await stopped.pollOnce(1)).toBe(1);

      const startedAt = Date.now();
      const redelivered = await eventually(async () => {
        const { Messages } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
        return Messages?.length ? Messages : undefined;
      }, 10_000);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(redelivered[0]?.Attributes?.ApproximateReceiveCount).toBe('2');
      expect(await readWalletState(em, wallet.walletId)).toMatchObject({ balance: '100.00', debits: 0 });
    } finally {
      await instance.close();
    }
  });
});

describe('recuperação após reinício', () => {
  test('instância encerrada no meio do processamento: outra assume e o estado final é consistente', async () => {
    const wallet = await createWallet(api, '1000.00');
    const total = 30;
    for (let i = 0; i < total; i++) await send(messageData(wallet, { amount: '1.00' }));

    const first = await startTestApp({ ...overrides, WORKERS_ENABLED: 'true' });
    await eventually(async () => (await readWalletState(em, wallet.walletId)).debits > 0, 20_000, 20);
    // SIGTERM: o consumer termina o que começou e devolve o resto
    await first.close();

    const second = await startTestApp({ ...overrides, WORKERS_ENABLED: 'true' });
    try {
      await eventually(async () => (await readWalletState(em, wallet.walletId)).debits === total, 30_000);
      await eventually(async () => {
        const rows = await em.fork().execute<{ count: string }[]>(`select count(*) from outbox_messages where published_at is null`);
        return Number(rows[0]?.count) === 0;
      }, 20_000);
    } finally {
      await second.close();
    }
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '970.00', debits: total });
    expect(await drain(sqs, wagerUrl)).toHaveLength(0);
    expect(await drain(sqs, dlqUrl)).toHaveLength(0);
  }, 90_000);
});
