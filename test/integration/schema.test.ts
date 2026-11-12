import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EntityManager } from "@mikro-orm/postgresql";
import { DuplicateTransactionError } from "../../src/application/errors";
import { UnitOfWork } from "../../src/application/ports/repositories";
import { Money } from "../../src/domain/money/money";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/domain/wager-transaction/wager-transaction";
import { startTestApp, type TestApp } from "../support/test-app";

let ctx: TestApp;
let em: EntityManager;

const uuid = () => Bun.randomUUIDv7();

async function insertWallet(
  id: string,
  balance = "0.00",
  version = 1,
  currency = "BRL",
): Promise<void> {
  await em.execute(
    `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) values (?, ?, ?, ?, ?, now(), now())`,
    [id, uuid(), currency, balance, version],
  );
}

async function insertTransaction(
  id: string,
  walletId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const row = {
    id,
    provider_id: "provider-a",
    external_transaction_id: `ext-${id}`,
    idempotency_key: `provider-a:ext-${id}`,
    payload_hash: "a".repeat(64),
    wallet_id: walletId,
    player_id: uuid(),
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    status: "PENDING",
    amount: "10.00",
    currency: "BRL",
    ...overrides,
  };
  const columns = Object.keys(row);
  await em.execute(
    `insert into wager_transactions (${columns.join(", ")}, created_at) values (${columns.map(() => "?").join(", ")}, now())`,
    Object.values(row),
  );
}

beforeAll(async () => {
  ctx = await startTestApp();
  em = ctx.orm.em.fork();
});

afterAll(async () => {
  await ctx?.close();
});

describe("migrations", () => {
  test("são reversíveis: down remove o schema e up recria", async () => {
    const migrator = ctx.orm.migrator;
    const count = async (sql: string) =>
      (await em.execute<{ n: number }[]>(sql))[0]?.n;
    const headColumn = `select count(*)::int as n from information_schema.columns where table_name = 'outbox_messages' and column_name = 'is_head'`;
    const index = (name: string) =>
      `select count(*)::int as n from pg_indexes where indexname = '${name}'`;
    expect(await count(headColumn)).toBe(1);
    expect(await count(index("outbox_messages_due_head_idx"))).toBe(1);
    expect(await count(index("outbox_messages_due_idx"))).toBe(0);
    // Desfaz a flag de cabeça: coluna e índice somem, e o índice de vencidas volta
    await migrator.down();
    expect(await count(headColumn)).toBe(0);
    expect(await count(index("outbox_messages_due_head_idx"))).toBe(0);
    expect(await count(index("outbox_messages_due_idx"))).toBe(1);
    const sequenceUnique = `select count(*)::int as n from pg_constraint where conname = 'outbox_messages_sequence_uq'`;
    expect((await em.execute<{ n: number }[]>(sequenceUnique))[0]?.n).toBe(0);
    // Desfaz a remoção do UNIQUE redundante: a constraint volta
    await migrator.down();
    expect((await em.execute<{ n: number }[]>(sequenceUnique))[0]?.n).toBe(1);
    // Desfaz a sequência: a coluna some e a tabela continua
    await migrator.down();
    const sequenceColumn = `select count(*)::int as n from information_schema.columns where table_name = 'outbox_messages' and column_name = 'sequence'`;
    expect((await em.execute<{ n: number }[]>(sequenceColumn))[0]?.n).toBe(0);
    await migrator.down({ to: 0 });
    const afterDown = await em.execute(
      `select to_regclass('public.wallets') as t`,
    );
    expect(afterDown[0]?.t).toBeNull();
    await migrator.up();
    expect((await em.execute<{ n: number }[]>(sequenceColumn))[0]?.n).toBe(1);
    expect((await em.execute<{ n: number }[]>(sequenceUnique))[0]?.n).toBe(0);
    expect(await count(headColumn)).toBe(1);
    const tables = await em.execute<{ table_name: string }[]>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      "inbox_messages",
      "outbox_messages",
      "wager_transactions",
      "wallet_ledger_entries",
      "wallets",
    ]);
  });
});

