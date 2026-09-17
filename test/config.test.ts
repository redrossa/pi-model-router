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
    categories: { devops: { description: "shell, CI, Docker", models: ["openai-codex/gpt-6-astra"] } },
  });
  assert.ok(merged.categories.devops);
  assert.equal(Object.keys(merged.categories).length, Object.keys(base.categories).length + 1);
});

test("shipped defaults route writing/docs to the same model class as planning", () => {
  const criteria = loadDefaultCriteria();
  const writing = criteria.categories.writing;
  assert.ok(writing, "shipped defaults must include a 'writing' category");
  assert.deepEqual(writing.models.slice(0, 2), ["anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra"]);
  assert.deepEqual(writing.models, criteria.categories.planning?.models);
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
