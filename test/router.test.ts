import { test } from "node:test";
import assert from "node:assert/strict";
import { pickModel } from "../src/router.js";
import { loadDefaultCriteria } from "../src/config.js";
import type { JevClient } from "../src/jev.js";
import type { JevChoiceAnswer } from "../src/types.js";

function fakeJev(answer: JevChoiceAnswer | Error): JevClient {
  return {
    classify: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as JevClient;
}

test("routes to the winning category's first available model", async () => {
  const criteria = loadDefaultCriteria();
  const decision = await pickModel("plan out the architecture", {
    jev: fakeJev({ type: "choice", choice: "planning", confidence: 0.9, probabilities: { planning: 0.9 } }),
    criteria,
    isAvailable: (id) => id === "astra",
  });
  assert.equal(decision.category, "planning");
  assert.equal(decision.model, "astra");
  assert.equal(decision.source, "jev");
});

test("skips unavailable models in priority order", async () => {
  const criteria = loadDefaultCriteria();
  const decision = await pickModel("fix this bug", {
    jev: fakeJev({ type: "choice", choice: "coding", confidence: 0.8, probabilities: {} }),
    criteria,
    isAvailable: (id) => id === "opus",
  });
  assert.equal(decision.model, "opus");
});

test("falls back on low confidence", async () => {
  const criteria = loadDefaultCriteria();
  const decision = await pickModel("hmm", {
    jev: fakeJev({ type: "choice", choice: "research", confidence: 0.1, probabilities: {} }),
    criteria,
    isAvailable: () => true,
  });
  assert.equal(decision.source, "fallback");
  assert.equal(decision.category, criteria.fallback.category);
});

test("falls back on Jev error", async () => {
  const criteria = loadDefaultCriteria();
  const decision = await pickModel("anything", {
    jev: fakeJev(new Error("timeout")),
    criteria,
    isAvailable: () => true,
  });
  assert.equal(decision.source, "fallback");
  assert.match(decision.error ?? "", /timeout/);
});

test("falls back to null jev client (no api key)", async () => {
  const criteria = loadDefaultCriteria();
  const decision = await pickModel("anything", {
    jev: null,
    criteria,
    isAvailable: () => true,
  });
  assert.equal(decision.source, "fallback");
});

test("cascades to any available category if fallback category is also unavailable", async () => {
  const criteria = loadDefaultCriteria();
  const decision = await pickModel("anything", {
    jev: fakeJev(new Error("down")),
    criteria,
    isAvailable: (id) => id === "terra",
  });
  assert.equal(decision.model, "terra");
  assert.equal(decision.source, "fallback");
});

test("throws when nothing is available anywhere", async () => {
  const criteria = loadDefaultCriteria();
  await assert.rejects(
    pickModel("anything", { jev: fakeJev(new Error("down")), criteria, isAvailable: () => false }),
  );
});
