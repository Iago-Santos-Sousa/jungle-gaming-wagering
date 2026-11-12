import { ConnectionException, DriverException, UniqueConstraintViolationException } from '@mikro-orm/core';

// SQLSTATEs que indicam falha passageira: reenviar a mesma operação pode dar certo
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08001',
  '08003',
  '08004',
  '08006', // connection_exception e variações
]);

const LOCK_CONFLICT_SQLSTATES = new Set(['40001', '40P01', '55P03']);

// Mensagens do driver pg para falhas de conexão que não chegam com SQLSTATE
const TRANSIENT_MESSAGE = /timeout exceeded when trying to connect|Connection terminated|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|the database system is (starting up|shutting down)/i;

function sqlState(error: unknown): string | undefined {
  if (error instanceof DriverException) return error.code ?? error.sqlState;
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  const state = sqlState(error);
  if (state && TRANSIENT_SQLSTATES.has(state)) return true;
  return error instanceof Error && TRANSIENT_MESSAGE.test(error.message);
}

// Classes de SQLSTATE em que reenviar a mesma operação nunca dá certo: 22 (data exception, ex.: numeric overflow)
// e 23 (violação de integridade). As unique de idempotência já chegam convertidas em erro de aplicação.
const PERMANENT_SQLSTATE_CLASSES = new Set(['22', '23']);

export function isPermanentDatabaseError(error: unknown): boolean {
  const state = sqlState(error);
  return state !== undefined && state.length === 5 && PERMANENT_SQLSTATE_CLASSES.has(state.slice(0, 2));
}

export function isLockConflict(error: unknown): boolean {
  const state = sqlState(error);
  return state !== undefined && LOCK_CONFLICT_SQLSTATES.has(state);
}

// Nome da constraint violada, quando o erro é de unicidade
export function uniqueViolationConstraint(error: unknown): string | undefined {
  if (!(error instanceof UniqueConstraintViolationException)) return undefined;
  const constraint = (error as UniqueConstraintViolationException & { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : 'unknown';
}
