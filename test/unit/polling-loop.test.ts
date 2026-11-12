import { describe, expect, test } from 'bun:test';
import type { PinoLogger } from 'nestjs-pino';
import { PollingLoop } from '../../src/interfaces/workers/polling-loop';

const warnings: unknown[] = [];
const logger = { warn: (payload: unknown) => warnings.push(payload), error: () => undefined } as unknown as PinoLogger;

describe('PollingLoop', () => {
  test('stop espera o ciclo em andamento só até o timeout', async () => {
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const loop = new PollingLoop('stuck', 10, async () => {
      await stuck;
      return false;
    }, logger);
    loop.start();
    await Bun.sleep(20);

    const startedAt = performance.now();
    await loop.stop(100);
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1_000);
    expect(warnings).toHaveLength(1);
    expect(loop.stopping).toBe(true);
    release();
  });

  test('stopping só fica verdadeiro depois do stop, mesmo antes do start', async () => {
    const loop = new PollingLoop('idle', 10, async () => false, logger);
    expect(loop.stopping).toBe(false);
    await loop.stop(10);
    expect(loop.stopping).toBe(true);
  });
});
