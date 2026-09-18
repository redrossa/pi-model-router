import type { ConversationTurn, JevChoiceAnswer, RouterCriteria } from "./types.js";

/** Appended to `criteria.instructions` only when recent context is supplied. */
export const CONTEXT_HINT =
  " The prompt may be a short reply (e.g. \"yes\", \"go ahead\", \"option 2\") to a question the assistant asked in `recentContext`. Use that context to determine what work the user is actually agreeing to or asking for, and classify by that underlying work — but classify the new prompt, not the earlier messages.";

export interface JevClientOptions {
  apiKey: string;
  apiBase?: string | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_API_BASE = "https://api.typesafe.ai/v1";

export class JevClient {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(opts: JevClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.timeoutMs = opts.timeoutMs ?? 2500;
  }

  /**
   * Classifies `prompt` using Jev's Choice primitive, with the category map
   * from `criteria` as the answer options. When `recentContext` is supplied
   * (the last few user/assistant messages), it is sent alongside the prompt
   * so short replies ("yes", "option 2") are classified by what they reply
   * to. Returns the raw Choice answer. Throws on network/API failure or
   * timeout — callers are expected to fall back to `criteria.fallback` on
   * error.
   */
  async classify(
    prompt: string,
    criteria: RouterCriteria,
    recentContext?: ConversationTurn[] | undefined,
  ): Promise<JevChoiceAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const criteriaMap: Record<string, unknown> = {};
    for (const [name, cat] of Object.entries(criteria.categories)) {
      criteriaMap[name] = cat.description;
    }

    const hasContext = !!recentContext && recentContext.length > 0;
    const state: { prompt: string; recentContext?: ConversationTurn[] } = { prompt };
    if (hasContext) state.recentContext = recentContext;
    const instructions = hasContext ? criteria.instructions + CONTEXT_HINT : criteria.instructions;

    try {
      // POST /v1/systemone per https://api.typesafe.ai/openapi.json
      const res = await fetch(`${this.apiBase}/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "jev-latest",
          state,
          questions: {
            [criteria.question]: {
              type: "choice",
              instructions,
              criteria: criteriaMap,
            },
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Jev request failed: ${res.status} ${res.statusText} ${body}`.trim());
      }

      const data = (await res.json()) as {
        answers?: Record<string, JevChoiceAnswer>;
      };
      const answer = data.answers?.[criteria.question];
      if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
        throw new Error(`Jev response missing "${criteria.question}" choice answer`);
      }
      return answer;
    } finally {
      clearTimeout(timer);
    }
  }
}
