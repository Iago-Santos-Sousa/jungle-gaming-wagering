import { Money } from "../../src/domain/money/money";
import { RetryPolicy } from "../../src/domain/shared/retry-policy";
import {
  WagerTransaction,
  WagerTransactionKind,
  computeWagerPayloadHash,
  type SubmittableKind,
  type WagerPayload,
} from "../../src/domain/wager-transaction/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";

export const NOW = new Date("2026-07-29T15:00:00.000Z");
export const PLAYER_ID = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
export const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

let sequence = 0;
export const nextId = (): string =>
  `00000000-0000-7000-8000-${String(++sequence).padStart(12, "0")}`;

export const brl = (amount: string): Money =>
  Money.from({ amount, currency: "BRL" });

export function openWallet(amount = "100.00", currency = "BRL"): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount, currency }),
    at: NOW,
  });
}

export function wagerPayload(
  overrides: Partial<WagerPayload> & { kind?: SubmittableKind } = {},
): WagerPayload {
  return {
    providerId: "provider-a",
    externalTransactionId: `tx-${++sequence}`,
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: brl("25.00"),
    ...overrides,
  };
}

export function buildTransaction(
  overrides: Partial<WagerPayload> & { kind?: SubmittableKind } = {},
): WagerTransaction {
  const payload = wagerPayload(overrides);
  return WagerTransaction.create({
    ...payload,
    id: nextId(),
    idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
    payloadHash: computeWagerPayloadHash(payload),
    createdAt: NOW,
  });
}

// Transação já aplicada, usada como referência de REFUND, ROLLBACK, WIN e LOSS
export function processedTransaction(
  overrides: Partial<WagerPayload> & { kind?: SubmittableKind } = {},
): WagerTransaction {
  const transaction = buildTransaction(overrides);
  transaction.markProcessed(undefined, NOW, brl("0.00"));
  return transaction;
}

export const referencePolicy = new RetryPolicy(1_000, 300_000, 10);
