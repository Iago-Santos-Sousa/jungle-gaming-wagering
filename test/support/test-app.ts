import type { NestExpressApplication } from '@nestjs/platform-express';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { createApp } from '../../src/bootstrap';
import { loadConfig, type AppConfig } from '../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.module';
import { createQueues } from '../../src/scripts/create-queues';

export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'wagering_test';

// Configuração de teste: banco próprio, filas próprias e workers desligados por padrão
export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    ...process.env,
    DB_NAME: TEST_DB_NAME,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    WORKERS_ENABLED: 'false',
    SQS_WAGER_QUEUE_NAME: 'test-wager-transactions.fifo',
    SQS_WAGER_DLQ_NAME: 'test-wager-transactions-dlq.fifo',
    SQS_EVENTS_QUEUE_NAME: 'test-wagering-events.fifo',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_MAX_RECEIVES: '3',
    OUTBOX_POLL_INTERVAL_MS: '50',
    OUTBOX_LEASE_MS: '2000',
    OUTBOX_RETRY_BASE_DELAY_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '50',
    PENDING_REFERENCE_BASE_DELAY_MS: '100',
    PENDING_REFERENCE_MAX_DELAY_MS: '400',
    PENDING_REFERENCE_MAX_ATTEMPTS: '4',
    // Precisa cobrir SQS_WAIT_TIME_SECONDS mais DB_LOCK_TIMEOUT_MS em todas as tentativas (validado no loadConfig)
    SHUTDOWN_TIMEOUT_MS: '20000',
    ...overrides,
  });
}

async function withAdminClient<T>(config: AppConfig, work: (client: Client) => Promise<T>): Promise<T> {
  const { database } = config;
  const client = new Client({ host: database.host, port: database.port, user: database.user, password: database.password, database: 'postgres' });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

let prepared: Promise<void> | undefined;

// Recria o banco de teste e as filas uma vez por execução da suíte, partindo de um estado limpo
export function prepareTestEnvironment(): Promise<void> {
  prepared ??= (async () => {
    const config = testConfig();
    await withAdminClient(config, async (client) => {
      await client.query(`drop database if exists ${TEST_DB_NAME} with (force)`);
      await client.query(`create database ${TEST_DB_NAME}`);
    });
    const sqs = createSqsClient(config);
    try {
      await createQueues(config, sqs);
    } finally {
      sqs.destroy();
    }
  })();
  return prepared;
}

export interface TestApp {
  app: NestExpressApplication;
  orm: MikroORM;
  baseUrl: string;
  config: AppConfig;
  close: () => Promise<void>;
}

// Sobe uma instância real da aplicação (HTTP, ORM, SQS) contra PostgreSQL e MiniStack
export async function startTestApp(overrides: Partial<Record<string, string>> = {}): Promise<TestApp> {
  await prepareTestEnvironment();
  const config = testConfig(overrides);
  // Filas da configuração desta instância (idempotente), para arquivos de teste usarem filas isoladas
  const sqs = createSqsClient(config);
  try {
    await createQueues(config, sqs);
  } finally {
    sqs.destroy();
  }
  const app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    orm: app.get(MikroORM),
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    close: () => app.close(),
  };
}
