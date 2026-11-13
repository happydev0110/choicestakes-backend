import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { AuthStore } from "../src/modules/auth/types.js";
import {
  resolveCallbackSession,
  pendingBalanceWindowMs,
  type CallbackLaunch,
  type CallbackSessions,
  type PendingCallbackLaunch,
} from "../src/modules/gaming/callback-session.js";
import type { Postback } from "../src/modules/gaming/contracts.js";
import { ApiMaticError } from "../src/modules/gaming/provider-error.js";
import { signRequest } from "../src/modules/gaming/signing.js";
import type { GamingStore } from "../src/modules/gaming/store.js";
import { WalletError } from "../src/modules/gaming/wallet.js";

const balance: Postback = {
  action: "balance", type: "balance", player_id: randomUUID(), game_uuid: randomUUID(),
  currency: "USD", session_id: "vendor-session", transaction_id: "",
  transaction_datetime: "2026-11-13 15:49:38.219223", casino_request_retry_count: 0,
};
const pending: PendingCallbackLaunch = {
  id: randomUUID(), playerId: balance.player_id, gameId: balance.game_uuid,
  currency: "USD", status: "pending", vendorSessionId: null, ageMs: 100,
};
const ready: CallbackLaunch = { ...pending, status: "ready", vendorSessionId: balance.session_id };
const lookup = (session: CallbackLaunch | null = null, launches: PendingCallbackLaunch[] = [pending]): CallbackSessions => ({
  bySession: async () => session,
  pending: async () => launches,
});
const code = (expected: string) => (error: unknown) => error instanceof WalletError && error.code === expected;

test("a recent, unique pending launch can answer balance without becoming a confirmed session", async () => {
  const launch = Object.freeze({ ...pending });
  const result = await resolveCallbackSession(balance, true, "USD", lookup(null, [launch]));
  assert.deepEqual(result, { launchId: launch.id, earlyBalance: true });
  assert.equal(launch.status, "pending");
  assert.equal(launch.vendorSessionId, null);
  assert.deepEqual(await resolveCallbackSession(balance, true, "USD", lookup(ready)), {
    launchId: ready.id, earlyBalance: false,
  });
});

test("unknown sessions never authorize money-changing callbacks through a pending launch", async () => {
  for (const action of ["bet", "win", "refund", "rollback"] as const) {
    const body = { ...balance, action, type: action, amount: "10.00", transaction_id: "tx@sbx", bet_transaction_id: "bet@sbx", rollback_transactions: [] } as Postback;
    const sessions = lookup();
    sessions.pending = async () => assert.fail("Transaction callbacks must not consult pending launches");
    await assert.rejects(resolveCallbackSession(body, true, "USD", sessions), code("SESSION_NOT_FOUND"));
  }
});

test("expired, future-dated and ambiguous pending launches do not authorize balances", async () => {
  for (const ageMs of [pendingBalanceWindowMs + 1, -1, Number.NaN]) {
    await assert.rejects(resolveCallbackSession(balance, true, "USD", lookup(null, [{ ...pending, ageMs }])), code("PENDING_LAUNCH_EXPIRED"));
  }
  await assert.rejects(resolveCallbackSession(balance, true, "USD", lookup(null, [pending, { ...pending, id: randomUUID() }])), code("PENDING_LAUNCH_AMBIGUOUS"));
  assert.equal((await resolveCallbackSession(balance, true, "USD", lookup(null, [pending, { ...pending, ageMs: pendingBalanceWindowMs + 1 }]))).earlyBalance, true);
});

