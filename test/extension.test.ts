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

type FakeCredential = { type: "api_key"; key: string };
type CommandHandler = (args: string, ctx: any) => Promise<void>;

interface Harness {
  fire(event: string, eventArg: unknown): Promise<void>;
  runCommand(name: string, args: string): Promise<void>;
  setModelCalls: FakeModel[];
  notifications: Notification[];
  statuses: Map<string, string>;
  auth: Map<string, FakeCredential>;
  inputCalls: Array<{ title: string; placeholder: string | undefined }>;
  commands: Map<string, CommandHandler>;
  setCurrentModel(model: FakeModel): void;
  currentModel(): FakeModel;
}

interface HarnessOptions {
  available: FakeModel[];
  initialModel: FakeModel;
  storedKey?: string;
  hasUI?: boolean;
  inputResponses?: (string | undefined)[];
}

/**
 * Minimal fake ExtensionAPI/ExtensionContext: records `setModel` calls,
 * notifications and statuses, and lets tests read/mutate the "current model".
 * The real pi runtime is not needed — the extension only ever touches
 * `ctx.model`, `ctx.modelRegistry.getAvailable()`, `ctx.ui.notify`,
 * `ctx.ui.setStatus` and `pi.setModel`.
 */
function makeHarness(opts: HarnessOptions): Harness {
  let current = opts.initialModel;
  const setModelCalls: FakeModel[] = [];
  const notifications: Notification[] = [];
  const statuses = new Map<string, string>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const auth = new Map<string, FakeCredential>();
  if (opts.storedKey !== undefined) auth.set("typesafe", { type: "api_key", key: opts.storedKey });
  const inputCalls: Array<{ title: string; placeholder: string | undefined }> = [];
  const inputResponses = [...(opts.inputResponses ?? [])];
  const commands = new Map<string, CommandHandler>();

  const ctx = {
    cwd: process.cwd(),
    hasUI: opts.hasUI ?? true,
    get model(): FakeModel {
      return current;
    },
    modelRegistry: {
      getAvailable: () => opts.available,
      getApiKeyForProvider: async (provider: string) => auth.get(provider)?.key,
      authStorage: {
        get: (provider: string) => auth.get(provider),
        set: (provider: string, credential: FakeCredential) => {
          auth.set(provider, credential);
        },
      },
    },
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      setStatus: (key: string, text: string | undefined) => {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      input: async (title: string, placeholder?: string) => {
        inputCalls.push({ title, placeholder });
        return inputResponses.shift();
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
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      commands.set(name, options.handler);
    },
    registerProvider: () => {},
  };

  piModelRouter(pi as unknown as ExtensionAPI);

  return {
    async fire(event, eventArg) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for "${event}"`);
      await handler(eventArg, ctx as unknown as ExtensionContext);
    },
    async runCommand(name, args) {
      const handler = commands.get(name);
      if (!handler) throw new Error(`no command registered for "${name}"`);
      await handler(args, ctx as unknown as ExtensionContext);
    },
    setModelCalls,
    notifications,
    statuses,
    auth,
    inputCalls,
    commands,
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

/**
 * Replaces global `fetch` with a stub that always answers Jev's Choice
 * request with `answer` (default: the "coding" category at 0.9 confidence)
 * and records every call's URL + Authorization header. Callers MUST call
 * `restore()` in a `finally` block.
 */
function stubFetch(answer?: { choice: string; confidence: number }): {
  calls: Array<{ url: string; authorization: string | undefined }>;
  restore(): void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    const body = JSON.stringify({
      answers: {
        task_category: {
          type: "choice",
          choice: answer?.choice ?? "coding",
          confidence: answer?.confidence ?? 0.9,
          probabilities: {},
        },
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const FAKE_INITIAL = { provider: "anthropic", id: "sonnet" };

test("no key anywhere: warns on session_start and never calls fetch", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL });
  const fetchStub = stubFetch();
  try {
    await h.fire("session_start", SESSION_START);
    const warning = h.notifications.find((n) => n.type === "warning" && n.message.includes("/router:login"));
    assert.ok(warning, `expected a warning mentioning /router:login, got: ${JSON.stringify(h.notifications)}`);
    await h.fire("before_agent_start", BEFORE_AGENT_START);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test("stored key only: no missing-key warning and routes with the stored key", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL, storedKey: "sk-stored" });
  const fetchStub = stubFetch();
  try {
    await h.fire("session_start", SESSION_START);
    assert.ok(
      !h.notifications.some((n) => n.type === "warning" && n.message.includes("no TypeSafe API key")),
      `unexpected missing-key warning: ${JSON.stringify(h.notifications)}`,
    );
    await h.fire("before_agent_start", BEFORE_AGENT_START);
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0]?.authorization, "Bearer sk-stored");
  } finally {
    fetchStub.restore();
  }
});

test("env key only: routes with the env var key", async () => {
  process.env.TYPESAFE_API_KEY = "sk-env";
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL });
  const fetchStub = stubFetch();
  try {
    await h.fire("session_start", SESSION_START);
    await h.fire("before_agent_start", BEFORE_AGENT_START);
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0]?.authorization, "Bearer sk-env");
  } finally {
    fetchStub.restore();
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("stored key takes precedence over the env var", async () => {
  process.env.TYPESAFE_API_KEY = "sk-env";
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL, storedKey: "sk-stored" });
  const fetchStub = stubFetch();
  try {
    await h.fire("session_start", SESSION_START);
    await h.fire("before_agent_start", BEFORE_AGENT_START);
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0]?.authorization, "Bearer sk-stored");
  } finally {
    fetchStub.restore();
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("/router:login stores the trimmed key and takes effect immediately", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL, inputResponses: ["  sk-new  "] });
  const fetchStub = stubFetch();
  try {
    await h.fire("session_start", SESSION_START);
    await h.runCommand("router:login", "");
    assert.deepEqual(h.auth.get("typesafe"), { type: "api_key", key: "sk-new" });
    assert.ok(
      h.notifications.some((n) => n.type === "info" && n.message.includes("saved")),
      `expected a "saved" info notification, got: ${JSON.stringify(h.notifications)}`,
    );
    await h.fire("before_agent_start", BEFORE_AGENT_START);
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0]?.authorization, "Bearer sk-new");
  } finally {
    fetchStub.restore();
  }
});

test("re-running /router:login overwrites the stored key", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL, inputResponses: ["sk-1", "sk-2"] });
  await h.runCommand("router:login", "");
  await h.runCommand("router:login", "");
  assert.equal(h.auth.get("typesafe")?.key, "sk-2");
  assert.ok(h.inputCalls[1]?.title.includes("replaces"), `got title: ${h.inputCalls[1]?.title}`);
});

test("cancelled /router:login stores nothing", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL, inputResponses: [undefined] });
  await h.runCommand("router:login", "");
  assert.equal(h.auth.has("typesafe"), false);
  assert.ok(
    h.notifications.some((n) => n.type === "info" && n.message.includes("cancelled")),
    `expected a "cancelled" info notification, got: ${JSON.stringify(h.notifications)}`,
  );
});

test("/router:login rejects an empty/whitespace key", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL, inputResponses: ["   "] });
  await h.runCommand("router:login", "");
  assert.equal(h.auth.has("typesafe"), false);
  assert.ok(
    h.notifications.some((n) => n.type === "error"),
    `expected an error notification, got: ${JSON.stringify(h.notifications)}`,
  );
});

test("/router:login requires an interactive UI", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL, hasUI: false });
  await h.runCommand("router:login", "");
  assert.equal(h.auth.has("typesafe"), false);
  assert.equal(h.inputCalls.length, 0);
  assert.ok(
    h.notifications.some((n) => n.type === "error" && n.message.includes("TYPESAFE_API_KEY")),
    `expected an error mentioning TYPESAFE_API_KEY, got: ${JSON.stringify(h.notifications)}`,
  );
});

test("/router:login rejects a key passed as an argument", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL });
  await h.runCommand("router:login", "sk-leak");
  assert.equal(h.auth.has("typesafe"), false);
  assert.equal(h.inputCalls.length, 0);
  assert.ok(
    h.notifications.some((n) => n.type === "warning"),
    `expected a warning notification, got: ${JSON.stringify(h.notifications)}`,
  );
});

test("key removed after session_start: no fetch on before_agent_start", async () => {
  const h = makeHarness({ available: [], initialModel: FAKE_INITIAL, storedKey: "sk-stored" });
  const fetchStub = stubFetch();
  try {
    await h.fire("session_start", SESSION_START);
    h.auth.delete("typesafe");
    await h.fire("before_agent_start", BEFORE_AGENT_START);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test("/router status reports where the key comes from", async () => {
  const stored = makeHarness({ available: [], initialModel: FAKE_INITIAL, storedKey: "sk-x" });
  await stored.fire("session_start", SESSION_START);
  await stored.runCommand("router", "");
  const storedText = stored.notifications.map((n) => n.message).join("\n");
  assert.ok(storedText.includes("pi auth storage"), `stored status was: ${storedText}`);

  process.env.TYPESAFE_API_KEY = "sk-env";
  try {
    const env = makeHarness({ available: [], initialModel: FAKE_INITIAL });
    await env.fire("session_start", SESSION_START);
    await env.runCommand("router", "");
    const envText = env.notifications.map((n) => n.message).join("\n");
    assert.ok(envText.includes("TYPESAFE_API_KEY env var"), `env status was: ${envText}`);
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }

  const none = makeHarness({ available: [], initialModel: FAKE_INITIAL });
  await none.fire("session_start", SESSION_START);
  await none.runCommand("router", "");
  const noneText = none.notifications.map((n) => n.message).join("\n");
  assert.ok(noneText.includes("disabled"), `none status was: ${noneText}`);
});
