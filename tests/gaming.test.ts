import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { signRequest, verifyPostback } from "../src/modules/gaming/signing.js";
import {
  parseAmount,
  formatAmount,
  callbackReply,
} from "../src/modules/gaming/money.js";
import { ApiMaticClient, safePlayLink } from "../src/modules/gaming/client.js";
import {
  ApiMaticError,
  providerDiagnostic,
} from "../src/modules/gaming/provider-error.js";
import { requireSandboxCredentials } from "../src/modules/gaming/config.js";
import type { GamingStore } from "../src/modules/gaming/store.js";
import type { AuthStore } from "../src/modules/auth/types.js";
import { loadConfig } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import {
  applyPostback,
  eventKey,
  type LedgerEvent,
  type Wallet,
  type WalletTransaction,
} from "../src/modules/gaming/wallet.js";
import type { Postback } from "../src/modules/gaming/contracts.js";

const secret =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
test("request signing matches the provider known-answer vectors and verifies raw bytes", () => {
  assert.equal(
    signRequest(
      secret,
      "1790604000",
      "7f3c9a1e2b4d4e6f8a0b1c2d3e4f5a6b",
      "GET",
      "/api/v1/games?currency=EUR",
      "",
    ),
    "cfedb7e4f48fbfd7cfcdc3e3d4c3702b15bd365d6c67fb4b8f00bc63b6c788ba",
  );
  assert.equal(
    signRequest(
      secret,
      "1790604000",
      "0b6e2f4a9c1d4e7f8a3b5c6d7e8f9a0b",
      "POST",
      "/api/v1/game/launch",
      '{"player_id":"player-1042","currency":"EUR","lang":"en"}',
    ),
    "1ca8940a212df7f27a5ee40b27b37ba06e9f90a08871028c98056050c9e9f0ff",
  );
  const now = Date.now(),
    timestamp = Math.floor(now / 1000).toString(),
    raw = Buffer.from('{ "action": "balance" }');
  const headers = {
    "x-timestamp": timestamp,
    "x-nonce": "unique",
    "x-sign": signRequest(
      secret,
      timestamp,
      "unique",
      "POST",
      "/callback",
      raw,
    ),
  };
  assert.ok(verifyPostback(secret, headers, "/callback", raw, now));
  assert.equal(
    verifyPostback(
      secret,
      headers,
      "/callback",
      Buffer.from('{"action":"balance"}'),
      now,
    ),
    null,
  );
  assert.equal(
    verifyPostback(secret, headers, "/callback", raw, now + 301000),
    null,
  );
  assert.equal(
    verifyPostback(
      secret,
      { ...headers, "x-sign": headers["x-sign"].toUpperCase() },
      "/callback",
      raw,
      now,
    ),
    null,
  );
});
test("money supports exact two/three decimal values and numeric JSON without float arithmetic", () => {
  assert.equal(parseAmount("1.250", 3), 1250n);
  assert.equal(parseAmount("1000", 2, true), 100000n);
  assert.equal(formatAmount(-1250n, 3), "-1.250");
  assert.equal(callbackReply(125405n, 3), '{"balance":125.405}');
  assert.throws(() => parseAmount("1.250", 2));
  assert.throws(() => parseAmount("-1.00", 2));
  assert.throws(() => parseAmount("1e3", 2));
});

