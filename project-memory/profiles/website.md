# Profile: website / app project — extra records to retain

Addon to the standard doc set (HANDOFF / record / PRD / bins) for projects that
ship a public website or app (a public-facing product). Consult at bootstrap and at
launch-gate audits. Adapted from standard PM/records practice for a solo builder — agency artifacts are stubbed N/A, not silently dropped.

## Initiation & strategy
- Project charter/brief (goals, audience, budget) — COVERED: HANDOFF.md Goal
  section. No separate file.
- Brand/style guide (voice, type, palette, motion) — COVERED: `ui.md` bin.
- Stakeholder register — N/A solo project.
- Signed contracts / SOWs — N/A solo, no clients.

## Design & development artifacts (keep in `docs/design/`, dated)
- Wireframes, mockups, prototypes — retain the approved versions, dated.
- Asset inventory — copy, imagery, fonts, multimedia, WITH LICENSE per asset
  (an unlicensed hero image is a launch-blocker class problem).
- Redirect map — REQUIRED on any URL restructure: old URL
  → new URL, one row each. SEO + bookmark continuity; cheap now, impossible to
  reconstruct later.
- Change orders — N/A as a document; the PRD fork/strike mechanism IS the
  scope-change log.

## QA & operations
- Bug/QA logs — record entries (symptom → root cause → fix) + the tracker.
- Maintenance evidence — scheduled-task health via `cron-task-manage` audits;
  backup validity via backup-restore drill outputs. Keep the run outputs, not
  prose claims.

## Compliance & retention (LOAD-BEARING for sites holding personal or minors' data)
- **Archived policy snapshots** — EVERY published version of the privacy
  policy / ToS, with effective dates. The question "what did the policy say
  when this student (or guardian) consented" must be answerable byte-exactly.
  Snapshot BEFORE each policy change goes live.
- **Consent-capture evidence** — proof any consent flow (guardian consent for minors
  especially) captured what it claims, at launch and after changes.
- **Accessibility evidence at launch** — the actual WCAG audit output, dated,
  not a claim of compliance. NEVER assert legal compliance status — retain the
  evidence, let counsel/adults judge (escalate legal judgment to qualified adults).
- **Content snapshots of prior site iterations** — archive before major
  redesigns; substantive-policy pages especially.
