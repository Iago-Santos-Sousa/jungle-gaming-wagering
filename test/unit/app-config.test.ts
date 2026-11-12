import { describe, expect, test } from 'bun:test';
import { InvalidConfigError, loadConfig } from '../../src/infrastructure/config/app-config';

describe('loadConfig', () => {
  test('defaults respeitam o orçamento de tempo do shutdown', () => {
    const config = loadConfig({});
    expect(config.shutdownTimeoutMs).toBeGreaterThan(config.sqs.waitTimeSeconds * 1_000 + config.database.lockTimeoutMs * 3);
  });

  test('SHUTDOWN_TIMEOUT_MS que não cobre o long polling mais as esperas de lock falha no boot', () => {
    // 10s de long polling + 3 x 5s de lock = 25s exigidos
    expect(() => loadConfig({ SHUTDOWN_TIMEOUT_MS: '25000', SQS_WAIT_TIME_SECONDS: '10', DB_LOCK_TIMEOUT_MS: '5000' })).toThrow(InvalidConfigError);
    expect(loadConfig({ SHUTDOWN_TIMEOUT_MS: '25001', SQS_WAIT_TIME_SECONDS: '10', DB_LOCK_TIMEOUT_MS: '5000' }).shutdownTimeoutMs).toBe(25_001);
  });
});
