import type { JevClient } from "./jev.js";
import type { RouteDecision, RouterCriteria } from "./types.js";

/**
 * Picks the first model in a category's priority list that the caller says
 * is available (i.e. the user is logged into that provider / it's present
 * in Pi's model registry).
 */
function firstAvailable(models: string[], isAvailable: (modelId: string) => boolean): string | null {
  for (const m of models) {
    if (isAvailable(m)) return m;
  }
  return null;
}

/** True if at least one model ref in any category resolves via `isAvailable`. */
export function hasAnyAvailableModel(criteria: RouterCriteria, isAvailable: (modelId: string) => boolean): boolean {
  return Object.values(criteria.categories).some((cat) => firstAvailable(cat.models, isAvailable) !== null);
}

export interface PickModelDeps {
  jev: JevClient | null;
  criteria: RouterCriteria;
  isAvailable: (modelId: string) => boolean;
}

/**
 * Core routing decision: classify `prompt` with Jev, then resolve the
 * winning category to a concrete, available model. Falls back to
 * `criteria.fallback.category` whenever Jev is unreachable, returns a
 * low-confidence answer, or its pick has no available model — and falls
 * back further to *any* available modeled category if even the configured
 * fallback category has nothing available.
 */
export async function pickModel(prompt: string, deps: PickModelDeps): Promise<RouteDecision> {
  const { jev, criteria, isAvailable } = deps;
  const threshold = criteria.confidenceThreshold ?? 0.34;

  const fallbackDecision = (reason: string, probabilities?: Record<string, number>): RouteDecision => {
    const fallbackCategory = criteria.categories[criteria.fallback.category];
    const model = fallbackCategory ? firstAvailable(fallbackCategory.models, isAvailable) : null;
    if (model) {
      return {
        category: criteria.fallback.category,
        model,
        confidence: 0,
        source: "fallback",
        probabilities,
        error: reason,
      };
    }
    // Fallback category itself has nothing available — scan every category.
    for (const [name, cat] of Object.entries(criteria.categories)) {
      const m = firstAvailable(cat.models, isAvailable);
      if (m) {
        return { category: name, model: m, confidence: 0, source: "fallback", probabilities, error: reason };
      }
    }
    throw new Error(
      `pi-model-router: no configured model is available (checked all categories). Original error: ${reason}`,
    );
  };

  if (!jev) {
    return fallbackDecision("no TypeSafe API key configured (run /login or set TYPESAFE_API_KEY); routing disabled");
  }

  let choice: string;
  let confidence: number;
  let probabilities: Record<string, number> | undefined;
  try {
    const answer = await jev.classify(prompt, criteria);
    choice = answer.choice;
    confidence = answer.confidence;
    probabilities = answer.probabilities;
  } catch (err) {
    return fallbackDecision((err as Error).message);
  }

  if (confidence < threshold) {
    return fallbackDecision(`low confidence (${confidence.toFixed(2)} < ${threshold})`, probabilities);
  }

  const category = criteria.categories[choice];
  if (!category) {
    return fallbackDecision(`Jev returned unknown category "${choice}"`, probabilities);
  }

  const model = firstAvailable(category.models, isAvailable);
  if (!model) {
    return fallbackDecision(`no available model for category "${choice}" (tried: ${category.models.join(", ")})`, probabilities);
  }

  return { category: choice, model, confidence, source: "jev", probabilities };
}
