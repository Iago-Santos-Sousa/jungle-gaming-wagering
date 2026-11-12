import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import type { AppConfig } from "./infrastructure/config/app-config";
import { runMigrations } from "./infrastructure/database/migration-runner";
import { setupSwagger } from "./interfaces/http/swagger";

export async function createApp(
  config: AppConfig,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config),
    {
      bufferLogs: true,
      abortOnError: false,
    },
  );

  app.useLogger(app.get(Logger));
  app.set("trust proxy", false);
  app.disable("x-powered-by");
  app.enableShutdownHooks();

  await runMigrations(app.get(MikroORM));

  setupSwagger(app);
  return app;
}
