---
name: docs-sync
description: >-
  Bring every doc a project keeps back in line with what the code and the
  session actually did — one ordered pass: record entry, HANDOFF, HTML twin,
  record index, bins, PRD status, memory files, handoff prompt, each with its
  own done-check. Owns three workflows ported from project-memory 2026-09-09:
  RECORD ENTRY, HANDOFF, DRIFT-CHECK. Use when: "update the project memory",
  "update the docs", "sync the docs", "update everything", "log this",
  "record this", "handoff", "drift check", "is HANDOFF still true". NOT an
  audit (/audit-docs asks whether docs are TRUE and only reports); this one
  EDITS. Bootstrap, PRD and bins stay in /project-memory.
---

# docs-sync — make every doc true again, in one ordered pass

A project's docs go stale in a fixed order, and the expensive failure is always
the same: a cheap model reads a confident snapshot that stopped being true three
sessions ago and acts on it. This skill is the write arm. `/audit-docs` asks
whether the docs are true and reports; this one makes them true and edits.

**It owns three workflows ported out of `/project-memory` on 2026-09-09**
(RECORD ENTRY §2, HANDOFF §3, DRIFT-CHECK §4 here). `/project-memory` keeps what
it still owns: cadence setup, BOOTSTRAP, PRD, codebase-memory bins, the
templates, and the scripts and hooks all of this runs on.

**Never invent history, data, or numbers.** Unsure whether something happened →
leave it out or mark it uncertain. Every date is absolute ("2026-09-09", never
"today"), read from a real `date` call, and the zone is stamped by the reported
UTC offset (UTC-6 → CST, UTC-5 → CDT) — never hardcoded.

---

## 1. THE FULL PASS ("update the project memory", "update everything")

Run these IN ORDER. Each step names what proves it. A step you skip is reported
as skipped, never silently dropped — "I did not check the bins" is a result;
a clean-looking summary that never looked is the failure this exists to prevent.

**First, ask what is actually stale.** `pm-cadence` already computes this and it
is cheaper and less biased than reading every file:

```
node ~/.claude/skills/project-memory/hooks/pm-cadence.js --report <project-root>
```

It compares project file mtimes against the doc that should describe them, per
subpart. Use its answer to decide which of the steps below have real work, but
run steps 1 and 2 regardless — a session that changed something always owes a
record entry.

| # | Step | Done-check |
|---|---|---|
| 1 | Gather facts | `git status` + `git log` since session start; the list is what CHANGED, never what was planned |
| 2 | Record entry (§2) | the script prints the appendix letter and `invariants:` line, exit 0 |
| 3 | HTML twin, if the project has one | `broken: 0` |
| 4 | Record index, if the project has one | `record-index: CURRENT — N appendices`, exit 0 |
| 5 | HANDOFF.md (§3) | `Last updated:` stamped from a real `date`; every claim in it is currently true |
| 6 | Bins (`/project-memory` §5) | only the bins the cadence report named as stale |
| 7 | PRD status | a milestone row moves ONLY if its done-check actually passed |
| 8 | Memory files | a durable fact changed → update the file AND its `MEMORY.md` index line |
| 9 | Handoff prompt | fenced, paste-ready, at the end of HANDOFF.md |

**Report at the end, outcome first:** what changed, what was already current,
what was skipped and why. Then the next actions in priority order.

---

## 2. RECORD ENTRY (mid-session "log this" — no full handoff ceremony)

1. Find the record file and its convention (check HANDOFF.md §Documentation).
   **Appendix-style records: APPEND WITH THE SCRIPT, never by hand.**

   ```
   node ~/.claude/skills/project-memory/append-record-entry.js \
     --record "<path>" --title "<title>" --date "<from a real `date` call>" \
     --body <file>            # add --dry-run to preview
   ```

   It derives the next letter from a LIVE scan, refuses a duplicate across any
   dash style, places the TOC line after the last existing one, computes the
   anchor with the renderer's own slug algorithm, and re-checks four invariants
   after writing (append-only, no duplicate letters, letters ordered,
   TOC/heading counts equal) — rolling the write back if any fails. It also
   REFUSES a guessed date: `--date` is required, so run `date` first.

   **Hand-splicing is the documented failure mode, not a shortcut.** Sessions
   wrote five bespoke splice scripts in one week; one appended a duplicate
   `BM` over three other sessions' entries because it derived "next" from the
   last entry IT had read, and its own guard missed the collision because that
   entry used a different dash. The instruction to grep for the last letter was
   already there and was followed — that is the point: this is a gate, and gates
   get scripts. Derive the next letter with `--next-letter`, never from a
   pointer in HANDOFF, which has gone stale within a day every time one existed.

   The dated-section convention (`## YYYY-MM-DD — <title>` sections in
   `docs/record_<date>.md`) is a different convention — the script refuses it
   rather than guessing; hand-append there, matching the file's existing shape.
2. Entry content: absolute date + approx time ("2026-07-08 ~16:40"); WHAT
   changed · WHY (problem, tradeoff) · HOW (approach, especially non-obvious
   or after an abandoned attempt); any bug as symptom → root cause → fix;
   honest open items labeled as such. Failures and slips stated, not smoothed.
   When reality shifted significantly (audit, re-baseline, deployment or
   architecture change), the entry carries a full point-in-time snapshot
   section (tables preferred) — snapshots live in the record, nowhere else.
3. APPEND ONLY — corrections are NEW entries referencing the old one.
4. Regenerate the HTML twin where one exists, by script only (e.g.
   `.venv\Scripts\python.exe -m scripts.render_record_html`, or
   `python -m scripts.render_record_html`). The renderer's `broken:` count
   verifies your TOC anchors — it must print `broken: 0`.
