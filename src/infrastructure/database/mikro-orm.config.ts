import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../config/app-config';
import { persistenceEntities } from './entities';
import { migrationsList } from './migrations';

export function buildOrmConfig(config: AppConfig): Options {
  const { database } = config;
  return defineConfig({
    host: database.host,
    port: database.port,
    dbName: database.name,
    user: database.user,
    password: database.password,
    entities: persistenceEntities,
    extensions: [Migrator],
    migrations: {
      migrationsList,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    // Pool limitado por instância: o total no banco é poolMax × instâncias
    pool: { min: 0, max: database.poolMax, idleTimeoutMillis: 30_000 },
    driverOptions: {
      connectionTimeoutMillis: database.poolAcquireTimeoutMs,
      // Espera por lock de linha vira erro transitório em vez de travar a requisição
      lock_timeout: database.lockTimeoutMs,
      statement_timeout: database.statementTimeoutMs,
      application_name: 'jungle-gaming-wagering',
    },
    // Todo acesso usa um EntityManager explicitamente bifurcado; o global é proibido
    allowGlobalContext: false,
    debug: false,
  });
}
