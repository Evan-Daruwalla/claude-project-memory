# project-memory

A [Claude Code](https://claude.com/claude-code) skill for keeping a project's
memory correct across sessions and models. It packages one durable
documentation system into five on-demand workflows.

## The system

Four artifacts, each with one job:

| Artifact | Role |
|---|---|
| `HANDOFF.md` | The single always-current snapshot. A fresh session reads it first. |
| `docs/<record>.md` | An **append-only** chronological build log — the ground truth. Point-in-time snapshots live inside it as dated entries. |
| `PRD_ROADMAP.md` | A standing plan a model executes one small task at a time. |
| `.claude/codebase-memory/` | Binned technical memory so a session loads only the facts a task needs. |

The design goal: a session started cold — by any model, including a cheaper
one — can read `HANDOFF.md`, pick up the plan, and execute without the owner
filling gaps from memory.

## Five workflows

- **Bootstrap** — stand the system up in a new project, seeded from real git
  history (nothing invented).
- **Record entry** — append one timestamped WHAT/WHY/HOW entry mid-session.
- **Handoff** — end-of-session sync (record + HANDOFF + a paste-ready
  next-session prompt).
- **PRD** — write a roadmap, or execute its next open task end-to-end with the
  project's own definition of done.
- **Codebase-memory bins** — maintain per-project technical memory that a
  session reads selectively to save tokens.

## Install

Copy the `project-memory/` directory into your Claude Code skills folder:

```
~/.claude/skills/project-memory/
```

Then invoke it with `/project-memory`, or let it trigger on phrases like
"handoff", "log this", "bootstrap the docs", or "run the next PRD task".

## Deterministic cadence hook

The cadence (e.g. "append a record entry every 3 prompts") is enforced by a
`UserPromptSubmit` hook — `project-memory/hooks/pm-cadence.js` (Node, no
dependencies). On the skill's first load in a project it asks how often each of
the four subparts should fire, writes the answers to `.claude/pm-cadence.json`,
and ensures the hook is registered. The hook then counts prompts per project
and injects a reminder every Nth.

What's deterministic: the counting and the reminder injection — they fire
regardless of context length or which model is driving. What's not: a hook
cannot *invoke* a skill, so acting on the reminder is still the model's job. It
replaces a CLAUDE.md cadence line the model forgets deep in a session with a
fresh top-of-turn instruction.

Register it once, globally, so it covers every project and stays dormant until
a project has a `pm-cadence.json`:

```json
"hooks": {
  "UserPromptSubmit": [
    { "hooks": [ { "type": "command",
      "command": "node \"<abs path>/project-memory/hooks/pm-cadence.js\"",
      "timeout": 5000 } ] }
  ]
}
```

Requires `node` on PATH.

## Principles it enforces

- Absolute dates only — never "today" or "recently".
- Append-only records — corrections are new entries referencing the old.
- Never invent history, data, or numbers; missing is reported as missing.
- Generated HTML is script-regenerated, never hand-edited.
- Structure from the templates; content always from your own project.

## Files

- `project-memory/SKILL.md` — the skill definition and the five workflows.
- `project-memory/templates.md` — copy-ready skeletons for each artifact.
- `project-memory/hooks/pm-cadence.js` — the deterministic cadence hook.
