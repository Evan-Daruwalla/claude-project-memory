#!/usr/bin/env node
/*
 * project-memory — deterministic cadence hook (UserPromptSubmit).
 *
 * Counts prompts per project and, on every Nth, injects a reminder into
 * Claude's context to run the matching /project-memory subpart. The COUNTING
 * and INJECTION are deterministic; obeying the reminder is still the model's
 * job (a hook cannot invoke a skill).
 *
 * State + config: <project>/.claude/pm-cadence.json (project found via the
 * `cwd` field on the hook's stdin JSON, falling back to process.cwd()).
 * If that file is absent, the project hasn't been set up — exit silently, so
 * one global registration stays dormant everywhere until a project opts in.
 *
 * Config schema (numbers are "remind every N prompts"; 0 / missing = off):
 *   { "record_entry": 3, "handoff": 0, "prd_next_task": 0, "bins": 0,
 *     "_count": 0, "_last_reminder_iso": null }
 *
 * stdout on UserPromptSubmit is injected as context for Claude. stderr shows
 * to the user in the terminal. Always exit 0 — a hook error must never block
 * the user's prompt.
 *
 * Register in settings.json (global ~/.claude or a project .claude):
 *   "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command",
 *     "command": "node \"<abs path to this file>\"", "timeout": 5000 } ] } ] }
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LABELS = {
  record_entry: "append a timestamped record entry (/project-memory §2)",
  handoff: "run the end-of-session handoff sync (/project-memory §3)",
  prd_next_task: "execute the next PRD task (/project-memory §4)",
  bins: "update the codebase-memory bins (/project-memory §5)",
};

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  let cwd = process.cwd();
  const raw = readStdin();
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j.cwd === "string" && j.cwd) cwd = j.cwd;
    } catch {
      /* ignore malformed stdin, fall back to process.cwd() */
    }
  }

  const cfgPath = path.join(cwd, ".claude", "pm-cadence.json");
  if (!fs.existsSync(cfgPath)) return 0; // project not set up — stay dormant

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (!cfg || typeof cfg !== "object") return 0;
  } catch {
    return 0; // corrupt config — never block the prompt
  }

  const count = (parseInt(cfg._count, 10) || 0) + 1;
  cfg._count = count;

  const due = [];
  for (const key of Object.keys(LABELS)) {
    const n = parseInt(cfg[key], 10);
    if (n > 0 && count % n === 0) due.push(LABELS[key]);
  }

  if (due.length) {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    cfg._last_reminder_iso = nowIso;
    process.stdout.write(
      `[PM-CADENCE] Prompt #${count} — cadence hit. Before continuing with ` +
        `the user's request, ${due.join("; and ")}. Then proceed. (${nowIso})\n`
    );
  }

  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    /* best-effort; a failed write just means the next prompt recounts */
  }
  return 0;
}

process.exit(main());
