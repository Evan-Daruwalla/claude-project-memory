# templates — file skeletons

Copy these skeletons when creating new files. `<...>` marks the parts you
replace. Existing files keep their own established convention.

## §1 HANDOFF.md

```markdown
# Handoff

## Goal

<Why the project exists, in the owner's terms — the deliverable and the
constraint, one short paragraph. Lead with the actual objective and the reason
it matters, not a feature list.>

## Current state — <one-line headline>

**Last updated: <YYYY-MM-DD>** — this file is the only live snapshot; history
lives in the record.

> **<YYYY-MM-DD> — <major recent event> (record <entry ref>).** <2–4 line
> callout for anything a fresh session must not miss.>

<The current inventory: tables preferred over prose. For PRD-driven projects,
use a workstream table mapped to PRD milestones:>

### Workstreams (mapped to PRD milestones)

| Workstream | PRD | Status | Notes |
|---|---|---|---|
| <name> | M<N> | **Done** / **In progress** / **Not started** | <commit hash, test count, date> |

## <Domain sections as the project needs: Infrastructure / Key scripts (table:
## Script | Purpose) / Known limitations / Operations / ...>

## Documentation
- `<record file>` — <one line: append-only chronological record + how the HTML
  twin regenerates, if one exists>
- `PRD_ROADMAP.md` — the standing plan. Source of truth for what to build and
  in what order.
- <other docs, one line each>

## BLOCKED (needs the owner)  <!-- PRD-driven projects -->
- <item> · <item> — everything downstream works against stubs until resolved.
```

## §2 Record (append-only chronological history)

New-project skeleton:

```markdown
# Project Record — Full Chronological History

Written <YYYY-MM-DD>. Every entry is grounded in one of:
- <the real sources: git history, file modification timestamps, output
  artifacts, existing doc content, memory files — list what THIS record
  actually uses>

Sections where a timestamp can't be precisely verified are explicitly
marked. No fabricated metrics, dates, or file names.

> **REMINDER: after editing this file, refresh the HTML.** <!-- only if the
> project keeps an HTML twin; name the exact regen command -->

---

# How this document is organized

This record has two parts plus this navigation front-matter:

- **Part I — Phases** (`##` headings): the original consolidation, written in
  one pass from real history at bootstrap time.
- **Part II — Appendices A–…** (`#` headings): chronological addenda appended
  one session at a time per the `CLAUDE.md` cadence rule. **Append-only** —
  prior appendices are never edited.

The two heading levels encode that distinction (Phases are sections of the
original record; Appendices are top-level addenda). Sub-sections use the
`Letter.Number` convention (e.g. `B.7`, `Q.2`).

The sections below are reading aids. The authoritative detail always lives in
the dated entry, not the digest.

---

# Table of Contents

