import { createHash } from "node:crypto";
import type { Action, Postback } from "./contracts.js";
import { parseAmount } from "./money.js";

export type Wallet = { currency: string; decimals: number; units: bigint };
export type LedgerEvent = {
  action: Exclude<Action, "balance">;
  id: string;
  playerId: string;
  currency: string;
  sessionId: string;
  roundId: string;
  gameId: string;
  fingerprint: string | null;
  amount: bigint;
  delta: bigint;
  reversed: boolean;
  errorCode: string | null;
};
export interface WalletTransaction {
  wallet(currency: string): Promise<Wallet>;
  updateWallet(wallet: Wallet): Promise<void>;
  event(action: string, id: string): Promise<LedgerEvent | null>;
  saveEvent(event: LedgerEvent): Promise<void>;
  refundCandidates(body: Postback): Promise<LedgerEvent[]>;
}
export class WalletError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const eventKey = (action: string, id: string) =>
  createHash("sha256")
    .update(JSON.stringify([action, id]))
    .digest("hex");
export function fingerprint(body: Postback) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action: body.action,
        player: body.player_id,
        currency: body.currency,
        session: body.session_id,
        game: body.game_uuid,
        round: body.round_id ?? "",
        amount: "amount" in body ? body.amount : null,
        bet: "bet_transaction_id" in body ? body.bet_transaction_id : null,
        items:
          "rollback_transactions" in body
            ? body.rollback_transactions
                .map((item) => [
                  item.type,
                  item.transaction_id,
                  item.currency ?? body.currency,
                  item.amount,
                ])
                .sort((a, b) =>
                  JSON.stringify(a).localeCompare(JSON.stringify(b)),
                )
            : null,
      }),
    )
    .digest("hex");
}
function assertOwner(
  event: LedgerEvent,
  body: Postback,
  currency = body.currency,
) {
  if (event.playerId !== body.player_id || event.currency !== currency)
    throw new WalletError("TRANSACTION_CONFLICT");
}
function record(body: Exclude<Postback, { action: "balance" }>): LedgerEvent {
  return {
    action: body.action,
    id: body.transaction_id,
    playerId: body.player_id,
    currency: body.currency,
    sessionId: body.session_id,
    roundId: body.round_id ?? "",
    gameId: body.game_uuid,
    fingerprint: fingerprint(body),
    amount: 0n,
    delta: 0n,
    reversed: false,
    errorCode: null,
  };
}
async function tombstone(
  tx: WalletTransaction,
  body: Postback,
  action: "bet" | "win" | "refund",
  id: string,
  currency: string,
) {
  await tx.saveEvent({
    action,
    id,
    playerId: body.player_id,
    currency,
    sessionId: body.session_id,
    roundId: body.round_id ?? "",
    gameId: body.game_uuid,
    fingerprint: null,
    amount: 0n,
    delta: 0n,
    reversed: true,
    errorCode: action === "bet" ? "TRANSACTION_CANCELLED" : null,
  });
}

// The repository locks the player row first, then commits balances and ledger entries together.
export async function applyPostback(
  tx: WalletTransaction,
  body: Postback,
  active: boolean,
) {
  const wallet = await tx.wallet(body.currency);
  if (body.action === "balance") return { wallet };
  const old = await tx.event(body.action, body.transaction_id);
  if (old) {
    assertOwner(old, body);
    if (old.fingerprint !== null && old.fingerprint !== fingerprint(body))
      throw new WalletError("TRANSACTION_CONFLICT");
    // A cancellation may arrive first. A later original must never change the wallet.
    return {
      wallet,
      errorCode: old.errorCode,
      transactionId: eventKey(old.action, old.id),
    };
  }
  const entry = record(body);
  if ("amount" in body) {
    try {
      entry.amount = parseAmount(body.amount, wallet.decimals);
    } catch {
      throw new WalletError("INVALID_AMOUNT");
    }
  }
  if (body.action === "bet") {
    if (!active) entry.errorCode = "PLAYER_BLOCKED";
    else if (wallet.units < entry.amount)
      entry.errorCode = "INSUFFICIENT_FUNDS";
    else entry.delta = -entry.amount;
  } else if (body.action === "win") {
    // Credits remain payable after logout, player suspension, and game removal.
    entry.delta = entry.amount;
  } else if (body.action === "refund") {
    let bet: LedgerEvent | null = null;
    if (body.bet_transaction_id) {
      bet = await tx.event("bet", body.bet_transaction_id);
      if (!bet)
        await tombstone(
          tx,
          body,
          "bet",
          body.bet_transaction_id,
          body.currency,
        );
    } else {
      // A nameless refund must be attributable before it can cancel a stake safely.
      const matches = await tx.refundCandidates(body);
      if (matches.length !== 1)
        throw new WalletError("REFUND_RECONCILIATION_REQUIRED");
      bet = matches[0]!;
    }
    if (bet) {
      assertOwner(bet, body);
      if (!bet.reversed && !bet.errorCode) {
        if (entry.amount > -bet.delta)
          throw new WalletError("REFUND_EXCEEDS_BET");
        entry.delta = entry.amount;
        bet.reversed = true;
        await tx.saveEvent(bet);
      }
    }
  } else {
    // Cancel each original at most once. Use recorded deltas, never the vendor's reversal amount.
    for (const item of body.rollback_transactions) {
      const currency = item.currency ?? body.currency;
      let target = ["bet", "win", "refund"].includes(item.type)
        ? await tx.event(item.type, item.transaction_id)
        : null;
      if (!["bet", "win", "refund"].includes(item.type)) {
        const matches = (
          await Promise.all(
            ["bet", "win", "refund"].map((type) =>
              tx.event(type, item.transaction_id),
            ),
          )
        ).filter((value): value is LedgerEvent => value !== null);
        if (matches.length > 1)
          throw new WalletError("ROLLBACK_RECONCILIATION_REQUIRED");
        target = matches[0] ?? null;
      }
      if (!target) {
        if (["bet", "win", "refund"].includes(item.type))
          await tombstone(
            tx,
            body,
            item.type as "bet" | "win" | "refund",
            item.transaction_id,
            currency,
          );
        else throw new WalletError("ROLLBACK_RECONCILIATION_REQUIRED");
        continue;
      }
      assertOwner(target, body, currency);
      if (target.reversed || target.errorCode) continue;
      const targetWallet =
        currency === wallet.currency ? wallet : await tx.wallet(currency);
      targetWallet.units -= target.delta;
      // Reversals of wins/refunds must succeed even if this leaves a negative test balance.
      await tx.updateWallet(targetWallet);
      target.reversed = true;
      await tx.saveEvent(target);
    }
  }
  wallet.units += entry.delta;
  await tx.updateWallet(wallet);
  await tx.saveEvent(entry);
  return {
    wallet,
    errorCode: entry.errorCode,
    transactionId: eventKey(entry.action, entry.id),
  };
}