test("early balances require active players, exact game/currency and an unbound pending launch", async () => {
  await assert.rejects(resolveCallbackSession(balance, false, "USD", lookup()), code("PLAYER_BLOCKED"));
  await assert.rejects(resolveCallbackSession(balance, true, "EUR", lookup()), code("SESSION_CURRENCY_MISMATCH"));
  await assert.rejects(resolveCallbackSession({ ...balance, game_uuid: "" }, true, "USD", lookup()), code("PENDING_GAME_REQUIRED"));
  for (const change of [
    { playerId: randomUUID() }, { gameId: randomUUID() }, { currency: "EUR" },
    { status: "failed" }, { status: "ready" }, { vendorSessionId: "already-bound" },
  ]) {
    await assert.rejects(resolveCallbackSession(balance, true, "USD", lookup(null, [{ ...pending, ...change }])), code("SESSION_NOT_FOUND"));
  }
  await assert.rejects(resolveCallbackSession(balance, true, "USD", lookup(null, [])), code("SESSION_NOT_FOUND"));
});

test("known session mismatches are diagnosed and never bypassed by a matching pending launch", async () => {
  const cases: [Partial<CallbackLaunch>, string][] = [
    [{ vendorSessionId: "different" }, "SESSION_ID_MISMATCH"],
    [{ playerId: randomUUID() }, "SESSION_PLAYER_MISMATCH"],
    [{ gameId: randomUUID() }, "SESSION_GAME_MISMATCH"],
    [{ currency: "EUR" }, "SESSION_CURRENCY_MISMATCH"],
    [{ status: "pending" }, "SESSION_NOT_READY"],
    [{ status: "failed" }, "SESSION_NOT_READY"],
  ];
  for (const [change, expected] of cases) {
    const sessions = lookup({ ...ready, ...change });
    sessions.pending = async () => assert.fail("A known session must not fall back to pending");
    await assert.rejects(resolveCallbackSession(balance, true, "USD", sessions), code(expected));
  }
});

test("confirmed settlement still allows suspended players and refund/rollback currency differences", async () => {
  for (const action of ["win", "refund", "rollback"] as const) {
    const body = { ...balance, action, type: action, currency: action === "win" ? "USD" : "EUR" } as Postback;
    assert.equal((await resolveCallbackSession(body, false, "USD", lookup(ready))).earlyBalance, false);
  }
  assert.equal((await resolveCallbackSession({ ...balance, game_uuid: "" }, true, "USD", lookup(ready))).earlyBalance, false);
});

