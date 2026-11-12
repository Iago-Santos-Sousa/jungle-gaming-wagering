export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(playerId: string, currency: string) {
    super(`Wallet for player ${playerId} in ${currency} already exists`);
  }
}

export class ResourceNotFoundError extends ApplicationError {
  readonly code = "NOT_FOUND";

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
  }
}

export const MAX_TRANSACTION_ATTEMPTS = 3;

export class ConcurrencyConflictError extends ApplicationError {
  readonly code = "CONCURRENCY_CONFLICT";
}

export class DuplicateTransactionError extends ApplicationError {
  readonly code = "DUPLICATE_TRANSACTION";
}

export class InvalidCursorError extends ApplicationError {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("Invalid pagination cursor");
  }
}
