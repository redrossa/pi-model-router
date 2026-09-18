import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { extractRecentContext, MAX_CONTEXT_MESSAGES, MAX_MESSAGE_CHARS } from "../src/context.js";

/**
 * Minimal fake `SessionMessageEntry`. The real type carries an `AgentMessage`
 * whose content union is far richer than these tests need; only the fields
 * `extractRecentContext` reads (type/role/content) matter here.
 */
function msgEntry(role: string, content: unknown): SessionEntry {
  return { type: "message", id: "x", parentId: null, timestamp: "", message: { role, content } } as unknown as SessionEntry;
}

/** Minimal fake non-message entry (compaction/custom/etc.). */
function rawEntry(type: string): SessionEntry {
  return { type, id: "x", parentId: null, timestamp: "" } as unknown as SessionEntry;
}

test("empty branch returns no turns", () => {
  assert.deepEqual(extractRecentContext([]), []);
});

test("extracts user/assistant text in chronological order, skipping tool/thinking content", () => {
  const branch: SessionEntry[] = [
    msgEntry("user", "refactor the auth module"),
    msgEntry("assistant", [
      { type: "text", text: "ok" },
      { type: "tool_call", id: "call-1", name: "read", input: {} },
    ]),
    msgEntry("toolResult", [{ type: "text", text: "file contents" }]),
    msgEntry("assistant", [{ type: "tool_call", id: "call-2", name: "edit", input: {} }]),
    msgEntry("assistant", [
      { type: "thinking", text: "hmm" },
      { type: "text", text: "Should I refactor or patch?" },
    ]),
  ];

  assert.deepEqual(extractRecentContext(branch), [
    { role: "user", text: "refactor the auth module" },
    { role: "assistant", text: "ok" },
    { role: "assistant", text: "Should I refactor or patch?" },
  ]);
});

test("skips non-message entries and non-user/assistant roles", () => {
  const branch: SessionEntry[] = [
    rawEntry("compaction"),
    msgEntry("system", "system prompt that must be ignored"),
    rawEntry("custom"),
    msgEntry("user", "do the thing"),
    msgEntry("bashExecution", "ls -la"),
  ];

  assert.deepEqual(extractRecentContext(branch), [{ role: "user", text: "do the thing" }]);
});

test("caps output at the most recent MAX_CONTEXT_MESSAGES in chronological order", () => {
  const branch: SessionEntry[] = [
    msgEntry("user", "msg1"),
    msgEntry("assistant", "msg2"),
    msgEntry("user", "msg3"),
    msgEntry("assistant", "msg4"),
    msgEntry("user", "msg5"),
    msgEntry("assistant", "msg6"),
    msgEntry("user", "msg7"),
    msgEntry("assistant", "msg8"),
    msgEntry("user", "msg9"),
    msgEntry("assistant", "msg10"),
  ];

  const out = extractRecentContext(branch);
  assert.equal(MAX_CONTEXT_MESSAGES, 8);
  assert.deepEqual(out, [
    { role: "user", text: "msg3" },
    { role: "assistant", text: "msg4" },
    { role: "user", text: "msg5" },
    { role: "assistant", text: "msg6" },
    { role: "user", text: "msg7" },
    { role: "assistant", text: "msg8" },
    { role: "user", text: "msg9" },
    { role: "assistant", text: "msg10" },
  ]);
});

test("assistant text keeps its tail and user text keeps its head when over the cap", () => {
  const assistantText = "A".repeat(1000) + "B".repeat(1000); // 2000 chars
  const userText = "C".repeat(1000) + "D".repeat(1000); // 2000 chars

  const out = extractRecentContext([msgEntry("user", userText), msgEntry("assistant", assistantText)]);

  assert.deepEqual(out, [
    // Head: first 1500 chars (1000 C + 500 D), suffixed with the ellipsis.
    { role: "user", text: "C".repeat(1000) + "D".repeat(500) + "…" },
    // Tail: last 1500 chars (500 A + 1000 B), prefixed with the ellipsis.
    { role: "assistant", text: "…" + "A".repeat(500) + "B".repeat(1000) },
  ]);
  assert.equal(out[0]?.text.length, MAX_MESSAGE_CHARS + 1);
  assert.equal(out[1]?.text.length, MAX_MESSAGE_CHARS + 1);
});

test("text exactly at the character cap is not truncated", () => {
  const exact = "E".repeat(MAX_MESSAGE_CHARS);
  const out = extractRecentContext([msgEntry("user", exact), msgEntry("assistant", exact)]);
  assert.deepEqual(out, [
    { role: "user", text: exact },
    { role: "assistant", text: exact },
  ]);
});

test("accepts plain-string content and skips whitespace-only messages without counting them toward the cap", () => {
  const branch: SessionEntry[] = [
    msgEntry("user", "one"),
    msgEntry("assistant", "two"),
    msgEntry("user", "three"),
    msgEntry("user", "   \n  "),
    msgEntry("assistant", "four"),
    msgEntry("user", "five"),
    msgEntry("assistant", "six"),
    msgEntry("assistant", ""),
    msgEntry("user", "seven"),
    msgEntry("assistant", "eight"),
    msgEntry("user", "nine"),
    msgEntry("assistant", "ten"),
  ];

  const out = extractRecentContext(branch);
  // Ten valid messages, but only the last MAX_CONTEXT_MESSAGES=8 are kept;
  // the whitespace-only entries are skipped and don't count toward the cap.
  assert.deepEqual(out, [
    { role: "user", text: "three" },
    { role: "assistant", text: "four" },
    { role: "user", text: "five" },
    { role: "assistant", text: "six" },
    { role: "user", text: "seven" },
    { role: "assistant", text: "eight" },
    { role: "user", text: "nine" },
    { role: "assistant", text: "ten" },
  ]);
});
