import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MikroORM } from '@mikro-orm/postgresql';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './infrastructure/config/app-config';
import { runMigrations } from './infrastructure/database/migration-runner';
import { setupSwagger } from './interfaces/http/swagger';

// Cria a aplicação já migrada e configurada, sem abrir a porta HTTP.
// Usado pelo main e pelos testes, para o comportamento ser idêntico.
export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.set('trust proxy', false);
  app.disable('x-powered-by');
  // Encerramento gracioso: SIGTERM aciona os hooks de shutdown dos workers e do ORM
  app.enableShutdownHooks();

  // Tabelas criadas ou atualizadas antes de qualquer worker ou rota começar a operar
  await runMigrations(app.get(MikroORM));

  setupSwagger(app);
  return app;
}