class MemoryWallet implements WalletTransaction {
  balances = new Map<string, Wallet>([
    ["EUR", { currency: "EUR", decimals: 2, units: 10000n }],
    ["TND", { currency: "TND", decimals: 3, units: 10000n }],
  ]);
  events = new Map<string, LedgerEvent>();
  async wallet(currency: string) {
    const value = this.balances.get(currency);
    if (!value) throw new Error("WALLET_NOT_FOUND");
    return { ...value };
  }
  async updateWallet(wallet: Wallet) {
    this.balances.set(wallet.currency, { ...wallet });
  }
  async event(action: string, id: string) {
    const value = this.events.get(eventKey(action, id));
    return value ? { ...value } : null;
  }
  async saveEvent(event: LedgerEvent) {
    this.events.set(eventKey(event.action, event.id), { ...event });
  }
  async refundCandidates(body: Postback) {
    return [...this.events.values()]
      .filter(
        (event) =>
          event.action === "bet" &&
          event.playerId === body.player_id &&
          event.currency === body.currency &&
          event.roundId === body.round_id,
      )
      .map((value) => ({ ...value }));
  }
}
const common = {
  type: "balance" as const,
  player_id: randomUUID(),
  session_id: "session",
  game_uuid: randomUUID(),
  currency: "EUR",
  transaction_id: "",
  round_id: "round@sbx",
  transaction_datetime: "2026-11-06 10:00:00.000000",
  casino_request_retry_count: 0,
};
const bet = (id = "bet@sbx", amount = "10.00"): Postback => ({
  ...common,
  action: "bet",
  type: "bet",
  transaction_id: id,
  amount,
});
const win = (id = "win@sbx", amount = "25.00"): Postback => ({
  ...common,
  action: "win",
  type: "win",
  transaction_id: id,
  amount,
});
const refund = (
  id = "refund@sbx",
  betId = "bet@sbx",
  amount = "10.00",
): Postback => ({
  ...common,
  action: "refund",
  type: "refund",
  transaction_id: id,
  bet_transaction_id: betId,
  amount,
});
const rollback = (
  id: string,
  items: {
    type: string;
    transaction_id: string;
    amount: string;
    currency?: string;
  }[],
): Postback => ({
  ...common,
  action: "rollback",
  type: "rollback",
  transaction_id: id,
  rollback_transactions: items,
});

