import { ArgumentsHost, BadRequestException, Catch, HttpException, HttpStatus, type ExceptionFilter, type ValidationError } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import {
  ApplicationError,
  ConcurrencyConflictError,
  DuplicateTransactionError,
  IdempotencyConflictError,
  InvalidCursorError,
  ResourceNotFoundError,
  WalletAlreadyExistsError,
} from '../../../application/errors';
import { DomainError, InvalidTransactionStateError } from '../../../domain/shared/domain-error';
import { isPermanentDatabaseError, isTransientDatabaseError } from '../../../infrastructure/database/database-errors';

export interface ErrorBody {
  code: string;
  message: string;
  details?: string[];
  correlationId: string;
}

// Segundos sugeridos ao cliente antes de reenviar em falha transitória
const RETRY_AFTER_SECONDS = '1';

// Erro de validação de payload com a lista de violações, no mesmo formato em todos os endpoints
export class RequestValidationError extends BadRequestException {
  constructor(readonly details: string[]) {
    super('Request validation failed');
  }
}

function flattenValidationErrors(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => `${path}: ${message}`);
    return [...own, ...flattenValidationErrors(error.children ?? [], path)];
  });
}

export function validationExceptionFactory(errors: ValidationError[]): RequestValidationError {
  return new RequestValidationError(flattenValidationErrors(errors));
}

// Mapeia cada categoria de erro para um status distinto, para o provedor decidir se pode reenviar sem ler a mensagem:
// 400 payload inválido, 404 inexistente, 409 conflito, 422 regra de negócio, 503 transitório, 500 permanente
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    logger.setContext(HttpErrorFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const correlationId = String(request.id ?? '');
    const { status, body } = this.map(exception, correlationId);

    if (status === HttpStatus.SERVICE_UNAVAILABLE) response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    if (status >= 500) {
      this.logger.error({ correlationId, err: exception, path: request.url }, 'request failed');
    }
    response.status(status).json(body);
  }

  private map(exception: unknown, correlationId: string): { status: number; body: ErrorBody } {
    const body = (code: string, message: string, details?: string[]): ErrorBody => ({ code, message, ...(details ? { details } : {}), correlationId });

    if (exception instanceof RequestValidationError) {
      return { status: HttpStatus.BAD_REQUEST, body: body('VALIDATION_ERROR', exception.message, exception.details) };
    }
    if (exception instanceof IdempotencyConflictError || exception instanceof WalletAlreadyExistsError) {
      return { status: HttpStatus.CONFLICT, body: body(exception.code, exception.message) };
    }
    if (exception instanceof ResourceNotFoundError) {
      return { status: HttpStatus.NOT_FOUND, body: body(exception.code, exception.message) };
    }
    if (exception instanceof InvalidCursorError) {
      return { status: HttpStatus.BAD_REQUEST, body: body('VALIDATION_ERROR', exception.message, ['cursor: invalid']) };
    }
    // Corrida de inserção que esgotou as tentativas também é transitória: reenviar com a mesma key vira replay ou conflito
    if (exception instanceof ConcurrencyConflictError || exception instanceof DuplicateTransactionError || isTransientDatabaseError(exception)) {
      return { status: HttpStatus.SERVICE_UNAVAILABLE, body: body('SERVICE_UNAVAILABLE', 'Temporary failure, retry with the same Idempotency-Key') };
    }
    // Falha permanente conhecida (dado inválido para o banco, integridade, transição ilegal): reenviar não resolve
    if (isPermanentDatabaseError(exception) || exception instanceof InvalidTransactionStateError) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: body('PERMANENT_FAILURE', 'Permanent failure, do not retry this request unchanged') };
    }
    // Violação de contrato detectada pelo domínio (ex.: REFUND sem referência) é payload inválido
    if (exception instanceof DomainError && !(exception instanceof InvalidTransactionStateError)) {
      return { status: HttpStatus.BAD_REQUEST, body: body('VALIDATION_ERROR', exception.message, [exception.message]) };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
      return { status, body: body(code, exception.message) };
    }
    if (exception instanceof ApplicationError) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: body(exception.code, 'Unexpected application error') };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: body('INTERNAL_ERROR', 'Unexpected error') };
  }
}
