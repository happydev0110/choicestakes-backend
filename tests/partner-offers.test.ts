import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import {
  isSovrnLink,
  createPublicOfferStore,
} from "../src/modules/partners/routes.js";
import type { Database } from "../src/database/mysql.js";

test("public partner offers can be browsed without a player session, with page validation and no caching", async (t) => {
  const pages: number[] = [];
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    partnerStore: {
      async list(page) {
        pages.push(page);
        return { items: [], page, perPage: 12, total: 0 };
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject({ url: "/api/v1/partner-offers?page=2" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json().data, {
    items: [],
    page: 2,
    perPage: 12,
    total: 0,
  });
  for (const query of ["page=0", "page=1.5", "page=10001", "published=false"])
    assert.equal(
      (await app.inject({ url: "/api/v1/partner-offers?" + query })).statusCode,
      400,
    );
  assert.deepEqual(pages, [2]);
});

test("only Sovrn HTTPS links can be published through the public projection", () => {
  assert.equal(isSovrnLink("https://sovrn.co/trzdl82"), true);
  assert.equal(
    isSovrnLink("https://sovrn.co/?key=x&u=https%3A%2F%2Fexample.com"),
    true,
  );
  for (const value of [
    null,
    "javascript:alert(1)",
    "https://sovrn.co.evil.com",
    "https://user:password@sovrn.co",
    "http://sovrn.co",
    "https://sovrn.co:444/",
  ])
    assert.equal(isSovrnLink(value), false);
});

test("missing shared database returns an explicit service error, not a hardcoded affiliate fallback", async () => {
  const store = createPublicOfferStore({ enabled: false } as Database);
  await assert.rejects(store.list(1), {
    code: "PARTNERS_UNAVAILABLE",
    statusCode: 503,
  });
});