test("bets and wins are idempotent, insufficient-funds refusals remain refused, conflicting retries fail", async () => {
  const tx = new MemoryWallet();
  await applyPostback(tx, bet(), true);
  await applyPostback(tx, bet(), true);
  assert.equal((await tx.wallet("EUR")).units, 9000n);
  await assert.rejects(
    applyPostback(tx, bet("bet@sbx", "11.00"), true),
    /TRANSACTION_CONFLICT/,
  );
  const refused = bet("expensive@sbx", "200.00");
  assert.equal(
    (await applyPostback(tx, refused, true)).errorCode,
    "INSUFFICIENT_FUNDS",
  );
  await applyPostback(tx, win("large@sbx", "500.00"), false);
  assert.equal(
    (await applyPostback(tx, refused, true)).errorCode,
    "INSUFFICIENT_FUNDS",
  );
  assert.equal((await tx.wallet("EUR")).units, 59000n);
});
test("refunds and rollback never return the same stake twice; partial refunds are checked", async () => {
  const tx = new MemoryWallet();
  await applyPostback(tx, bet(), true);
  await applyPostback(tx, refund(), true);
  await applyPostback(tx, refund(), true);
  await applyPostback(
    tx,
    rollback("rb@sbx", [
      { type: "bet", transaction_id: "bet@sbx", amount: "999.00" },
    ]),
    true,
  );
  assert.equal((await tx.wallet("EUR")).units, 10000n);
  await applyPostback(tx, bet("partial@sbx"), true);
  await applyPostback(tx, refund("part-ref@sbx", "partial@sbx", "2.00"), true);
  assert.equal((await tx.wallet("EUR")).units, 9200n);
  await applyPostback(tx, bet("small@sbx", "1.00"), true);
  await assert.rejects(
    applyPostback(tx, refund("too-big@sbx", "small@sbx", "2.00"), true),
    /REFUND_EXCEEDS_BET/,
  );
});
test("out-of-order cancellations suppress late originals and repeated rollbacks", async () => {
  const tx = new MemoryWallet();
  await applyPostback(tx, refund(), true);
  assert.equal(
    (await applyPostback(tx, bet(), true)).errorCode,
    "TRANSACTION_CANCELLED",
  );
  const cancel = rollback("rb-win@sbx", [
    { type: "win", transaction_id: "win@sbx", amount: "25.00" },
  ]);
  await applyPostback(tx, cancel, true);
  await applyPostback(tx, win(), true);
  await applyPostback(tx, cancel, true);
  assert.equal((await tx.wallet("EUR")).units, 10000n);
});
test("rollback uses recorded amounts and supports historical three-decimal wallets", async () => {
  const tx = new MemoryWallet();
  await applyPostback(tx, win("win@sbx", "200.00"), true);
  await applyPostback(tx, bet("spend@sbx", "300.00"), true);
  await applyPostback(
    tx,
    { ...win("tnd@sbx", "1.250"), currency: "TND" },
    true,
  );
  await applyPostback(
    tx,
    rollback("rb@sbx", [
      { type: "win", transaction_id: "win@sbx", amount: "0.01" },
      {
        type: "win",
        transaction_id: "tnd@sbx",
        amount: "1.250",
        currency: "TND",
      },
    ]),
    false,
  );
  assert.equal((await tx.wallet("EUR")).units, -20000n);
  assert.equal((await tx.wallet("TND")).units, 10000n);
});
test("ambiguous nameless refunds require reconciliation instead of inventing a credit", async () => {
  const tx = new MemoryWallet();
  await assert.rejects(
    applyPostback(tx, refund("missing@sbx", ""), true),
    /RECONCILIATION/,
  );
  await applyPostback(tx, bet(), true);
  await applyPostback(tx, refund("named-by-round@sbx", ""), true);
  assert.equal((await tx.wallet("EUR")).units, 10000n);
});
test("provider client is sandbox-only, handles absent artwork, and refuses incomplete catalogues", async () => {
  const config = loadConfig({ APIMATIC_API_KEY: "opaque-sandbox-test-key", APIMATIC_SECRET_KEY: secret });
  const game = {
    uuid: randomUUID(),
    name: "Test",
    code: "test",
    provider: "studio",
    vendor: "vendor",
  };
  let calls = 0;
  const nonces = new Set<string>();
  const client = new ApiMaticClient(config, async (input, init) => {
    assert.match(String(input), /^https:\/\/sandbox-api\.api-matic\.com\//);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["X-API-Key"], "opaque-sandbox-test-key");
    nonces.add(headers["X-Nonce"]!);
    calls++;
    return Response.json({
      success: true,
      data: calls === 1 ? [game] : [{ ...game, uuid: randomUUID() }],
      meta: { page: calls, per_page: 1, total: 2, last_page: 2 },
    });
  });
  assert.equal((await client.catalog()).length, 2);
  assert.equal(nonces.size, 2);
  const broken = new ApiMaticClient(config, async () =>
    Response.json({
      success: true,
      data: [],
      meta: { page: 1, per_page: 100, total: 2, last_page: 1 },
    }),
  );
  await assert.rejects(broken.catalog(), /Incomplete/);
  assert.throws(() => safePlayLink("javascript:alert(1)"));
  assert.throws(() => safePlayLink("https://127.0.0.1/game"));
});
test("disabled integration exposes an empty setup state and rejects callbacks", async (t) => {
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }));
  t.after(() => app.close());
  const games = await app.inject("/api/v1/gaming/games");
  assert.equal(games.statusCode, 200);
  assert.equal(games.json().data.configured, false);
  assert.deepEqual(games.json().data.games, []);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/provider/apimatic/sandbox",
        payload: {},
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/gaming/games/" + randomUUID() + "/launch",
        headers: { origin: "https://attacker.invalid" },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.throws(
    () =>
      loadConfig({
        APIMATIC_ENABLED: "true",
        DB_ENABLED: "true",
        MYSQL_USER: "test",
        APIMATIC_API_KEY: "",
      }),
    /APIMATIC_API_KEY/,
  );
});

