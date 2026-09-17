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
3. Still inside `before_agent_start`, the extension switches the active
   model with `pi.setModel()` so the whole agent run (including any
   tool-call loop) uses the picked model. Pi persists `setModel()` as your
   default, so when the run ends (`agent_end`) the extension switches back
   to the model you had before — unless you changed models manually
   mid-run. Model references in criteria may be a bare id (`"astra"`) or
   `"provider/id"` (`"anthropic/claude-sonnet-4-5"`).
4. If Jev is unreachable, times out, returns low confidence (below
   `confidenceThreshold`), or picks a category with no available model, the
   extension falls back to the configured `fallback.category`, then to any
   category with an available model.

## Setup

Start Pi, then run `/router:login` and paste your TypeSafe API key (get
one at [https://typesafe.ai](https://typesafe.ai)) when prompted. The key is
stored in Pi's own credential file (`~/.pi/agent/auth.json`), alongside your
other provider logins — remove it later with `/logout`. No further setup is
needed.

For CI or non-interactive use, you can instead set the key as an environment
variable:

```bash
export TYPESAFE_API_KEY=sk-...   # get one at https://typesafe.ai
```

A key stored via `/router:login` takes precedence over `TYPESAFE_API_KEY`.

Drop this repo (or its published package) into your Pi extensions path and
it auto-loads. Pi discovers extensions placed under
`~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local);
for a quick test without installing, load it directly with
`pi -e ./src/extension.ts`. No further config is required — a sensible
default criteria map ships in `config/default-criteria.json`:

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

- `/router` — show current config source, where the key is coming from, Jev status, and category → model map.
- `/router test <prompt>` — dry-run classification for a prompt without sending it to the agent.
- `/router reload` — re-read the criteria config from disk.
- `/router:login` — store your TypeSafe API key in pi's credential storage (no env var needed).

## Project layout

```
src/extension.ts   Pi extension entry point (hooks, commands)
src/router.ts       classification → model selection + fallback logic
src/jev.ts          TypeSafe Jev API client (Choice primitive)
src/config.ts       default + user criteria JSON loading/merging
config/default-criteria.json   shipped default criteria
examples/           example user override file
```
