---
name: project-memory
description: >-
  A project memory + execution-doc system: HANDOFF.md (only live snapshot) +
  append-only record + standing PRD_ROADMAP.md + codebase-memory bins. Owns
  the MACHINERY and three workflows: BOOTSTRAP, PRD write/execute-next-task,
  and the codebase-memory BINS — plus templates.md, append-record-entry.js and
  the cadence/record hooks everything else runs on. Use when: "/project-memory",
  "bootstrap the memory system", "write a PRD", "next task", "continue the
  roadmap", "update the bins", or in a project lacking HANDOFF.md. **Updating
  docs — record entry, handoff, drift check — moved to /docs-sync 2026-09-09.**
  Read templates.md before creating any doc.
---

# project-memory — the doc/memory system

One system, proven on a real long-running project. Copy the STRUCTURE exactly
(templates.md is character-exact); the content always comes from THIS project.
For files that already exist, match their established convention — e.g.
some projects' records use `## YYYY-MM-DD — title` entries instead of
`# Appendix X` headings; never reformat an existing doc to the template.

**The doc set** (project root unless noted):

| File | Role | Mutability |
|---|---|---|
| `HANDOFF.md` | The only live snapshot; a fresh session reads it FIRST | Rewritten freely; keep it a snapshot, move history to the record |
| `docs/Project Record — Full Chronological History.md` (or `docs/record_<date>.md`) | Append-only chronological build log — the ground truth; when anything disagrees with it, the record wins. Point-in-time snapshots live INSIDE it as dated entries | APPEND-ONLY; front-matter TOC gets one new line per entry; prior entries never edited |
| `PRD_ROADMAP.md` | Standing plan a model executes task-by-task | Grows by APPEND; never wholesale-deleted/retyped. Removed steps are struck through in place (kept + dated); a new direction is a dated FORK marked as the current plan (see §4) |
| `.claude/codebase-memory/` | Binned technical memory (see §5) | Superseded in place, same session as the code change |

Explicitly OUTSIDE this system: project-specific artifacts such as a
`daily_report.md` / `rebalance_log.md` (they have their own rules) — never fold them in.

**Cross-session rule — where "latest" comes from.** Other sessions write to
these files between your reads. Anything about the record's CURRENT position —
the latest appendix, the next free letter, canary counts, push state — is read
from the live artifact at the moment you act, never from HANDOFF's summary of
it and never from what this session remembers reading earlier. HANDOFF's
"appendices have reached X" note is a **reading, not a fact**: it was stale
within a day on both occasions it existed (records BT, BN). The same applies to
`git status`'s `ahead N` — ask `git ls-remote`, not a cached ref (gotchas.md).
Cheap rule of thumb: if another session could have changed it, re-derive it.

## 0. FIRST-LOAD CADENCE SETUP (before any workflow, once per project)

Cadence firing is made DETERMINISTIC by two hooks, not by the model
remembering to check:

