import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, DuplicateTransactionError, WalletAlreadyExistsError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerPageQuery,
  LedgerRepository,
  LedgerSummary,
  OutboxClaim,
  OutboxFailure,
  OutboxRepository,
  PendingReferenceClaim,
  RepositoryScope,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { uniqueViolationConstraint } from './database-errors';
import { InboxMessageRecord, LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord, type OutboxMessageRow } from './entities';
import {
  fromLedgerEntry,
  fromOutboxMessage,
  fromWagerTransaction,
  fromWallet,
  toLedgerEntry,
  toOutboxMessage,
  toWagerTransaction,
  toWallet,
} from './mappers';

const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];
const IDEMPOTENCY_CONSTRAINTS = new Set(['wager_transactions_idempotency_key_uq', 'wager_transactions_provider_external_uq']);

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRecord, { id });
    return row ? toWallet(row) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    // refresh garante que o valor lido é o da linha travada, não um cache do identity map
    const row = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return row ? toWallet(row) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, fromWallet(wallet));
    } catch (error) {
      if (uniqueViolationConstraint(error) === 'wallets_player_currency_uq') throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      throw error;
    }
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new ConcurrencyConflictError(`Wallet ${wallet.id} changed concurrently (expected version ${expectedVersion})`);
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRecord, { id });
    return row ? toWagerTransaction(row) : null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return row ? toWagerTransaction(row) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRecord, { idempotencyKey });
    return row ? toWagerTransaction(row) : null;
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return row ? toWagerTransaction(row) : null;
  }

  async findIdempotencyMatches(idempotencyKey: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction[]> {
    // Cada ramo do OR é coberto por uma constraint unique, então o planner usa os dois índices
    const rows = await this.em.find(WagerTransactionRecord, { $or: [{ idempotencyKey }, { providerId, externalTransactionId }] });
    return rows.map(toWagerTransaction);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: REVERSAL_KINDS },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      // Savepoint (em.transactional aninhado): se a unique falhar, a transação externa continua utilizável
      // para conferir a causa antes de classificar o erro
      await this.em.transactional((em) => em.insert(WagerTransactionRecord, fromWagerTransaction(transaction)));
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint && IDEMPOTENCY_CONSTRAINTS.has(constraint)) {
        throw new DuplicateTransactionError(`Transaction ${transaction.idempotencyKey} inserted concurrently`);
      }
      // 'unknown': o driver não informou o nome. Só é corrida de idempotência se já existir outra transação com a
      // mesma key ou o mesmo id externo; qualquer outra unique (PK repetida, constraint futura) mantém o erro original.
      // A linha concorrente já está confirmada: uma violação de unique só acontece depois do commit da outra.
      if (constraint === 'unknown') {
        const matches = await this.findIdempotencyMatches(transaction.idempotencyKey, transaction.providerId, transaction.externalTransactionId);
        if (matches.some((match) => match.id !== transaction.id)) {
          throw new DuplicateTransactionError(`Transaction ${transaction.idempotencyKey} inserted concurrently`);
        }
      }
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const row = fromWagerTransaction(transaction);
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      {
        status: row.status,
        referenceTransactionId: row.referenceTransactionId,
        failureCode: row.failureCode,
        resultBalanceAmount: row.resultBalanceAmount,
        resultBalanceCurrency: row.resultBalanceCurrency,
        referenceAttempts: row.referenceAttempts,
        nextAttemptAt: row.nextAttemptAt,
        processedAt: row.processedAt,
      },
    );
  }

  async claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<PendingReferenceClaim[]> {
    const claimedUntil = new Date(now.getTime() + leaseMs);
    // SKIP LOCKED: instâncias concorrentes pegam conjuntos disjuntos, e o lease vencido torna a linha disponível de novo.
    // Usa o índice parcial de next_attempt_at em PENDING_REFERENCE.
    const rows = await this.em.execute<{ id: string }[]>(
      `update wager_transactions t
          set next_attempt_at = ?
        where t.id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE'
             and next_attempt_at <= ?
           order by next_attempt_at
           limit ?
           for update skip locked)
       returning t.id`,
      [claimedUntil, now, limit],
    );
    return rows.map((row) => ({ transactionId: row.id, claimedUntil }));
  }

  async expeditePendingDependents(walletId: string, providerId: string, referenceExternalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      { walletId, providerId, referenceExternalTransactionId, status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $gt: now } },
      { nextAttemptAt: now },
    );
  }
}

