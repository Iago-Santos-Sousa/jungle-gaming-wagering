import Decimal from "decimal.js";
import {
  CurrencyMismatchError,
  InvalidArgumentError,
} from "../shared/domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export const MONEY_SCALE = 2;

const MAX_INTEGER_DIGITS = 18;

export const AMOUNT_PATTERN = new RegExp(
  `^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${MONEY_SCALE}}$`,
);

export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});
type MoneyDecimal = InstanceType<typeof MoneyDecimal>;

const STORAGE_LIMIT = new MoneyDecimal(10).pow(MAX_INTEGER_DIGITS);

export class Money {
  private constructor(
    private readonly value: MoneyDecimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (
      typeof props?.amount !== "string" ||
      !AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new InvalidArgumentError(
        `Invalid amount "${String(props?.amount)}": expected a non-negative decimal string with exactly ${MONEY_SCALE} decimal places`,
      );
    }

    return new Money(
      new MoneyDecimal(props.amount),
      Money.assertCurrency(props.currency),
    );
  }

  static rehydrate(props: MoneyProps): Money {
    const amount =
      typeof props?.amount === "string" && props.amount.startsWith("-")
        ? props.amount.slice(1)
        : props?.amount;
    const money = Money.from({ amount, currency: props?.currency });
    return amount === props.amount ? money : money.negate();
  }

  static zero(currency: string): Money {
    return new Money(new MoneyDecimal(0), Money.assertCurrency(currency));
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidArgumentError(
        `Invalid currency "${String(currency)}": expected an ISO-4217 code`,
      );
    }

    return currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  exceedsStorageLimit(): boolean {
    return this.value.abs().greaterThanOrEqualTo(STORAGE_LIMIT);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return (this.value.isZero() ? new MoneyDecimal(0) : this.value).toFixed(
      MONEY_SCALE,
    );
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency)
      throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
