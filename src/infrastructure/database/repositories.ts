import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, DuplicateTransactionError, WalletAlreadyExistsError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerPageQuery,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  RepositoryScope,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
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
      await this.em.insert(WagerTransactionRecord, fromWagerTransaction(transaction));
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint && IDEMPOTENCY_CONSTRAINTS.has(constraint)) {
        throw new DuplicateTransactionError(`Transaction ${transaction.idempotencyKey} inserted concurrently`);
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

  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { fields: ['id'], orderBy: { nextAttemptAt: 'asc' }, limit },
    );
    return rows.map((row) => row.id);
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

  async tryInsert(message: InboxMessage): Promise<boolean> {
    // ON CONFLICT DO NOTHING: uma entrega concorrente da mesma mensagem espera o commit da outra e vira duplicata
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
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
  };
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(fromOutboxMessage));
  }

  async claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    // Tempo do banco: leases comparáveis entre instâncias mesmo com relógios diferentes
    const rows = await this.em.execute<RawOutboxRow[]>(
      `update outbox_messages o
          set locked_until = now() + (? * interval '1 millisecond')
        where o.id in (
          select id from outbox_messages
           where published_at is null
             and next_attempt_at <= now()
             and (locked_until is null or locked_until < now())
           order by next_attempt_at
           limit ?
           for update skip locked)
       returning o.*`,
      [leaseMs, limit],
    );
    return rows.map((row) => toOutboxMessage(fromRawOutbox(row))).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id, publishedAt: null },
      { publishedAt: message.publishedAt ?? new Date(), lockedUntil: null, lastError: null },
    );
  }

  async scheduleRetry(message: OutboxMessage, error: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id, publishedAt: null },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt ?? new Date(), lockedUntil: null, lastError: error.slice(0, 512) },
    );
  }

  async pendingLagSeconds(): Promise<number> {
    const rows = await this.em.execute<{ lag: string | number | null }[]>(
      `select extract(epoch from (now() - min(occurred_at))) as lag from outbox_messages where published_at is null`,
    );
    const lag = Number(rows[0]?.lag ?? 0);
    return Number.isFinite(lag) && lag > 0 ? lag : 0;
  }
}

// Conjunto de repositórios ligados a um mesmo EntityManager (e portanto à mesma transação)
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
