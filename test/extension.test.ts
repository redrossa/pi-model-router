import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import piModelRouter from "../src/extension.js";

// Keep the jev-disabled fallback path deterministic regardless of the
// environment the tests happen to run in.
delete process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_BASE;

interface FakeModel {
  provider: string;
  id: string;
}

interface Notification {
  message: string;
  type: string | undefined;
}

interface Harness {
  fire(event: string, eventArg: unknown): Promise<void>;
  setModelCalls: FakeModel[];
  notifications: Notification[];
  statuses: Map<string, string>;
  setCurrentModel(model: FakeModel): void;
  currentModel(): FakeModel;
}

/**
 * Minimal fake ExtensionAPI/ExtensionContext: records `setModel` calls,
 * notifications and statuses, and lets tests read/mutate the "current model".
 * The real pi runtime is not needed — the extension only ever touches
 * `ctx.model`, `ctx.modelRegistry.getAvailable()`, `ctx.ui.notify`,
 * `ctx.ui.setStatus` and `pi.setModel`.
 */
function makeHarness(opts: { available: FakeModel[]; initialModel: FakeModel }): Harness {
  let current = opts.initialModel;
  const setModelCalls: FakeModel[] = [];
  const notifications: Notification[] = [];
  const statuses = new Map<string, string>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();

  const ctx = {
    cwd: process.cwd(),
    get model(): FakeModel {
      return current;
    },
    modelRegistry: {
      getAvailable: () => opts.available,
    },
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      setStatus: (key: string, text: string | undefined) => {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
    },
  };

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    setModel: async (model: FakeModel) => {
      setModelCalls.push(model);
      current = model;
      return true;
    },
    registerCommand: () => {},
  };

  piModelRouter(pi as unknown as ExtensionAPI);

  return {
    async fire(event, eventArg) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for "${event}"`);
      await handler(eventArg, ctx as unknown as ExtensionContext);
    },
    setModelCalls,
    notifications,
    statuses,
    setCurrentModel(model) {
      current = model;
    },
    currentModel() {
      return current;
    },
  };
}

const SESSION_START = { type: "session_start", reason: "startup" };
const BEFORE_AGENT_START = {
  type: "before_agent_start",
  prompt: "hi",
  systemPrompt: "",
  systemPromptOptions: {},
};
const AGENT_END = { type: "agent_end", messages: [] };

test("before_agent_start switches to the first available fallback model", async () => {
  const h = makeHarness({
    available: [{ provider: "openai", id: "opus" }],
    initialModel: { provider: "anthropic", id: "sonnet" },
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0]?.id, "opus");
  assert.ok(h.statuses.has("router"));
});

test("disambiguates provider/id refs (first match wins)", async () => {
  const h = makeHarness({
    available: [
      { provider: "openai", id: "opus" },
      { provider: "other", id: "opus" },
    ],
    initialModel: { provider: "anthropic", id: "sonnet" },
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0]?.provider, "openai");
});

test("does not call setModel when already on the routed model", async () => {
  const h = makeHarness({
    available: [{ provider: "openai", id: "opus" }],
    initialModel: { provider: "openai", id: "opus" },
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  assert.equal(h.setModelCalls.length, 0);
});

test("agent_end restores the previous model", async () => {
  const h = makeHarness({
    available: [{ provider: "openai", id: "opus" }],
    initialModel: { provider: "anthropic", id: "sonnet" },
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);
  await h.fire("agent_end", AGENT_END);

  assert.equal(h.setModelCalls.length, 2);
  assert.equal(h.setModelCalls[1]?.id, "sonnet");
});

test("agent_end does NOT restore when the user switched models mid-run", async () => {
  const h = makeHarness({
    available: [{ provider: "openai", id: "opus" }],
    initialModel: { provider: "anthropic", id: "sonnet" },
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  h.setCurrentModel({ provider: "anthropic", id: "haiku" });
  await h.fire("agent_end", AGENT_END);

  // Only the initial routing call — no restore, since the user moved off it.
  assert.equal(h.setModelCalls.length, 1);
});

test("notifies and keeps current model when nothing is available", async () => {
  const h = makeHarness({
    available: [],
    initialModel: { provider: "anthropic", id: "sonnet" },
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  assert.equal(h.setModelCalls.length, 0);
  const warning = h.notifications.find(
    (n) => n.type === "warning" && n.message.includes("no configured model is available"),
  );
  assert.ok(warning, `expected a warning notification, got: ${JSON.stringify(h.notifications)}`);
});
