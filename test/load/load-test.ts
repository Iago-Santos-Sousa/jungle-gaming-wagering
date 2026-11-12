// Teste de carga contra o stack do docker compose já no ar (bun run test:load). Metodologia em LOAD-TEST.md.
// Modelo fechado: cada usuário virtual envia uma requisição, espera a resposta e envia a próxima.
import { cpus, platform, release, totalmem } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { apiClient, brl, newId, submitWager, wagerBody, type ApiClient, type ApiResponse, type WagerResult } from '../support/api-client';

const targets = (process.env.LOAD_TARGETS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002').split(',').filter(Boolean);
const durationS = Number(process.env.LOAD_DURATION_S ?? '30');
const warmupS = Number(process.env.LOAD_WARMUP_S ?? '5');
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? '32');
const walletCount = Number(process.env.LOAD_WALLETS ?? '200');
const drainTimeoutS = Number(process.env.LOAD_DRAIN_TIMEOUT_S ?? '60');
const selected = (process.env.LOAD_SCENARIOS ?? 'distributed,contention-replay,hot-wallet').split(',').filter(Boolean);

const clients = targets.map((url) => apiClient(url));
let nextClient = 0;
// Round-robin entre instâncias: cada requisição vai para a próxima
const pickClient = (): ApiClient => clients[nextClient++ % clients.length]!;

type Body = ReturnType<typeof wagerBody>;
interface Wallet {
  walletId: string;
  playerId: string;
  roundId: string;
}

interface Sample {
  ms: number;
  status: number;
  failureCode?: string;
  replay: boolean;
}

interface Recorder {
  samples: Sample[];
  duplicateViolations: number;
  recording: boolean;
}

async function timedSubmit(recorder: Recorder, body: Body): Promise<ApiResponse<WagerResult> | null> {
  const started = performance.now();
  let response: ApiResponse<WagerResult> | null = null;
  try {
    response = await submitWager(pickClient(), body);
  } catch {
    // Falha de rede ou resposta ilegível: status 0
  }
  if (recorder.recording) {
    recorder.samples.push({
      ms: performance.now() - started,
      status: response?.status ?? 0,
      failureCode: response?.body.failureCode ?? response?.body.code,
      replay: response?.body.idempotentReplay === true,
    });
  }
  return response;
}

const randomAmount = (min: number, max: number): string => (min + Math.floor(Math.random() * (max - min + 1))).toFixed(2);

async function createWallets(count: number, amount: string): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (let start = 0; start < count; start += 20) {
    const batch = Array.from({ length: Math.min(20, count - start) }, async () => {
      const playerId = newId();
      const response = await pickClient().post<{ id: string }>('/wallets', { playerId, initialBalance: brl(amount) });
      if (response.status !== 201) throw new Error(`create wallet failed: ${response.status}`);
      return { walletId: response.body.id, playerId, roundId: `round-${newId()}` };
    });
    wallets.push(...(await Promise.all(batch)));
  }
  return wallets;
}

// Fábrica do usuário virtual: o estado criado para o índice vu dura entre as iterações dele
type VirtualUser = (vu: number) => (recorder: Recorder) => Promise<void>;

interface Scenario {
  name: string;
  description: string;
  setup: () => Promise<{ wallets: Wallet[]; user: VirtualUser }>;
}

