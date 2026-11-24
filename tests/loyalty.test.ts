import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { tokenHash } from "../src/modules/auth/routes.js";
import type { AuthStore } from "../src/modules/auth/types.js";
import type { Database } from "../src/database/mysql.js";
import {
  createLoyaltyStore,
  loyaltyView,
} from "../src/modules/loyalty/routes.js";

const tiers = ["basic", "bronze", "silver", "gold", "platinum", "diamond"].map(
  (code, i) => ({
    code,
    minXp: [
      "0.00",
      "2000.00",
      "12000.00",
      "45000.00",
      "180000.00",
      "750000.00",
    ][i],
  }),
);
test("public tier ranges and player progress use exact hundredths at tier boundaries", () => {
  assert.equal(loyaltyView(tiers, null, 3).player, null);
  assert.equal(loyaltyView(tiers, null, 3).tiers[0]?.maxXp, "1999.99");
  assert.equal(loyaltyView(tiers, null, 3).tiers[5]?.maxXp, null);
  for (const [balance, tier] of [
    ["0", "basic"],
    ["199999", "basic"],
    ["200000", "bronze"],
    ["1199999", "bronze"],
    ["1200000", "silver"],
    ["4499999", "silver"],
    ["4500000", "gold"],
    ["17999999", "gold"],
    ["18000000", "platinum"],
    ["74999999", "platinum"],
    ["75000000", "diamond"],
  ])
    assert.equal(loyaltyView(tiers, balance, 1).player?.tier, tier);
  assert.deepEqual(loyaltyView(tiers, "350000", 1).player, {
    xp: "3500.00",
    tier: "bronze",
    nextTier: "silver",
    xpToNext: "8500.00",
    progressPercent: 15,
  });
  assert.equal(loyaltyView(tiers, "199999", 1).player?.xpToNext, "0.01");
  assert.equal(
    loyaltyView(tiers, "99999999999", 1).player?.progressPercent,
    100,
  );
  assert.throws(() => loyaltyView(tiers, "-1", 1));
  assert.throws(() => loyaltyView([...tiers].reverse(), "0", 1));
});

test("tiers are public; XP is session-owned, never cached, and cannot be read or changed for another player", async (t) => {
  const id = randomUUID(),
    other = randomUUID(),
    token = "L".repeat(43);
  const reads: (string | undefined)[] = [];
  let active = true;
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    authStore: {
      findSession: async (hash, _now, _idle, touch) => {
        assert.equal(touch, false);
        return active && hash === tokenHash(token)
          ? {
              id,
              displayName: "QA",
              email: "qa@example.test",
              emailVerified: false,
            }
          : null;
      },
    } as AuthStore,
    loyaltyStore: {
      read: async (playerId) => {
        reads.push(playerId);
        return loyaltyView(tiers, playerId ? "200050" : null, 1);
      },
    },
  });
  t.after(() => app.close());
  const publicResponse = await app.inject({ url: "/api/v1/loyalty/tiers" });
  assert.equal(publicResponse.statusCode, 200);
  assert.equal(publicResponse.headers["cache-control"], "no-store");
  assert.equal(publicResponse.json().data.player, null);
  for (const cookie of [
    "",
    "choicestakes_session=invalid",
    `choicestakes_session=${"X".repeat(43)}`,
  ]) {
    const response = await app.inject({
      url: "/api/v1/loyalty/me",
      headers: { cookie },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const headers = { cookie: `choicestakes_session=${token}` };
  const own = await app.inject({ url: "/api/v1/loyalty/me", headers });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().data.player.xp, "2000.50");
  assert.doesNotMatch(own.body, /email|admin|reason|fingerprint|password/);
  assert.equal(
    (await app.inject({ url: `/api/v1/loyalty/me?playerId=${other}`, headers }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ url: `/api/v1/loyalty/${other}`, headers })).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/loyalty/me",
        headers,
        payload: { xp: 999 },
      })
    ).statusCode,
    404,
  );
  active = false;
  assert.equal(
    (await app.inject({ url: "/api/v1/loyalty/me", headers })).statusCode,
    401,
  );
  assert.deepEqual(reads, [undefined, id]);
});

test("database failures and corrupt settings never turn into sample data or zero XP", async () => {
  await assert.rejects(
    createLoyaltyStore({ enabled: false } as Database).read(),
    { code: "LOYALTY_UNAVAILABLE" },
  );
  const missing = {
    enabled: true,
    withConnection: async (work: (c: unknown) => unknown) =>
      work({ execute: async () => [[], []] }),
  } as unknown as Database;
  await assert.rejects(createLoyaltyStore(missing).read(randomUUID()), {
    statusCode: 503,
  });
  const failed = {
    enabled: true,
    withConnection: async () => {
      throw new Error("password=do-not-expose");
    },
  } as unknown as Database;
  await assert.rejects(createLoyaltyStore(failed).read(), (error) => {
    assert.doesNotMatch(String(error), /do-not-expose/);
    return true;
  });
});
