import type { PinoLogger } from 'nestjs-pino';

// Laço de polling com intervalo fixo. Se o ciclo indicar que há mais trabalho, roda de novo imediatamente.
// stop() espera o ciclo em andamento terminar, para o shutdown não cortar uma operação no meio, mas no máximo
// timeoutMs: o shutdown não pode passar do stop_grace_period do container.
export class PollingLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> | undefined;
  private stopped = true;
  private stopRequested = false;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: PinoLogger,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  // Pedido de parada já feito: ciclos longos conferem isso entre etapas para encerrar mais cedo.
  // Separado de `stopped`, que também é verdadeiro antes do start (ciclos chamados direto, como nos testes).
  get stopping(): boolean {
    return this.stopRequested;
  }

  async stop(timeoutMs: number): Promise<void> {
    this.stopRequested = true;
    this.stopped = true;
    clearTimeout(this.timer);
    const current = this.current;
    if (!current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([current.then(() => 'done' as const), timeout]);
    clearTimeout(timer);
    // O que ficou no meio é seguro: leases e tokens devolvem o trabalho para outra instância
    if (result === 'timeout') this.logger.warn({ worker: this.name, timeoutMs }, 'worker cycle still running at shutdown timeout');
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    let hasMore = false;
    try {
      hasMore = await this.tick();
    } catch (error) {
      this.logger.error({ err: error, worker: this.name }, 'worker cycle failed');
    } finally {
      this.current = undefined;
      this.schedule(hasMore ? 0 : this.intervalMs);
    }
  }
}
