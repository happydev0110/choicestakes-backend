import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config/env.js";
import { ApiMaticClient } from "../src/modules/gaming/client.js";
import { signRequest } from "../src/modules/gaming/signing.js";

const config = loadConfig({
  APIMATIC_API_KEY: "test-only-key",
  APIMATIC_SECRET_KEY: "01".repeat(32),
  APIMATIC_CURRENCY: "USD",
});

function fixture(link: string, configured = config) {
  let calls = 0;
  const client = new ApiMaticClient(configured, async (input, init) => {
    calls++;
    assert.equal(String(input), "https://sandbox-api.api-matic.com/api/v1/game/launch");
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ["currency", "gametype", "lang", "player_id"]);
    assert.equal(JSON.parse(body).currency, "USD");
    assert.equal(headers.get("X-Sign"), signRequest(
      configured.APIMATIC_SECRET_KEY, headers.get("X-Timestamp")!,
      headers.get("X-Nonce")!, "POST", "/api/v1/game/launch", body,
    ));
    return Response.json({ success: true, data: {
      link, vendor_session_id: "fixture-session", environment: "sandbox",
    } });
  });
  return { client, calls: () => calls };
}

test("Betby entry URLs apply tile/blue-dark while preserving encoded session data", async () => {
  for (const path of ["/sports", "/sports/", "/sports/embed", "/home"]) {
    for (const mode of ["real", "demo"] as const) {
      const query = "token=abc%2fDEF%2Bghi%3D&lang=en&top=%2Ftennis-5&currency=USD&path=live";
      const { client, calls } = fixture(`https://sports.example.com${path}?${query}&defaultLayout=sidebar&color=green-dark&color=red-white#section`);
      const result = await client.launch("fixture-player", config.SPORTSBOOK_GAME_ID, mode);
      assert.equal(result.link, `https://sports.example.com${path}?${query}&defaultLayout=tile&color=blue-dark#section`);
      assert.equal(result.sessionId, "fixture-session");
      assert.equal(result.sportsbookPresentationApplied, true);
      assert.equal(calls(), 1, "presentation must not create a second provider session");
    }
  }
});

test("resolved Betby routes retain deep links while switching layout and color", async () => {
  for (const layout of ["classic", "sidebar", "tile"]) {
    const { client } = fixture(`https://sports.example.com/sportsbook/${layout}/live/tennis-5?token=test&color=green-dark`);
    const result = await client.launch("fixture-player", config.SPORTSBOOK_GAME_ID, "real");
    assert.equal(result.link, "https://sports.example.com/sportsbook/tile/live/tennis-5?token=test&color=blue-dark");
  }
});

test("unknown Betby wrapper URLs are preserved and report unapplied settings", async () => {
  for (const path of ["/launch", "/sportsbook", "/sportsbook/unknown", "/other/sports"]) {
    const link = `https://wrapper.example.com${path}?token=test&redirect=%2Fsports&signature=test`;
    const { client } = fixture(link);
    const result = await client.launch("fixture-player", config.SPORTSBOOK_GAME_ID, "real");
    assert.equal(result.link, link);
    assert.equal(result.sportsbookPresentationApplied, false);
  }
});

test("an environment theme override replaces the provider preset without altering session data", async () => {
  const configured = loadConfig({
    APIMATIC_API_KEY: config.APIMATIC_API_KEY,
    APIMATIC_SECRET_KEY: config.APIMATIC_SECRET_KEY,
    APIMATIC_CURRENCY: "USD", SPORTSBOOK_THEME: "blue-yellow",
  });
  const { client } = fixture("https://sports.example.com/sports?token=a%2Fb%2B&color=green-dark", configured);
  const result = await client.launch("fixture-player", configured.SPORTSBOOK_GAME_ID, "real");
  assert.equal(result.link, "https://sports.example.com/sports?token=a%2Fb%2B&defaultLayout=tile&color=blue-yellow");
});

test("other games retain their URLs even when their route resembles Betby", async () => {
  const link = "https://other.example.com/sports?token=test&color=green-dark&defaultLayout=classic";
  const { client } = fixture(link);
  const result = await client.launch("fixture-player", "71dc9527-af3c-5466-8563-6e5da86a8188", "real");
  assert.equal(result.link, link);
  assert.equal(result.sportsbookPresentationApplied, undefined);
});

test("a configured alternate Betby UUID is targeted instead of the default", async () => {
  const alternate = "e1b646cc-c79d-4f86-ae2f-1896eec06cad";
  const configured = { ...config, SPORTSBOOK_GAME_ID: alternate };
  const link = "https://sports.example.com/sports?token=test";
  const { client } = fixture(link, configured);
  const result = await client.launch("fixture-player", alternate, "real");
  assert.equal(result.sportsbookPresentationApplied, true);
  assert.equal((await client.launch("fixture-player", config.SPORTSBOOK_GAME_ID, "real")).link, link);
});

test("Betby presentation does not bypass provider URL validation", async () => {
  for (const link of ["http://sports.example.com/sports", "https://127.0.0.1/sports", "https://user:secret@sports.example.com/sports"]) {
    const { client } = fixture(link);
    await assert.rejects(client.launch("fixture-player", config.SPORTSBOOK_GAME_ID, "real"), /Invalid provider play URL/);
  }
});
