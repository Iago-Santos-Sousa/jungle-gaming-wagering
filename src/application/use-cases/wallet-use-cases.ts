import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { eventsForOutcome } from '../../domain/events/wagering-events';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { InvalidCursorError, ResourceNotFoundError } from '../errors';
import { UnitOfWork } from '../ports/repositories';
import { Clock, IdGenerator, WageringMetrics } from '../ports/system';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

// Cria a wallet e, se houver saldo inicial, a transação OPENING e o crédito no ledger na mesma transação SQL
@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const now = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: command.playerId, initialBalance: command.initialBalance, at: now });

    await this.uow.transactional(async (scope) => {
      await scope.wallets.insert(wallet);
      const opening = wallet.openingMovement();
      if (!opening) return;

      const transaction = WagerTransaction.createOpening({ id: this.ids.next(), walletId: wallet.id, playerId: wallet.playerId, money: opening.money, createdAt: now });
      transaction.markProcessed(undefined, now, wallet.balance);
      const entry = WalletLedgerEntry.fromMovement({ id: this.ids.next(), walletId: wallet.id, transactionId: transaction.id, movement: opening, createdAt: now });
      const events = eventsForOutcome(transaction, wallet, entry, { newEventId: () => this.ids.next(), correlationId: command.correlationId, occurredAt: now });

      await scope.transactions.insert(transaction);
      await scope.ledger.insert(entry);
      await scope.outbox.add(events.map((event) => OutboxMessage.enqueue(event)));
    });

    if (wallet.openingMovement()) this.metrics.transactionDecided('OPENING', 'PROCESSED');
    return wallet;
  }
}

@Injectable()
export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((scope) => scope.wallets.findById(walletId));
    if (!wallet) throw new ResourceNotFoundError('Wallet', walletId);
    return wallet;
  }
}

export interface LedgerPage {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

// Cursor opaco e estável: codifica a walletVersion do último item (posição imutável no ledger)
export const LedgerCursor = {
  encode(walletVersion: number): string {
    return Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString('base64url');
  },
  decode(cursor: string): number {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      const version = typeof parsed === 'object' && parsed !== null && 'v' in parsed ? parsed.v : undefined;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new InvalidCursorError();
      return version;
    } catch {
      throw new InvalidCursorError();
    }
  },
};

@Injectable()
export class ListLedgerUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(query: { walletId: string; cursor?: string; limit: number }): Promise<LedgerPage> {
    const beforeVersion = query.cursor ? LedgerCursor.decode(query.cursor) : undefined;
    return this.uow.read(async (scope) => {
      const wallet = await scope.wallets.findById(query.walletId);
      if (!wallet) throw new ResourceNotFoundError('Wallet', query.walletId);
      // Busca limit + 1 para saber se existe próxima página sem um COUNT extra
      const rows = await scope.ledger.listByWallet({ walletId: query.walletId, beforeVersion, limit: query.limit + 1 });
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > query.limit && last ? LedgerCursor.encode(last.walletVersion) : null };
    });
  }
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

// Compara saldo materializado com o ledger. Divergência é logada, contabilizada e sinalizada, nunca corrigida.
@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: WageringMetrics,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ReconcileWalletUseCase.name);
  }

  async execute(walletId: string): Promise<ReconciliationReport> {
    const summary = await this.uow.read((scope) => scope.ledger.summarize(walletId));
    if (!summary) throw new ResourceNotFoundError('Wallet', walletId);

    const difference = summary.storedBalance.subtract(summary.calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.warn({ walletId, checkedEntries: summary.entries }, 'wallet balance diverges from ledger');
    }
    return {
      walletId,
      storedBalance: summary.storedBalance,
      calculatedBalance: summary.calculatedBalance,
      difference,
      consistent,
      checkedEntries: summary.entries,
    };
  }
}
