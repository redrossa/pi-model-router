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
    categories: { writing: { description: "docs", models: ["openai-codex/gpt-6-astra"] } },
  });
  assert.ok(merged.categories.writing);
  assert.equal(Object.keys(merged.categories).length, Object.keys(base.categories).length + 1);
});

test("overrides top-level fields", () => {
  const base = loadDefaultCriteria();
  const merged = mergeCriteria(base, { confidenceThreshold: 0.75 });
  assert.equal(merged.confidenceThreshold, 0.75);
});

test("shipped default criteria only uses provider/id refs and is internally consistent", () => {
  const criteria = loadDefaultCriteria();
  const providerId = /^[a-z0-9-]+\/\S+$/;
  for (const [name, category] of Object.entries(criteria.categories)) {
    assert.ok(category.models.length >= 1, `category "${name}" has no models`);
    for (const model of category.models) {
      assert.match(model, providerId, `category "${name}" model "${model}" is not in provider/id form`);
    }
  }
  assert.ok(
    criteria.categories[criteria.fallback.category],
    `fallback category "${criteria.fallback.category}" does not exist among the categories`,
  );
});
