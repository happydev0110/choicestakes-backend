import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadConfig } from "../src/config/env.js";
import { createDatabase } from "../src/database/mysql.js";
import { createGamingStore } from "../src/modules/gaming/store.js";
import { classifyGames } from "../src/modules/gaming/classify.js";
import { buildApp } from "../src/app.js";
import { ApiMaticError } from "../src/modules/gaming/provider-error.js";

test("MySQL catalog: complete pagination, literal search, provider counts, favorites, persistent manual categories and atomic imports", async () => {
  const original = loadConfig();
  assert.ok(
    original.DB_ENABLED && original.NODE_ENV !== "production",
    "Use an enabled, migrated development database.",
  );
  const currency = "QA" + randomUUID().replaceAll("-", "").slice(0, 10);
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    APIMATIC_ENABLED: "false",
    APIMATIC_API_KEY: "uks_local_test",
    APIMATIC_SECRET_KEY: "01".repeat(32),
    APIMATIC_CURRENCY: currency,
  });
  const database = createDatabase(config),
    store = createGamingStore(database, config);
  const games = Array.from({ length: 65 }, (_, index) => ({
    uuid: randomUUID(),
    code: `qa${index}`,
    name: `Catalog ${String(index).padStart(2, "0")}${index === 0 ? "%_" : ""}`,
    provider: index < 30 ? "Studio A" : "Studio B",
    vendor: "qa",
  }));
  const app = await buildApp(config, { database, gamingStore: store });
  try {
    assert.equal((await store.catalogStatus()).status, "not_synced");
    await assert.rejects(
      store.sync(async () => {
        throw new ApiMaticError(401, "INVALID_SIGNATURE");
      }),
    );
    assert.equal((await store.catalogStatus()).status, "failed");
    await store.sync(async () => games);
    const imported = await store.catalogStatus();
    assert.equal(imported.status, "ready");
    assert.equal(imported.total, 65);
    assert.equal(imported.providerTotal, 65);
    assert.ok(imported.lastSuccessAt);
    const noMatches = await store.catalog(1, "not a real game name", "");
    assert.equal(noMatches.total, 0);
    assert.equal(noMatches.catalog.total, 65);
    assert.equal(noMatches.syncedAt, imported.lastSuccessAt);

    let fetching!: () => void;
    const started = new Promise<void>((resolve) => {
      fetching = resolve;
    });
    let rejectFetch!: (error: Error) => void;
    const pending = store.sync(() => {
      fetching();
      return new Promise<typeof games>((_, reject) => {
        rejectFetch = reject;
      });
    });
    // Attach the rejection handler before releasing the held provider request.
    const failed = assert.rejects(pending, {
      providerCode: "INVALID_SIGNATURE",
    });
    await started;
    try {
      assert.equal((await store.catalogStatus()).status, "syncing");
      assert.equal((await store.catalog(1, "", "")).total, 65);
      await assert.rejects(
        store.sync(async () => []),
        { code: "CATALOG_SYNC_IN_PROGRESS" },
      );
      assert.equal((await store.catalogStatus()).status, "syncing");
    } finally {
      rejectFetch(new ApiMaticError(401, "INVALID_SIGNATURE"));
      await failed;
    }
    const stale = await store.catalogStatus();
    assert.equal(stale.status, "stale");
    assert.equal(stale.total, 65);
    assert.equal(stale.lastSuccessAt, imported.lastSuccessAt);
    assert.equal(stale.lastErrorCode, "INVALID_SIGNATURE");
    const publicResponse = await app.inject("/api/v1/gaming/games");
    assert.equal(publicResponse.json().data.catalog.status, "stale");
    assert.doesNotMatch(
      publicResponse.body,
      /INVALID_SIGNATURE|lastErrorCode|MYSQL|secret/,
    );

    // A SQL failure after an upsert must roll back the entire replacement catalog.
    await assert.rejects(
      store.sync(async () => [
        { ...games[0]!, name: "Must roll back" },
        { ...games[1]!, name: "x".repeat(10000) },
      ]),
    );
    assert.equal((await store.game(games[0]!.uuid))?.name, games[0]!.name);
    assert.equal((await store.catalogStatus()).total, 65);
    await store.sync(async () => games);
    const pages = await Promise.all(
      [1, 2, 3].map((page) => store.catalog(page, "", "")),
    );
    assert.deepEqual(
      pages.map((page) => page.games.length),
      [28, 28, 9],
    );
    assert.equal(
      new Set(pages.flatMap((page) => page.games.map((game) => game.uuid)))
        .size,
      65,
    );
    assert.deepEqual(pages[0]!.providerCounts, [
      { provider: "Studio A", total: 30 },
      { provider: "Studio B", total: 35 },
    ]);
    assert.equal((await store.catalog(500, "", "")).page, 3);
    assert.equal(
      (await store.catalog(1, "%_", "")).games[0]?.uuid,
      games[0]!.uuid,
    );
    assert.equal((await store.catalog(1, "", "Studio A")).total, 30);
    assert.equal((await store.catalog(1, "", "", { ids: [] })).total, 0);
    assert.equal(
      (
        await store.catalog(1, "", "", {
          ids: [games[0]!.uuid, games[40]!.uuid],
        })
      ).total,
      2,
    );
    assert.equal(
      (await store.catalog(1, "", "Studio A", { ids: [games[40]!.uuid] }))
        .total,
      0,
    );
    assert.equal(
      (await store.catalog(1, "", "", { sort: "name-desc" })).games[0]?.uuid,
      games[64]!.uuid,
    );
    await classifyGames(database, currency, {
      assignments: [
        { uuid: games[0]!.uuid, categories: ["slots", "new-games"] },
      ],
    });
    assert.equal(
      (await store.catalog(1, "", "", { category: "slots" })).total,
      1,
    );
    assert.equal(
      (await store.catalog(1, "", "", { category: "live" })).total,
      0,
    );
    assert.equal(
      (await store.catalog(1, "", "Studio B", { category: "slots" })).total,
      0,
    );
    await store.sync(async () => games);
    assert.equal(
      (await store.catalog(1, "", "", { category: "slots" })).games[0]?.uuid,
      games[0]!.uuid,
    );
    // The second assignment fails after the first changed; the whole import must roll back.
    await assert.rejects(
      classifyGames(database, currency, {
        assignments: [
          { uuid: games[0]!.uuid, categories: ["poker"] },
          {
            uuid: "ffffffff-ffff-4fff-bfff-ffffffffffff",
            categories: ["poker"],
          },
        ],
      }),
    );
    assert.equal(
      (await store.catalog(1, "", "", { category: "slots" })).total,
      1,
    );
    await store.disableGame(games[0]!.uuid);
    assert.equal(
      (await store.catalog(1, "", "", { category: "slots" })).total,
      0,
    );
    assert.equal(
      (await store.catalog(1, "", "", { ids: [games[0]!.uuid] })).total,
      0,
    );
    await store.sync(async () => games);
    await classifyGames(database, currency, {
      assignments: [{ uuid: games[0]!.uuid, categories: [] }],
    });
    assert.equal(
      (await store.catalog(1, "", "", { category: "slots" })).total,
      0,
    );
    const response = await app.inject(
      `/api/v1/gaming/games?ids=${games[0]!.uuid}`,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.total, 1);
    assert.equal(response.json().data.launchEnabled, false);
    for (const query of [
      "category=unknown",
      "sort=popular",
      "ids=not-a-game",
      "page=0",
    ]) {
      assert.equal(
        (await app.inject(`/api/v1/gaming/games?${query}`)).statusCode,
        400,
      );
    }
    await store.sync(async () => []);
    const empty = await store.catalogStatus();
    assert.equal(empty.status, "empty");
    assert.equal(empty.total, 0);
    assert.equal(empty.providerTotal, 0);
    assert.equal(empty.lastErrorCode, null);
    assert.ok(empty.lastSuccessAt);
    assert.equal((await store.catalog(1, "", "")).total, 0);
    await store.sync(async () => games);
    assert.equal((await store.catalogStatus()).status, "ready");
  } finally {
    await database.withConnection(async (connection) => {
      await connection.execute("DELETE FROM apimatic_games WHERE currency=?", [
        currency,
      ]);
      await connection.execute(
        "DELETE FROM apimatic_catalog_sync WHERE currency=?",
        [currency],
      );
    });
    await app.close();
  }
});
