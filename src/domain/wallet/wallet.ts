import { LedgerDirection } from '../ledger/ledger-direction';
import { Money } from '../money/money';
import { BalanceLimitExceededError, CurrencyMismatchError, InsufficientFundsError, InvalidArgumentError } from '../shared/domain-error';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceMovement {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  // Versão da wallet depois da movimentação; vira a posição do lançamento no ledger
  walletVersion: number;
}

export const INITIAL_WALLET_VERSION = 1;

// Aggregate root do saldo. Saldo nunca negativo e version só muda quando o saldo muda.
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new InvalidArgumentError('Initial balance cannot be negative');
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      INITIAL_WALLET_VERSION,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // Movimentação de abertura: crédito do saldo inicial sem incrementar version
  openingMovement(): BalanceMovement | undefined {
    if (this._version !== INITIAL_WALLET_VERSION || !this._balance.isPositive()) return undefined;
    return {
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      walletVersion: INITIAL_WALLET_VERSION,
    };
  }

  debit(money: Money, at: Date): BalanceMovement {
    return this.apply(LedgerDirection.Debit, money, at);
  }

  credit(money: Money, at: Date): BalanceMovement {
    return this.apply(LedgerDirection.Credit, money, at);
  }

  apply(direction: LedgerDirection, money: Money, at: Date): BalanceMovement {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new InvalidArgumentError('Movement amount must be positive');

    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Debit ? balanceBefore.subtract(money) : balanceBefore.add(money);
    if (balanceAfter.isNegative()) throw new InsufficientFundsError();
    if (balanceAfter.exceedsStorageLimit()) throw new BalanceLimitExceededError();

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return { direction, money, balanceBefore, balanceAfter, walletVersion: this._version };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
