import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadCriteria } from "./config.js";
import { extractRecentContext } from "./context.js";
import { JevClient } from "./jev.js";
import { hasAnyAvailableModel, pickModel } from "./router.js";
import type { ConversationTurn, RouteDecision, RouterCriteria, RouterThinkingLevel } from "./types.js";

/**
 * pi-model-router
 *
 * Classifies each prompt with TypeSafe's Jev (using a user-configurable
 * criteria map) and routes the agent run to whichever logged-in model best
 * fits the classified category.
 *
 * Strategy: classify once per agent run in `before_agent_start` (one Jev
 * call, stable for the whole run including the tool-call loop) and switch
 * the active model with `pi.setModel()` before the agent loop starts. In the
 * same step we also apply the winning category's configured thinking/effort
 * level with `pi.setThinkingLevel()` (clamped by pi to what the routed model
 * supports). Classification includes the last few user/assistant messages from
 * the session branch so short replies ("yes", "option 2") are classified by
 * what they're replying to. Pi's `setModel()`/`setThinkingLevel()` also persist
 * the choice as the new default in settings, so on `agent_end` we switch both back to the
 * model and thinking level that were active before routing — unless the user
 * changed them manually during the run.
 */

/**
 * Model references in criteria may be a bare id ("claude-sonnet-5") or
 * "provider/id" ("anthropic/claude-sonnet-5"). Bare ids match the first
 * available model with that id.
 */
function matchesRef(model: Model<Api>, ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash === -1) return model.id === ref;
  return model.provider === ref.slice(0, slash) && model.id === ref.slice(slash + 1);
}

function resolveModel(ctx: ExtensionContext, ref: string): Model<Api> | undefined {
  return ctx.modelRegistry.getAvailable().find((m) => matchesRef(m, ref));
}

function makeIsAvailable(ctx: ExtensionContext): (ref: string) => boolean {
  return (ref: string) => resolveModel(ctx, ref) !== undefined;
}

/** Recent user/assistant messages from the current session branch. Never throws — context is best-effort. */
function recentContextOf(ctx: ExtensionContext): ConversationTurn[] {
  try {
    return extractRecentContext(ctx.sessionManager.getBranch());
  } catch {
    return [];
  }
}

function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function describe(d: RouteDecision, thinking?: RouterThinkingLevel | undefined): string {
  const base = d.source === "jev"
    ? `${d.category} → ${d.model} (confidence ${d.confidence.toFixed(2)})`
    : `${d.category} → ${d.model} (fallback: ${d.error ?? "unknown"})`;
  return thinking !== undefined ? `${base} [thinking: ${thinking}]` : base;
}

/** Provider id under which the TypeSafe key is stored in pi's auth.json (~/.pi/agent/auth.json). */
export const TYPESAFE_PROVIDER_ID = "typesafe";

export type KeySource = "stored" | "env";

export interface ResolvedKey {
  apiKey: string;
  source: KeySource;
}

/**
 * Resolve the TypeSafe API key. Precedence: key stored via pi's /login
 * (auth storage) → TYPESAFE_API_KEY env var → none.
 */
export async function resolveTypesafeKey(ctx: ExtensionContext): Promise<ResolvedKey | undefined> {
  const stored = await ctx.modelRegistry.getApiKeyForProvider(TYPESAFE_PROVIDER_ID);
  if (stored) return { apiKey: stored, source: "stored" };
  const env = process.env.TYPESAFE_API_KEY;
  if (env) return { apiKey: env, source: "env" };
  return undefined;
}

