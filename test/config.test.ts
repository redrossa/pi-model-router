import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCriteria, loadDefaultCriteria } from "../src/config.js";

test("merges user category overrides without dropping siblings", () => {
  const base = loadDefaultCriteria();
  const merged = mergeCriteria(base, {
    categories: {
      coding: { description: "custom", models: ["only-model"] },
    },
  });
  assert.deepEqual(merged.categories.coding, { description: "custom", models: ["only-model"] });
  assert.deepEqual(merged.categories.planning, base.categories.planning);
});

test("adds new categories via override", () => {
  const base = loadDefaultCriteria();
  const merged = mergeCriteria(base, {
    categories: { writing: { description: "docs", models: ["astra"] } },
  });
  assert.ok(merged.categories.writing);
  assert.equal(Object.keys(merged.categories).length, Object.keys(base.categories).length + 1);
});

test("overrides top-level fields", () => {
  const base = loadDefaultCriteria();
  const merged = mergeCriteria(base, { confidenceThreshold: 0.75 });
  assert.equal(merged.confidenceThreshold, 0.75);
});
