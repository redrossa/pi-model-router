import type { JevChoiceAnswer, RouterCriteria } from "./types.js";

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
   * from `criteria` as the answer options. Returns the raw Choice answer.
   * Throws on network/API failure or timeout — callers are expected to
   * fall back to `criteria.fallback` on error.
   */
  async classify(prompt: string, criteria: RouterCriteria): Promise<JevChoiceAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const criteriaMap: Record<string, unknown> = {};
    for (const [name, cat] of Object.entries(criteria.categories)) {
      criteriaMap[name] = cat.description;
    }

    try {
      const res = await fetch(`${this.apiBase}/answer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "jev-latest",
          state: { prompt },
          questions: {
            [criteria.question]: {
              type: "choice",
              instructions: criteria.instructions,
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