**Part I — Original record (<YYYY-MM-DD>)**
- [Phase 0 — <title>](#<anchor>) (~<MM-DD>)

**Part II — Appendices (chronological)**
- [A — <short title>](#<anchor>) (<MM-DD>)
```

Entry format (Part II — one per session/batch; heading is EXACT):

```markdown
# Appendix <XX> - <Title, compressed but specific> (<YYYY-MM-DD>[, ~HH:MM local])

<Structured prose covering WHAT changed · WHY (problem solved, tradeoff
weighed) · HOW (approach, especially non-obvious or after an abandoned
attempt). Bold labels (**WHAT:**/**WHY:**/**HOW:**) optional — follow the
file's precedent. Bugs as symptom → root cause → fix. Unresolved items get an
explicit callout:>

**HONEST OPEN ITEM (not fixed):** <what's still broken/unknown, flagged for a
future session — never smoothed over.>
```

When reality shifted significantly (audit, re-baseline, deployment or
architecture change), the entry ALSO carries a full point-in-time snapshot
section (tables preferred). Snapshots live inside the record; `HANDOFF.md` is
the only live one.

Appendix letters run A–Z then AA, AB, … Update the front-matter TOC with the
matching line each time (additive; entries themselves are immutable). After
regenerating the HTML twin, its broken-internal-link count must be 0 — that
verifies your TOC anchors.

## §3 PRD_ROADMAP.md

```markdown
# <Project> — <scope> PRD & Roadmap

**Written <YYYY-MM-DD> by <author/session>. Standing document — the executing
model works through TASK BREAKDOWN top to bottom, one task at a time, and
checks off SUCCESS CRITERIA.**

**SCOPE GUARD (decided <YYYY-MM-DD>): <hard scope limits — what this plan must
NOT touch. If a task seems to require it, STOP and report.>**
<!-- scope guard optional; include when the project has live state to protect -->

---

## 1. OBJECTIVE

<What we are building and why, the user and the outcome, plain language.>

## 2. CONTEXT

### What exists (verified <YYYY-MM-DD>)
<bulleted reality, file paths named>

### Must not break
<the invariants, each one testable>

## 3. SUCCESS CRITERIA

- [ ] <checkbox a model can verify, with the exact command where one exists>

## 4. CONSTRAINTS

<scope limits, tech choices, standards, out-of-scope list ("Do not start these
even if convenient"), and an Environment block (shell quirks, venv paths).>

## 5. MILESTONES

| # | Milestone | Goal |
|---|---|---|
| M1 | <name> | <one line> |

<one paragraph: why this order is deliberate>

## 6. TASK BREAKDOWN

### M1 — <name>

1. **<Task title>.** <What to do, which files it touches.> Done: <the
   observable check>.

## 7. HANDOFF NOTES

**Read first, in order:** <files>.
**Work order:** M1 → M<N> strictly. One task per sitting; finish (tests green
+ commit + record entry) before starting the next.
**Gotchas that will bite you:**
- <each one concrete, from real experience>
```

Conventions: dated decisions ("decided <date>") · BLOCKED on anything needing
the owner's accounts/keys/purchases · per-task done-checks · tasks sized so a
cheaper model finishes one without the owner.

Mutability (never wholesale-delete/retype the roadmap): ADD by appending ·
REMOVE by striking through in place with a dated reason (`~~task~~ (dropped
<date>: why)`), never deleting · PIVOT by FORKING — keep the old tree marked
`SUPERSEDED by the <date> fork`, add `## CURRENT DIRECTION (forked <date>)`,
exactly one fork current at a time. Status ticks update in place; planned work
is only struck, never erased.

## §4 codebase-memory bins

`INDEX.md` (≤25 lines):

```markdown
# codebase-memory index — <project>

Core bins:
- security.md — <one-line scope> (updated <YYYY-MM-DD>)
- performance.md — <scope> (updated <YYYY-MM-DD>)
- architecture.md — <scope> (updated <YYYY-MM-DD>)
- features.md — <scope> (updated <YYYY-MM-DD>)
- conventions.md — <scope> (updated <YYYY-MM-DD>)
- gotchas.md — <scope> (updated <YYYY-MM-DD>)

Standards bins (only those the codebase actually commits to):
- dependencies.md — libraries/frameworks + pinned versions + why (updated <YYYY-MM-DD>)
- ui.md — UI + UX: design language / component / styling / motion / a11y + UX flows / IA / states (updated <YYYY-MM-DD>)
- testing.md — framework, test layout, coverage/frozen rules (updated <YYYY-MM-DD>)
- data.md — schema/migration + API/interface contracts (updated <YYYY-MM-DD>)
- tooling.md — build/lint/format/CI + required commands (updated <YYYY-MM-DD>)

Cross-bin invariants:
- <only ones short enough to always load>
```

Bootstrap the FULL set (core + standards), not opt-in. A standard this project
doesn't hold gets a one-line dated N/A stub, never omitted — e.g.
`ui.md — N/A, no frontend (2026-07-15)` — so every standard has one home and
facts never scatter. Replace the stub with real facts the moment they exist. Beyond this baseline, add a new SPECIFICALLY-NAMED bin whenever a durable fact fits none of the existing bins (name it for its domain, index it) — never a `misc`/`other` catch-all (see SKILL §5 'New bins on demand').
Same entry rules as the core bins.

Bin entries: one fact per line/short block · absolute dates · supersede in
place ("(supersedes <date> entry: X)") · "(inferred, unverified)" where not
verified in code.