// Wallets particionadas entre usuários virtuais: sem disputa de lock, mede o throughput entre wallets
const distributed: Scenario = {
  name: 'distributed',
  description: `${walletCount} wallets particionadas entre os usuários; BET 60%, WIN 25%, LOSS 10%, ROLLBACK de BET própria 5%`,
  async setup() {
    const wallets = await createWallets(walletCount, '100000.00');
    const user: VirtualUser = (vu) => {
      const own = wallets.filter((_, i) => i % concurrency === vu);
      // BETs aplicadas e ainda não revertidas, candidatas a ROLLBACK
      const reversible: { wallet: Wallet; externalTransactionId: string; amount: string }[] = [];
      const wallet = () => own[Math.floor(Math.random() * own.length)]!;
      return async (recorder) => {
        if (own.length === 0) return Bun.sleep(100);
        const roll = Math.random();
        if (roll < 0.05 && reversible.length > 0) {
          const ref = reversible.splice(Math.floor(Math.random() * reversible.length), 1)[0]!;
          await timedSubmit(recorder, wagerBody({ ...ref.wallet, kind: 'ROLLBACK', amount: ref.amount, referenceExternalTransactionId: ref.externalTransactionId }));
          return;
        }
        const target = wallet();
        const kind = roll < 0.65 ? 'BET' : roll < 0.9 ? 'WIN' : 'LOSS';
        const amount = kind === 'LOSS' ? '0.00' : randomAmount(1, 50);
        const body = wagerBody({ ...target, kind, amount });
        const response = await timedSubmit(recorder, body);
        if (kind === 'BET' && response?.status === 201) reversible.push({ wallet: target, externalTransactionId: body.externalTransactionId, amount });
      };
    };
    return { wallets, user };
  },
};

// Todos os usuários na mesma wallet: mede a serialização do lock pessimista
const hotWallet: Scenario = {
  name: 'hot-wallet',
  description: 'uma única wallet para todos os usuários; BET e WIN de 1.00 alternados',
  async setup() {
    const wallets = await createWallets(1, '1000000.00');
    const wallet = wallets[0]!;
    let flip = 0;
    const user: VirtualUser = () => async (recorder) => {
      const kind = flip++ % 2 === 0 ? 'BET' : 'WIN';
      await timedSubmit(recorder, wagerBody({ ...wallet, kind, amount: '1.00' }));
    };
    return { wallets, user };
  },
};

// Saldo baixo disputado e reenvio paralelo da mesma key: rejeições esperadas e replays
const contention: Scenario = {
  name: 'contention-replay',
  description: '20 wallets com 30.00 compartilhadas por todos; BET e WIN de 10.00; 20% das operações enviadas 2 vezes em paralelo com a mesma key',
  async setup() {
    const wallets = await createWallets(20, '30.00');
    const user: VirtualUser = () => async (recorder) => {
      const target = wallets[Math.floor(Math.random() * wallets.length)]!;
      const body = wagerBody({ ...target, kind: Math.random() < 0.5 ? 'BET' : 'WIN', amount: '10.00' });
      if (Math.random() >= 0.2) {
        await timedSubmit(recorder, body);
        return;
      }
      const pair = await Promise.all([timedSubmit(recorder, body), timedSubmit(recorder, body)]);
      // As duas respostas válidas e nenhuma marcada como replay: a mesma operação teria sido aplicada duas vezes
      const decided = pair.filter((r) => r && r.status < 500);
      if (recorder.recording && decided.length === 2 && decided.every((r) => !r!.body.idempotentReplay)) recorder.duplicateViolations++;
    };
    return { wallets, user };
  },
};

// A hot wallet roda por último: o acúmulo dela na outbox é o que mais demora para drenar
const scenarios = selected.map((name) => {
  const scenario = [distributed, contention, hotWallet].find((s) => s.name === name);
  if (!scenario) throw new Error(`cenário desconhecido: ${name}`);
  return scenario;
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

// Soma das séries de uma métrica Prometheus, agrupada pelo conjunto de labels
function parseMetric(text: string, name: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const key = match[2] ?? '';
    result[key] = (result[key] ?? 0) + Number(match[3]);
  }
  return result;
}

async function scrape(names: string[]): Promise<Record<string, Record<string, number>>> {
  const totals: Record<string, Record<string, number>> = {};
  for (const url of targets) {
    const text = await fetch(`${url}/metrics`).then((r) => r.text());
    for (const name of names) {
      const series = parseMetric(text, name);
      const bucket = (totals[name] ??= {});
      for (const [labels, value] of Object.entries(series)) bucket[labels] = (bucket[labels] ?? 0) + value;
    }
  }
  return totals;
}

function diff(after: Record<string, number> = {}, before: Record<string, number> = {}): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [labels, value] of Object.entries(after)) {
    const delta = value - (before[labels] ?? 0);
    if (delta !== 0) result[labels || 'total'] = round(delta, 0);
  }
  return result;
}