5. Regenerate the record index where one exists, by script only:
   `node scripts/record-index.js --record "<path>"`. It carries every
   appendix's LINE RANGE, which each append invalidates, so a hand-kept copy is
   wrong within one commit. `--check` exits 1 when it has drifted.
6. Don't update HANDOFF.md from this workflow — that's §3's job (offer it if
   the entry reveals it's stale).

---

## 3. HANDOFF (end of session)

1. **Gather facts**: what actually changed this session — files, decisions,
   bugs, unresolved items. Use `git status`/`git log` since session start.
   Nothing that was only planned.
2. **Record**: append the entry per §2 (including the snapshot section when
   reality shifted).
3. **HANDOFF.md**: update Current state + the **Last updated:** date; move
   displaced history into the record, not the trash.
4. **HTML twins and the record index** by script, per §2.4 and §2.5.
5. **Memory files**: if a durable fact changed (constraint, convention,
   roadmap shift), update the auto-memory file + its `MEMORY.md` index line.
6. **Handoff prompt**: end with a fenced, paste-ready prompt for the next
   session — read order (HANDOFF.md → record front-matter → PRD), 1-paragraph
   current state, hard constraints, concrete next actions in priority order.

**HANDOFF.md is the ONLY live snapshot, and it earns that by staying small.**
History belongs in the record. When a dated narrative block in HANDOFF is
already summarized by a record appendix, cite the appendix and delete the block
— check the letter exists first. A snapshot nobody can afford to read is not a
snapshot: one grew to 905 lines / 70 KB, costing ~18k tokens to reach a dozen
actionable lines, in the file whose whole job is to be read first.

---

## 4. DRIFT-CHECK ("verify the docs", "drift check", "is HANDOFF still true?")

The verification arm: HANDOFF.md is the only live snapshot, and a cheap model's
worst failure mode is confidently acting on a stale one. This re-tests what
HANDOFF CLAIMS against reality and reports the drift. Scope is strictly
HANDOFF.md's claims — NOT the skill docs, NOT a code audit (that's `/audit`).

1. **Extract claims.** Read HANDOFF.md and list every INDEPENDENTLY VERIFIABLE
   claim: test suites and their pinned results, services/ports said to be
   running, scheduled tasks said to exist, files/DBs said to exist (with sizes),
   workstream statuses ("Done" ⇒ the commit exists), dates ("Last updated").
2. **Classify each claim:**
   - CHEAP — verifiable now with a read-only or fast command → run it.
   - EXPENSIVE/RISKY — needs a long run, a protected time window, or touches
     live state (anything that trades, writes a shared DB) → do NOT run;
     report as UNVERIFIED-TODAY with the exact command a future session should
     use, and why it was skipped.
3. **Run the cheap checks for real.** Paste real output. Respect the project's
   hard rules while checking (e.g. read-only DB access, stay out of a
   5:00–6:30pm window; never run anything that trades).
4. **Report a drift table:** claim → observed reality → verdict per row:
   **MATCH** / **DRIFT** (with the delta) / **UNVERIFIED-TODAY** (with reason).
   Outcome-first: lead with "no drift" or the count of drifted rows.
5. **On DRIFT:** the report is the deliverable — fix HANDOFF only with the
   owner's go-ahead (or when the fix is unambiguous, e.g. a stale date), and
   any fix routes through §3 (record entry + HANDOFF update), never a silent
   edit. For historical disagreements the record wins; HANDOFF is what gets
   corrected.

---

## Rules (all workflows)

- Absolute dates everywhere ("2026-07-08", never "today"/"recently"), read from
  a real `date` call.
- NEVER invent history, data, or numbers. Unsure whether something happened →
  leave it out or mark it explicitly uncertain.
- Append-only means append-only. The record's front-matter TOC/digest may gain
  lines; dated entries are immutable.
- HTML twins and the record index are script-generated only.
- Cadence misses are logged, not hidden ("cadence missed by N prompts").
- Structure from `/project-memory`'s templates; content from this project.
- **Raw exit codes, nothing piped.** `node script.js | tail` reports `tail`'s
  exit code, not the script's — redirect to a file and echo `$?`.
- Anything needing the owner's accounts, keys, or purchases is marked
  BLOCKED-ON-OWNER and reported, never worked around or stubbed.

## What this skill does NOT own

| Want | Go to |
|---|---|
| Set the system up in a new project | `/project-memory` §1 BOOTSTRAP |
| Write a PRD, or execute its next task | `/project-memory` §4 |
| Codebase-memory bins and their DIRECTORY | `/project-memory` §5 |
| Cadence hook config | `/project-memory` §0 |
| Are the docs TRUE? (findings, no edits) | `/audit-docs` |
| Did my change land where it executes? | `/landing-check` |

## ASCII-only markdown (rule added 2026-09-23)

Every `.md` file this skill creates or writes to gets ASCII characters only
(bytes 0x00-0x7F) in the text you add. No exceptions for headings, tables,
quotes, names or pasted tool output.

- Dashes: `-` (never an en or em dash). Arrows: `->` and `<-`. Quotes:
  straight `"` and `'`. Ellipsis: `...`. Math: `x`, `+/-`, `<=`, `>=`, `~`.
  Separators: `-`, `;` or `|`. No emoji, no check-mark glyphs (use `[x]` and
  `[ ]`), no accented letters: transliterate names and quoted text.
- Check before saving. In a git repo,
  `git diff -U0 -- <file> | grep -v '^+++' | grep '^+' | grep -nP '[^\x00-\x7F]'`
  must print nothing. For a new or untracked file,
  `grep -nP '[^\x00-\x7F]' <file>` must print nothing.
- Leave non-ASCII in text you did not write. Earlier entries of an
  append-only record stay byte for byte; converting an existing file is a
  separate, explicit job.
