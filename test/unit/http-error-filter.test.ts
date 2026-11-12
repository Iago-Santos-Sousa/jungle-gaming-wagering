import { describe, expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { ConcurrencyConflictError, DuplicateTransactionError, IdempotencyConflictError } from '../../src/application/errors';
import { HttpErrorFilter, type ErrorBody } from '../../src/interfaces/http/errors/http-error.filter';

interface CapturedResponse {
  status?: number;
  body?: ErrorBody;
  headers: Record<string, string>;
}

// Logger silencioso: o filtro só registra erros 5xx
const silentLogger = { setContext: () => undefined, error: () => undefined } as unknown as PinoLogger;

function respond(exception: unknown): CapturedResponse {
  const captured: CapturedResponse = { headers: {} };
  const response = {
    setHeader: (name: string, value: string) => {
      captured.headers[name] = value;
    },
    status: (code: number) => {
      captured.status = code;
      return { json: (body: ErrorBody) => (captured.body = body) };
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id: 'corr-1', url: '/wagering/transactions' }), getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new HttpErrorFilter(silentLogger).catch(exception, host);
  return captured;
}

describe('HttpErrorFilter', () => {
  test.each([
    ['DuplicateTransactionError', new DuplicateTransactionError('inserted concurrently')],
    ['ConcurrencyConflictError', new ConcurrencyConflictError('version changed')],
  ])('%s esgotado é transitório: 503 com Retry-After', (_, error) => {
    const captured = respond(error);
    expect(captured.status).toBe(503);
    expect(captured.headers['Retry-After']).toBe('1');
    expect(captured.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE', correlationId: 'corr-1' });
  });

  test('conflito de idempotência continua 409 sem Retry-After', () => {
    const captured = respond(new IdempotencyConflictError('different payload'));
    expect(captured.status).toBe(409);
    expect(captured.headers['Retry-After']).toBeUndefined();
    expect(captured.body?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});
