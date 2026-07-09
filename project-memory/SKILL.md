---
name: project-memory
description: >
  A project memory + execution-doc system for Claude Code, built around four durable artifacts:
  HANDOFF.md (the single live snapshot) + an append-only chronological record + a standing
  PRD_ROADMAP.md + per-project codebase-memory bins. One skill, five workflows: BOOTSTRAP the
  system in a new project; append a RECORD ENTRY mid-session; end-of-session HANDOFF sync; write
  a PRD or EXECUTE its next open task; maintain CODEBASE-MEMORY bins. Use when the user says
  "/project-memory", "handoff", "update the docs", "update the record/HANDOFF", "append the
  record", "log this", "record this", "bootstrap the memory/doc system", "set up the docs",
  "next task", "run the next PRD task", "continue the plan/roadmap", "check the bins", "update
  the bins" — or when wrapping up a work session, starting a project that lacks HANDOFF.md, or
  given no direction in a project that has a PRD_ROADMAP.md. Exact file skeletons live in
  templates.md (read it before creating any doc).
---

# project-memory — the doc/memory system

One system for keeping a project's memory correct across sessions and models.
Copy the STRUCTURE exactly (templates.md is the skeleton); the content always
comes from THIS project. For files that already exist, match their established
convention — some records use `## YYYY-MM-DD — <title>` dated sections, others
use `# Appendix <X>` headings; never reformat an existing doc to the template.

**The doc set** (project root unless noted):

| File | Role | Mutability |
|---|---|---|
| `HANDOFF.md` | The only live snapshot; a fresh session reads it FIRST | Rewritten freely; keep it a snapshot, move history to the record |
| `docs/<record>.md` (a chronological build log, e.g. `Project Record — Full Chronological History.md` or `record_<date>.md`) | Append-only chronological build log — the ground truth; when anything disagrees with it, the record wins. Point-in-time snapshots live INSIDE it as dated entries | APPEND-ONLY; front-matter TOC gets one new line per entry; prior entries never edited |
| `PRD_ROADMAP.md` | Standing plan a model executes task-by-task | Updated only on the owner's scope decisions, each stamped with its date |
| `.claude/codebase-memory/` | Binned technical memory (see §5) | Superseded in place, same session as the code change |

Explicitly OUTSIDE this system: project-specific operational artifacts (daily
reports, run logs, generated dashboards) that have their own rules — never
fold them in.

## 0. FIRST-LOAD CADENCE SETUP (before any workflow, once per project)

Cadence firing is made DETERMINISTIC by two hooks, not by the model
remembering to check:

- **`hooks/pm-cadence-autoinit.js`** (`PreToolUse`, matcher `Skill`) fires on
  EVERY skill invocation project-wide; it no-ops unless `tool_input.skill ===
  "project-memory"`. The first time this skill is invoked in a project, if
  `.claude/pm-cadence.json` doesn't exist yet AND the project has no
  `UserPromptSubmit` hook of its own already (that second check is how a
  project already running its own cadence mechanism avoids getting a second
  one — no hardcoding, just "does this project already have a cadence hook"),
  it auto-creates the config with defaults and injects a context note.
- **`hooks/pm-cadence.js`** (`UserPromptSubmit`) then counts prompts per
  project against that config and injects a reminder every Nth subpart-cadence.

Neither hook can invoke this skill or ask the user anything — that's the real
ceiling (no hook can run interactively). What they DO make deterministic:
config creation and the counting/reminder, regardless of whether the model
ever reads this section. The model's only remaining job:

- **If the injected context says a config was just auto-created** (tagged
  `_auto_created: true` in the file, or you see the `[PM-CADENCE] ... auto-
  created defaults` note): ask, in ONE question, whether the user wants
  different numbers than the defaults (record_entry 3; handoff/prd_next_task/
  bins 0 = event-driven), then update `.claude/pm-cadence.json` if they do and
  drop the `_auto_created` flag.
- **Otherwise**: config already exists (auto-created earlier or hand-set) —
  don't re-ask, just proceed with the requested workflow.
