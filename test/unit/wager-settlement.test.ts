import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wager-transaction/failure-code';
import { settleWagerTransaction } from '../../src/domain/wager-transaction/wager-settlement';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../../src/domain/wager-transaction/wager-transaction';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { NOW, brl, buildTransaction, nextId, openWallet, processedTransaction, referencePolicy } from '../support/domain-builders';

function settle(transaction: WagerTransaction, wallet: Wallet, reference: WagerTransaction | null = null, referenceAlreadyReversed = false) {
  return settleWagerTransaction({ transaction, wallet, reference, referenceAlreadyReversed, referencePolicy, now: NOW, newLedgerEntryId: nextId });
}

describe('settleWagerTransaction', () => {
  describe('BET', () => {
    test('debita e gera 1 lançamento DEBIT', () => {
      const wallet = openWallet('1000.00');
      const bet = buildTransaction({ money: brl('25.00') });
      const { ledgerEntry } = settle(bet, wallet);
      expect(bet.status).toBe(WagerTransactionStatus.Processed);
      expect(bet.resultBalance?.toString()).toBe('975.00');
      expect(wallet.balance.toString()).toBe('975.00');
      expect(wallet.version).toBe(2);
      expect(ledgerEntry).toMatchObject({ direction: LedgerDirection.Debit, transactionId: bet.id, walletVersion: 2 });
    });

    test('saldo insuficiente rejeita com INSUFFICIENT_FUNDS sem ledger nem alteração de saldo', () => {
      const wallet = openWallet('100.00');
      settle(buildTransaction({ money: brl('80.00') }), wallet);
      const second = buildTransaction({ money: brl('80.00') });
      const { ledgerEntry } = settle(second, wallet);
      expect(second.status).toBe(WagerTransactionStatus.Rejected);
      expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(ledgerEntry).toBeUndefined();
      expect(wallet.balance.toString()).toBe('20.00');
      expect(wallet.version).toBe(2);
    });
  });

  describe('WIN', () => {
    test('credita sem referência', () => {
      const wallet = openWallet('10.00');
      const { ledgerEntry } = settle(buildTransaction({ kind: WagerTransactionKind.Win, money: brl('50.00') }), wallet);
      expect(wallet.balance.toString()).toBe('60.00');
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    });

    test('pode referenciar a BET da mesma rodada', () => {
      const wallet = openWallet('10.00');
      const bet = processedTransaction({ externalTransactionId: 'bet-1' });
      const win = buildTransaction({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'bet-1', money: brl('99.00') });
      settle(win, wallet, bet);
      expect(win.status).toBe(WagerTransactionStatus.Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
    });
  });

  describe('LOSS', () => {
    test('registra resultado sem mover saldo e sem ledger', () => {
      const wallet = openWallet('10.00');
      const loss = buildTransaction({ kind: WagerTransactionKind.Loss, money: brl('25.00') });
      const { ledgerEntry } = settle(loss, wallet);
      expect(loss.status).toBe(WagerTransactionStatus.Processed);
      expect(ledgerEntry).toBeUndefined();
      expect(wallet.balance.toString()).toBe('10.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    test('credita o valor da BET referenciada', () => {
      const wallet = openWallet('75.00');
      const bet = processedTransaction({ externalTransactionId: 'bet-1' });
      const refund = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
      const { ledgerEntry } = settle(refund, wallet, bet);
      expect(refund.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    });

    test('referência já revertida é rejeitada', () => {
      const wallet = openWallet('75.00');
      const refund = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
      settle(refund, wallet, processedTransaction({ externalTransactionId: 'bet-1' }), true);
      expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expect(wallet.balance.toString()).toBe('75.00');
    });

    test('referência ausente vira PENDING_REFERENCE com backoff', () => {
      const wallet = openWallet('75.00');
      const refund = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
      settle(refund, wallet, null);
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      expect(refund.referenceAttempts).toBe(1);
      expect(refund.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1_000);
    });

    test('esgotado o limite de tentativas vira REJECTED com REFERENCE_NOT_FOUND', () => {
      const wallet = openWallet('75.00');
      const refund = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
      for (let attempt = 1; attempt < referencePolicy.maxAttempts; attempt++) settle(refund, wallet, null);
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      settle(refund, wallet, null);
      expect(refund.status).toBe(WagerTransactionStatus.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    });
  });

  describe('ROLLBACK', () => {
    test('de BET credita', () => {
      const wallet = openWallet('75.00');
      const rollback = buildTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'bet-1' });
      const { ledgerEntry } = settle(rollback, wallet, processedTransaction({ externalTransactionId: 'bet-1' }));
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    test('de WIN debita', () => {
      const wallet = openWallet('100.00');
      const rollback = buildTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'win-1' });
      const { ledgerEntry } = settle(rollback, wallet, processedTransaction({ kind: WagerTransactionKind.Win, externalTransactionId: 'win-1' }));
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toString()).toBe('75.00');
    });

    test('que deixaria saldo negativo é rejeitado com REVERSAL_INSUFFICIENT_FUNDS', () => {
      const wallet = openWallet('10.00');
      const rollback = buildTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'win-1' });
      settle(rollback, wallet, processedTransaction({ kind: WagerTransactionKind.Win, externalTransactionId: 'win-1' }));
      expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
      expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.toString()).toBe('10.00');
    });
  });

  describe('validações contra a wallet', () => {
    test('moeda diferente da wallet é rejeitada com CURRENCY_MISMATCH', () => {
      const wallet = openWallet('100.00');
      const bet = buildTransaction({ money: Money.from({ amount: '10.00', currency: 'USD' }) });
      settle(bet, wallet);
      expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(wallet.version).toBe(1);
    });

    test('player diferente do dono da wallet é rejeitado', () => {
      const wallet = openWallet('100.00');
      const bet = buildTransaction({ playerId: '0192f28f-0000-7000-8000-000000000000' });
      settle(bet, wallet);
      expect(bet.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    });
  });
});
