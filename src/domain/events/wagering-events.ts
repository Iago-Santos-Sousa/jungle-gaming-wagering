import type { LedgerDirection } from '../ledger/ledger-direction';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wager-transaction/failure-code';
import { WagerTransactionStatus, type WagerTransaction, type WagerTransactionKind } from '../wager-transaction/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import { IntegrationEvent, type EventContext } from './integration-event';

function baseProps<T>(aggregateId: string, ctx: EventContext, data: T) {
  return {
    eventId: ctx.newEventId(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId: string | null;
  balance: MoneyProps;
}

// Qualquer transação aplicada, inclusive LOSS
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      baseProps(transaction.id, ctx, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId ?? null,
        gameId: transaction.gameId ?? null,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: (transaction.resultBalance ?? wallet.balance).toJSON(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

// Transação rejeitada por regra de negócio
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!transaction.failureCode) throw new Error('Rejected transaction must carry a failure code');
    return new WagerTransactionRejected(
      baseProps(transaction.id, ctx, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

// Somente quando o saldo muda
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      baseProps(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

// Referência ausente: a transação aguarda reprocessamento
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId || !transaction.nextAttemptAt) {
      throw new Error('Pending reference transaction must carry reference id and next attempt');
    }
    return new WagerTransactionPendingReference(
      baseProps(transaction.id, ctx, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        attempts: transaction.referenceAttempts,
        nextAttemptAt: transaction.nextAttemptAt.toISOString(),
      }),
    );
  }
}

// Eventos resultantes de uma decisão sobre a transação.
// PENDING_REFERENCE só publica na primeira vez, para não repetir o evento a cada tentativa.
export function eventsForOutcome(
  transaction: WagerTransaction,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry | undefined,
  ctx: EventContext,
): IntegrationEvent<unknown>[] {
  switch (transaction.status) {
    case WagerTransactionStatus.Processed: {
      const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(transaction, wallet, ctx)];
      if (ledgerEntry) events.push(WalletBalanceChanged.from(wallet, ledgerEntry, ctx));
      return events;
    }
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, ctx)];
    case WagerTransactionStatus.PendingReference:
      return transaction.referenceAttempts === 1 ? [WagerTransactionPendingReference.from(transaction, ctx)] : [];
    default:
      return [];
  }
}
