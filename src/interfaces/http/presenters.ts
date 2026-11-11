import type { LedgerPage, ReconciliationReport } from '../../application/use-cases/wallet-use-cases';
import type { WagerOutcome } from '../../application/use-cases/wager-use-cases';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { LedgerEntryResponse, LedgerPageResponse, ReconciliationResponse, WalletResponse } from './dto/wallet.dto';
import type { WagerTransactionResponse, WagerTransactionResultResponse } from './dto/wager.dto';

// Serialização de saída: dinheiro como MoneyProps e datas em ISO-8601 UTC

export function presentWallet(wallet: Wallet): WalletResponse {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

function presentLedgerEntry(entry: WalletLedgerEntry): LedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentLedgerPage(page: LedgerPage): LedgerPageResponse {
  return { items: page.items.map(presentLedgerEntry), nextCursor: page.nextCursor };
}

export function presentReconciliation(report: ReconciliationReport): ReconciliationResponse {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
  };
}

export function presentOutcome(outcome: WagerOutcome): WagerTransactionResultResponse {
  return {
    transactionId: outcome.transactionId,
    status: outcome.status,
    balance: outcome.balance?.toJSON() ?? null,
    ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
    idempotentReplay: outcome.idempotentReplay,
  };
}

export function presentTransaction(transaction: WagerTransaction): WagerTransactionResponse {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balance: transaction.resultBalance?.toJSON() ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
