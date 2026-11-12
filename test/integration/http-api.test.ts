import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ReprocessPendingReferenceUseCase } from '../../src/application/use-cases/wager-use-cases';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction';
import {
  apiClient,
  brl,
  createWallet,
  expectLedgerConsistent,
  newId,
  readWalletState,
  submitWager,
  wagerBody,
  type ApiClient,
} from '../support/api-client';
import { startTestApp, type TestApp } from '../support/test-app';

let ctx: TestApp;
let api: ApiClient;
let em: EntityManager;

beforeAll(async () => {
  ctx = await startTestApp();
  api = apiClient(ctx.baseUrl);
  em = ctx.orm.em.fork();
});

afterAll(async () => {
  await ctx?.close();
});

async function outboxEventTypes(aggregateIds: string[]): Promise<string[]> {
  const rows = await em.fork().execute<{ event_type: string }[]>(
    `select event_type from outbox_messages where aggregate_id = any(?::uuid[]) order by occurred_at, event_type`,
    [`{${aggregateIds.join(',')}}`],
  );
  return rows.map((row) => row.event_type);
}

describe('POST /wallets', () => {
  test('cria wallet com saldo inicial, transação OPENING e CREDIT no ledger', async () => {
    const playerId = newId();
    const response = await api.post('/wallets', { playerId, initialBalance: brl('1000.00') });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });

    const walletId = String(response.body.id);
    const state = await expectLedgerConsistent(em, walletId);
    expect(state).toMatchObject({ entries: 1, credits: 1, version: 1 });
    const opening = await em.fork().execute(`select kind, status, provider_id from wager_transactions where wallet_id = ?`, [walletId]);
    expect(opening).toEqual([{ kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal' }]);
    expect(await outboxEventTypes([walletId])).toContain('WalletBalanceChanged');
  });

  test('saldo inicial zero não gera ledger', async () => {
    const { walletId } = await createWallet(api, '0.00');
    expect(await readWalletState(em, walletId)).toMatchObject({ balance: '0.00', entries: 0, version: 1 });
  });

  test('wallet duplicada para playerId + currency é conflito', async () => {
    const { playerId } = await createWallet(api, '10.00');
    const duplicate = await api.post('/wallets', { playerId, initialBalance: brl('5.00') });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');
    const otherCurrency = await api.post('/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'USD' } });
    expect(otherCurrency.status).toBe(201);
  });

  test.each([
    [{ playerId: 'not-a-uuid', initialBalance: brl('1.00') }],
    [{ playerId: newId(), initialBalance: { amount: 10, currency: 'BRL' } }],
    [{ playerId: newId(), initialBalance: brl('-1.00') }],
    [{ playerId: newId(), initialBalance: brl('1.001') }],
    [{ playerId: newId() }],
    [{ playerId: newId(), initialBalance: brl('1.00'), extra: true }],
  ])('payload inválido retorna 400 VALIDATION_ERROR (%#)', async (payload) => {
    const response = await api.post('/wallets', payload);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /wallets/:walletId', () => {
  test('retorna a wallet, 404 se inexistente e 400 se id inválido', async () => {
    const { walletId, playerId } = await createWallet(api, '50.00');
    expect((await api.get(`/wallets/${walletId}`)).body).toEqual({ id: walletId, playerId, balance: brl('50.00'), version: 1 });
    expect((await api.get(`/wallets/${newId()}`)).status).toBe(404);
    expect((await api.get('/wallets/abc')).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET aplicada (201), replay idêntico (200) e payload divergente com a mesma key (409)', async () => {
    const wallet = await createWallet(api, '1000.00');
    const body = wagerBody({ ...wallet, amount: '25.00' });
    const first = await submitWager(api, body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: brl('975.00'), idempotentReplay: false });

    // Movimento posterior muda o saldo, mas o replay devolve o saldo observado na decisão original
    await submitWager(api, wagerBody({ ...wallet, amount: '100.00' }));
    const replay = await submitWager(api, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await submitWager(api, { ...body, money: brl('26.00') });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const sameExternalIdOtherKey = await submitWager(api, body, 'another-key');
    expect(sameExternalIdOtherKey.status).toBe(409);

    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '875.00', debits: 2 });
  });

  test('saldo insuficiente: 422 INSUFFICIENT_FUNDS, persistido e sem ledger', async () => {
    const wallet = await createWallet(api, '10.00');
    const response = await submitWager(api, wagerBody({ ...wallet, amount: '10.01' }));
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('10.00') });
    const stored = await api.get(`/wagering/transactions/${response.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ entries: 1, balance: '10.00' });
    expect(await outboxEventTypes([String(response.body.transactionId)])).toEqual(['WagerTransactionRejected']);
  });

  test('wallet inexistente: 422 WALLET_NOT_FOUND sem persistir', async () => {
    const response = await submitWager(api, wagerBody({ walletId: newId(), playerId: newId() }));
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ transactionId: null, status: 'REJECTED', balance: null, failureCode: 'WALLET_NOT_FOUND', idempotentReplay: false });
  });

  test('moeda diferente da wallet: 422 CURRENCY_MISMATCH', async () => {
    const wallet = await createWallet(api, '10.00');
    const response = await submitWager(api, wagerBody({ ...wallet, currency: 'USD', amount: '1.00' }));
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH', balance: brl('10.00') });
  });

  test.each([
    ['OPENING não pode ser submetido', { kind: 'OPENING' }],
    ['REFUND sem referência', { kind: 'REFUND' }],
    ['valor em notação científica', { money: { amount: '1e2', currency: 'BRL' } }],
    ['valor com mais de 2 casas', { money: { amount: '1.234', currency: 'BRL' } }],
    ['valor sem casas decimais', { money: { amount: '25', currency: 'BRL' } }],
    ['valor com uma casa decimal', { money: { amount: '25.5', currency: 'BRL' } }],
    ['amount numérico', { money: { amount: 10, currency: 'BRL' } }],
    ['BET com valor zero', { money: brl('0.00') }],
  ])('400 VALIDATION_ERROR: %s', async (_, overrides) => {
    const wallet = await createWallet(api, '10.00');
    const response = await submitWager(api, { ...wagerBody(wallet), ...overrides } as ReturnType<typeof wagerBody>);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  test('Idempotency-Key ausente é 400', async () => {
    const wallet = await createWallet(api, '10.00');
    const response = await api.post('/wagering/transactions', wagerBody(wallet));
    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(['Idempotency-Key: required']);
  });

  test('WIN credita e LOSS não move saldo nem gera ledger', async () => {
    const wallet = await createWallet(api, '100.00');
    const bet = wagerBody({ ...wallet, amount: '20.00', roundId: 'r-win' });
    await submitWager(api, bet);
    const win = await submitWager(api, wagerBody({ ...wallet, kind: 'WIN', amount: '55.00', roundId: 'r-win', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(win.body).toMatchObject({ status: 'PROCESSED', balance: brl('135.00') });
    const loss = await submitWager(api, wagerBody({ ...wallet, kind: 'LOSS', amount: '20.00', roundId: 'r-win' }));
    expect(loss.status).toBe(201);
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: brl('135.00') });
    expect(await outboxEventTypes([String(loss.body.transactionId)])).toEqual(['WagerTransactionProcessed']);
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ entries: 3, balance: '135.00' });
  });

  test('REFUND reverte a BET uma única vez', async () => {
    const wallet = await createWallet(api, '100.00');
    const bet = wagerBody({ ...wallet, amount: '30.00' });
    await submitWager(api, bet);
    const refund = await submitWager(api, wagerBody({ ...wallet, kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    const second = await submitWager(api, wagerBody({ ...wallet, kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const rollback = await submitWager(api, wagerBody({ ...wallet, kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const partial = await submitWager(api, wagerBody({ ...wallet, kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(partial.body.failureCode).toBe('AMOUNT_MISMATCH');
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '100.00', entries: 3 });
  });

  test('ROLLBACK de WIN debita; reversão que deixaria saldo negativo é REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await createWallet(api, '10.00');
    const win = wagerBody({ ...wallet, kind: 'WIN', amount: '50.00' });
    await submitWager(api, win);
    await submitWager(api, wagerBody({ ...wallet, amount: '55.00' }));
    const rollback = await submitWager(api, wagerBody({ ...wallet, kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: win.externalTransactionId }));
    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({ failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: brl('5.00') });
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '5.00' });
  });

  test('referência de outra rodada é REFERENCE_MISMATCH', async () => {
    const wallet = await createWallet(api, '100.00');
    const bet = wagerBody({ ...wallet, amount: '10.00', roundId: 'round-a' });
    await submitWager(api, bet);
    const refund = await submitWager(api, wagerBody({ ...wallet, kind: 'REFUND', amount: '10.00', roundId: 'round-b', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.body.failureCode).toBe('REFERENCE_MISMATCH');
  });

  test('REFUND antes da BET: 202 PENDING_REFERENCE e processado quando a referência chega', async () => {
    const wallet = await createWallet(api, '100.00');
    const betId = `bet-${newId()}`;
    const refund = wagerBody({ ...wallet, kind: 'REFUND', amount: '40.00', referenceExternalTransactionId: betId });
    const pending = await submitWager(api, refund);
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00') });
    expect((await submitWager(api, refund)).status).toBe(202);

    await submitWager(api, wagerBody({ ...wallet, amount: '40.00', externalTransactionId: betId }));
    const status = await ctx.app.get(ReprocessPendingReferenceUseCase).execute(String(pending.body.transactionId));
    expect(status).toBe(WagerTransactionStatus.Processed);

    const replay = await submitWager(api, refund);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00'), idempotentReplay: true });
    expect(await outboxEventTypes([String(pending.body.transactionId)])).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '100.00', debits: 1, credits: 2 });
  });
});

describe('consultas', () => {
  test('transação por id interno e por id do provedor', async () => {
    const wallet = await createWallet(api, '100.00');
    const body = wagerBody({ ...wallet, amount: '1.00' });
    const created = await submitWager(api, body);
    const byId = await api.get(`/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ transactionId: created.body.transactionId, kind: 'BET', money: brl('1.00'), status: 'PROCESSED', balance: brl('99.00') });
    const byExternal = await api.get(`/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal.body).toEqual(byId.body);
    expect((await api.get(`/wagering/transactions/${newId()}`)).status).toBe(404);
    expect((await api.get('/providers/provider-a/wagering/transactions/unknown')).status).toBe(404);
  });

  test('ledger paginado por cursor estável, do mais recente ao mais antigo', async () => {
    const wallet = await createWallet(api, '100.00');
    for (let i = 0; i < 5; i++) await submitWager(api, wagerBody({ ...wallet, amount: '1.00' }));

    const versions: number[] = [];
    let cursor: string | null = null;
    do {
      const page: { status: number; body: { items: { walletVersion: number }[]; nextCursor: string | null } } = await api.get(
        `/wallets/${wallet.walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page.status).toBe(200);
      versions.push(...page.body.items.map((item) => item.walletVersion));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(versions).toEqual([6, 5, 4, 3, 2, 1]);

    expect((await api.get(`/wallets/${wallet.walletId}/ledger?cursor=invalid`)).status).toBe(400);
    expect((await api.get(`/wallets/${wallet.walletId}/ledger?limit=101`)).status).toBe(400);
    expect((await api.get(`/wallets/${newId()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistente após operações', async () => {
    const wallet = await createWallet(api, '975.00');
    await submitWager(api, wagerBody({ ...wallet, amount: '25.00' }));
    const response = await api.post(`/wallets/${wallet.walletId}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.walletId,
      storedBalance: brl('950.00'),
      calculatedBalance: brl('950.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada e não corrigida', async () => {
    const wallet = await createWallet(api, '100.00');
    // Simula corrupção fora da aplicação, com as triggers de proteção desligadas só para este teste
    const tx = em.fork();
    await tx.execute('alter table wallets disable trigger user');
    try {
      await tx.execute(`update wallets set balance_amount = 90 where id = ?`, [wallet.walletId]);
    } finally {
      await tx.execute('alter table wallets enable trigger user');
    }
    const response = await api.post(`/wallets/${wallet.walletId}/reconciliation`);
    expect(response.body).toMatchObject({ consistent: false, storedBalance: brl('90.00'), calculatedBalance: brl('100.00'), difference: brl('-10.00') });
    expect((await readWalletState(em, wallet.walletId)).balance).toBe('90.00');
    const metrics = await (await fetch(`${ctx.baseUrl}/metrics`)).text();
    expect(metrics).toMatch(/reconciliation_divergences_total [1-9]/);
  });
});

describe('health e métricas', () => {
  test('liveness, readiness e métricas expostos sem autenticação', async () => {
    expect((await api.get('/health/live')).body).toEqual({ status: 'ok' });
    expect((await api.get('/health/ready')).body).toEqual({ status: 'ok', checks: { database: 'up', sqs: 'up' } });
    const metrics = await (await fetch(`${ctx.baseUrl}/metrics`)).text();
    for (const name of ['wager_transactions_total', 'duplicates_detected_total', 'processing_duration_seconds', 'outbox_lag_seconds', 'dlq_depth']) {
      expect(metrics).toContain(name);
    }
  });
});
