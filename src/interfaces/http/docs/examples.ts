// Exemplos de payloads e respostas da API usados na documentação Swagger

const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const TRANSACTION_ID = '0192f298-345e-7e38-af88-e43f851a819d';
const CORRELATION_ID = '6f1c2a9e-8b0d-4c55-9a8e-3f2d1b7c4e10';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

const betPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: PLAYER_ID,
  walletId: WALLET_ID,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: brl('25.00'),
};

const error = (code: string, message: string, details?: string[]) => ({ code, message, ...(details ? { details } : {}), correlationId: CORRELATION_ID });

export const WalletExamples = {
  createRequest: {
    withBalance: { summary: 'Wallet com saldo inicial (gera OPENING)', value: { playerId: PLAYER_ID, initialBalance: brl('1000.00') } },
    empty: { summary: 'Wallet sem saldo inicial', value: { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2', initialBalance: brl('0.00') } },
  },
  wallet: { id: WALLET_ID, playerId: PLAYER_ID, balance: brl('1000.00'), version: 1 },
  duplicated: error('WALLET_ALREADY_EXISTS', `Wallet for player ${PLAYER_ID} in BRL already exists`),
  ledgerPage: {
    items: [
      {
        id: '0192f299-0a11-7c3e-9f00-3b1a2c4d5e6f',
        transactionId: TRANSACTION_ID,
        direction: 'DEBIT',
        money: brl('25.00'),
        balanceBefore: brl('1000.00'),
        balanceAfter: brl('975.00'),
        walletVersion: 2,
        createdAt: '2026-07-29T15:00:00.120Z',
      },
      {
        id: '0192f291-27e0-7a10-8c55-1d2e3f4a5b6c',
        transactionId: '0192f291-27df-7b20-9d66-2e3f4a5b6c7d',
        direction: 'CREDIT',
        money: brl('1000.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1000.00'),
        walletVersion: 1,
        createdAt: '2026-07-29T14:59:00.000Z',
      },
    ],
    nextCursor: null,
  },
  reconciliation: {
    walletId: WALLET_ID,
    storedBalance: brl('975.00'),
    calculatedBalance: brl('975.00'),
    difference: brl('0.00'),
    consistent: true,
    checkedEntries: 2,
  },
  invalidCursor: error('VALIDATION_ERROR', 'Invalid pagination cursor', ['cursor: invalid']),
} as const;

export const WagerExamples = {
  submitRequest: {
    bet: { summary: 'BET', value: betPayload },
    win: { summary: 'WIN referenciando a BET', value: { ...betPayload, externalTransactionId: 'transaction-124', kind: 'WIN', money: brl('50.00'), referenceExternalTransactionId: 'transaction-123' } },
    loss: { summary: 'LOSS (sem efeito no saldo)', value: { ...betPayload, externalTransactionId: 'transaction-125', kind: 'LOSS', referenceExternalTransactionId: 'transaction-123' } },
    refund: { summary: 'REFUND da BET', value: { ...betPayload, externalTransactionId: 'transaction-126', kind: 'REFUND', referenceExternalTransactionId: 'transaction-123' } },
    rollback: { summary: 'ROLLBACK da BET', value: { ...betPayload, externalTransactionId: 'transaction-127', kind: 'ROLLBACK', referenceExternalTransactionId: 'transaction-123' } },
  },
  processed: { transactionId: TRANSACTION_ID, status: 'PROCESSED', balance: brl('975.00'), idempotentReplay: false },
  replay: { transactionId: TRANSACTION_ID, status: 'PROCESSED', balance: brl('975.00'), idempotentReplay: true },
  pendingReference: { transactionId: TRANSACTION_ID, status: 'PENDING_REFERENCE', balance: brl('975.00'), idempotentReplay: false },
  rejected: {
    insufficientFunds: {
      summary: 'Aposta sem saldo',
      value: { transactionId: TRANSACTION_ID, status: 'REJECTED', balance: brl('20.00'), failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false },
    },
    reversalInsufficientFunds: {
      summary: 'Reversão que deixaria saldo negativo',
      value: { transactionId: TRANSACTION_ID, status: 'REJECTED', balance: brl('10.00'), failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', idempotentReplay: false },
    },
    walletNotFound: {
      summary: 'Wallet inexistente (nada persistido)',
      value: { transactionId: null, status: 'REJECTED', balance: null, failureCode: 'WALLET_NOT_FOUND', idempotentReplay: false },
    },
  },
  validationError: error('VALIDATION_ERROR', 'Request validation failed', ['money.amount: amount must be a non-negative decimal string with exactly 2 decimal places']),
  missingIdempotencyKey: error('VALIDATION_ERROR', 'Idempotency-Key header is required', ['Idempotency-Key: required']),
  idempotencyConflict: error('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key already used with a different payload'),
  unavailable: error('SERVICE_UNAVAILABLE', 'Temporary failure, retry with the same Idempotency-Key'),
  transaction: {
    transactionId: TRANSACTION_ID,
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    status: 'PROCESSED',
    failureCode: null,
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    balance: brl('975.00'),
    referenceAttempts: 0,
    nextAttemptAt: null,
    createdAt: '2026-07-29T15:00:00.100Z',
    processedAt: '2026-07-29T15:00:00.100Z',
  },
} as const;

export const CommonExamples = {
  notFound: error('NOT_FOUND', `Wallet ${WALLET_ID} not found`),
  invalidId: error('VALIDATION_ERROR', 'Request validation failed', ['walletId: walletId must be a UUID']),
} as const;