describe("constraints de wallets", () => {
  test("rejeita saldo negativo", async () => {
    await expect(insertWallet(uuid(), "-1.00")).rejects.toThrow(
      /wallets_balance_non_negative_ck/,
    );
  });

  test("no máximo uma wallet por playerId + currency", async () => {
    const playerId = uuid();
    const sql = `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) values (?, ?, 'BRL', 0, 1, now(), now())`;
    await em.execute(sql, [uuid(), playerId]);
    await expect(em.execute(sql, [uuid(), playerId])).rejects.toThrow(
      /wallets_player_currency_uq/,
    );
  });

  test("saldo diferente de zero sem lançamento correspondente falha no commit", async () => {
    await expect(
      em
        .fork()
        .transactional((tx) =>
          tx.execute(
            `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) values (?, ?, 'BRL', 50, 1, now(), now())`,
            [uuid(), uuid()],
          ),
        ),
    ).rejects.toThrow(/no matching ledger entry/);
  });

  test("alteração de saldo exige incremento de version", async () => {
    const id = uuid();
    await insertWallet(id);
    await expect(
      em.execute(`update wallets set balance_amount = 10 where id = ?`, [id]),
    ).rejects.toThrow(/must increment version/);
    await expect(
      em.execute(`update wallets set version = 2 where id = ?`, [id]),
    ).rejects.toThrow(/version only changes/);
  });

  test("wallet não pode ser excluída", async () => {
    const id = uuid();
    await insertWallet(id);
    await expect(
      em.execute(`delete from wallets where id = ?`, [id]),
    ).rejects.toThrow(/cannot be deleted/);
  });
});

describe("constraints de wager_transactions", () => {
  test("idempotency key e (provider, externalTransactionId) são únicos", async () => {
    const walletId = uuid();
    await insertWallet(walletId);
    await insertTransaction(uuid(), walletId, {
      idempotency_key: "dup-key",
      external_transaction_id: "e1",
    });
    await expect(
      insertTransaction(uuid(), walletId, {
        idempotency_key: "dup-key",
        external_transaction_id: "e2",
      }),
    ).rejects.toThrow(/wager_transactions_idempotency_key_uq/);
    await expect(
      insertTransaction(uuid(), walletId, {
        idempotency_key: "other-key",
        external_transaction_id: "e1",
      }),
    ).rejects.toThrow(/wager_transactions_provider_external_uq/);
  });

  test("REFUND e ROLLBACK exigem referência; REJECTED exige failure_code", async () => {
    const walletId = uuid();
    await insertWallet(walletId);
    await expect(
      insertTransaction(uuid(), walletId, { kind: "REFUND" }),
    ).rejects.toThrow(/reference_required_ck/);
    await expect(
      insertTransaction(uuid(), walletId, { status: "REJECTED" }),
    ).rejects.toThrow(/failure_code_ck/);
    await expect(
      insertTransaction(uuid(), walletId, { kind: "BET", amount: "0.00" }),
    ).rejects.toThrow(/amount_ck/);
  });

  test("estado terminal é imutável e exclusão é proibida", async () => {
    const walletId = uuid();
    const id = uuid();
    await insertWallet(walletId);
    await insertTransaction(id, walletId, {
      status: "REJECTED",
      failure_code: "INSUFFICIENT_FUNDS",
    });
    await expect(
      em.execute(
        `update wager_transactions set status = 'PROCESSED' where id = ?`,
        [id],
      ),
    ).rejects.toThrow(/is terminal/);
    await expect(
      em.execute(`delete from wager_transactions where id = ?`, [id]),
    ).rejects.toThrow(/cannot be deleted/);
  });

  test("uma referência só pode ter uma reversão PROCESSED", async () => {
    const walletId = uuid();
    const betId = uuid();
    await insertWallet(walletId);
    await insertTransaction(betId, walletId);
    const reversal = (kind: string) =>
      insertTransaction(uuid(), walletId, {
        kind,
        status: "PROCESSED",
        reference_external_transaction_id: `ext-${betId}`,
        reference_transaction_id: betId,
        result_balance_amount: "10.00",
        result_balance_currency: "BRL",
        processed_at: new Date(),
      });
    await reversal("REFUND");
    await expect(reversal("ROLLBACK")).rejects.toThrow(
      /wager_transactions_single_reversal_uq/,
    );
  });
});

