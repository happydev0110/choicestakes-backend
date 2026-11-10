import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../src/config/env.js";
import { catalogReady, gamingReady, requireSandboxCredentials } from "../src/modules/gaming/config.js";
import { ApiMaticClient } from "../src/modules/gaming/client.js";
import { ApiMaticError } from "../src/modules/gaming/provider-error.js";

const secret = "01".repeat(32);
const enabled = {
  DB_ENABLED: "true", MYSQL_USER: "test", APIMATIC_ENABLED: "true",
  APIMATIC_SECRET_KEY: secret,
  APIMATIC_CALLBACK_URL: "https://api.example.com/api/v1/provider/apimatic/sandbox",
};

test("opaque sandbox keys pass startup, catalog and launch readiness without a prefix requirement", () => {
  for (const key of ["af8dc947b3a54cc5b923c0a977398013", "sandbox.test-key_123", "uks_legacy_test"]) {
    const config = loadConfig({ ...enabled, APIMATIC_API_KEY: key });
    requireSandboxCredentials(config);
    assert.equal(config.APIMATIC_API_KEY, key);
    assert.equal(catalogReady(config), true);
    assert.equal(gamingReady(config), true);
  }
  for (const key of ["", "   ", "invalid\r\nheader", "embedded space"]) {
    assert.throws(() => loadConfig({ ...enabled, APIMATIC_API_KEY: key }), /APIMATIC_API_KEY/);
    const config = loadConfig({ ...enabled, APIMATIC_ENABLED: "false", APIMATIC_API_KEY: key });
    assert.equal(catalogReady(config), false);
    assert.throws(() => requireSandboxCredentials(config), /APIMATIC_API_KEY/);
  }
  const invalidSecret = loadConfig({ ...enabled, APIMATIC_ENABLED: "false", APIMATIC_API_KEY: "opaque-key", APIMATIC_SECRET_KEY: "invalid-secret" });
  assert.equal(catalogReady(invalidSecret), false);
  assert.throws(() => requireSandboxCredentials(invalidSecret), /APIMATIC_SECRET_KEY/);
});

test("key spelling cannot switch the provider host or permit a production launch response", async () => {
  const config = loadConfig({ ...enabled, APIMATIC_API_KEY: "ukp_test_only" });
  const client = new ApiMaticClient(config, async (input, init) => {
    assert.equal(new URL(String(input)).origin, "https://sandbox-api.api-matic.com");
    assert.equal((init?.headers as Record<string, string>)["X-API-Key"], config.APIMATIC_API_KEY);
    return Response.json({ success: false, error: { code: "INVALID_API_KEY" } }, { status: 401 });
  });
  await assert.rejects(client.catalogPage(), (error) => error instanceof ApiMaticError && error.providerCode === "INVALID_API_KEY");
  const wrongEnvironment = new ApiMaticClient(config, async () => Response.json({
    success: true,
    data: { link: "https://games.example.com/play", vendor_session_id: "test-session", environment: "production" },
  }));
  await assert.rejects(wrongEnvironment.launch("test-player", "test-game", "real"));
});

test("sync CLI reports missing credentials explicitly without printing supplied values", () => {
  for (const [key, secretValue, expected] of [
    ["", "private-invalid-secret", /APIMATIC_API_KEY/],
    ["private-opaque-key", "private-invalid-secret", /APIMATIC_SECRET_KEY/],
    ["private-opaque-key", secret, /Set DB_ENABLED=true/],
  ] as const) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/modules/gaming/sync.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, NODE_ENV: "test", DB_ENABLED: "false", APIMATIC_ENABLED: "false", APIMATIC_API_KEY: key, APIMATIC_SECRET_KEY: secretValue },
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stdout + result.stderr, /private-opaque-key|private-invalid-secret/);
  }
});
