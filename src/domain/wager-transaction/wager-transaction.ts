import { LedgerDirection, invertDirection } from "../ledger/ledger-direction";
import { Money } from "../money/money";
import {
  InvalidArgumentError,
  InvalidTransactionStateError,
} from "../shared/domain-error";
import { hashPayload } from "../shared/payload-hash";
import { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const ALLOWED_REFERENCE_KINDS: Readonly<
  Record<WagerTransactionKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export const INTERNAL_PROVIDER_ID = "internal";

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface CreateWagerTransactionProps extends WagerPayload {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  resultBalance: Money | undefined;
  referenceAttempts: number;
  nextAttemptAt: Date | undefined;
}

export type ReferenceCheck =
  | { outcome: "resolved"; reference: WagerTransaction }
  | { outcome: "missing" }
  | { outcome: "invalid"; failureCode: FailureCode };

export function computeInboxPayloadHash(
  payload: WagerPayload & { idempotencyKey: string },
): string {
  return hashPayload({
    idempotencyKey: payload.idempotencyKey,
    wagerPayloadHash: computeWagerPayloadHash(payload),
  });
}

export function computeWagerPayloadHash(payload: WagerPayload): string {
  return hashPayload({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.toString(),
      currency: payload.money.currency,
    },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}

// Transação de aposta com transições explícitas.
// PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
// PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
// PROCESSED, REJECTED e FAILED são terminais.
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    // Saldo observado no momento da decisão; devolvido em replays
    private _resultBalance?: Money,
    private _referenceAttempts = 0,
    private _nextAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(props.kind))
      throw new InvalidArgumentError(
        `Kind ${String(props.kind)} cannot be submitted`,
      );

    if (props.providerId === INTERNAL_PROVIDER_ID)
      throw new InvalidArgumentError("Provider id is reserved");

    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new InvalidArgumentError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidArgumentError("A transaction cannot reference itself");
    }

    // LOSS só registra resultado e aceita zero; os demais movimentam saldo e exigem valor positivo
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidArgumentError(
        `${props.kind} amount must be greater than zero`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive())
      throw new InvalidArgumentError(
        "Opening amount must be greater than zero",
      );

    const externalTransactionId = `opening:${props.walletId}`;

    return new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      externalTransactionId,
      `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
      hashPayload({
        walletId: props.walletId,
        playerId: props.playerId,
        kind: WagerTransactionKind.Opening,
        money: {
          amount: props.money.toString(),
          currency: props.money.currency,
        },
      }),
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    resultBalance: Money,
  ): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextAttemptAt = undefined;
  }

  // Cada chamada conta uma tentativa de resolver a referência
  markPendingReference(nextAttemptAt: Date, observedBalance: Money): void {
    this.assertNotTerminal("markPendingReference");
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._resultBalance = observedBalance;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.isReversal();
  }

  isReversal(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback:
        if (!reference)
          throw new InvalidArgumentError(
            "ROLLBACK direction depends on its reference",
          );

        return invertDirection(reference.ledgerDirectionFor());

      case WagerTransactionKind.Loss:
        throw new InvalidArgumentError("LOSS does not move balance");
    }
  }

  checkReference(
    reference: WagerTransaction | null | undefined,
  ): ReferenceCheck {
    // Referência ainda não aplicada equivale a ausente: será resolvida depois
    if (
      !reference ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { outcome: "missing" };
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return {
        outcome: "invalid",
        failureCode: FailureCode.ReferenceNotProcessed,
      };
    }

    if (!ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind)) {
      return {
        outcome: "invalid",
        failureCode: FailureCode.ReferenceInvalidKind,
      };
    }

    const sameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId &&
      reference.money.currency === this.money.currency;

    if (!sameContext)
      return { outcome: "invalid", failureCode: FailureCode.ReferenceMismatch };

    // Reversão parcial está fora de escopo: valor deve ser igual ao da referência
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return { outcome: "invalid", failureCode: FailureCode.AmountMismatch };
    }

    return { outcome: "resolved", reference };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${transition}: transaction ${this.id} is already ${this._status}`,
      );
    }
  }
}
