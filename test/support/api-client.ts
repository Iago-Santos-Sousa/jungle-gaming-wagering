import { expect } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export function apiClient(baseUrl: string) {
  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, headers: response.headers };
  }
  return {
    get: <T = Record<string, unknown>>(path: string) => request<T>('GET', path),
    post: <T = Record<string, unknown>>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', path, body, headers),
  };
}

export type ApiClient = ReturnType<typeof apiClient>;

export const newId = (): string => Bun.randomUUIDv7();

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export async function createWallet(api: ApiClient, amount = '100.00', playerId = newId()): Promise<{ walletId: string; playerId: string }> {
  const response = await api.post<{ id: string }>('/wallets', { playerId, initialBalance: brl(amount) });
  expect(response.status).toBe(201);
  return { walletId: response.body.id, playerId };
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind?: string;
  amount?: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
  currency?: string;
}

export function wagerBody(input: WagerInput) {
  return {
    providerId: input.providerId ?? 'provider-a',
    externalTransactionId: input.externalTransactionId ?? `tx-${newId()}`,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: input.kind ?? 'BET',
    money: { amount: input.amount ?? '10.00', currency: input.currency ?? 'BRL' },
    ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
  };
}

export interface WagerResult {
  transactionId: string | null;
  status: string;
  balance: { amount: string; currency: string } | null;
  failureCode?: string;
  idempotentReplay: boolean;
  // Presentes nas respostas de erro (400, 404, 409, 500, 503)
  code?: string;
  details?: string[];
}

export function submitWager(api: ApiClient, body: ReturnType<typeof wagerBody>, idempotencyKey = `${body.providerId}:${body.externalTransactionId}`) {
  return api.post<WagerResult>('/wagering/transactions', body, { 'Idempotency-Key': idempotencyKey });
}

export interface WalletState {
  balance: string;
  version: number;
  ledgerSum: string;
  lastBalanceAfter: string | null;
  entries: number;
  debits: number;
  credits: number;
}

// Estado da wallet lido direto do banco, para verificar a invariante wallet.balance == saldo reconstruído pelo ledger
export async function readWalletState(em: EntityManager, walletId: string): Promise<WalletState> {
  const rows = await em.fork().execute<
    { balance: string; version: number; ledger_sum: string; last_balance_after: string | null; entries: string; debits: string; credits: string }[]
  >(
    `select w.balance_amount::text as balance, w.version,
            coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)::numeric(22,2)::text as ledger_sum,
            (select balance_after::text from wallet_ledger_entries where wallet_id = w.id order by wallet_version desc limit 1) as last_balance_after,
            count(e.id) as entries,
            count(e.id) filter (where e.direction = 'DEBIT') as debits,
            count(e.id) filter (where e.direction = 'CREDIT') as credits
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  const row = rows[0];
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return {
    balance: row.balance,
    version: row.version,
    ledgerSum: row.ledger_sum,
    lastBalanceAfter: row.last_balance_after,
    entries: Number(row.entries),
    debits: Number(row.debits),
    credits: Number(row.credits),
  };
}

export async function expectLedgerConsistent(em: EntityManager, walletId: string): Promise<WalletState> {
  const state = await readWalletState(em, walletId);
  expect(state.ledgerSum).toBe(state.balance);
  if (state.entries > 0) expect(state.lastBalanceAfter).toBe(state.balance);
  return state;
}
