import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { InvalidArgumentError, InvalidTransactionStateError } from '../../src/domain/shared/domain-error';
import { canonicalJson } from '../../src/domain/shared/payload-hash';
import { FailureCode } from '../../src/domain/wager-transaction/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  computeWagerPayloadHash,
  type SubmittableKind,
} from '../../src/domain/wager-transaction/wager-transaction';
import { NOW, brl, buildTransaction, nextId, processedTransaction, wagerPayload } from '../support/domain-builders';

describe('WagerTransaction', () => {
  test('nasce em PENDING', () => {
    expect(buildTransaction().status).toBe(WagerTransactionStatus.Pending);
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('%s exige referenceExternalTransactionId', (kind) => {
    expect(() => buildTransaction({ kind: kind as SubmittableKind })).toThrow(InvalidArgumentError);
    expect(buildTransaction({ kind: kind as SubmittableKind, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('OPENING é interno e não pode ser submetido', () => {
    expect(() => buildTransaction({ kind: WagerTransactionKind.Opening as unknown as SubmittableKind })).toThrow(InvalidArgumentError);
    expect(() => buildTransaction({ providerId: 'internal' })).toThrow(InvalidArgumentError);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => buildTransaction({ money: brl('0.00') })).toThrow(InvalidArgumentError);
    expect(buildTransaction({ kind: WagerTransactionKind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
  });

  test('não pode referenciar a si mesma', () => {
    expect(() => buildTransaction({ externalTransactionId: 'x', referenceExternalTransactionId: 'x', kind: WagerTransactionKind.Refund })).toThrow(InvalidArgumentError);
  });

  describe('transições', () => {
    test('PENDING → PENDING_REFERENCE conta tentativas e depois → PROCESSED', () => {
      const transaction = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
      transaction.markPendingReference(NOW, brl('10.00'));
      transaction.markPendingReference(NOW, brl('10.00'));
      expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
      expect(transaction.referenceAttempts).toBe(2);
      transaction.markProcessed('ref-id', NOW, brl('35.00'));
      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.referenceTransactionId).toBe('ref-id');
      expect(transaction.nextAttemptAt).toBeUndefined();
    });

    test.each([
      ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, NOW, brl('1.00'))],
      ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, NOW)],
      ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.InternalError, NOW)],
    ])('%s é terminal: qualquer transição lança InvalidTransactionStateError', (_, toTerminal) => {
      const transaction = buildTransaction();
      toTerminal(transaction);
      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markProcessed(undefined, NOW, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => transaction.markPendingReference(NOW, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => transaction.reject(FailureCode.InsufficientFunds, NOW)).toThrow(InvalidTransactionStateError);
      expect(() => transaction.fail(FailureCode.InternalError, NOW)).toThrow(InvalidTransactionStateError);
    });
  });

  describe('direção no ledger', () => {
    test('BET debita; WIN e REFUND creditam', () => {
      expect(buildTransaction().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(buildTransaction({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'b' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    test('ROLLBACK inverte a direção da referência', () => {
      const rollback = buildTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'r' });
      expect(rollback.ledgerDirectionFor(processedTransaction())).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(processedTransaction({ kind: WagerTransactionKind.Win }))).toBe(LedgerDirection.Debit);
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidArgumentError);
    });

    test('LOSS não tem direção', () => {
      expect(() => buildTransaction({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(InvalidArgumentError);
    });
  });

  describe('checkReference', () => {
    const refund = (overrides = {}) => buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1', ...overrides });

    test('referência ausente ou ainda pendente equivale a missing', () => {
      expect(refund().checkReference(null).outcome).toBe('missing');
      expect(refund().checkReference(buildTransaction()).outcome).toBe('missing');
    });

    test('referência rejeitada não pode ser revertida', () => {
      const bet = buildTransaction();
      bet.reject(FailureCode.InsufficientFunds, NOW);
      expect(refund().checkReference(bet)).toEqual({ outcome: 'invalid', failureCode: FailureCode.ReferenceNotProcessed });
    });

    test('REFUND só referencia BET; ROLLBACK aceita BET, WIN e REFUND', () => {
      const win = processedTransaction({ kind: WagerTransactionKind.Win });
      expect(refund().checkReference(win)).toEqual({ outcome: 'invalid', failureCode: FailureCode.ReferenceInvalidKind });
      const rollback = buildTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'w' });
      expect(rollback.checkReference(win).outcome).toBe('resolved');
      const loss = processedTransaction({ kind: WagerTransactionKind.Loss });
      expect(rollback.checkReference(loss)).toEqual({ outcome: 'invalid', failureCode: FailureCode.ReferenceInvalidKind });
    });

    test.each([
      ['player', { playerId: '0192f28f-0000-7000-8000-000000000000' }],
      ['wallet', { walletId: '0192f291-0000-7000-8000-000000000000' }],
      ['rodada', { roundId: 'other-round' }],
      ['provider', { providerId: 'provider-b' }],
    ])('referência de outro(a) %s gera REFERENCE_MISMATCH', (_, overrides) => {
      expect(refund().checkReference(processedTransaction(overrides))).toEqual({ outcome: 'invalid', failureCode: FailureCode.ReferenceMismatch });
    });

    test('valor da reversão diferente da referência gera AMOUNT_MISMATCH', () => {
      expect(refund({ money: brl('10.00') }).checkReference(processedTransaction())).toEqual({ outcome: 'invalid', failureCode: FailureCode.AmountMismatch });
    });
  });

  describe('idempotência e payloadHash', () => {
    test('hash é estável e independe da ordem das chaves', () => {
      const payload = wagerPayload({ externalTransactionId: 'transaction-123' });
      const reordered = { ...payload, money: payload.money, kind: payload.kind, providerId: payload.providerId };
      expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(payload));
      expect(computeWagerPayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
      expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    });

    test('mesma key com payload divergente não é reconhecida como replay', () => {
      const original = wagerPayload({ externalTransactionId: 'transaction-123' });
      const transaction = WagerTransaction.create({
        ...original,
        id: nextId(),
        idempotencyKey: 'provider-a:transaction-123',
        payloadHash: computeWagerPayloadHash(original),
        createdAt: NOW,
      });
      expect(transaction.matchesPayload(computeWagerPayloadHash(original))).toBe(true);
      expect(transaction.matchesPayload(computeWagerPayloadHash({ ...original, money: brl('26.00') }))).toBe(false);
      expect(transaction.matchesPayload(computeWagerPayloadHash({ ...original, kind: WagerTransactionKind.Win }))).toBe(false);
    });

    test('valores equivalentes de amount geram o mesmo hash', () => {
      const payload = wagerPayload({ externalTransactionId: 'same' });
      expect(computeWagerPayloadHash({ ...payload, money: brl('25.5') })).toBe(computeWagerPayloadHash({ ...payload, money: brl('25.50') }));
    });
  });
});
