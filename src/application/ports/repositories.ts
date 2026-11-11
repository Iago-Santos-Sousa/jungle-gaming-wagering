import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  // Lock pessimista de linha (SELECT ... FOR UPDATE); exige transação aberta
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  // Lança WalletAlreadyExistsError se já houver wallet para playerId + currency
  insert(wallet: Wallet): Promise<void>;
  // Update condicionado à versão lida; lança ConcurrencyConflictError se outra escrita venceu
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  // Lança DuplicateTransactionError quando a idempotency key ou o id externo já existem
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
  findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
  // Antecipa a próxima tentativa das transações que aguardam esta referência na mesma wallet
  expeditePendingDependents(walletId: string, providerId: string, referenceExternalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerPageQuery {
  walletId: string;
  // Lançamentos com walletVersion menor que este valor (cursor exclusivo)
  beforeVersion?: number;
  limit: number;
}

export interface LedgerSummary {
  storedBalance: Money;
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
  // Saldo materializado e saldo reconstruído pelo ledger lidos num único snapshot
  summarize(walletId: string): Promise<LedgerSummary | null>;
}

export interface InboxRepository {
  // Retorna false se a mensagem já foi registrada (duplicata)
  tryInsert(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  // Reserva mensagens vencidas com lease (FOR UPDATE SKIP LOCKED), sem segurar transação aberta.
  // now vem do Clock da aplicação: agendamento e lease usam a mesma fonte de tempo.
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  // Marca o lote publicado com um único UPDATE
  markPublished(messages: readonly OutboxMessage[]): Promise<void>;
  scheduleRetry(message: OutboxMessage, error: string): Promise<void>;
  // Idade em segundos da mensagem pendente mais antiga (outbox lag)
  pendingLagSeconds(now: Date): Promise<number>;
}

export interface RepositoryScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

// Unidade de trabalho: tudo dentro de transactional() é confirmado junto ou nada é
export abstract class UnitOfWork {
  abstract transactional<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T>;
  // Leituras e comandos de statement único, sem transação explícita
  abstract read<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T>;
}