// outbox_lag_seconds vem do banco, então qualquer instância informa o valor global
async function outboxLag(): Promise<number> {
  const text = await fetch(`${targets[0]}/metrics`).then((r) => r.text());
  return parseMetric(text, 'outbox_lag_seconds')[''] ?? 0;
}

async function runScenario(scenario: Scenario) {
  console.log(`\n> ${scenario.name}: ${scenario.description}`);
  const lagAtStart = await outboxLag();
  const { wallets, user } = await scenario.setup();
  const recorder: Recorder = { samples: [], duplicateViolations: 0, recording: false };
  const metricNames = ['lock_conflicts_total', 'retries_total', 'duplicates_detected_total'];

  let running = true;
  const lagSamples: number[] = [];
  const sampler = (async () => {
    while (running) {
      if (recorder.recording) lagSamples.push(await outboxLag().catch(() => Number.NaN));
      await Bun.sleep(1000);
    }
  })();

  const steps = Array.from({ length: concurrency }, (_, vu) => user(vu));
  const loops = steps.map(async (step) => {
    while (running) await step(recorder);
  });

  await Bun.sleep(warmupS * 1000);
  const before = await scrape(metricNames);
  recorder.recording = true;
  const started = performance.now();
  await Bun.sleep(durationS * 1000);
  recorder.recording = false;
  const elapsedS = (performance.now() - started) / 1000;
  running = false;
  await Promise.all(loops);
  await sampler;
  const after = await scrape(metricNames);
  const lagAtEnd = await outboxLag();

  const drainStarted = performance.now();
  let drainS: number | null = null;
  while ((performance.now() - drainStarted) / 1000 < drainTimeoutS) {
    if ((await outboxLag()) === 0) {
      drainS = (performance.now() - drainStarted) / 1000;
      break;
    }
    await Bun.sleep(250);
  }

  const inconsistent: string[] = [];
  for (let i = 0; i < wallets.length; i += 20) {
    const checks = await Promise.all(wallets.slice(i, i + 20).map((w) => pickClient().post<{ consistent: boolean }>(`/wallets/${w.walletId}/reconciliation`)));
    checks.forEach((check, j) => {
      if (check.status !== 200 || !check.body.consistent) inconsistent.push(wallets[i + j]!.walletId);
    });
  }

  return summarize(scenario, recorder, elapsedS, { samples: lagSamples, atStart: lagAtStart, atEnd: lagAtEnd, drainS }, inconsistent, wallets.length, {
    lockConflicts: diff(after.lock_conflicts_total, before.lock_conflicts_total),
    retries: diff(after.retries_total, before.retries_total),
    duplicatesDetected: diff(after.duplicates_detected_total, before.duplicates_detected_total),
  });
}

function summarize(
  scenario: Scenario,
  recorder: Recorder,
  elapsedS: number,
  lag: { samples: number[]; atStart: number; atEnd: number; drainS: number | null },
  inconsistent: string[],
  wallets: number,
  serverMetrics: Record<string, Record<string, number>>,
) {
  const samples = recorder.samples;
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  const failureCodes: Record<string, number> = {};
  for (const s of samples) {
    statuses[s.status] = (statuses[s.status] ?? 0) + 1;
    if (s.failureCode) failureCodes[s.failureCode] = (failureCodes[s.failureCode] ?? 0) + 1;
  }
  // 201/200/202 são sucesso, 422 é rejeição de negócio esperada, 503 é transitório com Retry-After; o resto é erro
  const expected = new Set([200, 201, 202, 422]);
  const transient = statuses['503'] ?? 0;
  const errors = samples.filter((s) => !expected.has(s.status) && s.status !== 503).length;
  const lags = lag.samples.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    scenario: scenario.name,
    description: scenario.description,
    wallets,
    durationS: round(elapsedS),
    requests: samples.length,
    throughputRps: round(samples.length / elapsedS, 1),
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies.at(-1) ?? 0),
    },
    statuses,
    failureCodes,
    replays: samples.filter((s) => s.replay).length,
    transient503: transient,
    errors,
    errorRate: samples.length ? round(errors / samples.length, 4) : 0,
    transientRate: samples.length ? round(transient / samples.length, 4) : 0,
    duplicateViolations: recorder.duplicateViolations,
    serverMetrics,
    outboxLagS: {
      atStart: round(lag.atStart),
      max: round(lags.at(-1) ?? 0),
      p95: round(percentile(lags, 95)),
      atEnd: round(lag.atEnd),
      samples: lags.length,
      drainS: lag.drainS === null ? null : round(lag.drainS),
    },
    reconciliation: { checked: wallets, inconsistent: inconsistent.length },
  };
}

