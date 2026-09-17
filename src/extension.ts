import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadCriteria } from "./config.js";
import { JevClient } from "./jev.js";
import { pickModel } from "./router.js";
import type { RouteDecision, RouterCriteria } from "./types.js";

/**
 * pi-model-router
 *
 * Classifies each prompt with TypeSafe's Jev (using a user-configurable
 * criteria map) and routes the agent run to whichever logged-in model best
 * fits the classified category.
 *
 * Strategy: classify once per agent run in `before_agent_start` (one Jev
 * call, stable for the whole run including the tool-call loop) and switch
 * the active model with `pi.setModel()` before the agent loop starts. Pi's
 * `setModel()` also persists the choice as the default model in settings,
 * so on `agent_end` we switch back to the model that was active before
 * routing — unless the user changed models manually during the run.
 */

/**
 * Model references in criteria may be a bare id ("astra") or "provider/id"
 * ("anthropic/claude-sonnet-4-5"). Bare ids match the first available model
 * with that id.
 */
function matchesRef(model: Model<Api>, ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash === -1) return model.id === ref;
  return model.provider === ref.slice(0, slash) && model.id === ref.slice(slash + 1);
}

function resolveModel(ctx: ExtensionContext, ref: string): Model<Api> | undefined {
  return ctx.modelRegistry.getAvailable().find((m) => matchesRef(m, ref));
}

function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function describe(d: RouteDecision): string {
  return d.source === "jev"
    ? `${d.category} → ${d.model} (confidence ${d.confidence.toFixed(2)})`
    : `${d.category} → ${d.model} (fallback: ${d.error ?? "unknown"})`;
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
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!criteria) return;
    await syncJev(ctx);
    const isAvailable = (ref: string) => resolveModel(ctx, ref) !== undefined;

    let decision: RouteDecision;
    try {
      decision = await pickModel(event.prompt, { jev, criteria, isAvailable });
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
    ctx.ui.setStatus("router", `router: ${describe(decision)}`);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const toRestore = restoreModel;
    const routed = routedModel;
    restoreModel = undefined;
    routedModel = undefined;
    // Only switch back if the user didn't manually change models during the run.
    if (toRestore && routed && sameModel(ctx.model, routed) && !sameModel(ctx.model, toRestore)) {
      await pi.setModel(toRestore);
    }
  });

  pi.registerCommand("router", {
    description: "Inspect or test pi-model-router's routing config",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const isAvailable = (ref: string) => resolveModel(ctx, ref) !== undefined;

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
          const decision = await pickModel(prompt, { jev, criteria, isAvailable });
          ctx.ui.notify(
            `category=${decision.category} model=${decision.model} confidence=${decision.confidence.toFixed(2)} ` +
              `source=${decision.source}${decision.error ? ` (${decision.error})` : ""}`,
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
          return `  ${name}: ${marks.join(", ")}`;
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
