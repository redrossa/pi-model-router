import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import piModelRouter from "../src/extension.js";

// Keep the jev-disabled fallback path deterministic regardless of the
// environment the tests happen to run in.
delete process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_BASE;

// Isolate from the developer's real user config and the repo's own untracked
// `.pi/pi-model-router.json`: loadCriteria looks in ctx.cwd (which the harness
// points at a fresh temp dir) and ~/.pi/agent/pi-model-router.json via
// os.homedir(), which honors $HOME on POSIX.
const ISOLATED_DIR = mkdtempSync(join(tmpdir(), "pi-model-router-test-"));
process.env.HOME = ISOLATED_DIR;

interface FakeModel {
  provider: string;
  id: string;
}

/**
 * Deliberately NOT one of the shipped default models, so restore-tracking
 * assertions are unambiguous.
 */
const INITIAL_MODEL: FakeModel = { provider: "anthropic", id: "claude-sonnet-4-5" };

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
  registerProviderCalls: Array<{ id: string; config: unknown }>;
  setCurrentModel(model: FakeModel): void;
  currentModel(): FakeModel;
}

interface HarnessOptions {
  available: FakeModel[];
  initialModel: FakeModel;
  storedKey?: string;
  hasUI?: boolean;
  inputResponses?: (string | undefined)[];
  userConfig?: Record<string, unknown>;
  cwd?: string;
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
  const cwd = opts.cwd ?? mkdtempSync(join(ISOLATED_DIR, "proj-"));
  if (opts.userConfig !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "pi-model-router.json"), JSON.stringify(opts.userConfig));
  }
  const setModelCalls: FakeModel[] = [];
  const notifications: Notification[] = [];
  const statuses = new Map<string, string>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const auth = new Map<string, FakeCredential>();
  if (opts.storedKey !== undefined) auth.set("typesafe", { type: "api_key", key: opts.storedKey });
  const inputCalls: Array<{ title: string; placeholder: string | undefined }> = [];
  const inputResponses = [...(opts.inputResponses ?? [])];
  const commands = new Map<string, CommandHandler>();
  const registerProviderCalls: Array<{ id: string; config: unknown }> = [];

  const ctx = {
    cwd,
    hasUI: opts.hasUI ?? true,
    get model(): FakeModel {
      return current;
    },
    modelRegistry: {
      getAvailable: () => opts.available,
      getApiKeyForProvider: async (provider: string) => auth.get(provider)?.key,
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
    registerProvider: (id: string, config: unknown) => {
      registerProviderCalls.push({ id, config });
    },
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
    registerProviderCalls,
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

/** A resolvable model from the shipped `coding` list (used to drive routing). */
const OPUS = { provider: "anthropic", id: "claude-opus-5" };

test("registers the typesafe credential-only provider on load", () => {
  const h = makeHarness({ available: [], initialModel: INITIAL_MODEL });
  assert.equal(h.registerProviderCalls.length, 1);
  assert.equal(h.registerProviderCalls[0]?.id, "typesafe");
  assert.deepEqual(h.registerProviderCalls[0]?.config, { name: "TypeSafe (pi-model-router)" });
});

test("before_agent_start switches to the first available fallback model", async () => {
  const h = makeHarness({
    available: [OPUS],
    initialModel: INITIAL_MODEL,
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0]?.id, "claude-opus-5");
  assert.ok(h.statuses.has("router"));
});

test("disambiguates provider/id refs (first match wins)", async () => {
  const h = makeHarness({
    available: [
      { provider: "openai", id: "opus" },
      { provider: "other", id: "opus" },
    ],
    initialModel: INITIAL_MODEL,
    userConfig: { categories: { coding: { models: ["opus"] } } },
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0]?.provider, "openai");
});

test("does not call setModel when already on the routed model", async () => {
  const h = makeHarness({
    available: [OPUS],
    initialModel: OPUS,
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  assert.equal(h.setModelCalls.length, 0);
});

test("agent_end restores the previous model", async () => {
  const h = makeHarness({
    available: [OPUS],
    initialModel: INITIAL_MODEL,
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);
  await h.fire("agent_end", AGENT_END);

  assert.equal(h.setModelCalls.length, 2);
  assert.equal(h.setModelCalls[1]?.id, "claude-sonnet-4-5");
});

test("agent_end does NOT restore when the user switched models mid-run", async () => {
  const h = makeHarness({
    available: [OPUS],
    initialModel: INITIAL_MODEL,
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  h.setCurrentModel({ provider: "anthropic", id: "claude-haiku-4-5" });
  await h.fire("agent_end", AGENT_END);

  // Only the initial routing call — no restore, since the user moved off it.
  assert.equal(h.setModelCalls.length, 1);
});

test("notifies and keeps current model when nothing is available", async () => {
  const h = makeHarness({
    available: [],
    initialModel: INITIAL_MODEL,
    storedKey: "sk-x",
  });
  const fetchStub = stubFetch();
  try {
    await h.fire("session_start", SESSION_START);
    await h.fire("before_agent_start", BEFORE_AGENT_START);

    assert.equal(h.setModelCalls.length, 0);
    const warning = h.notifications.find(
      (n) => n.type === "warning" && n.message.includes("none of the models") && n.message.includes("pi --list-models"),
    );
    assert.ok(warning, `expected a warning notification, got: ${JSON.stringify(h.notifications)}`);
    assert.match(h.statuses.get("router") ?? "", /disabled/);
    // The short-circuit must skip Jev's network call entirely, even with a key.
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
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

test("no key anywhere: warns on session_start and never calls fetch", async () => {
  const h = makeHarness({ available: [], initialModel: INITIAL_MODEL });
  const fetchStub = stubFetch();
  try {
    await h.fire("session_start", SESSION_START);
    const warning = h.notifications.find((n) => n.type === "warning" && n.message.includes("/login"));
    assert.ok(warning, `expected a warning mentioning /login, got: ${JSON.stringify(h.notifications)}`);
    await h.fire("before_agent_start", BEFORE_AGENT_START);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test("stored key only: no missing-key warning and routes with the stored key", async () => {
  const h = makeHarness({ available: [OPUS], initialModel: INITIAL_MODEL, storedKey: "sk-stored" });
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
  const h = makeHarness({ available: [OPUS], initialModel: INITIAL_MODEL });
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
  const h = makeHarness({ available: [OPUS], initialModel: INITIAL_MODEL, storedKey: "sk-stored" });
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

test("key removed after session_start: no fetch on before_agent_start", async () => {
  const h = makeHarness({ available: [OPUS], initialModel: INITIAL_MODEL, storedKey: "sk-stored" });
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
  const stored = makeHarness({ available: [], initialModel: INITIAL_MODEL, storedKey: "sk-x" });
  await stored.fire("session_start", SESSION_START);
  await stored.runCommand("router", "");
  const storedText = stored.notifications.map((n) => n.message).join("\n");
  assert.ok(storedText.includes("pi auth storage"), `stored status was: ${storedText}`);

  process.env.TYPESAFE_API_KEY = "sk-env";
  try {
    const env = makeHarness({ available: [], initialModel: INITIAL_MODEL });
    await env.fire("session_start", SESSION_START);
    await env.runCommand("router", "");
    const envText = env.notifications.map((n) => n.message).join("\n");
    assert.ok(envText.includes("TYPESAFE_API_KEY env var"), `env status was: ${envText}`);
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }

  const none = makeHarness({ available: [], initialModel: INITIAL_MODEL });
  await none.fire("session_start", SESSION_START);
  await none.runCommand("router", "");
  const noneText = none.notifications.map((n) => n.message).join("\n");
  assert.ok(noneText.includes("disabled"), `none status was: ${noneText}`);
});

test("warns when no configured model resolves at session_start", async () => {
  const h = makeHarness({ available: [], initialModel: INITIAL_MODEL });

  await h.fire("session_start", SESSION_START);

  const warning = h.notifications.find(
    (n) => n.type === "warning" && n.message.includes("none of the models") && n.message.includes("pi --list-models"),
  );
  assert.ok(warning, `expected a nothing-resolves warning, got: ${JSON.stringify(h.notifications)}`);
});

test("warns again on /router reload when nothing resolves", async () => {
  const h = makeHarness({ available: [], initialModel: INITIAL_MODEL });

  await h.fire("session_start", SESSION_START);
  h.notifications.length = 0;

  await h.runCommand("router", "reload");

  const warnings = h.notifications.filter(
    (n) => n.type === "warning" && n.message.includes("none of the models") && n.message.includes("pi --list-models"),
  );
  assert.equal(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(h.notifications)}`);
});

test("no nothing-resolves warning when at least one model is available", async () => {
  const h = makeHarness({ available: [OPUS], initialModel: INITIAL_MODEL });

  await h.fire("session_start", SESSION_START);

  assert.ok(
    !h.notifications.some((n) => n.message.includes("none of the models")),
    `unexpected nothing-resolves warning: ${JSON.stringify(h.notifications)}`,
  );
});

test("user override in <cwd>/.pi/pi-model-router.json is honoured", async () => {
  const h = makeHarness({
    userConfig: { categories: { coding: { models: ["myprov/my-model"] } } },
    available: [{ provider: "myprov", id: "my-model" }],
    initialModel: INITIAL_MODEL,
  });

  await h.fire("session_start", SESSION_START);
  await h.fire("before_agent_start", BEFORE_AGENT_START);

  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0]?.id, "my-model");
});
