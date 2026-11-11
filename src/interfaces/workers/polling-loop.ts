import type { PinoLogger } from 'nestjs-pino';

// Laço de polling com intervalo fixo. Se o ciclo indicar que há mais trabalho, roda de novo imediatamente.
// stop() espera o ciclo em andamento terminar, para o shutdown não cortar uma operação no meio.
export class PollingLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> | undefined;
  private stopped = true;

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

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
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
