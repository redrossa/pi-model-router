import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCriteria, loadCriteria, loadDefaultCriteria } from "../src/config.js";
import { THINKING_LEVELS } from "../src/types.js";

/** Writes `<dir>/.pi/pi-model-router.json` into a fresh temp dir and returns the dir. */
function tempProjectWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-router-cfg-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "pi-model-router.json"), JSON.stringify(config));
  return dir;
}

test("merges user category overrides without dropping siblings", () => {
  const base = loadDefaultCriteria();
  const merged = mergeCriteria(base, {
    categories: {
      coding: { description: "custom", models: ["only-model"] },
    },
  });
  assert.deepEqual(merged.categories.coding, {
    description: "custom",
    models: ["only-model"],
    thinkingLevel: base.categories.coding?.thinkingLevel,
  });
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

test("mergeCriteria carries the base category's thinkingLevel when the override omits it", () => {
  const base = loadDefaultCriteria();
  const baseLevel = base.categories.planning?.thinkingLevel;
  assert.ok(baseLevel, "shipped 'planning' category must define a thinkingLevel");
  const merged = mergeCriteria(base, {
    categories: { planning: { description: "custom", models: base.categories.planning?.models ?? [] } },
  });
  assert.equal(merged.categories.planning?.thinkingLevel, baseLevel);
});

test("mergeCriteria lets an override's thinkingLevel win", () => {
  const base = loadDefaultCriteria();
  assert.notEqual(base.categories.coding?.thinkingLevel, "xhigh");
  const merged = mergeCriteria(base, {
    categories: {
      coding: { description: "custom", models: base.categories.coding?.models ?? [], thinkingLevel: "xhigh" },
    },
  });
  assert.equal(merged.categories.coding?.thinkingLevel, "xhigh");
});

test("loadCriteria rejects an invalid thinkingLevel", () => {
  const dir = tempProjectWith({ categories: { coding: { thinkingLevel: "ultra" } } });
  assert.throws(() => loadCriteria(dir), /invalid thinkingLevel/);
});

test("shipped default criteria assign a valid thinkingLevel to every category", () => {
  const criteria = loadDefaultCriteria();
  for (const [name, category] of Object.entries(criteria.categories)) {
    assert.ok(
      category.thinkingLevel !== undefined && THINKING_LEVELS.includes(category.thinkingLevel),
      `category "${name}" has missing/invalid thinkingLevel: ${String(category.thinkingLevel)}`,
    );
  }
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
