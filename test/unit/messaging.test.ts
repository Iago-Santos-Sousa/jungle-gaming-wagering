import { describe, expect, test } from 'bun:test';
import { eventsForOutcome, WalletBalanceChanged } from '../../src/domain/events/wagering-events';
import { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { InvalidTransactionStateError } from '../../src/domain/shared/domain-error';
import { RetryPolicy } from '../../src/domain/shared/retry-policy';
import { settleWagerTransaction } from '../../src/domain/wager-transaction/wager-settlement';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction';
import { NOW, brl, buildTransaction, nextId, openWallet, referencePolicy } from '../support/domain-builders';

const ctx = { newEventId: nextId, correlationId: 'corr-1', occurredAt: NOW };

describe('RetryPolicy', () => {
  test('backoff exponencial com teto', () => {
    const policy = new RetryPolicy(1_000, 10_000, 5);
    expect([1, 2, 3, 4, 5, 6].map((attempt) => policy.delayFor(attempt))).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
    expect(policy.delayFor(500)).toBe(10_000);
    expect(policy.isExhausted(4)).toBe(false);
    expect(policy.isExhausted(5)).toBe(true);
  });
});

describe('OutboxMessage', () => {
  test('enqueue usa o eventId como id e serializa o envelope', () => {
    const wallet = openWallet('100.00');
    const bet = buildTransaction();
    const { ledgerEntry } = settleWagerTransaction({ transaction: bet, wallet, reference: null, referenceAlreadyReversed: false, referencePolicy, now: NOW, newLedgerEntryId: nextId });
    const event = WalletBalanceChanged.from(wallet, ledgerEntry!, ctx);
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe(event.eventId);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      occurredAt: NOW.toISOString(),
      data: { balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '75.00', currency: 'BRL' }, walletVersion: 2 },
    });
    expect(message.isDue(NOW)).toBe(true);
  });

  test('scheduleRetry incrementa tentativas e adia; markPublished é final', () => {
    const wallet = openWallet('1.00');
    const entry = WalletLedgerEntry.fromMovement({ id: nextId(), walletId: wallet.id, transactionId: 'tx-opening', movement: wallet.openingMovement()!, createdAt: NOW });
    const message = OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx));
    const policy = new RetryPolicy(1_000, 60_000);
    message.scheduleRetry(NOW, policy);
    message.scheduleRetry(NOW, policy);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 2_000);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 2_000))).toBe(true);
    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(() => message.markPublished(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => message.scheduleRetry(NOW, policy)).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage', () => {
  test('marca processamento uma única vez', () => {
    const inbox = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'c', payloadHash: 'h', receivedAt: NOW });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(NOW)).toThrow(InvalidTransactionStateError);
  });
});

describe('eventsForOutcome', () => {
  const settleWith = (transaction: ReturnType<typeof buildTransaction>, amount = '100.00') => {
    const wallet = openWallet(amount);
    const { ledgerEntry } = settleWagerTransaction({ transaction, wallet, reference: null, referenceAlreadyReversed: false, referencePolicy, now: NOW, newLedgerEntryId: nextId });
    return eventsForOutcome(transaction, wallet, ledgerEntry, ctx).map((event) => event.eventType);
  };

  test('BET aplicada publica Processed e BalanceChanged', () => {
    expect(settleWith(buildTransaction())).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('LOSS publica Processed sem BalanceChanged', () => {
    expect(settleWith(buildTransaction({ kind: WagerTransactionKind.Loss }))).toEqual(['WagerTransactionProcessed']);
  });

  test('rejeição publica Rejected', () => {
    expect(settleWith(buildTransaction({ money: brl('500.00') }))).toEqual(['WagerTransactionRejected']);
  });

  test('referência ausente publica PendingReference', () => {
    expect(settleWith(buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'b' }))).toEqual(['WagerTransactionPendingReference']);
  });
});
