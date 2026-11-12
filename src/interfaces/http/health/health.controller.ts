import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../../../infrastructure/config/app-config';
import { SqsQueueResolver } from '../../../infrastructure/messaging/sqs.module';
import { Public } from '../auth/public.decorator';
import { HealthExamples } from './health.examples';

type CheckStatus = 'up' | 'down';

// Tempo máximo de cada verificação, para o readiness nunca travar
const CHECK_TIMEOUT_MS = 2_000;

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly queues: SqsQueueResolver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Processo vivo', schema: { example: HealthExamples.live } })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ description: 'PostgreSQL e SQS alcançáveis', schema: { example: HealthExamples.ready } })
  @ApiServiceUnavailableResponse({ description: 'Alguma dependência indisponível', schema: { example: HealthExamples.notReady } })
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, sqs] = await Promise.all([
      check(() => this.orm.em.getConnection().execute('select 1')),
      check(() => this.queues.ping(this.config.sqs.wagerQueueName)),
    ]);
    const ready = database === 'up' && sqs === 'up';
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable', checks: { database, sqs } };
  }
}
