import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_HINT, JevClient } from "../src/jev.js";
import type { RouterCriteria } from "../src/types.js";

const FIXTURE: RouterCriteria = {
  question: "task_category",
  instructions: "test fixture instructions",
  categories: {
    planning: { description: "planning work", models: ["fable"] },
    coding: { description: "coding work", models: ["flash"] },
  },
  fallback: { category: "coding" },
};

/**
 * Replaces global `fetch` with a stub that records each call's parsed request
 * body and answers with `response`. Callers MUST call `restore()` in a
 * `finally` block.
 */
function stubFetch(response: { status: number; statusText?: string; body?: unknown }): {
  calls: Array<{ url: string; body: any }>;
  restore(): void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(response.body === undefined ? "" : JSON.stringify(response.body), {
      status: response.status,
      statusText: response.statusText ?? "",
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function okAnswerBody(): unknown {
  return {
    answers: {
      task_category: { type: "choice", choice: "coding", confidence: 0.9, probabilities: {} },
    },
  };
}

test("omits recentContext and the hint when no context is given", async () => {
  const stub = stubFetch({ status: 200, body: okAnswerBody() });
  try {
    const client = new JevClient({ apiKey: "sk-test" });
    await client.classify("yes", FIXTURE);

    assert.equal(stub.calls.length, 1);
    const body = stub.calls[0]?.body;
    assert.deepEqual(body.state, { prompt: "yes" });
    assert.ok(!("recentContext" in body.state), "recentContext must not be present at all");
    assert.equal(body.questions[FIXTURE.question].instructions, FIXTURE.instructions);
  } finally {
    stub.restore();
  }
});

test("sends recentContext and appends the hint when context is supplied", async () => {
  const stub = stubFetch({ status: 200, body: okAnswerBody() });
  try {
    const client = new JevClient({ apiKey: "sk-test" });
    const recentContext = [{ role: "assistant" as const, text: "Refactor or patch?" }];
    await client.classify("yes", FIXTURE, recentContext);

    const body = stub.calls[0]?.body;
    assert.deepEqual(body.state.recentContext, recentContext);
    assert.equal(body.questions[FIXTURE.question].instructions, FIXTURE.instructions + CONTEXT_HINT);
  } finally {
    stub.restore();
  }
});

test("an empty recentContext array counts as no context", async () => {
  const stub = stubFetch({ status: 200, body: okAnswerBody() });
  try {
    const client = new JevClient({ apiKey: "sk-test" });
    await client.classify("yes", FIXTURE, []);

    const body = stub.calls[0]?.body;
    assert.deepEqual(body.state, { prompt: "yes" });
    assert.ok(!("recentContext" in body.state), "recentContext must not be present at all");
    assert.equal(body.questions[FIXTURE.question].instructions, FIXTURE.instructions);
  } finally {
    stub.restore();
  }
});

test("a non-OK response rejects with the status code in the message", async () => {
  const stub = stubFetch({ status: 500, statusText: "Internal Server Error", body: "boom" });
  try {
    const client = new JevClient({ apiKey: "sk-test" });
    await assert.rejects(client.classify("yes", FIXTURE), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /500/);
      return true;
    });
  } finally {
    stub.restore();
  }
});
