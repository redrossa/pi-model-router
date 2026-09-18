import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { ConversationTurn } from "./types.js";

/** Max prior user/assistant messages sent to Jev (≈ two turns: the previous ask + the assistant's reply/question). */
export const MAX_CONTEXT_MESSAGES = 4;
/** Per-message character cap. Assistant text keeps its tail (the question is at the end); user text keeps its head. */
export const MAX_MESSAGE_CHARS = 1500;

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function clamp(text: string, role: ConversationTurn["role"]): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return role === "assistant" ? `…${text.slice(-MAX_MESSAGE_CHARS)}` : `${text.slice(0, MAX_MESSAGE_CHARS)}…`;
}

/**
 * Extracts the most recent user/assistant text messages from a session branch
 * (as returned by `ctx.sessionManager.getBranch()`), oldest first. Tool
 * results, tool-call-only assistant messages, thinking blocks, custom/bash
 * entries, compaction entries etc. are skipped. Never throws on odd input.
 */
export function extractRecentContext(entries: readonly SessionEntry[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < MAX_CONTEXT_MESSAGES; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message as { role?: unknown; content?: unknown };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = textOf(msg.content);
    if (!text) continue;
    out.push({ role: msg.role, text: clamp(text, msg.role) });
  }
  return out.reverse();
}