test("HTTP launch completes when the vendor waits for a signed balance callback before returning its session", async (t) => {
  const secret = "12".repeat(32);
  const config = loadConfig({ NODE_ENV: "test", DB_ENABLED: "true", MYSQL_USER: "test",
    APIMATIC_ENABLED: "true", APIMATIC_SYNC_ENABLED: "false", APIMATIC_API_KEY: "test-sandbox",
    APIMATIC_SECRET_KEY: secret, APIMATIC_CURRENCY: "USD",
    APIMATIC_CALLBACK_URL: "https://api.example.com/api/v1/provider/apimatic/sandbox" });
  let launch: PendingCallbackLaunch | null = null;
  let earlyReads = 0;
  const seenNonces = new Set<string>();
  const game = { uuid: balance.game_uuid, name: "Callback regression", code: "test", provider: "test", vendor: "test", imageUrl: null };
  // Lifecycle fixture: the SQL-backed version of this scenario is in gaming.mysql.ts.
  const store = {
    game: async () => game,
    claimLaunch: async () => { launch = { ...pending }; return launch.id; },
    completeLaunch: async (id: string, sessionId: string) => {
      assert.equal(earlyReads, 1);
      assert.equal(launch?.id, id);
      launch = { ...launch!, status: "ready", vendorSessionId: sessionId };
    },
    failLaunch: async (_id: string, errorCode: string) => assert.fail(errorCode),
    postback: async (body: Postback, nonceHash: string) => {
      const context = await resolveCallbackSession(body, true, "USD", lookup(
        launch?.vendorSessionId === body.session_id ? launch : null,
        launch ? [launch] : [],
      ));
      if (seenNonces.has(nonceHash)) throw new WalletError("REPLAY_DETECTED");
      seenNonces.add(nonceHash);
      if (context.earlyBalance) earlyReads++;
      return { wallet: { currency: "USD", units: 95312n, decimals: 2 }, earlyBalanceLaunchId: context.earlyBalance ? context.launchId : undefined };
    },
    issue: async () => {},
  } as unknown as GamingStore;
  const callbackPath = "/api/v1/provider/apimatic/sandbox";
  function signed(body: Postback) {
    const payload = JSON.stringify(body), nonce = randomUUID(), timestamp = Math.floor(Date.now() / 1000).toString();
    return { method: "POST" as const, url: callbackPath, payload, headers: {
      "content-type": "application/json", "x-timestamp": timestamp, "x-nonce": nonce,
      "x-sign": signRequest(secret, timestamp, nonce, "POST", callbackPath, payload),
    } };
  }
  const app = await buildApp(config, {
    database: { enabled: true, ping: async () => {}, close: async () => {} },
    authStore: { findSession: async () => ({ id: balance.player_id }) } as unknown as AuthStore,
    gamingStore: store,
    gamingClient: { async launch() {
      const forged = signed(balance);
      forged.payload += " ";
      assert.equal((await app.inject(forged)).statusCode, 401);
      assert.equal(earlyReads, 0);
      const request = signed(balance);
      const response = await app.inject(request);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { balance: 953.12 });
      assert.equal((await app.inject(request)).statusCode, 401, "nonce replay is rejected");
      const transaction = { ...balance, action: "bet", type: "bet", amount: "10.00", transaction_id: "before-ready@sbx" } as Postback;
      const refused = await app.inject(signed(transaction));
      assert.equal(refused.json().error_code, "SESSION_NOT_FOUND");
      return { sessionId: balance.session_id, link: "https://games.example.com/play" };
    } },
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/api/v1/gaming/games/${game.uuid}/launch`,
    headers: { origin: config.CORS_ORIGINS[0]!, "x-requested-with": "choicestakes", cookie: `choicestakes_session=${"a".repeat(43)}` },
    payload: { requestId: randomUUID(), mode: "real" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.environment, "sandbox");
  const after = await app.inject(signed(balance));
  assert.equal(after.statusCode, 200);
  assert.equal(after.json().balance, 953.12);
  assert.equal(earlyReads, 1, "post-launch balance uses the confirmed session");
});

test("failed launches persist the specific provider diagnostic while returning the safe public code", async (t) => {
  let savedCode = "";
  const config = loadConfig({ NODE_ENV: "test", DB_ENABLED: "true", MYSQL_USER: "test",
    APIMATIC_ENABLED: "true", APIMATIC_SYNC_ENABLED: "false", APIMATIC_API_KEY: "test-sandbox",
    APIMATIC_SECRET_KEY: "12".repeat(32), APIMATIC_CALLBACK_URL: "https://api.example.com/api/v1/provider/apimatic/sandbox" });
  const app = await buildApp(config, {
    database: { enabled: true, ping: async () => {}, close: async () => {} },
    authStore: { findSession: async () => ({ id: balance.player_id }) } as unknown as AuthStore,
    gamingStore: {
      game: async () => ({ uuid: balance.game_uuid }), claimLaunch: async () => pending.id,
      failLaunch: async (_id: string, value: string) => { savedCode = value; },
    } as unknown as GamingStore,
    gamingClient: { launch: async () => { throw new ApiMaticError(503, "VENDOR_ERROR"); } },
  });
  t.after(() => app.close());
  const result = await app.inject({ method: "POST", url: `/api/v1/gaming/games/${balance.game_uuid}/launch`,
    headers: { origin: config.CORS_ORIGINS[0]!, "x-requested-with": "choicestakes", cookie: `choicestakes_session=${"a".repeat(43)}` },
    payload: { requestId: randomUUID(), mode: "real" },
  });
  assert.equal(result.statusCode, 502);
  assert.equal(result.json().error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(savedCode, "VENDOR_ERROR");
});
