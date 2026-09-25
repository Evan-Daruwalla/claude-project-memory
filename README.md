# project-memory

A [Claude Code](https://claude.com/claude-code) skill for keeping a project's
memory correct across sessions and models. It packages one durable
documentation system into two skills: **`project-memory`** (the machinery —
bootstrap, PRD, bins, templates, scripts and hooks) and **`docs-sync`** (the
write arm — bring every doc back in line with what the code and the session
actually did).

> This is the memory / documentation half of a two-repo generalized skill set.
> The non-memory skills — security gates, model-quality tooling, and review /
> advisory skills — live in the sibling repo
> **[claude-skill-suite](https://github.com/Evan-Daruwalla/claude-skill-suite)**.

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

## The workflows, and which skill owns them

Record entry, handoff and drift-check moved from `project-memory` to
`docs-sync` on 2026-09-09: they are the ones that EDIT docs, they are what
people actually ask for ("update the docs"), and splitting them keeps each
skill small enough to load one section instead of the whole file.

`project-memory` — the machinery:

- **Bootstrap** — stand the system up in a new project, seeded from real git
  history (nothing invented).
- **PRD** — write a roadmap, or execute its next open task end-to-end with the
  project's own definition of done.
- **Codebase-memory bins** — maintain per-project technical memory that a
  session reads selectively to save tokens.

`docs-sync` — the write arm:

- **The full pass** — one ordered run over every doc a project keeps: record
  entry, HTML twin, record index, HANDOFF, bins, PRD status, memory files,
  handoff prompt, each with its own done-check. Triggered by "update the
  project memory" / "update the docs" / "update everything".
- **Record entry** — append one timestamped WHAT/WHY/HOW entry mid-session.
- **Handoff** — end-of-session sync (record + HANDOFF + a paste-ready
  next-session prompt).
- **Drift-check** — re-test what HANDOFF claims (tests, services, statuses)
  against reality and report MATCH / DRIFT / UNVERIFIED-TODAY per claim.

## Install

Copy BOTH skill directories into your Claude Code skills folder — they are
siblings on purpose, and `pm-cadence` resolves `docs-sync` relative to
`project-memory`, so splitting them up breaks its reminders:

```
~/.claude/skills/project-memory/
~/.claude/skills/docs-sync/
```

Then invoke them with `/project-memory` or `/docs-sync`, or let them trigger on
phrases like "update the docs", "handoff", "log this", "drift check",
"bootstrap the docs", or "run the next PRD task".

### The commit gate (optional)

This repo carries its own pre-commit hook at `scripts/git-hooks/pre-commit`.
It is version controlled rather than living in `.git/hooks`, which git does not
track — a hook there protects one machine and vanishes on clone. Enable it with:

```
git config core.hooksPath scripts/git-hooks
```

It blocks a commit whose staged diff contains a secret. It also runs an
optional private-identifier check, whose location it reads from
`git config leakguard.path`; with that unset the check simply does not apply,
which is the normal case for a clone.

## Deterministic cadence hooks

The cadence (e.g. "append a record entry every 3 prompts") is enforced by two
hooks (Node, no dependencies), not by the model remembering to check:

- **`pm-cadence-autoinit.js`** (`PreToolUse`, matcher `Skill`) fires on every
  skill invocation and no-ops unless it's this skill. The first time
  project-memory runs in a project, if `.claude/pm-cadence.json` doesn't exist
  and the project has no `UserPromptSubmit` hook of its own already (that
  check is how a project running its own cadence mechanism avoids getting a
  second one), it auto-creates the config with defaults and injects a context
  note so the model asks the user if they want different numbers.
- **`pm-cadence.js`** (`UserPromptSubmit`) counts prompts per project against
  that config and injects a reminder every Nth, per subpart.

What's deterministic: config creation, counting, and reminder injection — they
fire regardless of context length, which model is driving, or whether the
model ever reads the skill's setup instructions. What's not: a hook can't
*invoke* a skill or ask the user anything interactively, so acting on the
reminder — and answering the "want different numbers?" question — is still the
model's job. This replaces a CLAUDE.md cadence line the model forgets deep in a
session with a fresh top-of-turn instruction, and removes the model's own
first-load check as a single point of failure.

Register both once, globally, so they cover every project:

```json
"hooks": {
  "UserPromptSubmit": [
    { "hooks": [ { "type": "command",
      "command": "node \"<abs path>/project-memory/hooks/pm-cadence.js\"",
      "timeout": 5000 } ] }
  ],
  "PreToolUse": [
    { "matcher": "Skill", "hooks": [ { "type": "command",
      "command": "node \"<abs path>/project-memory/hooks/pm-cadence-autoinit.js\"",
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

- `docs-sync/SKILL.md` — the write arm: the full pass, record entry, handoff,
  drift-check.
- `project-memory/SKILL.md` — the machinery: bootstrap, PRD, bins.
- `project-memory/templates.md` — copy-ready skeletons for each artifact.
- `project-memory/append-record-entry.js` — the only sanctioned way to append
  to an appendix-style record. Derives the next letter from a live scan,
  refuses a duplicate across any dash style, and re-checks four invariants
  after writing, rolling back if any fails. `--canary` self-tests it.
- `project-memory/hooks/pm-cadence.js` — compares project file mtimes against
  the doc that should describe them and injects a reminder naming the section
  to read, by line range.
- `project-memory/hooks/pm-cadence-autoinit.js` — auto-creates the config on
  first invocation.
- `project-memory/hooks/pretooluse-record-guard.js` — denies a direct
  Edit/Write to an append-only record, so every write goes through the
  locking appender. A heading written without its TOC line breaks the record
  for every later append.
- `project-memory/hooks/pretooluse-ascii-md.js` - denies a Write, Edit or
  MultiEdit that ADDS non-ASCII characters to a .md file (rule added
  2026-09-23); non-ASCII already in the file can stay. Register it as a
  `PreToolUse` hook on matcher `Edit|Write|MultiEdit`.
  `ASCII_MD_GUARD_OFF=1` turns it off.
- `project-memory/hooks/pre-commit-record` — the same invariants at commit
  time.
- `project-memory/profiles/research.md`, `profiles/website.md` — per-project-type
  starting points for the bins.
- `scripts/git-hooks/pre-commit` — this repo's own commit gate (see Install).