export default function piModelRouter(pi: ExtensionAPI) {
  let criteria: RouterCriteria | null = null;
  let sourcePath: string | null = null;

  let jev: JevClient | null = null;
  let keySource: KeySource | undefined;
  let activeKey: string | undefined;

  /**
   * Re-resolve the TypeSafe key and (re)build the Jev client only when the
   * key actually changed. Cheap (in-memory lookups), so it is called at the
   * start of every run — this is what makes pi's /login, /logout and env
   * changes take effect without a reload.
   */
  async function syncJev(ctx: ExtensionContext): Promise<void> {
    const resolved = await resolveTypesafeKey(ctx);
    keySource = resolved?.source;
    const nextKey = resolved?.apiKey;
    if (nextKey === activeKey) return;
    activeKey = nextKey;
    jev = nextKey ? new JevClient({ apiKey: nextKey, apiBase: process.env.TYPESAFE_API_BASE }) : null;
  }

  function describeKeySource(): string {
    if (!jev) return 'disabled (no key — run /login and pick "TypeSafe (pi-model-router)", or set TYPESAFE_API_KEY)';
    return keySource === "stored"
      ? "configured (key from pi auth storage via /login)"
      : "configured (key from TYPESAFE_API_KEY env var)";
  }

  // Credential-only provider (no models/baseUrl). Registering it is what makes
  // the "typesafe" slot in ~/.pi/agent/auth.json reachable: pi's /login lists it
  // under this name with a generic "Enter API key" prompt, /logout can remove it,
  // and modelRegistry.getApiKeyForProvider("typesafe") resolves the stored key.
  pi.registerProvider(TYPESAFE_PROVIDER_ID, { name: "TypeSafe (pi-model-router)" });

  /** Model that was active before this run's routing switched it; restored on agent_end. */
  let restoreModel: Model<Api> | undefined;
  /** Model this run was routed to (used to detect manual /model changes mid-run). */
  let routedModel: Model<Api> | undefined;
  /** Thinking level that was active before this run's routing changed it; restored on agent_end. */
  let restoreThinking: RouterThinkingLevel | undefined;
  /** Thinking level this run was actually routed to (read back post-clamp; used to detect manual changes mid-run). */
  let routedThinking: RouterThinkingLevel | undefined;

  function loadInto(ctx: ExtensionContext): boolean {
    try {
      ({ criteria, sourcePath } = loadCriteria(ctx.cwd));
      return true;
    } catch (err) {
      criteria = null;
      ctx.ui.notify(`pi-model-router: ${(err as Error).message}`, "error");
      return false;
    }
  }

  /** Warn if no configured model ref resolves to anything in pi's registry. */
  function warnIfNothingResolves(ctx: ExtensionContext): void {
    if (!criteria || hasAnyAvailableModel(criteria, makeIsAvailable(ctx))) return;
    ctx.ui.notify(
      `pi-model-router: none of the models in your criteria config (${sourcePath ?? "shipped defaults"}) are available in pi's model registry — routing is disabled until this is fixed. ` +
        `Run "pi --list-models" for valid ids and add them as "provider/id" to .pi/pi-model-router.json (project) or ~/.pi/agent/pi-model-router.json (global). ` +
        `Run /router to see which entries resolve (✓/✗).`,
      "warning",
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!loadInto(ctx)) return;
    await syncJev(ctx);
    if (!jev && criteria) {
      ctx.ui.notify(
        `pi-model-router: no TypeSafe API key — run /login and pick "TypeSafe (pi-model-router)" (or set TYPESAFE_API_KEY) to enable routing; ` +
          `every run falls back to "${criteria.fallback.category}".`,
        "warning",
      );
    }
    warnIfNothingResolves(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!criteria) return;
    await syncJev(ctx);
    const isAvailable = makeIsAvailable(ctx);

    if (!hasAnyAvailableModel(criteria, isAvailable)) {
      ctx.ui.setStatus("router", "router: disabled — no configured model is available (see /router)");
      return;
    }

    let decision: RouteDecision;
    try {
      decision = await pickModel(event.prompt, { jev, criteria, isAvailable, recentContext: recentContextOf(ctx) });
    } catch (err) {
      ctx.ui.notify(`pi-model-router: ${(err as Error).message} — using current model.`, "warning");
      return;
    }

    const target = resolveModel(ctx, decision.model);
    if (!target) {
      ctx.ui.notify(`pi-model-router: routed model "${decision.model}" not found in registry — using current model.`, "warning");
      return;
    }

    if (!sameModel(ctx.model, target)) {
      restoreModel = ctx.model;
      const ok = await pi.setModel(target);
      if (!ok) {
        restoreModel = undefined;
        ctx.ui.notify(`pi-model-router: no API key for ${target.provider}/${target.id} — using current model.`, "warning");
        return;
      }
      routedModel = target;
    }

    const wantedThinking = criteria.categories[decision.category]?.thinkingLevel;
    if (wantedThinking !== undefined) {
      const currentThinking = pi.getThinkingLevel();
      if (currentThinking !== wantedThinking) {
        restoreThinking = currentThinking;
        pi.setThinkingLevel(wantedThinking);
        routedThinking = pi.getThinkingLevel(); // read back the clamped value, may differ from wantedThinking
      }
    }
    ctx.ui.setStatus(
      "router",
      `router: ${describe(decision, wantedThinking !== undefined ? pi.getThinkingLevel() : undefined)}`,
    );
  });

  pi.on("agent_end", async (_event, ctx) => {
    const toRestore = restoreModel;
    const routed = routedModel;
    restoreModel = undefined;
    routedModel = undefined;
    const thinkToRestore = restoreThinking;
    const thinkRouted = routedThinking;
    restoreThinking = undefined;
    routedThinking = undefined;
    // Only switch back if the user didn't manually change models during the run.
    if (toRestore && routed && sameModel(ctx.model, routed) && !sameModel(ctx.model, toRestore)) {
      await pi.setModel(toRestore);
    }
    // Restore thinking last: setModel() re-clamps the thinking level as a side effect.
    // Only switch back if the user didn't manually change the level during the run.
    if (
      thinkToRestore !== undefined &&
      thinkRouted !== undefined &&
      pi.getThinkingLevel() === thinkRouted &&
      thinkToRestore !== thinkRouted
    ) {
      pi.setThinkingLevel(thinkToRestore);
    }
  });

  pi.registerCommand("router", {
    description: "Inspect or test pi-model-router's routing config",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const isAvailable = makeIsAvailable(ctx);

      if (sub === "test") {
        const prompt = rest.join(" ");
        if (!prompt) {
          ctx.ui.notify("Usage: /router test <prompt text>", "warning");
          return;
        }
        if (!criteria) {
          ctx.ui.notify("pi-model-router: no criteria loaded", "error");
          return;
        }
        await syncJev(ctx);
        try {
          const decision = await pickModel(prompt, { jev, criteria, isAvailable, recentContext: recentContextOf(ctx) });
          ctx.ui.notify(
            `category=${decision.category} model=${decision.model} confidence=${decision.confidence.toFixed(2)} ` +
              `source=${decision.source}${decision.error ? ` (${decision.error})` : ""}` +
              ` thinking=${criteria.categories[decision.category]?.thinkingLevel ?? "unchanged"}`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`pi-model-router: ${(err as Error).message}`, "error");
        }
        return;
      }

      if (sub === "reload") {
        if (loadInto(ctx)) {
          ctx.ui.notify(`pi-model-router: reloaded criteria from ${sourcePath ?? "defaults"}`, "info");
          warnIfNothingResolves(ctx);
        }
        return;
      }

      // default: status
      if (!criteria) {
        ctx.ui.notify("pi-model-router: no criteria loaded", "error");
        return;
      }
      await syncJev(ctx);
      const categories = Object.entries(criteria.categories)
        .map(([name, c]) => {
          const marks = c.models.map((m) => (isAvailable(m) ? `${m} ✓` : `${m} ✗`));
          return `  ${name}${c.thinkingLevel ? ` (thinking: ${c.thinkingLevel})` : ""}: ${marks.join(", ")}`;
        })
        .join("\n");
      ctx.ui.notify(
        `pi-model-router status\n` +
          `  config: ${sourcePath ?? "defaults only"}\n` +
          `  jev: ${describeKeySource()}\n` +
          `  fallback category: ${criteria.fallback.category}\n` +
          `  categories (✓ = logged in):\n${categories}\n` +
          `Use "/router test <prompt>" to see how a prompt would route, "/router reload" to re-read config. ` +
          `Use "/login" and pick "TypeSafe (pi-model-router)" to store your TypeSafe key.`,
        "info",
      );
    },
  });
}
