import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { AuthStore } from "../src/modules/auth/types.js";
import { ApiMaticClient } from "../src/modules/gaming/client.js";
import { gameLanguages } from "../src/modules/gaming/launch-request.js";
import { signRequest } from "../src/modules/gaming/signing.js";
import type { GamingStore } from "../src/modules/gaming/store.js";

test("launch API validates and signs each selected language, defaulting older clients to English", async (t) => {
  const config = loadConfig({ NODE_ENV: "test", DB_ENABLED: "true", MYSQL_USER: "test",
    APIMATIC_ENABLED: "true", APIMATIC_SYNC_ENABLED: "false", APIMATIC_API_KEY: "test-language-key",
    APIMATIC_SECRET_KEY: "01".repeat(32), APIMATIC_CURRENCY: "USD",
    APIMATIC_CALLBACK_URL: "https://api.example.com/api/v1/provider/apimatic/sandbox" });
  const gameId = randomUUID(), playerId = randomUUID();
  let calls = 0, claims = 0, expectedLanguage = "en";
  const client = new ApiMaticClient(config, async (url, init) => {
    calls++;
    assert.equal(String(url), "https://sandbox-api.api-matic.com/api/v1/game/launch");
    const body = String(init?.body), headers = new Headers(init?.headers);
    assert.deepEqual(JSON.parse(body), {player_id: playerId, currency: "USD", lang: expectedLanguage, gametype: "real"});
    assert.equal(headers.get("x-sign"), signRequest(config.APIMATIC_SECRET_KEY,
      headers.get("x-timestamp")!, headers.get("x-nonce")!, "POST", "/api/v1/game/launch", body));
    return Response.json({ success: true, data: {link: "https://games.example.com/play", vendor_session_id: randomUUID(), environment: "sandbox"} });
  });
  const app = await buildApp(config, {
    database: {enabled: true, ping: async () => {}, close: async () => {}},
    authStore: {findSession: async () => ({id: playerId})} as unknown as AuthStore,
    gamingStore: {
      game: async () => ({uuid: gameId}),
      claimLaunch: async () => { claims++; return randomUUID(); },
      completeLaunch: async () => {},
      failLaunch: async () => assert.fail("Unexpected launch failure"),
    } as unknown as GamingStore,
    gamingClient: client,
  });
  t.after(() => app.close());
  const launch = (extra: object) => app.inject({method: "POST", url: `/api/v1/gaming/games/${gameId}/launch`,
    headers: {origin: config.CORS_ORIGINS[0]!, "x-requested-with": "choicestakes", cookie: `choicestakes_session=${"a".repeat(43)}`},
    payload: {requestId: randomUUID(), ...extra},
  });
  for (const lang of [undefined, ...gameLanguages]) {
    expectedLanguage = lang ?? "en";
    const response = await launch(lang ? {lang} : {});
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal(calls, 9);
  for (const lang of ["ar", "unknown", "en-US", "../en", "", null, 123, ["en"]]) {
    const response = await launch({lang});
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_LAUNCH");
  }
  assert.equal(calls, 9, "invalid languages never call the provider");
  assert.equal(claims, 9, "invalid languages never create pending sessions");
});
