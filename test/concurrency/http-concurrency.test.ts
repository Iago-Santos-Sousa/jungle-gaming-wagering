import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { apiClient, brl, createWallet, expectLedgerConsistent, newId, submitWager, wagerBody, type ApiClient } from '../support/api-client';
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

describe('concorrência real (requisições simultâneas)', () => {
  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await createWallet(api, '100.00');
    const body = wagerBody({ ...wallet, amount: '10.00' });
    const responses = await Promise.all(Array.from({ length: 50 }, () => submitWager(api, body)));

    const created = responses.filter((r) => r.status === 201);
    const replays = responses.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(replays.every((r) => r.body.idempotentReplay && r.body.balance?.amount === '90.00')).toBe(true);
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '90.00', debits: 1, version: 2 });
  });

  test('saldo 100.00 e duas apostas de 80.00 simultâneas: uma PROCESSED, outra REJECTED, saldo 20.00 e um débito', async () => {
    const wallet = await createWallet(api, '100.00');
    const bodies = [wagerBody({ ...wallet, amount: '80.00' }), wagerBody({ ...wallet, amount: '80.00' })];
    const first = await Promise.all(bodies.map((body) => submitWager(api, body)));
    const outcomes = first.map((r) => `${r.status}:${r.body.status}:${r.body.failureCode ?? ''}`).sort();
    expect(outcomes).toEqual(['201:PROCESSED:', '422:REJECTED:INSUFFICIENT_FUNDS']);

    const retries = await Promise.all([...bodies, ...bodies].map((body) => submitWager(api, body)));
    expect(retries.every((r) => r.body.idempotentReplay)).toBe(true);
    expect(retries.map((r) => r.status).sort()).toEqual([200, 200, 422, 422]);
    const state = await expectLedgerConsistent(em, wallet.walletId);
    expect(state).toMatchObject({ balance: '20.00', debits: 1 });
  });

  test('muitas apostas disputando o mesmo saldo nunca deixam saldo negativo', async () => {
    const wallet = await createWallet(api, '100.00');
    const responses = await Promise.all(Array.from({ length: 40 }, () => submitWager(api, wagerBody({ ...wallet, amount: '7.00' }))));
    const processed = responses.filter((r) => r.body.status === 'PROCESSED').length;
    const rejected = responses.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS').length;
    expect(processed).toBe(14);
    expect(rejected).toBe(26);
    expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '2.00', debits: 14 });
  });

  test('wallets distintas processadas em paralelo permanecem consistentes', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(api, '50.00')));
    await Promise.all(
      wallets.flatMap((wallet) => [
        ...Array.from({ length: 5 }, () => submitWager(api, wagerBody({ ...wallet, amount: '3.00' }))),
        ...Array.from({ length: 3 }, () => submitWager(api, wagerBody({ ...wallet, kind: 'WIN', amount: '2.50' }))),
      ]),
    );
    for (const wallet of wallets) {
      expect(await expectLedgerConsistent(em, wallet.walletId)).toMatchObject({ balance: '42.50', entries: 9 });
    }
  });

  test('três processos independentes sobre a mesma wallet: sem perda de atualização e sem débito duplicado', async () => {
    const wallet = await createWallet(api, '1000.00');
    const sharedIds = Array.from({ length: 10 }, () => `shared-${newId()}`);
    const uniquePerInstance = 20;

    const children = ['1', '2', '3'].map((instance) =>
      Bun.spawn([process.execPath, 'test/support/instance-process.ts'], {
        env: { ...process.env, WALLET_ID: wallet.walletId, PLAYER_ID: wallet.playerId, UNIQUE_COUNT: String(uniquePerInstance), SHARED_IDS: sharedIds.join(','), INSTANCE: instance },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
      }),
    );

    const readers = children.map((child) => child.stdout.getReader());
    const outputs = children.map(() => '');
    const decoder = new TextDecoder();
    async function readUntil(index: number, marker: string): Promise<void> {
      while (!outputs[index]!.includes(marker)) {
        const { value, done } = await readers[index]!.read();
        if (done) throw new Error(`instance ${index + 1} exited before ${marker}`);
        outputs[index] += decoder.decode(value);
      }
    }

    // Barreira: todas as instâncias sobem e só então disparam ao mesmo tempo
    await Promise.all(children.map((_, i) => readUntil(i, 'READY')));
    for (const child of children) {
      child.stdin.write('go\n');
      await child.stdin.flush();
    }
    await Promise.all(children.map((_, i) => readUntil(i, '"statuses"')));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0]);

    const results = outputs.map((output) => JSON.parse(output.split('\n').find((line) => line.includes('"statuses"'))!) as { statuses: Record<string, number> });
    const total = (status: string) => results.reduce((sum, r) => sum + (r.statuses[status] ?? 0), 0);
    // 60 apostas únicas + 10 compartilhadas aplicadas uma vez; as outras 20 entregas são replays
    expect(total('201')).toBe(70);
    expect(total('200')).toBe(20);

    const state = await expectLedgerConsistent(em, wallet.walletId);
    expect(state).toMatchObject({ balance: '930.00', debits: 70, version: 71 });
  }, 120_000);
});

describe('saldo final reconstruído pelo ledger', () => {
  test('reconciliação de todas as wallets do teste é consistente', async () => {
    const rows = await em.fork().execute<{ id: string }[]>(`select id from wallets`);
    for (const { id } of rows) {
      const response = await api.post<{ consistent: boolean; difference: unknown }>(`/wallets/${id}/reconciliation`);
      if (!response.body.consistent) {
        // Única divergência esperada é a provocada de propósito no teste de reconciliação
        expect(response.body.difference).toEqual(brl('-10.00'));
      }
    }
  });
});
