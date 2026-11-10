import type { MikroORM } from '@mikro-orm/postgresql';

// Chave fixa do advisory lock que serializa migrations entre instâncias subindo ao mesmo tempo
const MIGRATION_LOCK_KEY = 782_341_001;

// Executa as migrations pendentes segurando um advisory lock numa conexão dedicada.
// O lock vale só durante o boot e não participa do fluxo financeiro.
export async function runMigrations(orm: MikroORM): Promise<void> {
  const pool = await orm.em.getConnection().getNativeClient();
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await orm.migrator.up();
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
