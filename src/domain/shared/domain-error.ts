export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidArgumentError extends DomainError {
  readonly code = 'INVALID_ARGUMENT';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor() {
    super('Insufficient funds');
  }
}

export class BalanceLimitExceededError extends DomainError {
  readonly code = 'BALANCE_LIMIT_EXCEEDED';

  constructor() {
    super('Balance limit exceeded');
  }
}

// Tentativa de transição a partir de um estado terminal: erro de programação, não de negócio
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
}