- **`hooks/pm-cadence-autoinit.js`** (`PreToolUse`, matcher `Skill`) fires on
  EVERY skill invocation project-wide; it no-ops unless `tool_input.skill ===
  "project-memory"`. The first time this skill is invoked in a project, if
  `.claude/pm-cadence.json` doesn't exist yet AND the directory carries a
  PROJECT MARKER (`.git`, `HANDOFF.md`, `PRD_ROADMAP.md`, `CLAUDE.md`, or a
  language manifest) AND the project has no `UserPromptSubmit` hook of its own
  already (that last check is how a project that keeps its own
  cadence script avoids getting one — no hardcoding, just "does this
  project already have a cadence mechanism"), it auto-creates the config with
  defaults and injects a context note. **The marker check exists because
  without it the hook seeds a counter in whatever directory the session was
  opened in — including a parent folder that merely CONTAINS projects, which
  then accumulates prompts belonging to no project while every real project
  undercounts. Observed live: a container dir reached `_count` 72 beside a real
  project sitting at 13.** A marker-less directory gets no config and says so.
- **`hooks/pm-cadence.js`** (`UserPromptSubmit`) then decides per prompt which
  subparts are DUE. Since 2026-09-01 record_entry/handoff/bins are
  **change-driven**: it compares the newest project file's mtime against the doc
  that should describe it (record file / `HANDOFF.md` / newest bin) and stays
  SILENT when nothing is newer — a chat-only session now costs zero reminders
  and zero skill loads. Their config number became a **debounce** (at most one
  reminder per N prompts), not a trigger; `_floor` (default 0 = off) forces a
  periodic reminder even with no file change. `prd_next_task` stays a pure
  counter. mtime is a proxy: a formatter or `git checkout` can false-positive,
  costing one wasted reminder. Measured 2026-09-01: 143–155 ms on a real project
  (4,939 scannable files), 1.96 s worst case on a synthetic 15k-file tree where
  nothing is stale and the early exit never fires — both inside the 5 s hook
  timeout. Past `MAX_ENTRIES` (25000) or `MAX_DEPTH` (12) the walk can't see a
  change; it then degrades to the old prompt counter rather than going silent,
  and says so instead of claiming a change it never observed.
  The reminder also carries **line ranges**, not a skill name: obeying it used
  to mean invoking `/project-memory` and loading all ~29 KB (~7k tokens) to do
  a job one section answers. It now emits e.g. `SKILL.md:140-182` plus the
  rules block, parsed from this file at fire time so the numbers cannot rot
  when it is edited (a hardcoded range would silently cite the wrong text).
  §2 is 2.5 KB against the file's 28.9 KB — 11.5x less to read.
  **All four subparts now run** (2026-09-02). They were all off but
  `record_entry`, which is why one project's `conventions.md` went stale
  unnoticed; that default was only rational while enabling a subpart meant
  nagging every N prompts regardless of need. Three fixes made it safe:
  `bins` finds `codebase-memory/` by bounded search (root, then one level down
  — one real project keeps its config at the root and its bins one level down,
  which a fixed path missed entirely); `bins_max_age_days` (21) flags an
  individual rotting bin even when a sibling is fresh, since taking only the
  NEWEST bin meant touching any one file silenced the whole subpart; and an
  ABSENT target (no `HANDOFF.md`, no bins dir) now means "not in use here"
  rather than mtime 0 = infinitely stale, which would have nagged forever with
  no action able to stop it. `handoff` runs on a long 15-prompt debounce, not
  3: `HANDOFF.md` is the end-of-session snapshot, so mid-session drift is
  expected. A bin reviewed and still accurate is kept fresh by touching it.
  **`drift_check` (§6) is the fifth subpart** (2026-09-02) and §3's stricter
  sibling: `handoff` says "source moved, sync the snapshot"; `drift_check` says
  "the snapshot has ALSO sat untouched for `drift_check_days` (14) while the
  project moved, so verify its CLAIMS, not just its state". It targets
  `HANDOFF.md` itself rather than storing "when I last asked" in the config —
  a hook cannot check whether the model complied, so a written-back clock would
  silence itself for two weeks on nothing; keyed to the file, ignoring the
  reminder changes nothing and it keeps firing until HANDOFF is really touched.
  A dormant project never fires it: an old HANDOFF alone is not drift.
  **All three targets are found by root-then-one-level search** — one real project
  keeps its record at the root but `HANDOFF.md` and its bins inside
  a subdirectory, so a root-only lookup found one of three and silently
  missed the rest. Root wins when present; otherwise the NEWEST match one level
  down, which picks the live tree over a retired sibling.

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
   **Project-type profiles:** if the project ships a public website/app, or is
   research-class (experiments/studies), ALSO read `profiles/website.md` /
   `profiles/research.md` — the extra records that project type must retain
   beyond the standard doc set; fold the applicable rows into the HANDOFF,
   bins, and docs plan. Inapplicable rows are already stubbed N/A there.
2. **Create `HANDOFF.md`** from templates.md §1: Goal (why the project exists,
   in the owner's terms), dated Current state, key architecture/data facts, hard
   constraints, Documentation section, next actions.
3. **Create the record** from templates.md §2: grounding preamble (list the
   real sources entries are grounded in), "How this document is organized",
   TOC. Seed from git history and existing docs — real events with absolute
   dates only, NOTHING invented; an empty section beats a plausible fabrication.
4. **Wire the cadence into `CLAUDE.md`** — ASK, don't assume. This skill has
   four independently-firing subparts; ask the user how often each should run
   and write the answers into the project `CLAUDE.md` (default in parens if
   they say "whatever"):
   - **Record entry** (§2) — fires when project files are newer than the
     record; N is the debounce, i.e. at most one reminder per N prompts
     (default: 3).
   - **Handoff** (§3) — at session end, or whenever files are newer than
     `HANDOFF.md` with N as the debounce (default: session end only, i.e. 0).
   - **PRD next-task** (§4) — on request, or as the default idle action
     (default: on request).
   - **Codebase-memory bins** (§5) — same session as any code change that
     alters a stored fact (default: on fact-change only; not prompt-timed).
   These are SOFT instructions the model self-enforces, not hooks — if a count
   slips, catch up next prompt and note the miss in the record. If the user
   wants a hard guarantee, that's a `settings.json` hook, out of this skill's
   scope.
5. **Auto-memory files**: record the doc layout + hard constraints in the
   Claude auto-memory directory, indexed in MEMORY.md.
6. **Verify**: re-read HANDOFF.md as a fresh session would — does it alone say
   what the project is, where it stands, what to do next? Fix now if not.
7. Report what was seeded from real history vs. left empty.

## 2. RECORD ENTRY — MOVED to /docs-sync §2

Ported to `/docs-sync` on 2026-09-09. The appender it drives,
`append-record-entry.js`, still lives HERE and is still the only sanctioned
way to append — hand-splicing remains the documented failure mode.

## 3. HANDOFF — MOVED to /docs-sync §3

Ported to `/docs-sync` on 2026-09-09, along with the ordered full pass that
runs it (`/docs-sync` §1: record entry, HTML twin, record index, HANDOFF,
bins, PRD status, memory files, handoff prompt).

## 4. PRD — write one, or execute its next task

**Before drafting — grill the open decisions.** If the plan has interdependent
or unresolved design choices, interview the owner ONE question at a time, each with
your recommended answer, walking down the decision tree until every branch is
resolved. Where a question is already answered by the codebase, resolve it from
the code instead of asking. Only draft once the tree is settled — a PRD written
over unresolved forks bakes in guesses a cheaper model can't unwind later.

**Writing/updating a PRD**: use templates.md §3 (the 7 numbered sections).
Every PRD opens with the one-paragraph **GOAL** block at the very top of the
file (see §3) — write it FIRST; it is the sentence that keeps every later
session squarely on track.
Tasks must be small enough for a cheaper model to finish alone, each naming
its files and its done-check. Scope decisions get dated ("decided by the owner
YYYY-MM-DD"). Anything needing the owner's accounts/keys/purchases is marked
BLOCKED-ON-OWNER, never silently assumed.

**PRD mutability — the roadmap keeps its own planning history; NEVER
wholesale-delete or retype it.** The plan's evolution is itself part of the
record ("the process is the product"):
- **Add** by APPENDING new tasks/milestones. Don't rewrite the whole plan to
  slot something in.
- **Remove** a step by STRIKING IT THROUGH in place with a dated reason —
  `~~M3.2 — do X~~ (dropped 2026-07-10: superseded by Y)` — never by deleting
  the line. A later reader must still see what was planned and abandoned, and why.
- **Pivot** (the plan takes a genuinely new direction) by FORKING, not
  replacing: keep the old milestone tree, mark it `SUPERSEDED by the <date>
  fork`, and add the new direction under a clearly-labelled
  `## CURRENT DIRECTION (forked <date>): <why>` heading. Exactly ONE fork is
  the current plan at a time — mark it unambiguously so the executing model
  works the right one.
- Every add / strike / fork is dated. The PRD is append-mostly (not strictly
  append-only like the record): reading aids — SUCCESS CRITERIA checkboxes,
  milestone status — tick in place, but planned WORK is only struck, never
  erased.

**Executing the next task** (default action in a project with a PRD):
1. Load context in order: project `CLAUDE.md` → `HANDOFF.md` →
   `PRD_ROADMAP.md` → record front-matter. The HANDOFF workstream table says
   what's already done — trust it over guessing from code. (If cwd is
   the project root, the PRD may sit one level down at `<subdir>/PRD_ROADMAP.md`.)
2. Pick the first not-done task in milestone order (or the task the owner named).
   BLOCKED-ON-OWNER or gated tasks are REPORTED, not worked around — move to
   the next independent task only if the PRD allows it, else stop and say
   exactly what you need from the owner.
3. Restate before coding (2–3 lines): the task, files it touches, its
   done-check. If it looks wrong-sized, ambiguous, or its premise no longer
   matches the code — STOP and report with a recommendation.
4. Implement surgically: every changed line traces to the task; read files
   fully before editing; re-read the PRD's HANDOFF NOTES gotchas every time.
5. Verify: the project CLAUDE.md's definition of done PLUS the task's own
   done-check. Run the real commands, paste real output (e.g. frozen
   tests must print d=±0.0000pp; or backend pytest + frontend
   lint + build + browser-verify UI). NEVER "should pass".
6. Document: record entry per §2; HANDOFF workstream table if a milestone's
   status changed.
7. Commit if the PRD authorizes per-task commits (both current PRDs do).
   NEVER push without the owner's instruction.
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
  file per bin. **Core bins**: `security.md`, `performance.md`,
  `architecture.md`, `features.md`, `conventions.md`, `gotchas.md`.
  **Standards bins** — one per standard the codebase actually commits to, so a
  future session honors the same choices instead of guessing:
  `dependencies.md` (libraries/frameworks + pinned versions + why each + what
  NOT to add), `ui.md` (**UI + UX design** — visual/design language,
  component/styling/motion/a11y standards, AND UX: user flows, interaction
  patterns, information architecture, empty/error/loading states — frontend
  only), `testing.md` (framework, test layout, what must
  be covered, frozen-test rules), `data.md` (schema/migration conventions,
  API/interface contracts), `tooling.md` (build/lint/format/CI + required
  commands), `disclosure.md` (**what may leave this project** — who the
  non-code stakeholders are, what a case study / screenshot / demo / public
  README may and may not show, and any standing external constraint on
  outward-facing work).
  (Live case: a project holding MINORS' data, which constrains what any
  screenshot, demo, or portfolio case study may show long after the code is
  frozen — a rule `security.md` does not cover and the record does not
  surface at the moment the case study gets written.) *Boundary vs
  `security.md`: security.md governs the CODEBASE (secrets, auth, input
  handling) and its failure is a breach;
  disclosure.md governs ARTIFACTS DERIVED from the project that go outside it,
  and its failure is publishing something that should never have left.*
  **Bootstrap creates the FULL set (core + standards), not opt-in**:
  a bin with no facts yet — or a standard this project doesn't hold — gets a
  ONE-LINE dated stub (`ui.md — N/A, no frontend (2026-…)`; `performance.md —
  empty, no perf work yet (2026-…)`), NEVER omitted. Why: every standard gets
  one obvious home, so facts stop scattering into other bins, and the stub
  records that the standard was considered. Replace the stub with real facts
  the moment they exist. (The owner's stated preference: an empty bin beats a
  fact scattered across three other bins.)
- **New bins on demand — specific, never a catch-all.** The core + standards
  set is the baseline, not a ceiling. When a durable fact fits none of the
  existing bins, CREATE A NEW bin named for its specific domain (e.g.
  `mcp-setup.md`, `deployment.md`) and add its line to INDEX — never a
  `misc`/`other`/`general` catch-all, and never force the fact into an
  ill-fitting bin. The name must describe a specific domain; if you can't name
  it specifically, the fact belongs in an existing bin. Keeps "one obvious
  home" true as the project grows.
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
  **The protocol is not code-only.** Any task whose OUTPUT LEAVES THE PROJECT —
  a case study, portfolio or resume entry, demo, screenshot, public README,
  marketing or outreach copy — ALWAYS loads `disclosure.md`, the same way
  security.md is always loaded for auth work. This is the one bin a non-code
  task must read: without it such a task loads NO bins at all, which is how a
  constraint that was correctly recorded still gets violated at publish time.
- **Write protocol** (staleness is the failure mode): any change that alters a
  fact updates that bin the SAME session. Supersede in place ("(supersedes
  2026-06-30 entry: X)" when history matters). Cap ~150 lines/bin — compress
  oldest, least load-bearing first. Never delete a security/invariant entry
  without telling the user.
- **Bootstrap mode**: scan entry points/config/docs/ADRs/tests, populate
  verified high-value facts only (10 load-bearing beats 50 trivia), harvest
  decisions from HANDOFF/record/ADRs citing the source file, and present
  INDEX to the user for correction before treating it as truth.
- **Precedence**: CLAUDE.md/HANDOFF override bin contents on conflict. Bins
  govern memory mechanics, never how the owner wants code written.

### 5.1 The codebase DIRECTORY (`.claude/codebase-memory/DIRECTORY.md`)

A **map of the tree**, not a bin of facts: what each module IS, what the entry
points are, which modules are load-bearing, and what nothing imports. Bins
answer "what must I not get wrong?"; the directory answers "what is here and
what depends on what?" — the question every cold session currently re-derives
with a dozen tool calls before it can start.

- **Boundary vs `architecture.md`, stated so facts stop scattering:** *if it
  changes when you MOVE A FILE, it belongs in DIRECTORY; if it changes when you
  CHANGE YOUR MIND, it belongs in architecture.md.* Directory = where things
  are and what imports what (navigational, mechanically derivable).
  architecture.md = why it is built that way (decisions, rationale, tradeoffs).
- **Contents**, in this order:
  1. **Header** — generated date, the **commit SHA it reflects**, the staleness
     commands pasted verbatim so the next session reruns them identically, and
     which directories are mapped per-module vs summarized. No VCS? Say so in
     the header and treat the map as unverifiable — re-derive on read rather
     than inventing a version marker.
  2. **Tree** — one line per directory/module: what it IS, in its own terms.
     Not how it works, not its API. If the line would change on a refactor that
     moved nothing, it is architecture, not directory.
  3. **Entry points** — what a human, a scheduler, or CI actually invokes.
     Distinguish "runs the thing" from "imported by the thing", and look past
     imports entirely: CLI dispatch tables, `__main__`, hook and plugin config,
     route decorators, scheduled jobs, package scripts.
  4. **The spine** — the most-imported modules, with counts. These are the
     blast centers: a change there reaches everything, and it is where an
     audit's targeting pass should point first.
  5. **Unreferenced** — modules nothing imports, and code no test touches.
     Cheap to compute, and reliably surprising.
- **Counts are grepped, never estimated.** Items 4–5 are the only numbers in
  this artifact, which makes them its entire fabrication surface. Derive each
  with a real command, RECORD THAT COMMAND in the file, and when the language's
  import forms defeat a mechanical count (dynamic imports, star imports,
  re-exports, aliasing), write what you could count and NAME what you could not.
  Never a guessed number; never a count that silently covers part of the tree.
- **"Unreferenced" means unreferenced BY STATIC IMPORT** — label it that way in
  the file, and check it against item 3's dynamic surfaces before believing it.
  A live module listed as dead is the worst thing this file can say: it invites
  a deletion.
- **Staleness is THE failure mode** — a stale map is worse than no map, because
  it sends a session confidently to a file that moved. The halves rot at
  different rates, so they get different checks:
  - Items 2–3 (tree, entry points) go stale only when files APPEAR, VANISH, or
    MOVE — `git diff --name-status --diff-filter=ADR <sha>..HEAD -- <mapped
    dirs>`; empty output means the map still holds.
  - Items 4–5 (spine, unreferenced) go stale on any edit to an import line, so
    they get no cheap check. Treat them as EXPIRING: re-derive before letting
    them steer where work goes.
  Do NOT use `git diff --stat` here — it fires on content-only edits (2 of 3
  sampled real commits), and a check that cries wolf gets ignored within a week.
- **Regenerate, don't hand-edit.** Items 3–5 are mechanically derivable — rerun
  the recorded commands. Only item 2's annotations are human-written; preserve
  those across regenerations.
- **Read protocol**: read DIRECTORY at COLD ENTRY, and before any change that
  spans modules. Run its staleness check FIRST, and treat what it says as a
  CLAIM — good enough to target work, never good enough to conclude from. Never
  read it in place of a file you are about to edit.
- **Write protocol**: update it when the STRUCTURE changes — a file added,
  deleted, or moved; an entry point gained or lost — not on every commit. A
  directory that demands updating on every commit is one nobody updates.
- **Size rule, applied out loud**: this file earns its place only if a session
  will read all of it. Past roughly 200 lines, map at directory granularity and
  keep per-module lines only inside the directories the project actually works
  in — and SAY in the header which ones you summarized. A map silently covering
  half the tree reads exactly like one covering all of it.
- **When to build one**: at bootstrap for a codebase big enough that the tree is
  not obvious at a glance (roughly >15 source files), or the first time a
  session spends real effort mapping the surface. A five-file project does not
  need one — say so and skip it rather than generating ceremony.
- **Never invent a purpose line.** If you cannot tell what a module is for from
  its code and docs, write `— purpose unclear, not yet traced`. A confident
  wrong label is what makes a map actively harmful.

## 6. DRIFT-CHECK — MOVED to /docs-sync §4

Ported to `/docs-sync` on 2026-09-09. Note the section NUMBER changed (§6
here became §4 there); `pm-cadence`'s SECTIONS map carries the new one, and
its canary asserts it.

## Rules (all workflows)

- Absolute dates everywhere ("2026-07-08", never "today"/"recently").
- NEVER invent history, data, or numbers. Unsure whether something happened →
  leave it out or mark it explicitly uncertain.
- Append-only means append-only. The record's front-matter TOC/digest may gain
  lines; dated entries are immutable.
- HTML twins are script-generated only.
- Cadence misses are logged, not hidden ("cadence missed by N prompts").
- Structure from the templates; content from this project.

`node append-record-entry.js --canary` — MUST print `CANARY PASS 52/52` before you trust a result.

`node hooks/pm-cadence-autoinit.js --canary` — MUST print `CANARY PASS 11/11` before you trust a result.

`node hooks/pm-cadence.js --canary` — MUST print `CANARY PASS 54/54` before you trust a result.

`node hooks/pretooluse-record-guard.js --canary` — MUST print `CANARY PASS 23/23` before you trust a result.