test("catalog can be previewed with sandbox credentials while launches and callbacks remain disabled", async (t) => {
  const config = loadConfig({
    NODE_ENV: "test",
    DB_ENABLED: "true",
    MYSQL_USER: "test",
    APIMATIC_API_KEY: "opaque-sandbox-test-key",
    APIMATIC_SECRET_KEY: secret,
  });
  requireSandboxCredentials(config);
  assert.throws(
    () =>
      requireSandboxCredentials(
        loadConfig({
          APIMATIC_API_KEY: "",
          APIMATIC_SECRET_KEY: secret,
        }),
      ),
    /APIMATIC_API_KEY/,
  );
  const game = {
    uuid: randomUUID(),
    code: "test",
    name: "Catalog preview",
    provider: "test",
    vendor: "test",
    imageUrl: null,
  };
  const player = {
    id: randomUUID(),
    email: "preview@example.invalid",
    displayName: "Preview",
    emailVerified: false,
  };
  const app = await buildApp(config, {
    authStore: { findSession: async () => player } as unknown as AuthStore,
    gamingStore: {
      catalog: async () => ({
        games: [game],
        total: 1,
        providers: ["test"],
        page: 1,
        perPage: 28,
        syncedAt: null,
      }),
      game: async () => game,
    } as unknown as GamingStore,
  });
  t.after(() => app.close());
  const catalog = await app.inject("/api/v1/gaming/games");
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().data.configured, true);
  assert.equal(catalog.json().data.launchEnabled, false);
  assert.equal(catalog.json().data.games[0].uuid, game.uuid);
  const details = await app.inject(`/api/v1/gaming/games/${game.uuid}`);
  assert.equal(details.statusCode, 200);
  assert.equal(details.json().data.launchEnabled, false);
  const launch = await app.inject({
    method: "POST",
    url: `/api/v1/gaming/games/${game.uuid}/launch`,
    headers: {
      origin: config.CORS_ORIGINS[0],
      "x-requested-with": "choicestakes",
      cookie: `choicestakes_session=${"a".repeat(43)}`,
    },
    payload: { requestId: randomUUID(), mode: "real" },
  });
  assert.equal(launch.statusCode, 503);
  assert.equal(launch.json().error.code, "GAMES_NOT_CONFIGURED");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/provider/apimatic/sandbox",
        payload: {},
      })
    ).statusCode,
    503,
  );
});

test("provider diagnostics distinguish authentication and rate limits without echoing upstream values", async () => {
  const config = loadConfig({});
  const invalid = new ApiMaticClient(config, async () =>
    Response.json(
      {
        success: false,
        error: {
          code: "INVALID_SIGNATURE",
          message: "sensitive upstream content",
        },
      },
      { status: 401 },
    ),
  );
  await assert.rejects(invalid.catalogPage(1, 10), (error) => {
    assert.ok(error instanceof ApiMaticError);
    assert.equal(error.providerStatus, 401);
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.match(providerDiagnostic(error), /matching pair/);
    assert.doesNotMatch(
      providerDiagnostic(error),
      /sensitive upstream content/,
    );
    return true;
  });
  const unknown = new ApiMaticError(500, "DO_NOT_ECHO_SECRET");
  assert.doesNotMatch(
    JSON.stringify(unknown) + providerDiagnostic(unknown),
    /DO_NOT_ECHO_SECRET/,
  );
  const limited = new ApiMaticClient(
    config,
    async () => new Response("proxy response", { status: 429 }),
  );
  await assert.rejects(
    limited.catalogPage(),
    (error) =>
      error instanceof ApiMaticError && error.providerCode === "RATE_LIMITED",
  );
  const malformed = new ApiMaticClient(config, async () =>
    Response.json({ success: true, data: "unexpected secret" }),
  );
  await assert.rejects(malformed.catalogPage(), /unexpected catalog format/);
});
