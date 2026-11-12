import { Migration } from '@mikro-orm/migrations';

// Schema inicial. As garantias de unicidade, imutabilidade e não negatividade vivem aqui,
// no banco, e não só no código da aplicação.
export class Migration20261110120000InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance_amount numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- alvo da FK composta do ledger, garante moeda do lançamento igual à da wallet
        constraint wallets_id_currency_uq unique (id, currency),
        constraint wallets_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_ck check (balance_amount >= 0),
        constraint wallets_version_ck check (version >= 1)
      )`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(64) not null,
        external_transaction_id varchar(128) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id varchar(128),
        game_id varchar(128),
        kind varchar(16) not null,
        status varchar(24) not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(128),
        reference_transaction_id uuid references wager_transactions (id),
        failure_code varchar(64),
        result_balance_amount numeric(20,2),
        result_balance_currency char(3),
        reference_attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        constraint wager_transactions_provider_external_uq unique (provider_id, external_transaction_id),
        -- alvo da FK composta do ledger, garante que o lançamento pertence à wallet da transação
        constraint wager_transactions_id_wallet_uq unique (id, wallet_id),
        constraint wager_transactions_kind_ck check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_ck check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_currency_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_amount_ck check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_reference_required_ck check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_round_game_ck check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        constraint wager_transactions_failure_code_ck check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_ck check (status <> 'PROCESSED' or (processed_at is not null and result_balance_amount is not null)),
        constraint wager_transactions_reversal_resolved_ck check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),
        constraint wager_transactions_pending_reference_ck check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null),
        constraint wager_transactions_reference_attempts_ck check (reference_attempts >= 0),
        constraint wager_transactions_result_balance_ck check (
          (result_balance_amount is null and result_balance_currency is null) or
          (result_balance_amount >= 0 and result_balance_currency is not null)
        )
      )`);

    // Uma referência só pode ser revertida uma vez (REFUND ou ROLLBACK)
    this.addSql(`
      create unique index wager_transactions_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`);
    // Fila do worker de referências pendentes
    this.addSql(`
      create index wager_transactions_pending_due_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE'`);
    // Antecipa dependentes quando a referência chega
    this.addSql(`
      create index wager_transactions_pending_by_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE'`);
    this.addSql(`create index wager_transactions_wallet_idx on wager_transactions (wallet_id, created_at)`);

    // Estado terminal é imutável e campos de identidade nunca mudam; exclusão é proibida
    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted' using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%) and cannot change', old.id, old.status using errcode = 'restrict_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash, new.wallet_id,
            new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency, new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash, old.wallet_id,
            old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency, old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % identity fields are immutable', old.id using errcode = 'restrict_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`
      create trigger wager_transactions_guard_trg
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard()`);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        wallet_version integer not null,
        direction varchar(6) not null,
        amount numeric(20,2) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        currency char(3) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_wallet_fk foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fk foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        -- no máximo um lançamento por transação
        constraint wallet_ledger_entries_transaction_uq unique (transaction_id),
        -- uma posição por versão da wallet: impede lost update e serve de cursor estável
        constraint wallet_ledger_entries_wallet_version_uq unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_ck check (amount > 0),
        constraint wallet_ledger_entries_balances_ck check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_version_ck check (wallet_version >= 1),
        constraint wallet_ledger_entries_arithmetic_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      )`);

    // Ledger append-only: update, delete e truncate são bloqueados no banco
    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% blocked)', tg_op using errcode = 'restrict_violation';
      end $$`);
    this.addSql(`
      create trigger wallet_ledger_entries_append_only_trg
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only()`);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate_trg
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_append_only()`);

    // Wallet: identidade imutável, version incrementa exatamente quando o saldo muda
    this.addSql(`
      create function wallets_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets cannot be deleted' using errcode = 'restrict_violation';
        end if;
        if (new.id, new.player_id, new.currency, new.created_at) is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet % identity fields are immutable', old.id using errcode = 'restrict_violation';
        end if;
        if new.balance_amount <> old.balance_amount and new.version <> old.version + 1 then
          raise exception 'wallet % balance change must increment version by one', old.id using errcode = 'restrict_violation';
        end if;
        if new.balance_amount = old.balance_amount and new.version <> old.version then
          raise exception 'wallet % version only changes with the balance', old.id using errcode = 'restrict_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`
      create trigger wallets_guard_trg
        before update or delete on wallets
        for each row execute function wallets_guard()`);

    // Toda alteração de saldo tem lançamento correspondente: verificado no commit (constraint trigger adiada)
    this.addSql(`
      create function wallets_ledger_consistency() returns trigger language plpgsql as $$
      begin
        if new.version = 1 and new.balance_amount = 0 then
          return null;
        end if;
        if not exists (
          select 1 from wallet_ledger_entries e
          where e.wallet_id = new.id and e.wallet_version = new.version and e.balance_after = new.balance_amount
        ) then
          raise exception 'wallet % balance % at version % has no matching ledger entry', new.id, new.balance_amount, new.version
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end $$`);
    this.addSql(`
      create constraint trigger wallets_ledger_consistency_trg
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_ledger_consistency()`);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(128) not null,
        message_id varchar(255) not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(64) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        locked_until timestamptz,
        published_at timestamptz,
        last_error varchar(512),
        constraint outbox_messages_attempts_ck check (attempts >= 0)
      )`);
    // Fila do publisher: só mensagens ainda não publicadas
    this.addSql(`
      create index outbox_messages_due_idx
        on outbox_messages (next_attempt_at)
        where published_at is null`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages');
    this.addSql('drop table if exists inbox_messages');
    this.addSql('drop trigger if exists wallets_ledger_consistency_trg on wallets');
    this.addSql('drop trigger if exists wallets_guard_trg on wallets');
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
    this.addSql('drop function if exists wallets_ledger_consistency()');
    this.addSql('drop function if exists wallets_guard()');
    this.addSql('drop function if exists wallet_ledger_entries_append_only()');
    this.addSql('drop function if exists wager_transactions_guard()');
  }
}