interface SummaryRow {
  stored_balance: string;
  currency: string;
  calculated_balance: string;
  entries: number | string;
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, fromLedgerEntry(entry));
  }

  async listByWallet({ walletId, beforeVersion, limit }: LedgerPageQuery): Promise<WalletLedgerEntry[]> {
    const where = beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: beforeVersion } };
    const rows = await this.em.find(LedgerEntryRecord, where, { orderBy: { walletVersion: 'desc' }, limit });
    return rows.map(toLedgerEntry);
  }

  async summarize(walletId: string): Promise<LedgerSummary | null> {
    // Um único statement: saldo materializado e soma do ledger vêm do mesmo snapshot
    const rows = await this.em.execute<SummaryRow[]>(
      `select w.balance_amount::text as stored_balance,
              w.currency,
              coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)::numeric(22,2)::text as calculated_balance,
              count(e.id) as entries
         from wallets w
         left join wallet_ledger_entries e on e.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return null;
    const currency = row.currency.trim();
    return {
      storedBalance: Money.rehydrate({ amount: row.stored_balance, currency }),
      calculatedBalance: Money.rehydrate({ amount: row.calculated_balance, currency }),
      entries: Number(row.entries),
    };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async register(message: InboxMessage): Promise<InboxMessage | null> {
    // ON CONFLICT DO NOTHING: uma entrega concorrente da mesma mensagem espera o commit da outra e vira duplicata
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    if (rows.length === 1) return null;

    const [existing] = await this.em.execute<{ payload_hash: string; received_at: Date; processed_at: Date | null }[]>(
      `select payload_hash, received_at, processed_at from inbox_messages where consumer_name = ? and message_id = ?`,
      [message.consumerName, message.messageId],
    );
    // Conflito sem linha visível só acontece se a outra entrega reverteu no meio: tentar de novo resolve
    if (!existing) throw new ConcurrencyConflictError(`Inbox message ${message.messageId} changed concurrently`);
    return InboxMessage.rehydrate({
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: existing.payload_hash.trim(),
      receivedAt: new Date(existing.received_at),
      processedAt: existing.processed_at ? new Date(existing.processed_at) : undefined,
    });
  }
}

interface RawOutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  locked_until: Date | null;
  published_at: Date | null;
  last_error: string | null;
  // bigint chega como string pelo driver pg
  sequence: string;
  is_head: boolean;
}

function fromRawOutbox(row: RawOutboxRow): OutboxMessageRow {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
    publishedAt: row.published_at ? new Date(row.published_at) : null,
    lastError: row.last_error,
    isHead: row.is_head,
  };
}

// Namespace dos advisory locks de agregado da outbox (forma de duas chaves int4, separada da chave bigint do boot)
const OUTBOX_AGGREGATE_LOCK_NAMESPACE = 7001;

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  // Serializa insert e promoção de cabeça do mesmo agregado. Sempre em ordem crescente, para não haver deadlock
  // entre transações que travam mais de um agregado; exige transação aberta (lock liberado no commit).
  private async lockAggregates(aggregateIds: readonly string[]): Promise<void> {
    const sorted = [...new Set(aggregateIds)].sort();
    if (sorted.length === 0) return;
    await this.em.execute(
      `select pg_advisory_xact_lock(?::int, hashtext(s.aggregate_id))
         from (select unnest(?::text[]) as aggregate_id order by 1) s`,
      [OUTBOX_AGGREGATE_LOCK_NAMESPACE, `{${sorted.join(',')}}`],
    );
  }

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const aggregateIds = [...new Set(messages.map((message) => message.aggregateId))];
    await this.lockAggregates(aggregateIds);
    // Agregado que já tem pendente mantém a cabeça atual; senão a primeira mensagem nova vira a cabeça
    const pending = await this.em.execute<{ aggregate_id: string }[]>(
      `select distinct aggregate_id from outbox_messages where published_at is null and aggregate_id = any(?::uuid[])`,
      [`{${aggregateIds.join(',')}}`],
    );
    const withHead = new Set(pending.map((row) => row.aggregate_id));
    const rows = messages.map((message) => {
      const isHead = !withHead.has(message.aggregateId);
      withHead.add(message.aggregateId);
      return fromOutboxMessage(message, isHead);
    });
    await this.em.insertMany(OutboxMessageRecord, rows);
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxClaim> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    // 1) Trava a cabeça de até `limit` agregados vencidos e livres. Só as cabeças estão no índice parcial
    //    outbox_messages_due_head_idx, então a varredura para no limit e nunca passa pelos eventos seguintes de um
    //    agregado com acúmulo. SKIP LOCKED faz publishers concorrentes pegarem agregados diferentes, e o FOR UPDATE
    //    reavalia o WHERE (published_at, is_head e lease) na versão mais nova da linha.
    const heads = await this.em.execute<{ aggregate_id: string }[]>(
      `select o.aggregate_id
         from outbox_messages o
        where o.published_at is null
          and o.is_head
          and o.next_attempt_at <= ?
          and (o.locked_until is null or o.locked_until < ?)
        order by o.next_attempt_at
        limit ?
        for update skip locked`,
      [now, now, limit],
    );
    if (heads.length === 0) return { leaseUntil, messages: [] };

    // 2) Reserva um prefixo de cada agregado, com teto total de `limit` mensagens. O LATERAL lê no máximo `limit`
    //    linhas de cada agregado pelo índice (aggregate_id, sequence), sem tocar no resto do acúmulo. Ordenar pela
    //    posição no agregado garante que toda cabeça entra; a cabeça com lease impede outro publisher de pegar o agregado.
    const rows = await this.em.execute<RawOutboxRow[]>(
      `with picked as (
         select x.id
           from unnest(?::uuid[]) as h(aggregate_id)
          cross join lateral (
            select id, sequence
              from outbox_messages
             where aggregate_id = h.aggregate_id
               and published_at is null
             order by sequence
             limit ?) x
          order by row_number() over (partition by h.aggregate_id order by x.sequence), x.id
          limit ?
       )
       update outbox_messages o
          set locked_until = ?
         from picked
        where o.id = picked.id
       returning o.*`,
      [`{${heads.map((head) => head.aggregate_id).join(',')}}`, limit, limit, leaseUntil],
    );
    // Ordem de publicação pela sequência do banco, nunca pelo relógio (occurred_at pode andar para trás)
    const messages = rows
      .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1))
      .map((row) => toOutboxMessage(fromRawOutbox(row)));
    return { leaseUntil, messages };
  }

  async markPublished(messages: readonly OutboxMessage[], leaseUntil: Date): Promise<void> {
    if (messages.length === 0) return;
    const aggregateIds = [...new Set(messages.map((message) => message.aggregateId))];
    await this.lockAggregates(aggregateIds);
    // Publicado é fato e sempre é gravado; o lease só é zerado se ainda for deste publisher
    await this.em.execute(
      `update outbox_messages
          set published_at = ?,
              is_head = false,
              last_error = null,
              locked_until = case when locked_until = ? then null else locked_until end
        where id = any(?::uuid[])
          and published_at is null`,
      [messages[0]?.publishedAt ?? new Date(), leaseUntil, `{${messages.map((message) => message.id).join(',')}}`],
    );
    // Promove a nova cabeça de cada agregado (a pendente de menor sequence), sob o mesmo advisory lock do insert
    await this.em.execute(
      `update outbox_messages
          set is_head = true
        where id in (
          select distinct on (aggregate_id) id
            from outbox_messages
           where published_at is null
             and aggregate_id = any(?::uuid[])
           order by aggregate_id, sequence)
          and not is_head`,
      [`{${aggregateIds.join(',')}}`],
    );
  }

  async scheduleRetries(failures: readonly OutboxFailure[], leaseUntil: Date): Promise<void> {
    if (failures.length === 0) return;
    // Um único UPDATE para o lote inteiro; sem efeito nas linhas cujo lease outro publisher assumiu
    const values = failures.map(() => '(?::uuid, ?::int, ?::timestamptz, ?::varchar)').join(', ');
    const params = failures.flatMap(({ message, error }) => [message.id, message.attempts, message.nextAttemptAt ?? new Date(), error.slice(0, 512)]);
    await this.em.execute(
      `update outbox_messages o
          set attempts = v.attempts,
              next_attempt_at = v.next_attempt_at,
              locked_until = null,
              last_error = v.last_error
         from (values ${values}) as v(id, attempts, next_attempt_at, last_error)
        where o.id = v.id
          and o.published_at is null
          and o.locked_until = ?`,
      [...params, leaseUntil],
    );
  }

  async releaseLease(messages: readonly OutboxMessage[], leaseUntil: Date): Promise<void> {
    if (messages.length === 0) return;
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: { $in: messages.map((message) => message.id) }, publishedAt: null, lockedUntil: leaseUntil },
      { lockedUntil: null },
    );
  }

  async pendingLagSeconds(now: Date): Promise<number> {
    const rows = await this.em.execute<{ lag: string | number | null }[]>(
      `select extract(epoch from (?::timestamptz - min(occurred_at))) as lag from outbox_messages where published_at is null`,
      [now],
    );
    const lag = Number(rows[0]?.lag ?? 0);
    return Number.isFinite(lag) && lag > 0 ? lag : 0;
  }
}

export class MikroOrmRepositoryScope implements RepositoryScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }
}
