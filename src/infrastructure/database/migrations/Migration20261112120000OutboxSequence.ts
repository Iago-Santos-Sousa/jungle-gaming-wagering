import { Migration } from '@mikro-orm/migrations';

// Ordem de publicação da outbox independente de relógio.
// occurred_at vem do relógio da aplicação e pode andar para trás (ressincronização de NTP ou da VM),
// então dois eventos da mesma wallet podiam sair invertidos. A sequência é atribuída pelo banco no insert,
// que acontece com a wallet travada, logo é monotônica por agregado na ordem de commit.
//
// Impacto: a coluna é identity, então o PostgreSQL preenche as linhas existentes no próprio ALTER, sem backfill manual
// e sem default para a aplicação informar. Mensagens pendentes já existentes recebem números na ordem física da tabela,
// o que só importa para eventos não publicados no momento do deploy. A aplicação nunca grava a coluna.
export class Migration20261112120000OutboxSequence extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table outbox_messages add column sequence bigint generated always as identity`);
    this.addSql(`alter table outbox_messages add constraint outbox_messages_sequence_uq unique (sequence)`);
    // Cabeça de cada agregado e lote reservado em ordem, só entre as pendentes
    this.addSql(`
      create index outbox_messages_pending_aggregate_idx
        on outbox_messages (aggregate_id, sequence)
        where published_at is null`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists outbox_messages_pending_aggregate_idx');
    this.addSql('alter table outbox_messages drop constraint if exists outbox_messages_sequence_uq');
    this.addSql('alter table outbox_messages drop column if exists sequence');
  }
}