- **If somehow no config exists and no auto-init note appeared** (e.g. the
  global hook isn't registered on this machine): fall back to asking directly
  and writing the file yourself, and tell the user to add the PreToolUse block
  from `pm-cadence-autoinit.js`'s header to `~/.claude/settings.json` so this
  doesn't recur.

## 1. BOOTSTRAP (new project, or "set up the memory system")

1. **Inventory what exists.** HANDOFF.md, docs/, CLAUDE.md, git history. Never
   overwrite an existing doc — extend it; converge partial systems to this
   shape rather than duplicating files.
2. **Create `HANDOFF.md`** from templates.md §1: Goal (why the project exists,
   in the owner's terms), dated Current state, key architecture/data facts,
   hard constraints, Documentation section, next actions.
3. **Create the record** from templates.md §2: grounding preamble (list the
   real sources entries are grounded in), "How this document is organized",
   TOC. Seed from git history and existing docs — real events with absolute
   dates only, NOTHING invented; an empty section beats a plausible fabrication.
4. **Wire the cadence into `CLAUDE.md`** — ASK, don't assume. This skill has
   four independently-firing subparts; ask the user how often each should run
   and write the answers into the project `CLAUDE.md` (default in parens if
   they say "whatever"):
   - **Record entry** (§2) — every N prompts of real work (default: 3).
   - **Handoff** (§3) — at session end, or every N prompts (default: session
     end only).
   - **PRD next-task** (§4) — on request, or as the default idle action
     (default: on request).
   - **Codebase-memory bins** (§5) — same session as any code change that
     alters a stored fact (default: on fact-change only; not prompt-timed).
   These are SOFT instructions the model self-enforces, not hooks — if a count
   slips, catch up next prompt and note the miss in the record. If the user
   wants a hard guarantee, that's a `settings.json` hook, out of this skill's
   scope.
5. **Memory files**: if the harness has a persistent memory store, record the
   doc layout + hard constraints there and index them.
6. **Verify**: re-read HANDOFF.md as a fresh session would — does it alone say
   what the project is, where it stands, what to do next? Fix now if not.
7. Report what was seeded from real history vs. left empty.

## 2. RECORD ENTRY (mid-session "log this" — no full handoff ceremony)

1. Find the record file and its convention (check HANDOFF.md §Documentation).
   For an appendix-style record: next `# Appendix <XX> - <Title> (<date>)` —
   grep `"^# Appendix"` for the last letter, add the matching TOC line in the
   front-matter. For a dated-section record: `## YYYY-MM-DD — <title>`.
2. Entry content: absolute date + approx time ("2026-01-15 ~16:40"); WHAT
   changed · WHY (problem, tradeoff) · HOW (approach, especially non-obvious
   or after an abandoned attempt); any bug as symptom → root cause → fix;
   honest open items labeled as such. Failures and slips stated, not smoothed.
   When reality shifted significantly (audit, re-baseline, deployment or
   architecture change), the entry carries a full point-in-time snapshot
   section (tables preferred) — snapshots live in the record, nowhere else.
3. APPEND ONLY — corrections are NEW entries referencing the old one.
4. Regenerate the HTML twin where one exists, by the project's render script
   only — never hand-edit generated HTML. If the renderer reports a broken
   internal-link count, it must be 0; that verifies your TOC anchors.
5. Don't update HANDOFF.md from this workflow — that's §3's job (offer it if
   the entry reveals it's stale).

## 3. HANDOFF (end of session, "update everything")

1. **Gather facts**: what actually changed this session — files, decisions,
   bugs, unresolved items. Use `git status`/`git log` since session start.
   Nothing that was only planned.
2. **Record**: append the entry per §2 (including the snapshot section when
   reality shifted).
3. **HANDOFF.md**: update Current state + the **Last updated:** date; move
   displaced history into the record, not the trash.
4. **HTML twins** by script, per §2.4.
5. **Memory files**: if a durable fact changed (constraint, convention,
   roadmap shift), update the persistent memory store + its index.
6. **Handoff prompt**: end with a fenced, paste-ready prompt for the next
   session — read order (HANDOFF.md → record front-matter → PRD), 1-paragraph
   current state, hard constraints, concrete next actions in priority order.

## 4. PRD — write one, or execute its next task

**Writing/updating a PRD**: use templates.md §3 (the 7 numbered sections).
Tasks must be small enough for a cheaper model to finish alone, each naming
its files and its done-check. Scope decisions get dated ("decided
YYYY-MM-DD"). Anything needing the owner's accounts/keys/purchases is marked
BLOCKED (needs the owner), never silently assumed.

**Executing the next task** (default action in a project with a PRD):
1. Load context in order: project `CLAUDE.md` → `HANDOFF.md` →
   `PRD_ROADMAP.md` → record front-matter. The HANDOFF workstream table says
   what's already done — trust it over guessing from code.
2. Pick the first not-done task in milestone order (or the task the owner
   named). BLOCKED or gated tasks are REPORTED, not worked around — move to
   the next independent task only if the PRD allows it, else stop and say
   exactly what's needed.
3. Restate before coding (2–3 lines): the task, files it touches, its
   done-check. If it looks wrong-sized, ambiguous, or its premise no longer
   matches the code — STOP and report with a recommendation.
4. Implement surgically: every changed line traces to the task; read files
   fully before editing; re-read the PRD's HANDOFF NOTES gotchas every time.
5. Verify: the project CLAUDE.md's definition of done PLUS the task's own
   done-check. Run the real commands, paste real output. NEVER "should pass".
6. Document: record entry per §2; HANDOFF workstream table if a milestone's
   status changed.
7. Commit if the PRD authorizes per-task commits. NEVER push without the
   owner's instruction.
8. Report outcome-first: what shipped, verification summary, record location,
   then "next task: <id> — <one line>" so the owner can say "go".
One task per invocation. A blocked task honestly reported beats a fudged one.

## 5. CODEBASE-MEMORY BINS (`.claude/codebase-memory/`)

Binned technical memory so future sessions write correct code without
re-reading the codebase — and without loading everything.

- **Per-project isolation.** Each project's bins live in ITS
  `.claude/codebase-memory/`; facts never leak between projects. No dir yet →
  offer to bootstrap a fresh one, never reuse another project's.
- **Structure**: `INDEX.md` (≤25 lines: one line per bin — name, scope,
  last-updated — plus cross-bin invariants short enough to always load) + one
  file per bin: `security.md`, `performance.md`, `architecture.md`,
  `features.md`, `conventions.md`, `gotchas.md`. Add a bin only when recurring
  facts don't fit; never speculatively.
- **What goes in**: only facts expensive to rediscover or dangerous to forget —
  invariants, protocols, decisions with reasons, measured results, constraints.
  NOT what grep answers instantly, NOT session narrative (that's the record's
  job). One fact per line/short block, absolute dates, nothing invented;
  inference marked "(inferred, unverified)".
- **Read protocol** (the token saver): before writing code, read INDEX.md then
  ONLY the bins the task touches. Input/auth/secrets/rendering ALWAYS loads
  security.md; hot paths always load performance.md. Never all bins by
  default. Bin facts are claims: when code disagrees, trust the code, fix the
  bin, note the correction.
- **Write protocol** (staleness is the failure mode): any change that alters a
  fact updates that bin the SAME session. Supersede in place ("(supersedes
  2026-01-10 entry: X)" when history matters). Cap ~150 lines/bin — compress
  oldest, least load-bearing first. Never delete a security/invariant entry
  without telling the user.
- **Bootstrap mode**: scan entry points/config/docs/ADRs/tests, populate
  verified high-value facts only (10 load-bearing beats 50 trivia), harvest
  decisions from HANDOFF/record/ADRs citing the source file, and present
  INDEX to the user for correction before treating it as truth.
- **Precedence**: CLAUDE.md/HANDOFF override bin contents on conflict. Bins
  govern memory mechanics, never how the owner wants code written.

## Rules (all workflows)

- Absolute dates everywhere ("2026-01-15", never "today"/"recently").
- NEVER invent history, data, or numbers. Unsure whether something happened →
  leave it out or mark it explicitly uncertain.
- Append-only means append-only. The record's front-matter TOC/digest may gain
  lines; dated entries are immutable.
- HTML twins are script-generated only.
- Cadence misses are logged, not hidden ("cadence missed by N prompts").
- Structure from the templates; content from this project.
