import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  catalogFilters,
  classificationFile,
} from "../src/modules/gaming/catalog-filters.js";

test("catalog filters distinguish an empty favorites list from no filter and reject invalid input", () => {
  assert.equal(catalogFilters.parse({}).ids, undefined);
  assert.deepEqual(catalogFilters.parse({ ids: "" }).ids, []);
  const ids = [randomUUID(), randomUUID()];
  assert.deepEqual(catalogFilters.parse({ ids: ids.join(",") }).ids, ids);
  for (const query of [
    { ids: "not-a-game" },
    { ids: Array.from({ length: 101 }, randomUUID).join(",") },
    { category: "popular" },
    { sort: "name; DELETE" },
    { page: -1 },
    { page: "NaN" },
  ]) {
    assert.equal(catalogFilters.safeParse(query).success, false);
  }
});

test("manual categories allow multiple assignments and clearing, but reject duplicates and unsupported categories", () => {
  const uuid = randomUUID();
  assert.ok(
    classificationFile.safeParse({
      assignments: [{ uuid, categories: ["slots", "new-games"] }],
    }).success,
  );
  assert.ok(
    classificationFile.safeParse({ assignments: [{ uuid, categories: [] }] })
      .success,
  );
  for (const assignments of [
    [{ uuid, categories: ["unknown"] }],
    [{ uuid, categories: ["slots", "slots"] }],
    [
      { uuid, categories: [] },
      { uuid: uuid.toUpperCase(), categories: [] },
    ],
  ])
    assert.equal(classificationFile.safeParse({ assignments }).success, false);
});