function dockerInfo(): string | null {
  try {
    const out = Bun.spawnSync(['docker', 'info', '--format', '{{.ServerVersion}} | {{.OperatingSystem}} | {{.NCPU}} CPUs | {{.MemTotal}} bytes']);
    return out.success ? out.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

for (const url of targets) {
  const ready = await fetch(`${url}/health/ready`).then((r) => r.status).catch(() => 0);
  if (ready !== 200) {
    console.error(`${url}/health/ready respondeu ${ready}. Suba o stack com docker compose up -d --build.`);
    process.exit(1);
  }
}

const environment = {
  startedAt: new Date().toISOString(),
  host: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cpus: cpus().length, memoryGb: round(totalmem() / 1024 ** 3, 1) },
  docker: dockerInfo(),
  bun: Bun.version,
  targets,
  // Valores lidos do .env do host, o mesmo arquivo que o compose usa
  config: {
    DB_POOL_MAX: process.env.DB_POOL_MAX ?? '10',
    DB_LOCK_TIMEOUT_MS: process.env.DB_LOCK_TIMEOUT_MS ?? '5000',
    OUTBOX_POLL_INTERVAL_MS: process.env.OUTBOX_POLL_INTERVAL_MS ?? '500',
    OUTBOX_BATCH_SIZE: process.env.OUTBOX_BATCH_SIZE ?? '50',
  },
  load: { concurrency, durationS, warmupS, walletCount, drainTimeoutS, scenarios: selected },
};
console.log('ambiente', JSON.stringify(environment, null, 2));

const results = [];
for (const scenario of scenarios) {
  const result = await runScenario(scenario);
  results.push(result);
  console.table({
    rps: result.throughputRps,
    p50: result.latencyMs.p50,
    p95: result.latencyMs.p95,
    p99: result.latencyMs.p99,
    errorRate: result.errorRate,
    transient503: result.transient503,
    lockConflicts: Object.values(result.serverMetrics.lockConflicts ?? {}).reduce((a, b) => a + b, 0),
    outboxLagStartS: result.outboxLagS.atStart,
    outboxLagMaxS: result.outboxLagS.max,
    drainS: result.outboxLagS.drainS ?? 'timeout',
  });
  console.log(JSON.stringify({ statuses: result.statuses, failureCodes: result.failureCodes, serverMetrics: result.serverMetrics }));
}

await mkdir('test/load/results', { recursive: true });
const file = `test/load/results/${environment.startedAt.replace(/[:.]/g, '-')}.json`;
await Bun.write(file, JSON.stringify({ environment, results }, null, 2));
console.log(`\nresultado completo em ${file}`);

const undrained = results.filter((r) => r.outboxLagS.drainS === null);
if (undrained.length > 0) console.warn(`outbox não drenou em ${drainTimeoutS}s após: ${undrained.map((r) => r.scenario).join(', ')}`);
// Só correção falha o processo: saldo divergente do ledger ou a mesma operação aplicada duas vezes
const broken = results.filter((r) => r.reconciliation.inconsistent > 0 || r.duplicateViolations > 0);
if (broken.length > 0) {
  console.error('falha de correção:', broken.map((r) => r.scenario).join(', '));
  process.exit(1);
}
