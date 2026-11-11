import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { eventsForOutcome } from '../../domain/events/wagering-events';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { RetryPolicy } from '../../domain/shared/retry-policy';
import { FailureCode } from '../../domain/wager-transaction/failure-code';
import { settleWagerTransaction } from '../../domain/wager-transaction/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionStatus,
  computeWagerPayloadHash,
  type WagerPayload,
} from '../../domain/wager-transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { ConcurrencyConflictError, DuplicateTransactionError, IdempotencyConflictError, ResourceNotFoundError } from '../errors';
import { UnitOfWork, type RepositoryScope } from '../ports/repositories';
import { Clock, IdGenerator, WageringMetrics, type MetricSource } from '../ports/system';

// Política de tentativas para resolver referências fora de ordem (configurável por ambiente)
export const REFERENCE_RETRY_POLICY = Symbol('REFERENCE_RETRY_POLICY');

// Tentativas totais em conflito de lock ou corrida de inserção antes de devolver erro transitório
const MAX_TRANSACTION_ATTEMPTS = 3;

export interface SubmitWagerCommand extends WagerPayload {
  idempotencyKey: string;
}

export interface SubmitContext {
  source: MetricSource;
  correlationId: string;
  causationId?: string;
  // Presente quando a entrada é SQS: deduplicação persistente por (consumerName, messageId)
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface WagerOutcome {
  transactionId: string | null;
  status: WagerTransactionStatus;
  balance: Money | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
  // Mensagem já registrada no inbox: efeito já aplicado por uma entrega anterior
  duplicateMessage: boolean;
}

function outcomeOf(transaction: WagerTransaction, idempotentReplay: boolean, duplicateMessage = false): WagerOutcome {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.resultBalance ?? null,
    failureCode: transaction.failureCode ?? null,
    idempotentReplay,
    duplicateMessage,
  };
}

// Aplica a decisão de domínio e persiste transação, ledger, wallet e outbox no escopo transacional recebido.
// Compartilhado pela entrada HTTP, pelo consumer SQS e pelo worker de referências pendentes.
@Injectable()
export class WagerSettlementWriter {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    @Inject(REFERENCE_RETRY_POLICY) private readonly referencePolicy: RetryPolicy,
  ) {}

  async settle(scope: RepositoryScope, transaction: WagerTransaction, wallet: Wallet, isNew: boolean, ctx: { correlationId: string; causationId?: string }): Promise<void> {
    const now = this.clock.now();
    const reference = transaction.referenceExternalTransactionId
      ? await scope.transactions.findByProviderExternalId(transaction.providerId, transaction.referenceExternalTransactionId)
      : null;
    const referenceAlreadyReversed = reference && transaction.isReversal() ? await scope.transactions.hasProcessedReversal(reference.id) : false;
    const expectedVersion = wallet.version;

    const { ledgerEntry } = settleWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      referencePolicy: this.referencePolicy,
      now,
      newLedgerEntryId: () => this.ids.next(),
    });

    if (isNew) await scope.transactions.insert(transaction);
    else await scope.transactions.update(transaction);

    if (ledgerEntry) {
      await scope.ledger.insert(ledgerEntry);
      await scope.wallets.update(wallet, expectedVersion);
    }
    // Quem esperava por esta transação como referência é reprocessado já no próximo ciclo do worker
    if (transaction.status === WagerTransactionStatus.Processed) {
      await scope.transactions.expeditePendingDependents(wallet.id, transaction.providerId, transaction.externalTransactionId, now);
    }

    const events = eventsForOutcome(transaction, wallet, ledgerEntry, { newEventId: () => this.ids.next(), occurredAt: now, ...ctx });
    await scope.outbox.add(events.map((event) => OutboxMessage.enqueue(event)));
  }
}

// Executa a unidade de trabalho com novas tentativas limitadas para conflitos transitórios
async function withConflictRetry<T>(metrics: WageringMetrics, component: string, work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const retryable = error instanceof ConcurrencyConflictError || error instanceof DuplicateTransactionError;
      if (error instanceof ConcurrencyConflictError) metrics.lockConflict();
      if (!retryable || attempt >= MAX_TRANSACTION_ATTEMPTS) throw error;
      metrics.retry(component);
      // Pequeno atraso aleatório para dessincronizar disputas pela mesma wallet
      await Bun.sleep(5 + Math.floor(Math.random() * 20 * attempt));
    }
  }
}

