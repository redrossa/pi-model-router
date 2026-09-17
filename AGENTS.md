# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

A [Pi](https://pi.dev) extension. On every agent run it classifies the user's
prompt with [TypeSafe's Jev](https://docs.typesafe.ai), maps the resulting
category to a priority-ordered list of model ids, and switches the active
model with `pi.setModel()` before the agent loop starts — plus the category's
optional thinking/effort level via `pi.setThinkingLevel()`. It restores both
previous values on `agent_end`.

## Commands

```bash
npm test        # tsx --test test/**/*.test.ts  (node:test + node:assert/strict)
npm run typecheck   # tsc --noEmit  (also the lint script)
```

Run **both** before reporting work done. There is no build step, formatter, or
linter beyond `tsc`. Node >= 20.

## Layout

| Path | Responsibility |
|---|---|
| `src/extension.ts` | Pi wiring: hooks (`session_start`, `before_agent_start`, `agent_end`), provider registration, `/router` command, model + thinking-level switch/restore. Side effects live here. |
| `src/router.ts` | `pickModel()` — the routing decision. Pure: all I/O is injected via deps. Model-only; knows nothing about thinking levels. |
| `src/jev.ts` | `JevClient` — HTTP call to Jev's `Choice` primitive. |
| `src/config.ts` | Loads shipped defaults + user override, deep-merges, validates `thinkingLevel`. |
| `src/types.ts` | `RouterCriteria`, `RouterThinkingLevel`/`THINKING_LEVELS`, `RouteDecision`, etc. |
| `config/default-criteria.json` | Shipped categories, thinking levels, and model lists. |
| `src/criteria.schema.json` | JSON Schema for user override files. |
| `test/` | `router.test.ts` (pure logic), `config.test.ts` (merge/lookup), `extension.test.ts` (fake ExtensionAPI harness). |

## The fallback cascade — do not change its order

`pickModel()` resolves a model through these steps, **in order**. This is the
core contract of the extension and every branch is covered by a test:

1. No Jev client (no API key) → fallback.
2. `jev.classify()` throws (network, timeout, bad response) → fallback.
3. `confidence < criteria.confidenceThreshold` (default `0.34`) → fallback.
4. Jev returns a category name not in `criteria.categories` → fallback.
5. Winning category has no *available* model → fallback.
6. Falls back to `criteria.fallback.category`; if that category also has
   nothing available, scan **every** category for any available model
   (`source: "fallback"` in both cases).
7. Nothing available anywhere → `throw`. The extension catches this at the
   call site and leaves the current model alone.

The fallback path must never throw except in case 7. A routing failure is
always non-fatal and must degrade to "use the current model".

`RouteDecision.source` is `"jev"` only when Jev's own pick was used; every
fallback reports `source: "fallback"` (the `"single-candidate"` variant is
declared in `src/types.ts` but not currently produced).

## Thinking level is applied, not routed

`pickModel()` and `RouteDecision` are **model-only** — the cascade above has no
thinking-level involvement, and `test/router.test.ts` has no thinking-level
cases. A category's optional `thinkingLevel` is applied in `src/extension.ts`
*after* the model switch, in the same `before_agent_start`:

- Omitting `thinkingLevel` leaves the user's current level untouched; it is
  never reset to a default.
- The level is applied even when the routed model equals the current model, so
  a category can change effort without changing model.
- `pi.setThinkingLevel()` **clamps** to what the routed model supports. Track
  the value read back from `pi.getThinkingLevel()`, not the value requested —
  the `agent_end` guard compares against reality, not intent.
- `agent_end` restores the pre-run level only when the user hasn't changed it
  mid-run, and restores the **model before the level** (see Gotchas).

## Conventions

- **ESM with explicit `.js` on relative imports**, even though sources are
  `.ts` (`import { pickModel } from "./router.js"`). `moduleResolution` is
  `Bundler`; without the extension the runtime import fails.
- **`strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`
  are on.** Optional properties that may be assigned `undefined` must be
  typed `T | undefined`, not just `?:`. Index access into records returns
  `T | undefined` — handle it.
- Keep I/O out of `src/router.ts`. It takes `PickModelDeps`
  (`jev`, `criteria`, `isAvailable`) so tests can exercise every branch with
  no network and no Pi runtime.
- Model references are bare ids (`"claude-sonnet-5"`) or preferably
  `"provider/id"` (`"anthropic/claude-sonnet-5"`). Bare ids match the first
  available model with that id across providers. `matchesRef()` in
  `src/extension.ts` implements this — reuse it, don't re-parse refs.
- Availability comes from `ctx.modelRegistry.getAvailable()`. Never assume a
  configured model exists.
- Secrets never touch this repo. The TypeSafe key is read from Pi's auth
  storage (`~/.pi/agent/auth.json`, provider id `"typesafe"`) or the
  `TYPESAFE_API_KEY` env var, in that precedence order.

## Testing

- `node:test` + `node:assert/strict`, run through `tsx`. Add a test for every
  behavioral change; keep tests deterministic (no real network, no real
  `~/.pi`).
- `test/extension.test.ts` has a fake `ExtensionAPI`/`ExtensionContext` that
  records `setModel` calls, notifications, and statuses, and isolates
  `$HOME` and `TYPESAFE_API_KEY`. Extend the harness rather than mocking
  ad-hoc. The extension only touches `ctx.model`, `ctx.modelRegistry`,
  `ctx.ui.notify`, `ctx.ui.setStatus`, `pi.setModel`, and
  `pi.getThinkingLevel`/`pi.setThinkingLevel`.
- `test/config.test.ts` exercises the merge/lookup order and `thinkingLevel`
  validation; `test/router.test.ts` covers the cascade; `test/extension.test.ts`
  covers thinking-level apply/no-op/no-config/restore/mid-run-override/
  model-unchanged/clamped-value cases.

## Config layering

`loadCriteria(projectDir)` deep-merges the shipped default with the **first**
user file found in this order:

1. `<project>/.pi/pi-model-router.json`
2. `<project>/.pi-model-router.json`
3. `<project>/pi-model-router.json`
4. `~/.pi/agent/pi-model-router.json`

Merge semantics: per category, `description`, `models`, and `thinkingLevel` are
merged (override wins per field); top-level `question`, `instructions`,
`fallback`, and `confidenceThreshold` are replaced. Unknown categories are
added. `loadCriteria()` validates every merged `thinkingLevel` against
`THINKING_LEVELS` inside its existing `try`, so an invalid value is reported
through the same `failed to parse <path>` wrapper as a JSON syntax error.
Keep `mergeCriteria()`, `THINKING_LEVELS`, and `src/criteria.schema.json` in
sync when adding fields.

The model ids in `config/default-criteria.json` are real entries from Pi's
built-in registry — the extension warns at session start if none of them
resolve. If you change them, keep them plausible and update the README table.

## Gotchas

- `pi.setModel()` **persists** the choice as Pi's default model, and
  `pi.setThinkingLevel()` persists the level the same way. That is why
  `agent_end` restores both pre-run values — and why each restore is skipped
  when the user changed *that* thing mid-run: model by comparing `ctx.model`
  to `routedModel`, level by comparing `pi.getThinkingLevel()` to the value
  read back when it was applied. Don't drop any of these guards.
- **Restore the model first, then the thinking level.** `setModel()`
  re-clamps thinking as a side effect, so a level restored before the model
  switch gets overwritten.
- Known limitation (pre-existing, not a regression): if routing changes the
  model and a level the intermediate model can't represent gets clamped
  (`xhigh` → `high`), restoring the original model cannot bring `xhigh` back —
  pi's `setModel()` clamping has no inverse. Fixing it would mean snapshotting
  `getThinkingLevel()` before the model switch.
- The TypeSafe provider is registered as credential-only (no models/baseUrl).
  It exists so the `"typesafe"` slot in Pi's auth storage is reachable via
  `/login` and `/logout`. Don't "fix" it by adding models.
- Jev endpoint is `POST {apiBase}/systemone` with `model: "jev-latest"` and a
  `2500ms` `AbortController` timeout. The path was a past bug
  (`/v1/answer` → 404); verify against
  `https://api.typesafe.ai/openapi.json` before changing it.
- Key/client state is re-resolved at the start of every run (`syncJev`) so
  `/login`, `/logout`, and env changes take effect without a reload. It
  rebuilds the client only when the key actually changed.
