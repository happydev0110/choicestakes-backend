import type { Postback } from "./contracts.js";
import { WalletError } from "./wallet.js";

// Longer than the provider request deadline, but never an open-ended fallback.
export const pendingBalanceWindowMs = 30_000;

export interface CallbackLaunch {
  id: string;
  playerId: string;
  gameId: string;
  currency: string;
  status: string;
  vendorSessionId: string | null;
}
export interface PendingCallbackLaunch extends CallbackLaunch {
  ageMs: number;
}
export interface CallbackSessions {
  bySession(sessionId: string): Promise<CallbackLaunch | null>;
  pending(body: Postback): Promise<PendingCallbackLaunch[]>;
}

export async function resolveCallbackSession(
  body: Postback,
  active: boolean,
  configuredCurrency: string,
  sessions: CallbackSessions,
): Promise<{ launchId: string; earlyBalance: boolean }> {
  const session = await sessions.bySession(body.session_id);
  if (session) {
    // A known but mismatched session must never fall through to a pending launch.
    if (session.vendorSessionId !== body.session_id)
      throw new WalletError("SESSION_ID_MISMATCH");
    if (session.playerId !== body.player_id)
      throw new WalletError("SESSION_PLAYER_MISMATCH");
    if (body.game_uuid && session.gameId !== body.game_uuid)
      throw new WalletError("SESSION_GAME_MISMATCH");
    if (!["refund", "rollback"].includes(body.action) && session.currency !== body.currency)
      throw new WalletError("SESSION_CURRENCY_MISMATCH");
    if (session.status !== "ready") throw new WalletError("SESSION_NOT_READY");
    return { launchId: session.id, earlyBalance: false };
  }

  // Some vendors ask for balance synchronously inside their launch request.
  // Only a read may precede the authoritative launch response/session binding.
  if (body.action !== "balance") throw new WalletError("SESSION_NOT_FOUND");
  if (!active) throw new WalletError("PLAYER_BLOCKED");
  if (body.currency !== configuredCurrency)
    throw new WalletError("SESSION_CURRENCY_MISMATCH");
  if (!body.game_uuid) throw new WalletError("PENDING_GAME_REQUIRED");
  const matching = (await sessions.pending(body)).filter((launch) =>
    launch.status === "pending" && launch.vendorSessionId === null &&
    launch.playerId === body.player_id && launch.gameId === body.game_uuid &&
    launch.currency === body.currency,
  );
  const recent = matching.filter((launch) =>
    Number.isFinite(launch.ageMs) && launch.ageMs >= 0 && launch.ageMs <= pendingBalanceWindowMs,
  );
  if (!recent.length)
    throw new WalletError(matching.length ? "PENDING_LAUNCH_EXPIRED" : "SESSION_NOT_FOUND");
  if (recent.length !== 1) throw new WalletError("PENDING_LAUNCH_AMBIGUOUS");
  return { launchId: recent[0]!.id, earlyBalance: true };
}
