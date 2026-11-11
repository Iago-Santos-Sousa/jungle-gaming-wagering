import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { RequestValidationError } from './errors/http-error.filter';

// Idempotency-Key é obrigatório e é a fonte da verdade da idempotência
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:\-]{1,255}$/;

export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const header = ctx.switchToHttp().getRequest<Request>().header('idempotency-key');
  if (!header) throw new RequestValidationError(['Idempotency-Key: required']);
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new RequestValidationError(['Idempotency-Key: must have 1 to 255 characters among letters, digits, ".", "_", ":" or "-"']);
  }
  return header;
});

// Correlation id atribuído pelo logger HTTP (header X-Correlation-Id ou gerado)
export const CorrelationId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request & { id?: unknown }>();
  return String(request.id ?? '');
});
