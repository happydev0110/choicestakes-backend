import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createCatalogWorker } from "../src/modules/gaming/catalog-worker.js";
import {
  catalogFailure,
  catalogStatus,
} from "../src/modules/gaming/catalog-sync.js";
import { ApiMaticError } from "../src/modules/gaming/provider-error.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { GamingStore } from "../src/modules/gaming/store.js";

const quiet = { info() {}, warn() {} };

test("catalog status distinguishes a failed refresh, a successful empty import and initial loading", () => {
  assert.equal(catalogStatus(0, null, null), "not_synced");
  assert.equal(catalogStatus(0, "running", null), "syncing");
  assert.equal(catalogStatus(0, "failed", null), "failed");
  assert.equal(catalogStatus(0, "succeeded", "2026-11-10"), "empty");
  assert.equal(catalogStatus(10, "failed", "2026-11-10"), "stale");
  assert.equal(catalogStatus(10, "succeeded", "2026-11-10"), "ready");
  for (const [code, expected] of [
    ["ER_NO_SUCH_TABLE", "CATALOG_MIGRATIONS_REQUIRED"],
    ["ER_BAD_DB_ERROR", "CATALOG_DATABASE_NOT_FOUND"],
    ["ER_DBACCESS_DENIED_ERROR", "CATALOG_DATABASE_ACCESS_DENIED"],
    ["ECONNREFUSED", "CATALOG_DATABASE_UNREACHABLE"],
    ["EACCES", "CATALOG_DATABASE_UNREACHABLE"],
    ["unknown", "CATALOG_SYNC_FAILED"],
  ]) {
    const error = catalogFailure({
      code,
      message: "private database password",
    });
    assert.equal(error.code, expected);
    assert.doesNotMatch(error.message, /private|password/);
  }
  const provider = new ApiMaticError(401, "INVALID_SIGNATURE");
  assert.equal(catalogFailure(provider), provider);
});

test("worker runs immediately, prevents overlaps, retries after failure and cancels pending timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runs = 0,
    warnings = 0;
  let rejectRun!: (error: Error) => void;
  const worker = createCatalogWorker(
    () => {
      runs++;
      return new Promise<number>((_, reject) => {
        rejectRun = reject;
      });
    },
    1000,
    {
      info() {},
      warn() {
        warnings++;
      },
    },
  );
  worker.start();
  await nextTurn();
  assert.equal(runs, 1);
  worker.start();
  t.mock.timers.tick(5000);
  await nextTurn();
  assert.equal(runs, 1);
  rejectRun(new Error("provider unavailable"));
  await nextTurn();
  assert.equal(warnings, 1);
  t.mock.timers.tick(1000);
  await nextTurn();
  assert.equal(runs, 2);
  rejectRun(new Error("provider unavailable"));
  await nextTurn();
  await worker.stop();
  t.mock.timers.tick(5000);
  worker.start();
  await nextTurn();
  assert.equal(runs, 2);
});

test("shutdown aborts an active provider request and waits for its cleanup", async () => {
  let signal: AbortSignal | undefined;
  let cleaned = false;
  const worker = createCatalogWorker(
    async (value) => {
      signal = value;
      await new Promise<void>((resolve) =>
        value.addEventListener("abort", () => resolve(), { once: true }),
      );
      await nextTurn();
      cleaned = true;
      throw new Error("aborted");
    },
    1000,
    quiet,
  );
  worker.start();
  await nextTurn();
  await worker.stop();
  assert.ok(signal?.aborted);
  assert.ok(cleaned);
});

test("HTTP startup imports once; browser requests do not trigger imports; shutdown finishes before closing MySQL", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DB_ENABLED: "true",
    MYSQL_USER: "qa",
    APIMATIC_API_KEY: "sandbox-key",
    APIMATIC_SECRET_KEY: "01".repeat(32),
  });
  let calls = 0,
    finished = false,
    closed = false;
  let signal: AbortSignal | undefined;
  const app = await buildApp(config, {
    database: {
      enabled: true,
      async ping() {},
      async close() {
        assert.ok(finished);
        closed = true;
      },
    },
    gamingStore: {
      async sync(fetchCatalog) {
        await fetchCatalog();
        return 0;
      },
    } as GamingStore,
    catalogClient: {
      async catalog(value) {
        calls++;
        signal = value;
        await new Promise<void>((resolve) =>
          value!.addEventListener("abort", () => resolve(), { once: true }),
        );
        finished = true;
        return [];
      },
    },
  });
  try {
    await app.inject("/health/live");
    assert.equal(calls, 0);
    await app.listen({ port: 0, host: "127.0.0.1" });
    await nextTurn();
    assert.equal(calls, 1);
    await app.inject("/health/live");
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
  assert.ok(signal?.aborted);
  assert.ok(closed);
});
