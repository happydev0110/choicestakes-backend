import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/database/mysql.js";
import { migrations } from "../src/database/migrations.js";
import type { Postback } from "../src/modules/gaming/contracts.js";
import { createGamingStore } from "../src/modules/gaming/store.js";
import { WalletError } from "../src/modules/gaming/wallet.js";

test("database timezone regression: fresh launches, pool reuse, expiry and legacy timestamps", async () => {
  const testDatabase = process.env.MYSQL_TEST_DATABASE;
  if (!testDatabase || !/^[A-Za-z0-9_]+_test$/.test(testDatabase) || process.env.NODE_ENV === "production")
    throw new Error("Set MYSQL_TEST_DATABASE to a disposable database ending in _test; never run in production.");
  const config = loadConfig({ ...process.env, NODE_ENV: "test", DB_ENABLED: "true",
    MYSQL_DATABASE: testDatabase, MYSQL_CONNECTION_LIMIT: "1", APIMATIC_ENABLED: "false",
    APIMATIC_SYNC_ENABLED: "false", APIMATIC_CURRENCY: "TZ" + randomUUID().replaceAll("-", "").slice(0, 10),
    APIMATIC_TEST_CREDITS: "1000", APIMATIC_CURRENCY_DECIMALS: "2" });
  const database = createDatabase(config), store = createGamingStore(database, config);
  const playerId = randomUUID(), gameId = randomUUID(), currency = config.APIMATIC_CURRENCY;
  const nonces: string[] = [];
  const nonce = () => {
    const value = createHash("sha256").update(randomUUID()).digest("hex");
    nonces.push(value);
    return value;
  };
  const body = (sessionId: string): Postback => ({
    action: "balance", type: "balance", player_id: playerId, game_uuid: gameId,
    currency, session_id: sessionId, transaction_id: "", casino_request_retry_count: 0,
    transaction_datetime: "2026-11-13 16:45:11.089188",
  });
  const errorCode = (code: string) => (error: unknown) => error instanceof WalletError && error.code === code;
  let fixtureCreated = false;
  try {
    await database.withConnection(async (connection) => {
      for (const migration of migrations)
        for (const statement of migration.statements) await connection.query(statement);
    });
    // Check reused connections as well as newly opened ones. The driver timezone
    // option alone cannot make this assertion pass.
    for (const zone of ["+05:30", "-07:00", "+12:00"]) {
      const connectionId = await database.withConnection(async (connection) => {
        const [rows] = await connection.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id");
        await connection.query("SET SESSION time_zone=?", [zone]);
        return rows[0]!.id;
      });
      await database.transaction(async (connection) => {
        const [rows] = await connection.query<RowDataPacket[]>(
          "SELECT CONNECTION_ID() AS id,@@session.time_zone AS zone,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),NOW()) AS offset_seconds",
        );
        assert.equal(rows[0]!.id, connectionId, "exercise the same physical pooled connection");
        assert.equal(rows[0]!.zone, "+00:00");
        assert.equal(Number(rows[0]!.offset_seconds), 0);
      });
    }
    await database.withConnection((connection) => connection.execute(
      `INSERT INTO players (id,email,display_name,password_hash,status,terms_version,terms_accepted_at,adult_confirmed_at)
       VALUES (?,?,'Timezone fixture','unused-fixture-hash','active','test',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
      [playerId, `timezone-${playerId}@example.invalid`],
    ));
    fixtureCreated = true;
    await store.sync(async () => [{ uuid: gameId, name: "Timezone fixture", code: "timezone", provider: "test", vendor: "test" }]);

    // These obsolete pending rows resemble timestamps written by an old process
    // in a timezone ahead of UTC. They must not hide a valid new row behind LIMIT 2.
    const legacy: string[] = [];
    for (let index = 0; index < 2; index++) legacy.push(await store.claimLaunch(playerId, gameId, randomUUID(), "real"));
    await database.withConnection((connection) => connection.execute(
      "UPDATE apimatic_launches SET created_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 5 HOUR) WHERE id IN (?,?)", legacy,
    ));

    for (const zone of ["+05:30", "-07:00", "+12:00"]) {
      // Deliberately override the session after pool checkout to independently
      // verify the explicit UTC INSERT, even if a caller changes the SQL timezone.
      const zonedDatabase: Database = {
        ...database,
        transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
          return database.transaction(async (connection) => {
            await connection.query("SET SESSION time_zone=?", [zone]);
            return work(connection);
          });
        },
      };
      const zonedStore = createGamingStore(zonedDatabase, config);
      const launchId = await zonedStore.claimLaunch(playerId, gameId, randomUUID(), "real");
      const callback = body(randomUUID());
      const [rows] = await database.withConnection((connection) => connection.execute<RowDataPacket[]>(
        "SELECT TIMESTAMPDIFF(MICROSECOND,created_at,UTC_TIMESTAMP(3)) AS age_us FROM apimatic_launches WHERE id=?", [launchId],
      ));
      assert.ok(Number(rows[0]!.age_us) >= 0 && Number(rows[0]!.age_us) < 30_000_000, `fresh launch age under ${zone}`);
      const result = await zonedStore.postback(callback, nonce());
      assert.equal(result.earlyBalanceLaunchId, launchId);
      assert.equal(result.wallet.units, 100000n);

      const competing = await zonedStore.claimLaunch(playerId, gameId, randomUUID(), "real");
      await assert.rejects(zonedStore.postback(callback, nonce()), errorCode("PENDING_LAUNCH_AMBIGUOUS"));
      await store.failLaunch(competing, "QA_CANCELLED");
      await database.withConnection((connection) => connection.execute(
        "UPDATE apimatic_launches SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 31 SECOND) WHERE id=?", [launchId],
      ));
      await assert.rejects(zonedStore.postback(callback, nonce()), errorCode("PENDING_LAUNCH_EXPIRED"));
      await database.withConnection((connection) => connection.execute(
        "UPDATE apimatic_launches SET created_at=UTC_TIMESTAMP(3) WHERE id=?", [launchId],
      ));
      await store.completeLaunch(launchId, callback.session_id);
      assert.equal((await zonedStore.postback(callback, nonce())).earlyBalanceLaunchId, undefined);
      assert.equal((await store.wallet(playerId)).balance, "1000.00");
    }
    await assert.rejects(store.postback(body(randomUUID()), nonce()), errorCode("PENDING_LAUNCH_EXPIRED"));
  } finally {
    try {
      if (fixtureCreated) await database.transaction(async (connection) => {
        for (const table of ["apimatic_sandbox_movements", "apimatic_sandbox_ledger", "apimatic_launches", "apimatic_sandbox_wallets"])
          await connection.execute(`DELETE FROM ${table} WHERE player_id=?`, [playerId]);
        await connection.execute("DELETE FROM players WHERE id=?", [playerId]);
        await connection.execute("DELETE FROM apimatic_games WHERE currency=?", [currency]);
        await connection.execute("DELETE FROM apimatic_catalog_sync WHERE currency=?", [currency]);
        for (const hash of nonces) await connection.execute("DELETE FROM apimatic_callback_nonces WHERE nonce_hash=?", [hash]);
      });
    } finally { await database.close(); }
  }
});
