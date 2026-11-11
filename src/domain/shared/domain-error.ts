// Erro base do domínio: carrega um código estável e legível por máquina
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// Entrada que viola o contrato de um value object ou de uma factory
export class InvalidArgumentError extends DomainError {
  readonly code = 'INVALID_ARGUMENT';
}

// Operação entre valores de moedas diferentes
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

// Débito maior que o saldo disponível
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor() {
    super('Insufficient funds');
  }
}

// Tentativa de transição a partir de um estado terminal: erro de programação, não de negócio
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

// Lançamento cuja aritmética não fecha (balanceBefore ± money !== balanceAfter)
export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
}
