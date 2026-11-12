import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { BalanceLimitExceededError, InsufficientFundsError } from '../shared/domain-error';
import type { RetryPolicy } from '../shared/retry-policy';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';

export interface SettlementInput {
  transaction: WagerTransaction;
  // Wallet já travada pela camada de aplicação
  wallet: Wallet;
  // Resultado da busca por (providerId, referenceExternalTransactionId); null se ausente
  reference: WagerTransaction | null;
  // Se a referência já possui uma reversão PROCESSED
  referenceAlreadyReversed: boolean;
  referencePolicy: RetryPolicy;
  now: Date;
  newLedgerEntryId: () => string;
}

export interface SettlementResult {
  ledgerEntry?: WalletLedgerEntry;
}

// Regras de negócio de BET, WIN, LOSS, REFUND e ROLLBACK, sem I/O.
// Muta a transação e a wallet recebidas e devolve o lançamento quando o saldo muda.
export function settleWagerTransaction(input: SettlementInput): SettlementResult {
  const { transaction, wallet, now } = input;

  if (transaction.playerId !== wallet.playerId) {
    transaction.reject(FailureCode.WalletPlayerMismatch, now, wallet.balance);
    return {};
  }
  if (transaction.money.currency !== wallet.currency) {
    transaction.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
    return {};
  }

  let reference: WagerTransaction | undefined;
  if (transaction.referenceExternalTransactionId) {
    const check = transaction.checkReference(input.reference);
    if (check.outcome === 'missing') {
      deferForReference(input);
      return {};
    }
    if (check.outcome === 'invalid') {
      transaction.reject(check.failureCode, now, wallet.balance);
      return {};
    }
    if (transaction.isReversal() && input.referenceAlreadyReversed) {
      transaction.reject(FailureCode.ReferenceAlreadyReversed, now, wallet.balance);
      return {};
    }
    reference = check.reference;
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, now, wallet.balance);
    return {};
  }

  const direction = transaction.ledgerDirectionFor(reference);
  try {
    const movement = wallet.apply(direction, transaction.money, now);
    transaction.markProcessed(reference?.id, now, movement.balanceAfter);
    return {
      ledgerEntry: WalletLedgerEntry.fromMovement({
        id: input.newLedgerEntryId(),
        walletId: wallet.id,
        transactionId: transaction.id,
        movement,
        createdAt: now,
      }),
    };
  } catch (error) {
    if (error instanceof BalanceLimitExceededError) {
      transaction.reject(FailureCode.BalanceLimitExceeded, now, wallet.balance);
      return {};
    }
    if (!(error instanceof InsufficientFundsError)) throw error;
    // Reversão sem saldo é operacionalmente diferente de aposta sem saldo
    const code = transaction.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
    transaction.reject(code, now, wallet.balance);
    return {};
  }
}

// Referência ausente: agenda nova tentativa com backoff ou rejeita ao esgotar o limite
function deferForReference({ transaction, wallet, referencePolicy, now }: SettlementInput): void {
  const attempt = transaction.referenceAttempts + 1;
  if (referencePolicy.isExhausted(attempt)) {
    transaction.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
    return;
  }
  transaction.markPendingReference(referencePolicy.nextAttemptAt(now, attempt), wallet.balance);
}