describe("constraints de wallet_ledger_entries", () => {
  async function ledgerFixture() {
    const walletId = uuid();
    const transactionId = uuid();
    await insertWallet(walletId);
    await insertTransaction(transactionId, walletId);
    return { walletId, transactionId };
  }

  const insertEntry = (
    walletId: string,
    transactionId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const row = {
      id: uuid(),
      wallet_id: walletId,
      transaction_id: transactionId,
      wallet_version: 2,
      direction: "CREDIT",
      amount: "10.00",
      balance_before: "0.00",
      balance_after: "10.00",
      currency: "BRL",
      ...overrides,
    };
    const columns = Object.keys(row);
    return em.execute(
      `insert into wallet_ledger_entries (${columns.join(", ")}, created_at) values (${columns.map(() => "?").join(", ")}, now())`,
      Object.values(row),
    );
  };

  test("aritmética do lançamento é verificada no banco", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    await expect(
      insertEntry(walletId, transactionId, { balance_after: "11.00" }),
    ).rejects.toThrow(/arithmetic_ck/);
    await expect(
      insertEntry(walletId, transactionId, {
        direction: "DEBIT",
        balance_before: "5.00",
        balance_after: "-5.00",
      }),
    ).rejects.toThrow(/balances_ck|arithmetic_ck/);
  });

  test("moeda do lançamento deve ser a da wallet", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    await expect(
      insertEntry(walletId, transactionId, { currency: "USD" }),
    ).rejects.toThrow(/wallet_ledger_entries_wallet_fk/);
  });

  test("um lançamento por transação e um por versão da wallet", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    await insertEntry(walletId, transactionId);
    await expect(
      insertEntry(walletId, transactionId, { wallet_version: 3 }),
    ).rejects.toThrow(/wallet_ledger_entries_transaction_uq/);
    const other = uuid();
    await insertTransaction(other, walletId);
    await expect(insertEntry(walletId, other)).rejects.toThrow(
      /wallet_ledger_entries_wallet_version_uq/,
    );
  });

  test("ledger é append-only: update, delete e truncate são bloqueados", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    await insertEntry(walletId, transactionId);
    await expect(
      em.execute(
        `update wallet_ledger_entries set amount = 1 where transaction_id = ?`,
        [transactionId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      em.execute(`delete from wallet_ledger_entries where transaction_id = ?`, [
        transactionId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      em.execute(`truncate wallet_ledger_entries cascade`),
    ).rejects.toThrow(/append-only/);
  });
});

describe("insert de transação com unique de idempotência", () => {
  test("corrida na mesma key vira DuplicateTransactionError e a transação externa continua utilizável (savepoint)", async () => {
    const walletId = uuid();
    // Saldo zero: wallet sem ledger é consistente para o trigger de consistência
    await insertWallet(walletId);
    const build = (id: string) =>
      WagerTransaction.create({
        id,
        providerId: "provider-a",
        externalTransactionId: `race-${walletId}`,
        idempotencyKey: `provider-a:race-${walletId}`,
        payloadHash: "a".repeat(64),
        walletId,
        playerId: uuid(),
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        createdAt: new Date(),
      });

    const after = await ctx.app.get(UnitOfWork).transactional(async (scope) => {
      await scope.transactions.insert(build(uuid()));
      await expect(
        scope.transactions.insert(build(uuid())),
      ).rejects.toBeInstanceOf(DuplicateTransactionError);
      // Sem o savepoint, este comando falharia com "current transaction is aborted"
      return scope.transactions.findIdempotencyMatches(
        `provider-a:race-${walletId}`,
        "provider-a",
        `race-${walletId}`,
      );
    });
    expect(after).toHaveLength(1);
  });
});
