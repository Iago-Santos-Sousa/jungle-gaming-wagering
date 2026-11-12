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

export interface PendingReferenceClaim {
  transactionId: string;
  claimedUntil: Date;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  // Uma única consulta pelas duas chaves únicas de idempotência; devolve no máximo 2 transações
  findIdempotencyMatches(idempotencyKey: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction[]>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  // Lança DuplicateTransactionError quando a idempotency key ou o id externo já existem
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
  // Reserva transações PENDING_REFERENCE vencidas (FOR UPDATE SKIP LOCKED) empurrando next_attempt_at para o fim do lease.
  // O claimedUntil devolvido funciona como token: só quem reservou processa enquanto o valor não mudar.
  claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<PendingReferenceClaim[]>;
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
  // Registra a mensagem. Retorna null se for nova, ou o registro já existente se for duplicata.
  register(message: InboxMessage): Promise<InboxMessage | null>;
}

// Lote reservado por um publisher. leaseUntil é o token do lease: só quem reservou libera ou reagenda essas linhas.
export interface OutboxClaim {
  leaseUntil: Date;
  // Em ordem de publicação (sequence), com um prefixo de cada agregado
  messages: OutboxMessage[];
}

export interface OutboxFailure {
  // Já com attempts e nextAttemptAt recalculados pelo domínio (scheduleRetry)
  message: OutboxMessage;
  error: string;
}

export interface OutboxRepository {
  // Exige transação: mantém a cabeça de cada agregado sob advisory lock, na mesma transação do efeito financeiro
  add(messages: readonly OutboxMessage[]): Promise<void>;
  // Reserva com lease até `limit` mensagens de agregados cuja mensagem mais antiga está vencida e livre, sempre um
  // prefixo de cada agregado. Um agregado fica com um único publisher por vez, o que preserva a ordem por agregado.
  // Exige transação (FOR UPDATE). now vem do Clock da aplicação: agendamento e lease usam a mesma fonte de tempo.
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxClaim>;
  // Marca o lote publicado com um único UPDATE e promove a próxima cabeça de cada agregado. Exige transação.
  // O lease só é liberado se ainda for deste publisher.
  markPublished(messages: readonly OutboxMessage[], leaseUntil: Date): Promise<void>;
  // Falhas reais do lote num único UPDATE: grava tentativas e backoff, só onde o lease ainda é deste publisher
  scheduleRetries(failures: readonly OutboxFailure[], leaseUntil: Date): Promise<void>;
  // Mensagens não enviadas por bloqueio do agregado: devolve sem mexer em tentativas, backoff nem last_error
  releaseLease(messages: readonly OutboxMessage[], leaseUntil: Date): Promise<void>;
  pendingLagSeconds(now: Date): Promise<number>;
}

export interface RepositoryScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export abstract class UnitOfWork {
  abstract transactional<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T>;
  // Leituras e comandos de statement único, sem transação explícita
  abstract read<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T>;
}