// Caso de uso único para a entrada HTTP e para o consumer SQS
@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
    private readonly writer: WagerSettlementWriter,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(SubmitWagerTransactionUseCase.name);
  }

  async execute(command: SubmitWagerCommand, ctx: SubmitContext): Promise<WagerOutcome> {
    const startedAt = performance.now();
    const payloadHash = computeWagerPayloadHash(command);
    try {
      const outcome = await withConflictRetry(this.metrics, 'submit', () => this.uow.transactional((scope) => this.process(scope, command, payloadHash, ctx)));
      // Métrica e log só depois do commit; replays não contam como nova decisão
      if (!outcome.idempotentReplay) this.metrics.transactionDecided(command.kind, outcome.status);
      this.logger.info(
        {
          source: ctx.source,
          correlationId: ctx.correlationId,
          messageId: ctx.inbox?.messageId,
          transactionId: outcome.transactionId,
          walletId: command.walletId,
          providerId: command.providerId,
          kind: command.kind,
          status: outcome.status,
          failureCode: outcome.failureCode,
          idempotentReplay: outcome.idempotentReplay,
        },
        'wager transaction decided',
      );
      return outcome;
    } finally {
      this.metrics.processingDuration(ctx.source, (performance.now() - startedAt) / 1000);
    }
  }

  private async process(scope: RepositoryScope, command: SubmitWagerCommand, payloadHash: string, ctx: SubmitContext): Promise<WagerOutcome> {
    const now = this.clock.now();

    if (ctx.inbox) {
      const inbox = InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
      inbox.markProcessed(now);
      const fresh = await scope.inbox.tryInsert(inbox);
      if (!fresh) {
        this.metrics.duplicateDetected('inbox');
        const previous = await scope.transactions.findByIdempotencyKey(command.idempotencyKey);
        return previous ? outcomeOf(previous, true, true) : this.walletNotFound(true);
      }
    }

    // Lock da wallet antes de olhar a idempotência: duplicatas concorrentes são serializadas aqui
    const wallet = await scope.wallets.findByIdForUpdate(command.walletId);

    const existing = await scope.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) throw new IdempotencyConflictError('Idempotency-Key already used with a different payload');
      this.metrics.duplicateDetected(ctx.source);
      return outcomeOf(existing, true);
    }
    const sameExternalId = await scope.transactions.findByProviderExternalId(command.providerId, command.externalTransactionId);
    if (sameExternalId) throw new IdempotencyConflictError('externalTransactionId already used with a different Idempotency-Key');

    // Sem wallet não há onde persistir a transação (FK): rejeição explícita, sem efeito
    if (!wallet) return this.walletNotFound(false);

    const transaction = WagerTransaction.create({ ...command, id: this.ids.next(), payloadHash, createdAt: now });
    await this.writer.settle(scope, transaction, wallet, true, { correlationId: ctx.correlationId, causationId: ctx.causationId });
    return outcomeOf(transaction, false);
  }

  private walletNotFound(duplicateMessage: boolean): WagerOutcome {
    return {
      transactionId: null,
      status: WagerTransactionStatus.Rejected,
      balance: null,
      failureCode: FailureCode.WalletNotFound,
      idempotentReplay: duplicateMessage,
      duplicateMessage,
    };
  }
}

// Reprocessa uma transação PENDING_REFERENCE: chamado pelo worker agendado
@Injectable()
export class ReprocessPendingReferenceUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly writer: WagerSettlementWriter,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ReprocessPendingReferenceUseCase.name);
  }

  findDue(limit: number): Promise<string[]> {
    return this.uow.read((scope) => scope.transactions.findDuePendingReferenceIds(this.clock.now(), limit));
  }

  async execute(transactionId: string): Promise<WagerTransactionStatus | null> {
    const transaction = await withConflictRetry(this.metrics, 'pending-reference', () =>
      this.uow.transactional(async (scope) => {
        const snapshot = await scope.transactions.findById(transactionId);
        if (snapshot?.status !== WagerTransactionStatus.PendingReference) return null;

        // Mesma ordem de locks do fluxo de submissão (wallet e depois transação), sem risco de deadlock
        const wallet = await scope.wallets.findByIdForUpdate(snapshot.walletId);
        const locked = await scope.transactions.findByIdForUpdate(transactionId);
        const now = this.clock.now();
        // Outra instância já decidiu ou a próxima tentativa ainda não venceu
        if (!wallet || locked?.status !== WagerTransactionStatus.PendingReference) return null;
        if (locked.nextAttemptAt && locked.nextAttemptAt.getTime() > now.getTime()) return null;

        await this.writer.settle(scope, locked, wallet, false, { correlationId: locked.id, causationId: locked.id });
        return locked;
      }),
    );
    if (!transaction) return null;

    // Nova tentativa ainda pendente não é decisão nova; terminal conta uma vez
    if (transaction.isTerminal()) this.metrics.transactionDecided(transaction.kind, transaction.status);
    this.logger.info(
      {
        correlationId: transaction.id,
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        status: transaction.status,
        failureCode: transaction.failureCode,
        attempts: transaction.referenceAttempts,
      },
      'pending reference reprocessed',
    );
    return transaction.status;
  }

  // Erro permanente de infraestrutura: registra FAILED para auditoria em vez de tentar para sempre
  async failPermanently(transactionId: string): Promise<void> {
    const failed = await this.uow.transactional(async (scope) => {
      const snapshot = await scope.transactions.findById(transactionId);
      if (snapshot?.status !== WagerTransactionStatus.PendingReference) return null;
      await scope.wallets.findByIdForUpdate(snapshot.walletId);
      const transaction = await scope.transactions.findByIdForUpdate(transactionId);
      if (transaction?.status !== WagerTransactionStatus.PendingReference) return null;
      transaction.fail(FailureCode.InternalError, this.clock.now());
      await scope.transactions.update(transaction);
      return transaction;
    });
    if (failed) this.metrics.transactionDecided(failed.kind, failed.status);
  }
}

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.uow.read((scope) => scope.transactions.findById(transactionId));
    if (!transaction) throw new ResourceNotFoundError('Transaction', transactionId);
    return transaction;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.uow.read((scope) => scope.transactions.findByProviderExternalId(providerId, externalTransactionId));
    if (!transaction) throw new ResourceNotFoundError('Transaction', `${providerId}/${externalTransactionId}`);
    return transaction;
  }
}
