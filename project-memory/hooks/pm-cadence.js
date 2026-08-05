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

// must match pm-cadence-autoinit.js's DEFAULTS — used only to recover from an
// unreadable config, never to create one (autoinit owns creation).
const DEFAULTS = {
  record_entry: 3,
  handoff: 0,
  prd_next_task: 0,
  bins: 0,
  _count: 0,
  _last_reminder_iso: null,
};

// nearest ancestor (inclusive) holding .claude/pm-cadence.json, else null
function findConfig(startDir) {
  let dir;
  try { dir = path.resolve(startDir); } catch { return null; }
  for (;;) {
    const p = path.join(dir, ".claude", "pm-cadence.json");
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

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

  // Walk UP to the nearest ancestor holding the config: a session opened in a
  // subdirectory of the project (scripts/, src/) would otherwise find nothing
  // and stay dormant, silently under-counting that project's cadence.
  const cfgPath = findConfig(cwd);
  if (!cfgPath) return 0; // project not set up — stay dormant

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (!cfg || typeof cfg !== "object") throw new Error("not an object");
  } catch (e) {
    // A truncated/corrupt config used to kill the cadence PERMANENTLY and
    // silently: this returned 0 forever, and autoinit refuses to recreate a
    // file that exists. Keep the damaged file, say so, and resume on defaults.
    try { fs.copyFileSync(cfgPath, cfgPath + ".corrupt"); } catch { /* best effort */ }
    process.stderr.write(
      `[PM-CADENCE] ${cfgPath} is unreadable (${e.message}); kept a copy as ` +
        `pm-cadence.json.corrupt and reset to defaults. Cadence counting restarts at 0.\n`
    );
    cfg = { ...DEFAULTS };
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
    // write+rename, never a bare write: the hook has a hard timeout, and a kill
    // mid-write leaves truncated JSON that bricks the cadence. rename() is
    // atomic on the same filesystem, so it also serializes concurrent sessions.
    const tmp = cfgPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
    fs.renameSync(tmp, cfgPath);
  } catch {
    /* best-effort; a failed write just means the next prompt recounts */
  }
  return 0;
}

// self-test: this hook fires on EVERY prompt, so a silent break is expensive.
function runCanary() {
  const os = require("os");
  const { spawnSync } = require("child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pmcad-canary-"));
  let pass = 0, fail = 0;
  const check = (c, d) => { if (c) pass++; else { fail++; console.log("  FAIL: " + d); } };
  const fire = (cwd) => spawnSync(process.execPath, [__filename], {
    input: JSON.stringify({ cwd }), encoding: "utf8",
  });
  try {
    const proj = path.join(root, "proj");
    const deep = path.join(proj, "src", "deep");
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    fs.mkdirSync(deep, { recursive: true });
    const cfg = path.join(proj, ".claude", "pm-cadence.json");
    const read = () => JSON.parse(fs.readFileSync(cfg, "utf8"));

    fs.writeFileSync(cfg, JSON.stringify({ ...DEFAULTS }));
    let r;
    for (let i = 0; i < 3; i++) r = fire(deep);
    check(read()._count === 3, "counts a session started in a SUBdirectory (ancestor config)");
    check(/PM-CADENCE/.test(r.stdout || ""), "reminder fires on the Nth prompt");
    check(!fs.existsSync(cfg + ".tmp"), "atomic write leaves no .tmp behind");

    fs.writeFileSync(cfg, '{"record_entry":3,"_cou');
    r = fire(proj);
    check(fs.existsSync(cfg + ".corrupt"), "corrupt config is preserved, not discarded");
    let valid = false;
    try { read(); valid = true; } catch { /* stays false */ }
    check(valid, "corrupt config is rewritten to valid defaults (cadence resumes)");
    check(/PM-CADENCE/.test(r.stderr || ""), "corruption is announced, not swallowed");

    const bare = path.join(root, "bare");
    fs.mkdirSync(bare);
    r = fire(bare);
    check((r.stdout || "") === "" && r.status === 0, "no config in any ancestor -> silent, exit 0");

    r = spawnSync(process.execPath, [__filename], { input: "not json", encoding: "utf8" });
    check(r.status === 0, "malformed stdin never blocks the prompt");

    const ok = fail === 0;
    console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
    return ok;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
process.exit(main());
