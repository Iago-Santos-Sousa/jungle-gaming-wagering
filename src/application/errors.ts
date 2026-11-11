// Erros da camada de aplicação. Cada um mapeia para um status HTTP e uma decisão de reenvio distintos.

export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

// Mesma Idempotency-Key (ou mesmo id externo) com payload diferente: conflito, nunca replay
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Wallet for player ${playerId} in ${currency} already exists`);
  }
}

export class ResourceNotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
  }
}

// Escrita perdeu a corrida de versão; transitório, pode ser reenviado
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';
}

// Corrida de inserção na mesma idempotency key; o use case relê e responde replay ou conflito
export class DuplicateTransactionError extends ApplicationError {
  readonly code = 'DUPLICATE_TRANSACTION';
}

// Cursor de paginação ilegível ou adulterado
export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('Invalid pagination cursor');
  }
}
