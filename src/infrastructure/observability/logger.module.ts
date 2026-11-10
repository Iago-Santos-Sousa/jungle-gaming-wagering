import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

// Aceita o correlation id do cliente só se for um identificador curto e seguro
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveCorrelationId(req: IncomingMessage, res: ServerResponse): string {
  const header = req.headers[CORRELATION_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  const correlationId = candidate && SAFE_CORRELATION_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  return correlationId;
}

// Logs estruturados em JSON. Corpo de requisição e resposta nunca é logado.
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          base: { service: 'jungle-gaming-wagering' },
          timestamp: () => `,"time":"${new Date().toISOString()}"`,
          formatters: { level: (label: string) => ({ level: label }) },
          genReqId: resolveCorrelationId,
          customProps: (req: IncomingMessage) => ({ correlationId: (req as IncomingMessage & { id?: unknown }).id }),
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["idempotency-key"]'],
            remove: true,
          },
          serializers: {
            req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url }),
            res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
          },
          // Health e métricas são consultados com frequência e só geram ruído
          autoLogging: { ignore: (req: IncomingMessage) => /^\/(health|metrics)/.test(req.url ?? '') },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
