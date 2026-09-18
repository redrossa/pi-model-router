# pi-model-router

A [Pi](https://pi.dev) extension that classifies every prompt you send with
[TypeSafe's Jev](https://docs.typesafe.ai) and routes the turn to whichever
model you're logged into that best fits the task — planning/brainstorming to
one model, coding implementation to another, research/exploration to a
third, docs/prose writing to a fourth — without you having to `/model`
switch by hand.

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
   mid-run. Model references in criteria may be a bare id
   (`"claude-sonnet-5"`) or `"provider/id"` (`"anthropic/claude-sonnet-5"`).
   Prefer `provider/id` — bare ids match the first available model with that
   id across providers.
4. If Jev is unreachable, times out, returns low confidence (below
   `confidenceThreshold`), or picks a category with no available model, the
   extension falls back to the configured `fallback.category`, then to any
   category with an available model. If **none** of the configured models
   are available, you get a one-time warning at session start and the
   extension leaves your current model alone (no Jev call is made).

Jev also receives the last ~4 turns of conversation (recent user messages
and the assistant's replies/questions) alongside the new prompt, so a
short reply like "yes" or "option 2" is routed by what it's actually
replying to rather than classified in isolation. The context payload is
bounded — at most the last 8 user/assistant messages, each truncated to
1500 characters — and only the new prompt is classified.

## Install

Requires Pi and Node >= 20. Install the package into Pi:

```bash
pi install npm:@redrossa/pi-model-router
```

Or straight from git, which tracks `main`:

```bash
pi install git:github.com/redrossa/pi-model-router
```

`pi install` records the package in your global Pi settings
(`~/.pi/agent/settings.json`). Pass `-l` to write to project settings
(`.pi/settings.json`) instead, which can be committed so teammates pick the
package up automatically. To try it for a single run without installing:

```bash
pi -e npm:@redrossa/pi-model-router
```

Remove it again with `pi remove npm:@redrossa/pi-model-router`; `pi list` shows
what is installed and `pi update` updates non-pinned packages.

## Setup

Start Pi, then run `/login`, choose **"TypeSafe (pi-model-router)"** from the
provider list, and paste your TypeSafe API key (get one at
[https://typesafe.ai](https://typesafe.ai)) when prompted. The key is
stored in Pi's own credential file (`~/.pi/agent/auth.json`), alongside your
other provider logins — remove it later with `/logout`. No further setup is
needed.

For CI or non-interactive use, you can instead set the key as an environment
variable:

```bash
export TYPESAFE_API_KEY=sk-...   # get one at https://typesafe.ai
```

A key stored via `/login` takes precedence over `TYPESAFE_API_KEY`.

A default criteria map ships in
`config/default-criteria.json`. Its model lists reference models from pi's
**built-in** registry for the `anthropic`, `openai-codex` and `deepseek`
providers, so if you're logged into any of those it works out of the box:

| category | goes to (first available wins) |
|---|---|
| planning (reasoning, brainstorming, architecture) | `anthropic/claude-fable-5-1`, `openai-codex/gpt-6-astra`, `deepseek/deepseek-v4-pro` |
| coding (implementation, debugging, refactors) | `deepseek/deepseek-v4-flash`, `openai-codex/gpt-5.6-sol`, `anthropic/claude-opus-5` |
| research (exploration, reading code/docs) | `anthropic/claude-sonnet-5`, `openai-codex/gpt-5.6-terra`, `deepseek/deepseek-v4-flash` |
| writing (README/docs/Markdown, changelogs, comments, commit messages) | `anthropic/claude-fable-5-1`, `openai-codex/gpt-6-astra`, `deepseek/deepseek-v4-pro` |

These lists are a starting point, not a recommendation — if you use other
providers (OpenRouter, Ollama, …) or these ids have been renamed in your pi
version, **none of them will resolve** and you'll see a warning at startup.
Run `pi --list-models` to see what you're logged into, then put those ids
(as `provider/id`) in your own config as described below. `/router` shows
which entries resolve (✓/✗).

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
    "coding": { "description": "...", "models": ["your-provider/your-model-id"] },
    "devops": { "description": "shell, CI, Docker, deployment tasks", "models": ["openai-codex/gpt-6-astra"] }
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
- `/login` — store your TypeSafe API key in pi's credential storage (pick **"TypeSafe (pi-model-router)"** from the list; no env var needed). Use `/logout` to remove it.

## Project layout

```
src/extension.ts   Pi extension entry point (hooks, commands)
src/router.ts       classification → model selection + fallback logic
src/jev.ts          TypeSafe Jev API client (Choice primitive)
src/context.ts      recent-conversation extraction for classifying short replies
src/config.ts       default + user criteria JSON loading/merging
config/default-criteria.json   shipped default criteria
examples/           example user override file
```
