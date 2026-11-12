import { Money } from "../money/money";
import {
  InvalidArgumentError,
  UnbalancedLedgerEntryError,
} from "../shared/domain-error";
import type { BalanceMovement } from "../wallet/wallet";
import { LedgerDirection } from "./ledger-direction";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  // Valida a aritmética do lançamento antes de existir
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive())
      throw new InvalidArgumentError("Ledger entry amount must be positive");

    if (props.balanceAfter.isNegative())
      throw new InvalidArgumentError(
        "Ledger entry cannot leave a negative balance",
      );

    const entry = WalletLedgerEntry.rehydrate(props);

    if (!entry.isBalanced())
      throw new UnbalancedLedgerEntryError(
        "balanceBefore ± money must equal balanceAfter",
      );

    return entry;
  }

  static fromMovement(props: {
    id: string;
    walletId: string;
    transactionId: string;
    movement: BalanceMovement;
    createdAt: Date;
  }): WalletLedgerEntry {
    const { movement } = props;
    return WalletLedgerEntry.create({
      id: props.id,
      walletId: props.walletId,
      transactionId: props.transactionId,
      direction: movement.direction,
      money: movement.money,
      balanceBefore: movement.balanceBefore,
      balanceAfter: movement.balanceAfter,
      walletVersion: movement.walletVersion,
      createdAt: props.createdAt,
    });
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit
      ? this.money
      : this.money.negate();
  }
}
