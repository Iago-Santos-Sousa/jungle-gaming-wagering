import { MAX_TRANSACTION_ATTEMPTS } from '../../application/errors';

export const APP_CONFIG = Symbol('APP_CONFIG');

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  poolMax: number;
  poolAcquireTimeoutMs: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface SqsConfig {
  region: string;
  endpoint: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
  consumerName: string;
  maxReceives: number;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
  batchSize: number;
  retryBaseDelaySeconds: number;
  retryMaxDelaySeconds: number;
}

export interface RetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  logLevel: LogLevel;
  workersEnabled: boolean;
  shutdownTimeoutMs: number;
  database: DatabaseConfig;
  sqs: SqsConfig;
  outbox: RetryConfig & { pollIntervalMs: number; batchSize: number; leaseMs: number };
  pendingReference: RetryConfig & { pollIntervalMs: number; batchSize: number; maxAttempts: number; leaseMs: number };
}

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

type Env = Record<string, string | undefined>;

export class InvalidConfigError extends Error {
  constructor(key: string, reason: string) {
    super(`Invalid environment variable ${key}: ${reason}`);
    this.name = 'InvalidConfigError';
  }
}

function readString(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function readInt(env: Env, key: string, fallback: number, min = 0): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new InvalidConfigError(key, 'must be a non-negative integer');
  const value = Number.parseInt(raw, 10);
  if (value < min) throw new InvalidConfigError(key, `must be >= ${min}`);
  return value;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new InvalidConfigError(key, 'must be true or false');
}

function readLogLevel(env: Env): LogLevel {
  const raw = readString(env, 'LOG_LEVEL', 'info') as LogLevel;
  if (!LOG_LEVELS.includes(raw)) throw new InvalidConfigError('LOG_LEVEL', `must be one of ${LOG_LEVELS.join(', ')}`);
  return raw;
}

// O shutdown precisa cobrir o long polling em andamento mais o pior caso de uma mensagem esperando lock em todas as tentativas.
// Com menos que isso, o hook retornaria com trabalho em curso e o ORM fecharia no meio da transação.
function assertShutdownBudget(config: AppConfig): AppConfig {
  const required = config.sqs.waitTimeSeconds * 1_000 + config.database.lockTimeoutMs * MAX_TRANSACTION_ATTEMPTS;
  if (config.shutdownTimeoutMs <= required) {
    throw new InvalidConfigError(
      'SHUTDOWN_TIMEOUT_MS',
      `must be greater than SQS_WAIT_TIME_SECONDS * 1000 + DB_LOCK_TIMEOUT_MS * ${MAX_TRANSACTION_ATTEMPTS} (${required})`,
    );
  }
  return config;
}

export function loadConfig(env: Env = process.env): AppConfig {
  return assertShutdownBudget({
    nodeEnv: readString(env, 'NODE_ENV', 'development'),
    port: readInt(env, 'PORT', 3000, 1),
    logLevel: readLogLevel(env),
    workersEnabled: readBool(env, 'WORKERS_ENABLED', true),
    shutdownTimeoutMs: readInt(env, 'SHUTDOWN_TIMEOUT_MS', 30_000),
    database: {
      host: readString(env, 'DB_HOST', 'localhost'),
      port: readInt(env, 'DB_PORT', 5432, 1),
      name: readString(env, 'DB_NAME', 'wagering'),
      user: readString(env, 'DB_USER', 'wagering'),
      password: readString(env, 'DB_PASSWORD', 'wagering'),
      // Mínimo 2: o boot segura uma conexão dedicada para o advisory lock das migrations
      poolMax: readInt(env, 'DB_POOL_MAX', 10, 2),
      poolAcquireTimeoutMs: readInt(env, 'DB_POOL_ACQUIRE_TIMEOUT_MS', 10_000, 1),
      lockTimeoutMs: readInt(env, 'DB_LOCK_TIMEOUT_MS', 5_000, 1),
      statementTimeoutMs: readInt(env, 'DB_STATEMENT_TIMEOUT_MS', 15_000, 1),
    },
    sqs: {
      region: readString(env, 'AWS_REGION', 'us-east-1'),
      endpoint: env.SQS_ENDPOINT?.trim() || undefined,
      accessKeyId: readString(env, 'AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: readString(env, 'AWS_SECRET_ACCESS_KEY', 'test'),
      wagerQueueName: readString(env, 'SQS_WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
      wagerDlqName: readString(env, 'SQS_WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      eventsQueueName: readString(env, 'SQS_EVENTS_QUEUE_NAME', 'wagering-events.fifo'),
      consumerName: readString(env, 'SQS_CONSUMER_NAME', 'wager-transactions-consumer'),
      maxReceives: readInt(env, 'SQS_MAX_RECEIVES', 5, 1),
      visibilityTimeoutSeconds: readInt(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 30, 1),
      waitTimeSeconds: readInt(env, 'SQS_WAIT_TIME_SECONDS', 10),
      batchSize: Math.min(readInt(env, 'SQS_BATCH_SIZE', 10, 1), 10),
      retryBaseDelaySeconds: readInt(env, 'SQS_RETRY_BASE_DELAY_SECONDS', 2, 1),
      // Teto do SQS para ChangeMessageVisibility é 12 horas
      retryMaxDelaySeconds: Math.min(readInt(env, 'SQS_RETRY_MAX_DELAY_SECONDS', 300, 1), 43_200),
    },
    outbox: {
      pollIntervalMs: readInt(env, 'OUTBOX_POLL_INTERVAL_MS', 500, 1),
      batchSize: readInt(env, 'OUTBOX_BATCH_SIZE', 50, 1),
      leaseMs: readInt(env, 'OUTBOX_LEASE_MS', 30_000, 1),
      baseDelayMs: readInt(env, 'OUTBOX_RETRY_BASE_DELAY_MS', 1_000, 1),
      maxDelayMs: readInt(env, 'OUTBOX_RETRY_MAX_DELAY_MS', 60_000, 1),
    },
    pendingReference: {
      pollIntervalMs: readInt(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000, 1),
      batchSize: readInt(env, 'PENDING_REFERENCE_BATCH_SIZE', 50, 1),
      maxAttempts: readInt(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', 10, 1),
      leaseMs: readInt(env, 'PENDING_REFERENCE_LEASE_MS', 30_000, 1),
      baseDelayMs: readInt(env, 'PENDING_REFERENCE_BASE_DELAY_MS', 1_000, 1),
      maxDelayMs: readInt(env, 'PENDING_REFERENCE_MAX_DELAY_MS', 300_000, 1),
    },
  });
}
