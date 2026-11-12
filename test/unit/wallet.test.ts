import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { BalanceLimitExceededError, CurrencyMismatchError, InsufficientFundsError, InvalidArgumentError, UnbalancedLedgerEntryError } from '../../src/domain/shared/domain-error';
import { Wallet } from '../../src/domain/wallet/wallet';
import { NOW, PLAYER_ID, WALLET_ID, brl, openWallet } from '../support/domain-builders';

describe('Wallet', () => {
  test('abre com version 1 e saldo inicial', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
  });

  test('saldo inicial positivo gera movimentação de abertura sem mudar version', () => {
    const wallet = openWallet('1000.00');
    const opening = wallet.openingMovement();
    expect(opening).toMatchObject({ direction: LedgerDirection.Credit, walletVersion: 1 });
    expect(opening?.balanceBefore.toString()).toBe('0.00');
    expect(opening?.balanceAfter.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
  });

  test('saldo inicial zero não gera abertura', () => {
    expect(openWallet('0.00').openingMovement()).toBeUndefined();
  });

  test('crédito que passaria do limite armazenável é recusado sem mudar saldo nem version', () => {
    const wallet = openWallet('999999999999999999.00');
    expect(() => wallet.credit(brl('1.00'), NOW)).toThrow(BalanceLimitExceededError);
    expect(wallet.balance.toString()).toBe('999999999999999999.00');
    expect(wallet.version).toBe(1);
    // Ainda cabe: o maior valor de numeric(20,2)
    expect(wallet.credit(brl('0.99'), NOW).balanceAfter.toString()).toBe('999999999999999999.99');
  });

  test('débito e crédito incrementam version somente quando o saldo muda', () => {
    const wallet = openWallet('100.00');
    const debit = wallet.debit(brl('80.00'), NOW);
    expect(debit).toMatchObject({ direction: LedgerDirection.Debit, walletVersion: 2 });
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('20.00');
    wallet.credit(brl('5.00'), NOW);
    expect(wallet.version).toBe(3);
    expect(wallet.balance.toString()).toBe('25.00');
  });

  test('saldo nunca fica negativo e falha não altera estado', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('100.01'), NOW)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('débito do saldo exato zera a wallet', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('100.00'), NOW);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejeita movimentação em moeda diferente', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(Money.from({ amount: '1.00', currency: 'USD' }), NOW)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rejeita movimentação de valor zero', () => {
    expect(() => openWallet('100.00').credit(brl('0.00'), NOW)).toThrow(InvalidArgumentError);
  });

  test('rehydrate reconstrói estado sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('10.00'),
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('10.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'entry-1',
    walletId: WALLET_ID,
    transactionId: 'tx-1',
    walletVersion: 2,
    createdAt: NOW,
  };

  test('valida aritmética do débito e do crédito', () => {
    const debit = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('80.00'), balanceBefore: brl('100.00'), balanceAfter: brl('20.00') });
    expect(debit.isBalanced()).toBe(true);
    expect(debit.signedAmount().toString()).toBe('-80.00');
    const credit = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('5.00'), balanceBefore: brl('20.00'), balanceAfter: brl('25.00') });
    expect(credit.signedAmount().toString()).toBe('5.00');
  });

  test('rejeita lançamento desbalanceado', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('80.00'), balanceBefore: brl('100.00'), balanceAfter: brl('30.00') }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejeita valor zero e saldo final negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('0.00'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00') }),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('2.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00').subtract(brl('2.00')),
      }),
    ).toThrow(InvalidArgumentError);
  });

  test('não expõe campos mutáveis nem métodos de transição', () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('5.00'), balanceBefore: brl('0.00'), balanceAfter: brl('5.00') });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['isBalanced', 'signedAmount']);
  });
});
