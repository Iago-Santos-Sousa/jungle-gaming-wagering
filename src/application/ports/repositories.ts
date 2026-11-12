import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface PendingReferenceClaim {
  transactionId: string;
  claimedUntil: Date;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findIdempotencyMatches(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
  claimDuePendingReferences(
    now: Date,
    limit: number,
    leaseMs: number,
  ): Promise<PendingReferenceClaim[]>;
  expeditePendingDependents(
    walletId: string,
    providerId: string,
    referenceExternalTransactionId: string,
    now: Date,
  ): Promise<number>;
}

export interface LedgerPageQuery {
  walletId: string;
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
  summarize(walletId: string): Promise<LedgerSummary | null>;
}

export interface InboxRepository {
  register(message: InboxMessage): Promise<InboxMessage | null>;
}

export interface OutboxClaim {
  leaseUntil: Date;
  messages: OutboxMessage[];
}

export interface OutboxFailure {
  message: OutboxMessage;
  error: string;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxClaim>;
  markPublished(
    messages: readonly OutboxMessage[],
    leaseUntil: Date,
  ): Promise<void>;
  scheduleRetries(
    failures: readonly OutboxFailure[],
    leaseUntil: Date,
  ): Promise<void>;
  releaseLease(
    messages: readonly OutboxMessage[],
    leaseUntil: Date,
  ): Promise<void>;
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
  abstract transactional<T>(
    work: (scope: RepositoryScope) => Promise<T>,
  ): Promise<T>;
  abstract read<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T>;
}
