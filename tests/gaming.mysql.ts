import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../src/config/env.js";
import { createDatabase } from "../src/database/mysql.js";
import { buildApp } from "../src/app.js";
import { createGamingStore } from "../src/modules/gaming/store.js";
import { signRequest } from "../src/modules/gaming/signing.js";

test("MySQL integration: signed callbacks, concurrent retries, rollback, audit trail, launch ownership and catalogue recovery", async () => {
  const original = loadConfig();
  if (!original.DB_ENABLED || original.NODE_ENV === "production")
    throw new Error("Run with an enabled, migrated development database.");
  const secret = "01".repeat(32),
    currency = "QA" + randomUUID().replaceAll("-", "").slice(0, 10);
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    APIMATIC_ENABLED: "true",
    APIMATIC_API_KEY: "uks_local_test",
    APIMATIC_SECRET_KEY: secret,
    APIMATIC_CALLBACK_URL:
      "https://api.example.com/api/v1/provider/apimatic/sandbox",
    APIMATIC_CURRENCY: currency,
    APIMATIC_CURRENCY_DECIMALS: "2",
    APIMATIC_TEST_CREDITS: "1000",
  });
  const database = createDatabase(config),
    store = createGamingStore(database, config);
  const game = {
    uuid: randomUUID(),
    name: "Temporary integration check",
    code: "check",
    provider: "Test Studio",
    vendor: "test",
  };
  const vendorSession = randomUUID();
  let launches = 0;
  const app = await buildApp(config, {
    database,
    gamingStore: store,
    gamingClient: {
      async launch() {
        launches++;
        // Model a vendor that cannot finish launching until it receives our balance.
        const openingBalance = {
          action: "balance", type: "balance", player_id: playerId!, game_uuid: game.uuid,
          currency, session_id: vendorSession, transaction_id: "",
          transaction_datetime: "2026-11-13 15:49:38.219223", casino_request_retry_count: 0,
        };
        await database.withConnection((connection) => connection.execute(
          "UPDATE apimatic_launches SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE player_id=? AND status='pending'",
          [playerId!],
        ));
        assert.equal((await app.inject(signed(openingBalance))).json().error_code, "PENDING_LAUNCH_EXPIRED");
        await database.withConnection((connection) => connection.execute(
          "UPDATE apimatic_launches SET created_at=UTC_TIMESTAMP(3) WHERE player_id=? AND status='pending'", [playerId!],
        ));
        const competing = await store.claimLaunch(playerId!, game.uuid, randomUUID(), "real");
        assert.equal((await app.inject(signed(openingBalance))).json().error_code, "PENDING_LAUNCH_AMBIGUOUS");
        await store.failLaunch(competing, "QA_CANCELLED");
        assert.equal((await app.inject(signed({ ...openingBalance, game_uuid: randomUUID() }))).json().error_code, "SESSION_NOT_FOUND");
        assert.equal((await app.inject(signed({ ...openingBalance, currency: "OTHER" }))).json().error_code, "SESSION_CURRENCY_MISMATCH");
        const balanceRequest = signed(openingBalance);
        const response = await app.inject(balanceRequest);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), { balance: 1000 });
        assert.equal((await app.inject(balanceRequest)).statusCode, 401, "early balance also consumes its nonce");
        for (const action of ["bet", "win", "refund", "rollback"]) {
          const refused = await app.inject(signed({ ...openingBalance, action, type: action,
            transaction_id: randomUUID() + "@sbx", amount: "1.00", bet_transaction_id: "",
            rollback_transactions: [{ transaction_id: "unknown@sbx", type: "bet", amount: "1.00" }],
          }));
          assert.equal(refused.json().error_code, "SESSION_NOT_FOUND", refused.body);
        }
        const [beforeResponse] = await database.withConnection((connection) => connection.execute<RowDataPacket[]>(
          "SELECT vendor_session_id,session_hash FROM apimatic_launches WHERE player_id=? AND status='pending'", [playerId!],
        ));
        assert.equal(beforeResponse.length, 1);
        assert.equal(beforeResponse[0]!.vendor_session_id, null, "balance does not bind the session before the launch response");
        assert.equal(beforeResponse[0]!.session_hash, null);
        return {
          link: "https://games.example.com/test",
          sessionId: vendorSession,
        };
      },
    },
  });
  const email = `games-check-${randomUUID()}@example.invalid`,
    password = randomUUID() + "!",
    nonces: string[] = [];
  let playerId: string | undefined;
  const headers = {
    origin: config.CORS_ORIGINS[0]!,
    "x-requested-with": "choicestakes",
  };
  const callbackPath = "/api/v1/provider/apimatic/sandbox";
  function signed(body: unknown, nonce = randomUUID(), raw?: string) {
    const text = raw ?? JSON.stringify(body),
      timestamp = Math.floor(Date.now() / 1000).toString();
    nonces.push(createHash("sha256").update(nonce).digest("hex"));
    return {
      method: "POST" as const,
      url: callbackPath,
      headers: {
        "content-type": "application/json",
        "x-timestamp": timestamp,
        "x-nonce": nonce,
        "x-sign": signRequest(
          secret,
          timestamp,
          nonce,
          "POST",
          callbackPath,
          text,
        ),
      },
      payload: text,
    };
  }
  try {
    await store.sync(async () => [game]);
    assert.equal((await store.catalog(1, "", "")).total, 1);
    await assert.rejects(
      store.sync(async () => {
        throw new Error("provider failed");
      }),
    );
    assert.ok(await store.game(game.uuid));
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers,
      payload: {
        displayName: "Integration check",
        email,
        password,
        confirmPassword: password,
        acceptTerms: true,
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    playerId = registered.json().data.player.id;
    const cookie = String(registered.headers["set-cookie"]).split(";")[0]!;
    const requestId = randomUUID(),
      launchPath = `/api/v1/gaming/games/${game.uuid}/launch`;
    const opened = await app.inject({
      method: "POST",
      url: launchPath,
      headers: { ...headers, cookie },
      payload: { requestId },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    assert.equal(launches, 1);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: launchPath,
          headers: { ...headers, cookie },
          payload: { requestId },
        })
      ).statusCode,
      409,
    );
    assert.equal(launches, 1);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: launchPath,
          headers: { ...headers, cookie },
          payload: { requestId: randomUUID(), player_id: randomUUID() },
        })
      ).statusCode,
      400,
    );
    const common = {
      currency,
      player_id: playerId,
      session_id: vendorSession,
      game_uuid: game.uuid,
      round_id: randomUUID() + "@sbx",
      transaction_datetime: "2026-11-06 10:00:00.000000",
      casino_request_retry_count: 0,
    };
    const bet = {
      ...common,
      action: "bet",
      type: "bet",
      transaction_id: randomUUID() + "@sbx",
      amount: "10.00",
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => app.inject(signed(bet))),
    );
    for (const result of results) {
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().balance, 990);
    }
    const conflict = await app.inject(signed({ ...bet, amount: "11.00" }));
    assert.equal(conflict.statusCode, 503);
    assert.equal(conflict.json().error_code, "TRANSACTION_CONFLICT");
    const win = {
      ...common,
      action: "win",
      type: "win",
      transaction_id: randomUUID() + "@sbx",
      amount: "25.00",
    };
    const winRequest = signed(win);
    assert.equal((await app.inject(winRequest)).json().balance, 1015);
    assert.equal(
      (await app.inject(winRequest)).json().error_code,
      "REPLAY_DETECTED",
    );
    const differentSpacing = JSON.stringify(
      Object.fromEntries(Object.entries(win).reverse()),
      null,
      2,
    );
    assert.equal(
      (await app.inject(signed(win, randomUUID(), differentSpacing))).json()
        .balance,
      1015,
    );
    const invalid = signed({ ...win, transaction_id: randomUUID() + "@sbx" });
    invalid.payload += " ";
    assert.equal((await app.inject(invalid)).statusCode, 401);
    const refund = {
      ...common,
      action: "refund",
      type: "refund",
      transaction_id: randomUUID() + "@sbx",
      bet_transaction_id: bet.transaction_id,
      amount: "10.00",
    };
    assert.equal((await app.inject(signed(refund))).json().balance, 1025);
    const rollback = {
      ...common,
      action: "rollback",
      type: "rollback",
      transaction_id: randomUUID() + "@sbx",
      rollback_transactions: [
        { transaction_id: bet.transaction_id, type: "bet", amount: "10.00" },
        { transaction_id: win.transaction_id, type: "win", amount: "25.00" },
      ],
    };
    assert.equal((await app.inject(signed(rollback))).json().balance, 1000);
    assert.equal((await app.inject(signed(rollback))).json().balance, 1000);
    const lateId = randomUUID() + "@sbx";
    const earlyRollback = {
      ...rollback,
      transaction_id: randomUUID() + "@sbx",
      rollback_transactions: [
        { transaction_id: lateId, type: "win", amount: "20.00" },
      ],
    };
    assert.equal(
      (await app.inject(signed(earlyRollback))).json().balance,
      1000,
    );
    assert.equal(
      (
        await app.inject(
          signed({ ...win, transaction_id: lateId, amount: "20.00" }),
        )
      ).json().balance,
      1000,
    );
    const [audit] = await database.withConnection((connection) =>
      connection.execute<RowDataPacket[]>(
        "SELECT COALESCE(SUM(delta_units),0) AS total FROM apimatic_sandbox_movements WHERE player_id=?",
        [playerId!],
      ),
    );
    assert.equal(BigInt(audit[0]!.total), 0n);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { ...headers, cookie },
      payload: {},
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: launchPath,
          headers: { ...headers, cookie },
          payload: { requestId: randomUUID() },
        })
      ).statusCode,
      401,
    );
    // Provider settlement is independent of the browser authentication session.
    assert.equal(
      (
        await app.inject(
          signed({
            ...win,
            transaction_id: randomUUID() + "@sbx",
            amount: "1.00",
          }),
        )
      ).json().balance,
      1001,
    );
    const faultyRollback = {
      ...rollback,
      transaction_id: randomUUID() + "@sbx",
      rollback_transactions: [
        {
          transaction_id: refund.transaction_id,
          type: "refund",
          amount: "10.00",
        },
        {
          transaction_id: randomUUID() + "@sbx",
          type: "unknown",
          amount: "1.00",
        },
      ],
    };
    assert.equal((await app.inject(signed(faultyRollback))).statusCode, 503);
    const balance = {
      ...common,
      action: "balance",
      type: "balance",
      transaction_id: "",
    };
    assert.equal(
      (await app.inject(signed(balance))).json().balance,
      1001,
      "failed multi-item rollback must be atomic",
    );
    assert.equal(
      (
        await app.inject(
          signed({ ...balance, session_id: "not-a-launched-session" }),
        )
      ).statusCode,
      503,
    );
    const otherApp = await buildApp(config);
    try {
      assert.equal(
        (await otherApp.inject(signed(win))).json().balance,
        1001,
        "deduplication must survive app instances",
      );
    } finally {
      await otherApp.close();
    }
    const simultaneous = await Promise.all(
      [1, 2].map(() =>
        app.inject(
          signed({
            ...bet,
            transaction_id: randomUUID() + "@sbx",
            amount: "750.00",
          }),
        ),
      ),
    );
    assert.equal(
      simultaneous.filter(
        (result) => result.json().error_code === "INSUFFICIENT_FUNDS",
      ).length,
      1,
    );
    assert.equal(
      (await app.inject(signed(balance))).json().balance,
      251,
      "concurrent bets must not overspend",
    );
    await store.sync(async () => []);
    assert.equal(await store.game(game.uuid), null);
  } finally {
    try {
      await database.transaction(async (connection) => {
        if (playerId) {
          await connection.execute(
            "DELETE FROM apimatic_callback_issues WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.player_id'))=?",
            [playerId],
          );
          for (const table of [
            "apimatic_sandbox_movements",
            "apimatic_sandbox_ledger",
            "apimatic_launches",
            "apimatic_sandbox_wallets",
          ])
            await connection.execute(`DELETE FROM ${table} WHERE player_id=?`, [
              playerId,
            ]);
          await connection.execute(
            "DELETE FROM players WHERE id=? AND email=?",
            [playerId, email],
          );
        }
        for (const nonce of nonces)
          await connection.execute(
            "DELETE FROM apimatic_callback_nonces WHERE nonce_hash=?",
            [nonce],
          );
        await connection.execute(
          "DELETE FROM apimatic_games WHERE currency=?",
          [currency],
        );
        await connection.execute("DELETE FROM apimatic_catalog_sync WHERE currency=?", [currency]);
      });
    } finally {
      await app.close();
    }
  }
});
