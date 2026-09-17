import { loadCriteria } from "./config.js";
import { JevClient } from "./jev.js";
import { pickModel } from "./router.js";
import type { RouteDecision, RouterCriteria } from "./types.js";
import type { PiExtensionAPI } from "./pi-api.d.ts";

/**
 * pi-model-router
 *
 * Classifies each prompt with TypeSafe's Jev (using a user-configurable
 * criteria map) and routes the turn to whichever logged-in model best fits
 * the classified category — without persisting the choice as your default
 * model in settings.json.
 *
 * Strategy: classify once per agent run in `before_agent_start` (cheap,
 * one Jev call, stable for the whole run including any tool-call loop),
 * then rewrite the outgoing wire payload's `model` field on every
 * `before_provider_request` for that run. This avoids both known pitfalls
 * of `pi.setModel()`: it doesn't persist a new default, and it actually
 * reaches in-flight/looped requests since the payload is rewritten per
 * request rather than set once on the agent loop config.
 */
export default function piModelRouter(pi: PiExtensionAPI) {
  let criteria: RouterCriteria;
  let sourcePath: string | null;
  try {
    ({ criteria, sourcePath } = loadCriteria(pi.projectDir));
  } catch (err) {
    console.error(`[pi-model-router] ${(err as Error).message}`);
    return;
  }

  const apiKey = pi.config?.get("TYPESAFE_API_KEY") ?? process.env.TYPESAFE_API_KEY;
  const apiBase = pi.config?.get("TYPESAFE_API_BASE") ?? process.env.TYPESAFE_API_BASE;
  const jev = apiKey ? new JevClient({ apiKey, apiBase }) : null;

  if (!jev) {
    console.warn(
      "[pi-model-router] TYPESAFE_API_KEY not set — routing disabled, every turn falls back to " +
        `"${criteria.fallback.category}".`,
    );
  }

  const isAvailable = (modelId: string): boolean => {
    if (pi.isModelAvailable) return pi.isModelAvailable(modelId);
    if (pi.listModels) return pi.listModels().some((m) => m.id === modelId && m.loggedIn !== false);
    return true; // best-effort: assume available if Pi doesn't expose a check
  };

  /** Decision for the agent run currently in flight; applied to every provider request in that run. */
  let currentDecision: RouteDecision | null = null;

  pi.on("before_agent_start", async (event, ctx) => {
    currentDecision = await pickModel(event.prompt, { jev, criteria, isAvailable });
    const d = currentDecision;
    const label =
      d.source === "jev"
        ? `${d.category} → ${d.model} (confidence ${d.confidence.toFixed(2)})`
        : `${d.category} → ${d.model} (fallback: ${d.error})`;
    ctx.ui.setStatus?.(`router: ${label}`);
    return undefined;
  });

  pi.on("before_provider_request", (event) => {
    if (!currentDecision) return undefined;
    return { ...event.payload, model: currentDecision.model };
  });

  pi.registerCommand("router", {
    description: "Inspect or test pi-model-router's routing config",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.args;
      if (sub === "test") {
        const prompt = rest.join(" ");
        if (!prompt) {
          ctx.ui.notify("Usage: /router test <prompt text>", "warn");
          return;
        }
        const decision = await pickModel(prompt, { jev, criteria, isAvailable });
        ctx.ui.notify(
          `category=${decision.category} model=${decision.model} confidence=${decision.confidence.toFixed(2)} ` +
            `source=${decision.source}${decision.error ? ` (${decision.error})` : ""}`,
          "info",
        );
        return;
      }
      if (sub === "reload") {
        try {
          ({ criteria, sourcePath } = loadCriteria(pi.projectDir));
          ctx.ui.notify(`pi-model-router: reloaded criteria from ${sourcePath ?? "defaults"}`, "info");
        } catch (err) {
          ctx.ui.notify(`pi-model-router: reload failed — ${(err as Error).message}`, "error");
        }
        return;
      }
      // default: status
      const categories = Object.entries(criteria.categories)
        .map(([name, c]) => `  ${name}: ${c.models.join(", ")}`)
        .join("\n");
      ctx.ui.notify(
        `pi-model-router status\n` +
          `  config: ${sourcePath ?? "defaults only"}\n` +
          `  jev: ${jev ? "configured" : "disabled (no TYPESAFE_API_KEY)"}\n` +
          `  fallback category: ${criteria.fallback.category}\n` +
          `  categories:\n${categories}\n` +
          `Use "/router test <prompt>" to see how a prompt would route, "/router reload" to re-read config.`,
        "info",
      );
    },
  });
}
