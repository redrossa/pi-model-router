/**
 * Shape of the criteria configuration fed to Jev.
 *
 * This is intentionally "whatever JSON structure" the user wants beyond the
 * required fields below — extra keys inside a category are passed through to
 * Jev untouched (e.g. richer per-option guidance as an object/array, per the
 * TypeSafe Choice primitive spec).
 */
export interface CriteriaCategory {
  /** Freeform description of what belongs in this category. String, object, or array. */
  description: unknown;
  /** Model ids (as configured in Pi / models.json), in priority order. First logged-in match wins. */
  models: string[];
}

export interface RouterFallback {
  /** Category to use when Jev can't be reached, is low-confidence, or its pick has no available model. */
  category: string;
  note?: string;
}

export interface RouterCriteria {
  /** Question id Jev's answer will come back under. */
  question: string;
  /** Top-level instructions given to Jev alongside the criteria map. */
  instructions: string;
  /** category name -> category definition. This is the "Choice" criteria map. */
  categories: Record<string, CriteriaCategory>;
  fallback: RouterFallback;
  /** Below this confidence, fall back instead of trusting Jev's pick. 0-1. Default 0.34. */
  confidenceThreshold?: number | undefined;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface RouteDecision {
  category: string;
  model: string;
  confidence: number;
  source: "jev" | "fallback" | "single-candidate";
  probabilities?: Record<string, number> | undefined;
  error?: string | undefined;
}
