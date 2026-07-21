# Profile: research project — extra records to retain

Addon to the standard doc set for research-class projects
(experiments, quantitative studies, model evaluations). Distilled from Schreier,
Wilson & Resnik, "Academic Research Record-Keeping" (Acad Med 2006, PMC3943904),
individual-researcher tier — group-leader and institutional tiers are N/A solo
(2026-07-21). The record system already implements most of List 1 (append-only,
dated, failures kept); this profile is the DELTA.

## Before running anything: the protocol record
- A dated pre-run note per experiment: hypothesis, method, parameters, and the
  success metric — written BEFORE results exist. Kills post-hoc rationalization
  and makes a negative result a result. (PRD tasks partially cover this; a
  one-paragraph record entry is enough.)

## Data provenance (every dataset touched)
- Source, version/date retrieved, license/terms, and the adjustment basis —
  e.g. a price cache's adjustment basis; that class of fact lives in the
  `data` bin and every writer honors it.

## Analysis & manipulation records — mechanized, point don't prose
- Exact run provenance (inputs hashed, versions, exit, git state) →
  `experiment-log` (JSONL, append-only).
- Frozen expected outputs / regression baselines → `golden-lock`
  (frozen-regression discipline: any drift is a failing diff).
- Unseeded-randomness sweep before any frozen run → `seed-control`;
  stability proof → `determinism-guard`.

## Interpretation & decisions
- Interpretations of results: dated record entries — including the wrong
  interpretations later superseded (append-only keeps them; that's the point).
- Decisions with reasons → `decision-log` line + record entry for big ones.

## Retention & reproduction
- Keep enough to re-derive any number you might later publish or put in a
  portfolio: raw data (or its provenance row), the exact code version (commit
  hash), and the run's experiment-log line. any downstream
  case-study/publication claim must be able to cite these or it gets cut.
- IP witnessing / countersigning — N/A unless patent intent exists.
