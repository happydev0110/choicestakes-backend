import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createWalletEvents } from "../src/modules/gaming/wallet-events.js";
import type { GamingStore } from "../src/modules/gaming/store.js";
import type { AuthStore } from "../src/modules/auth/types.js";
import { createAuthStore } from "../src/modules/auth/store.js";
import type { Database } from "../src/database/mysql.js";
import { tokenHash } from "../src/modules/auth/routes.js";
import { signRequest } from "../src/modules/gaming/signing.js";

const secret = "12".repeat(32);
const config = loadConfig({ NODE_ENV: "test", DB_ENABLED: "true", MYSQL_USER: "fixture", APIMATIC_ENABLED: "true",
  APIMATIC_SYNC_ENABLED: "false", APIMATIC_API_KEY: "test-key", APIMATIC_SECRET_KEY: secret,
  APIMATIC_CALLBACK_URL: "https://api.example.test/api/v1/provider/apimatic/sandbox", APIMATIC_CURRENCY: "USD" });
const log = { warn() {} } as unknown as FastifyBaseLogger;
const player = { id: randomUUID(), email: "wallet@example.test", displayName: "Wallet", emailVerified: false };
const other = { ...player, id: randomUUID() };
const token = "a".repeat(43);
const otherToken = "b".repeat(43);

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Expected stream event did not arrive");
}

test("wallet events are player-scoped, clean up listeners, and cannot fail a committed callback", async () => {
  const events = await createWalletEvents(config, log);
  const messages: string[] = [];
  const off = events.subscribe(player.id, event => messages.push(event));
  let otherDeliveries = 0;
  events.subscribe(other.id, () => { otherDeliveries++; });
  events.subscribe(player.id, () => { throw new Error("Broken consumer"); });
  assert.doesNotThrow(() => events.publish(player.id));
  assert.deepEqual(messages, ["wallet.updated"]);
  assert.equal(otherDeliveries, 0);
  off();
  events.publish(player.id);
  assert.equal(messages.length, 1);
  await events.close();
  assert.equal(events.ready(), false);
});

test("authenticated SSE delivers only committed wallet changes and stops on revocation and shutdown", { timeout: 15000 }, async (t) => {
  const events = await createWalletEvents(config, log);
  let valid = true;
  const touches: (boolean | undefined)[] = [];
  let finishCommit: () => void = () => {};
  let entered = false;
  let fail = false;
  let changed = true;
  const app = await buildApp(config, {
    database: { enabled: true, async ping() {}, async close() {} }, walletEvents: events,
    authStore: { async findSession(hash: string, _now: Date, _idle: number, touch?: boolean) {
      touches.push(touch);
      return hash === tokenHash(token) ? valid ? player : null : hash === tokenHash(otherToken) ? other : null;
    } } as AuthStore,
    gamingStore: {
      async postback() {
        entered = true;
        await new Promise<void>(resolve => { finishCommit = resolve; });
        if (fail) throw new Error("Commit failed");
        return { wallet: { currency: "USD", decimals: 2, units: 12500n }, balanceChanged: changed };
      }, async issue() {},
    } as unknown as GamingStore,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/v1/gaming/wallet/events`;
  const controllers: AbortController[] = [];
  t.after(async () => { controllers.forEach(c => c.abort()); await app.close(); });
  const unauthenticated = await app.inject({ url: "/api/v1/gaming/wallet/events?playerId=" + player.id });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal((await app.inject({ method: "HEAD", url: "/api/v1/gaming/wallet/events" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/v1/gaming/wallet/events", headers: {
    cookie: `choicestakes_session=${token}`, origin: "https://attacker.test",
  } })).statusCode, 403);
  async function open(value: string) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(url, { headers: { Cookie: `choicestakes_session=${value}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body!.getReader();
    const received = { text: "", ended: false };
    void (async () => { try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; received.text += new TextDecoder().decode(chunk.value); }
    } catch { /* abort closes the test stream */ } finally { received.ended = true; } })();
    await eventually(() => received.text.includes("wallet.ready"));
    return received;
  }
  const first = await open(token);
  const second = await open(otherToken);
  async function callback() {
    const path = "/api/v1/provider/apimatic/sandbox";
    const body = JSON.stringify({ action: "bet", type: "bet", currency: "USD", player_id: player.id,
      game_uuid: randomUUID(), session_id: "fixture-session", transaction_id: randomUUID() + "@sbx", amount: "1.00",
      transaction_datetime: "2026-11-17 00:00:00.000000", casino_request_retry_count: 0 });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    return app.inject({ method: "POST", url: path, payload: body, headers: {
      "content-type": "application/json", "x-timestamp": timestamp, "x-nonce": nonce,
      "x-sign": signRequest(secret, timestamp, nonce, "POST", path, body),
    } });
  }
  const committed = callback();
  await eventually(() => entered);
  assert.doesNotMatch(first.text, /wallet.updated/);
  finishCommit();
  assert.equal((await committed).statusCode, 200);
  await eventually(() => first.text.includes("wallet.updated"));
  assert.doesNotMatch(second.text, /wallet.updated/);
  assert.doesNotMatch(first.text, new RegExp(`${player.id}|12500|fixture-session`));
  const before = first.text;
  for (const outcome of ["duplicate", "failed"] as const) {
    entered = false; changed = false; fail = outcome === "failed";
    const pending = callback(); await eventually(() => entered); finishCommit();
    assert.equal((await pending).statusCode, fail ? 503 : 200);
  }
  assert.equal(first.text, before);
  valid = false;
  events.publish(player.id);
  await eventually(() => first.ended);
  assert.match(first.text, /session.expired/);
  assert.ok(touches.every(touch => touch === false), "stream activity must not extend idle expiry");
  await app.close();
  await eventually(() => second.ended);
});

test("passive session validation checks validity without extending last_seen_at", async () => {
  const statements: string[] = [];
  const auth = createAuthStore({ enabled: true, async withConnection(work: (connection: unknown) => unknown) {
    return work({ async execute(sql: string) {
      statements.push(sql);
      return sql.startsWith("SELECT") ? [[{ id: player.id, email: player.email, display_name: player.displayName, email_verified_at: null }]] : [];
    } });
  } } as unknown as Database);
  await auth.findSession("test-hash", new Date(), 60, false);
  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /expires_at.*last_seen_at/s);
  await auth.findSession("test-hash", new Date(), 60);
  assert.match(statements.at(-1)!, /UPDATE player_sessions/);
});

test("Redis bridges notifications between backend workers", { skip: !process.env.TEST_WALLET_REDIS_URL, timeout: 15000 }, async () => {
  const shared = { ...config, WALLET_EVENTS_REDIS_URL: process.env.TEST_WALLET_REDIS_URL!, WALLET_EVENTS_REDIS_CHANNEL: `wallet-test:${randomUUID()}` };
  const one = await createWalletEvents(shared, log);
  const two = await createWalletEvents(shared, log);
  try {
    let deliveries = 0;
    two.subscribe(player.id, () => { deliveries++; });
    one.publish(player.id);
    await eventually(() => deliveries === 1);
  } finally { await one.close(); await two.close(); }
});
