import { Migration } from "@mikro-orm/migrations";

// Marca a cabeça de cada agregado na outbox (a pendente de menor sequence), para o publisher achar as cabeças
// vencidas direto por um índice parcial, sem passar pelos eventos seguintes de um agregado com acúmulo.
//
// Impacto:
// - o default é constante, então o ADD COLUMN não reescreve a tabela;
// - o backfill marca as cabeças das pendentes atuais; publicadas ficam false (não entram em nenhum índice parcial);
// - outbox_messages_due_idx deixa de ser usado pelo claim e sai, poupando um índice em cada insert do fluxo financeiro;
// - a aplicação passa a manter is_head no insert e na publicação: todas as instâncias precisam estar nesta versão.
export class Migration20261113120000OutboxHeadFlag extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table outbox_messages add column is_head boolean not null default false`,
    );

    this.addSql(`
      update outbox_messages
         set is_head = true
       where id in (
         select distinct on (aggregate_id) id
           from outbox_messages
          where published_at is null
          order by aggregate_id, sequence)`);

    this.addSql(`
      create index outbox_messages_due_head_idx
        on outbox_messages (next_attempt_at)
        where published_at is null and is_head`);

    this.addSql("drop index if exists outbox_messages_due_idx");
  }

  override async down(): Promise<void> {
    this.addSql(`
      create index if not exists outbox_messages_due_idx
        on outbox_messages (next_attempt_at)
        where published_at is null`);

    this.addSql("drop index if exists outbox_messages_due_head_idx");
    this.addSql("alter table outbox_messages drop column if exists is_head");
  }
}
