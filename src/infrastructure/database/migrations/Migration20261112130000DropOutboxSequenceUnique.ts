import { Migration } from "@mikro-orm/migrations";

// Remove o UNIQUE(sequence) da outbox. A coluna é identity GENERATED ALWAYS: só o banco atribui valores,
// então a constraint não protegia nada e custava um índice a mais em cada insert do fluxo financeiro.
// Impacto: nenhuma query depende da constraint; a ordem continua garantida pela identity e pelo índice
// parcial (aggregate_id, sequence). A migration anterior não é editada porque já foi aplicada.
export class Migration20261112130000DropOutboxSequenceUnique extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      "alter table outbox_messages drop constraint if exists outbox_messages_sequence_uq",
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      "alter table outbox_messages add constraint outbox_messages_sequence_uq unique (sequence)",
    );
  }
}
