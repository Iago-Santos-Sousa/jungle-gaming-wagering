import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/app-config';
import { buildOrmConfig } from './infrastructure/database/mikro-orm.config';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { LoggerModule } from './infrastructure/observability/logger.module';
import { AuthGuard } from './interfaces/http/auth/auth.guard';
import { HealthController } from './interfaces/http/health/health.controller';

// Módulo raiz construído a partir da configuração, para testes subirem instâncias isoladas
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule,
        MikroOrmModule.forRoot({ ...buildOrmConfig(config), registerRequestContext: false }),
        SqsModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [APP_CONFIG],
    };
  }
}
