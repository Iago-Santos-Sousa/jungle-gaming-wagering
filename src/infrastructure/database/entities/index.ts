import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

// Registros de persistência. O domínio nunca os enxerga: os repositórios mapeiam para as entidades de domínio.
// O schema real (constraints, índices e triggers) é definido nas migrations.

export const WalletRecord = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().columnType("char(3)"),
    balanceAmount: p.decimal().columnType("numeric(20,2)"),
    version: p.integer(),
    createdAt: p.datetime().columnType("timestamptz"),
    updatedAt: p.datetime().columnType("timestamptz"),
  },
});
export type WalletRow = InferEntity<typeof WalletRecord>;

export const WagerTransactionRecord = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().length(64),
    externalTransactionId: p.string().length(128),
    idempotencyKey: p.string().length(255),
    payloadHash: p.string().columnType("char(64)"),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.string().length(128).nullable(),
    gameId: p.string().length(128).nullable(),
    kind: p.string().length(16),
    status: p.string().length(24),
    amount: p.decimal().columnType("numeric(20,2)"),
    currency: p.string().columnType("char(3)"),
    referenceExternalTransactionId: p.string().length(128).nullable(),
    referenceTransactionId: p.uuid().nullable(),
    failureCode: p.string().length(64).nullable(),
    resultBalanceAmount: p.decimal().columnType("numeric(20,2)").nullable(),
    resultBalanceCurrency: p.string().columnType("char(3)").nullable(),
    referenceAttempts: p.integer(),
    nextAttemptAt: p.datetime().columnType("timestamptz").nullable(),
    createdAt: p.datetime().columnType("timestamptz"),
    processedAt: p.datetime().columnType("timestamptz").nullable(),
  },
});
export type WagerTransactionRow = InferEntity<typeof WagerTransactionRecord>;

export const LedgerEntryRecord = defineEntity({
  name: "LedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    walletVersion: p.integer(),
    direction: p.string().length(6),
    amount: p.decimal().columnType("numeric(20,2)"),
    balanceBefore: p.decimal().columnType("numeric(20,2)"),
    balanceAfter: p.decimal().columnType("numeric(20,2)"),
    currency: p.string().columnType("char(3)"),
    createdAt: p.datetime().columnType("timestamptz"),
  },
});
export type LedgerEntryRow = InferEntity<typeof LedgerEntryRecord>;

export const InboxMessageRecord = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.string().length(128).primary(),
    messageId: p.string().length(255).primary(),
    payloadHash: p.string().columnType("char(64)"),
    receivedAt: p.datetime().columnType("timestamptz"),
    processedAt: p.datetime().columnType("timestamptz").nullable(),
  },
  primaryKeys: ["consumerName", "messageId"],
});
export type InboxMessageRow = InferEntity<typeof InboxMessageRecord>;

export const OutboxMessageRecord = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.string().length(64),
    payload: p.json<Record<string, unknown>>().columnType("jsonb"),
    occurredAt: p.datetime().columnType("timestamptz"),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType("timestamptz"),
    lockedUntil: p.datetime().columnType("timestamptz").nullable(),
    publishedAt: p.datetime().columnType("timestamptz").nullable(),
    lastError: p.string().length(512).nullable(),
    // Pendente de menor sequence do agregado; mantida pelo repositório da outbox sob advisory lock
    isHead: p.boolean(),
  },
});
export type OutboxMessageRow = InferEntity<typeof OutboxMessageRecord>;

export const persistenceEntities = [
  WalletRecord,
  WagerTransactionRecord,
  LedgerEntryRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
];
