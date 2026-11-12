import type { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wager-transaction/failure-code';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { LedgerEntryRow, OutboxMessageRow, WagerTransactionRow, WalletRow } from './entities';


const money = (amount: string, currency: string): Money => Money.rehydrate({ amount, currency: currency.trim() });

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency.trim(),
    balance: money(row.balanceAmount, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function fromWallet(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceAmount: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  const resultBalance =
    row.resultBalanceAmount !== null && row.resultBalanceAmount !== undefined && row.resultBalanceCurrency
      ? money(row.resultBalanceAmount, row.resultBalanceCurrency)
      : undefined;
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId ?? undefined,
    gameId: row.gameId ?? undefined,
    kind: row.kind as WagerTransactionKind,
    money: money(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: row.processedAt ?? undefined,
    resultBalance,
    referenceAttempts: row.referenceAttempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
  });
}

export function fromWagerTransaction(transaction: WagerTransaction): WagerTransactionRow {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    status: transaction.status,
    amount: transaction.money.toString(),
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    resultBalanceAmount: transaction.resultBalance?.toString() ?? null,
    resultBalanceCurrency: transaction.resultBalance?.currency ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

export function toLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: money(row.amount, row.currency),
    balanceBefore: money(row.balanceBefore, row.currency),
    balanceAfter: money(row.balanceAfter, row.currency),
    walletVersion: row.walletVersion,
    createdAt: row.createdAt,
  });
}

export function fromLedgerEntry(entry: WalletLedgerEntry): LedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: entry.money.toString(),
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    currency: entry.money.currency,
    createdAt: entry.createdAt,
  };
}

export function toOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    publishedAt: row.publishedAt ?? undefined,
  });
}

// isHead é decidido pelo repositório no insert (depende das pendentes do agregado no banco)
export function fromOutboxMessage(message: OutboxMessage, isHead = false): OutboxMessageRow {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    // Sem agendamento explícito, a mensagem já nasce vencida
    nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
    lockedUntil: null,
    publishedAt: message.publishedAt ?? null,
    lastError: null,
    isHead,
  };
}
