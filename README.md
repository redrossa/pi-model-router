# pi-model-router

A [Pi](https://pi.dev) extension that classifies every prompt you send with
[TypeSafe's Jev](https://docs.typesafe.ai) and routes the turn to whichever
model you're logged into that best fits the task — planning/brainstorming to
one model, coding implementation to another, research/exploration to a
third — without you having to `/model` switch by hand.

## How it works

1. On `before_agent_start`, the extension sends your prompt to Jev as a
   `Choice` question, with your criteria config's categories as the answer
   options (each category = a name + a free-form description of what belongs
   in it).
2. Jev returns a category pick with a confidence score. The extension maps
   that category to a priority-ordered list of model ids and picks the first
   one you're actually logged into.
3. On every `before_provider_request` for that agent run, the extension
   rewrites the outgoing model field to the picked model. It does **not**
   call `pi.setModel()`, so your default model in `settings.json` is never
   touched — routing is purely per-turn.
4. If Jev is unreachable, times out, returns low confidence (below
   `confidenceThreshold`), or picks a category with no available model, the
   extension falls back to the configured `fallback.category`, then to any
   category with an available model.

## Setup

```bash
export TYPESAFE_API_KEY=sk-...   # required — get one at https://typesafe.ai
```

Drop this repo (or its published package) into your Pi extensions path and
it auto-loads. No further config is required — a sensible default criteria
map ships in `config/default-criteria.json`:

| category | goes to |
|---|---|
| planning (reasoning, brainstorming, architecture) | `fable-5.1`, `astra` |
| coding (implementation, debugging, refactors) | `deepseek-v4.1-flash`, `sol`, `opus` |
| research (exploration, reading code/docs) | `sonnet`, `terra` |

## Configuring your own criteria

Criteria is just JSON — write your own at `.pi/pi-model-router.json` in your
project, or `~/.pi/agent/pi-model-router.json` globally. See
`examples/pi-model-router.json` and the schema at
`src/criteria.schema.json`. You only need to specify what you want to
override or add; it's deep-merged with the shipped defaults by category
name.

```jsonc
{
  "categories": {
    "coding": { "description": "...", "models": ["your-model-id"] },
    "writing": { "description": "commit messages, docs, PR descriptions", "models": ["astra"] }
  },
  "confidenceThreshold": 0.4
}
```

`description` can be a string, object, or array — anything Jev's `Choice`
primitive accepts — so you can give richer per-category guidance (what it
covers, what it doesn't, examples) if a plain sentence isn't discriminating
enough.

## Commands

- `/router` — show current config source, Jev status, and category → model map.
- `/router test <prompt>` — dry-run classification for a prompt without sending it to the agent.
- `/router reload` — re-read the criteria config from disk.

## Project layout

```
src/extension.ts   Pi extension entry point (hooks, commands)
src/router.ts       classification → model selection + fallback logic
src/jev.ts          TypeSafe Jev API client (Choice primitive)
src/config.ts       default + user criteria JSON loading/merging
config/default-criteria.json   shipped default criteria
examples/           example user override file
```
