#!/usr/bin/env node
/*
 * project-memory — deterministic first-invocation cadence auto-init.
 *
 * PreToolUse hook matched on the `Skill` tool. Fires for EVERY skill
 * invocation (the matcher can't filter by skill name), so this script exits
 * silently unless tool_input.skill === "project-memory".
 *
 * Purpose: pm-cadence.js (the UserPromptSubmit counter) only works once
 * `.claude/pm-cadence.json` exists — and until now, creating that file relied
 * on the model reading SKILL.md §0 and remembering to check. A cheaper model
 * skips that and cadence silently never gets configured. This hook removes
 * that dependency: it deterministically creates the config with defaults the
 * moment project-memory is first invoked in a project, no model step
 * required. The model's only remaining job is to notice the injected context
 * below and ask the user if they want different numbers than the defaults.
 *
 * Skip conditions (no config created):
 *   - tool_input.skill !== "project-memory"
 *   - .claude/pm-cadence.json already exists
 *   - the cwd carries no PROJECT MARKER (see PROJECT_MARKERS). Without this
 *     the hook happily seeds a counter in whatever directory the session was
 *     opened in — including a parent folder that merely CONTAINS projects,
 *     which then accumulates prompts belonging to no project while each real
 *     project undercounts. Observed live: a container dir reached _count 72.
 *   - the project's own .claude/settings.json already registers a
 *     UserPromptSubmit hook (assume it runs its own cadence mechanism —
 *     this lets a project with a pre-existing cadence hook avoid a
 *     double-fire, without hardcoding any project by name)
 *
 * Output: structured JSON on stdout per the PreToolUse hook contract, adding
 * additionalContext when (and only when) a config was just auto-created.
 * Always exits 0 — a hook error must never block the tool call.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  record_entry: 3,
  handoff: 0,
  prd_next_task: 0,
  bins: 0,
  _count: 0,
  _last_reminder_iso: null,
  _auto_created: true,
};

// A directory only counts as a project if it carries one of these. A parent
// folder that merely CONTAINS projects has none of them, so it never gets a
// counter. Deliberately broad: a VCS root, this doc system's own artifacts, an
// agent-instruction file, or any common language manifest.
const PROJECT_MARKERS = [
  ".git",
  "HANDOFF.md",
  "PRD_ROADMAP.md",
  "CLAUDE.md",
  "package.json",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "Gemfile",
  "composer.json",
];

function projectMarker(cwd) {
  for (const m of PROJECT_MARKERS) {
    try { if (fs.existsSync(path.join(cwd, m))) return m; } catch { /* keep looking */ }
  }
  return null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function hasOwnCadenceHook(cwd) {
  const p = path.join(cwd, ".claude", "settings.json");
  if (!fs.existsSync(p)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const hooks = cfg && cfg.hooks && cfg.hooks.UserPromptSubmit;
    return Array.isArray(hooks) && hooks.length > 0;
  } catch {
    return false; // corrupt/unreadable settings.json — don't assume a hook exists
  }
}

function emit(additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
  if (additionalContext) out.hookSpecificOutput.additionalContext = additionalContext;
  process.stdout.write(JSON.stringify(out) + "\n");
}

function main() {
  const raw = readStdin();
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return 0; // malformed input — allow silently, nothing to do
  }

  const skill = j && j.tool_input && j.tool_input.skill;
  if (skill !== "project-memory") return 0; // not our skill, stay silent

  const cwd = (j && j.cwd) || process.cwd();
  const cfgPath = path.join(cwd, ".claude", "pm-cadence.json");

  if (fs.existsSync(cfgPath)) return 0; // already configured
  if (hasOwnCadenceHook(cwd)) return 0; // project runs its own mechanism

  // No project marker => this is probably a parent folder that CONTAINS
  // projects, not a project. Seeding a counter here would collect prompts that
  // belong to no project while every real project undercounts. Say so rather
  // than skipping silently — a dormant cadence with no explanation is the
  // failure mode this hook exists to prevent.
  if (!projectMarker(cwd)) {
    emit(
      "[PM-CADENCE] No cadence config was auto-created here: " + cwd + " carries " +
        "no project marker (.git, HANDOFF.md, PRD_ROADMAP.md, CLAUDE.md, or a " +
        "language manifest), so it looks like a folder that CONTAINS projects " +
        "rather than a project. Re-run from the project directory, or — if this " +
        "IS the project — bootstrap it (/project-memory §1) or create " +
        ".claude/pm-cadence.json by hand, and cadence starts on the next prompt."
    );
    return 0;
  }

  try {
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(DEFAULTS, null, 2) + "\n");
  } catch {
    return 0; // couldn't write — fail open, no context injected
  }

  emit(
    "[PM-CADENCE] No cadence config existed for this project — auto-created " +
      "defaults at .claude/pm-cadence.json (record_entry: every 3 prompts; " +
      "handoff/prd_next_task/bins: event-driven, not prompt-counted). Before " +
      "proceeding with the user's project-memory request, ask if they want " +
      "different numbers for any subpart, and update the file if so."
  );
  return 0;
}

// self-test: this hook CREATES the cadence config, so a silent break means a
// project never starts counting at all.
function runCanary() {
  const os = require("os");
  const { spawnSync } = require("child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pmauto-canary-"));
  let pass = 0, fail = 0;
  const check = (c, d) => { if (c) pass++; else { fail++; console.log("  FAIL: " + d); } };
  const fire = (cwd, skill) => spawnSync(process.execPath, [__filename], {
    input: JSON.stringify({ cwd, tool_input: { skill: skill === undefined ? "project-memory" : skill } }),
    encoding: "utf8",
  });
  try {
    const proj = path.join(root, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "HANDOFF.md"), "# Handoff\n"); // project marker
    const cfg = path.join(proj, ".claude", "pm-cadence.json");

    let r = fire(proj);
    check(fs.existsSync(cfg), "creates .claude/pm-cadence.json on a project-memory invocation");
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(cfg, "utf8")); } catch { /* stays null */ }
    check(parsed !== null, "the file it writes is valid JSON");
    check(parsed && parsed.record_entry === 3, "seeds record_entry: 3");
    check(/PM-CADENCE/.test(r.stdout || ""), "announces the auto-creation");

    const before = fs.readFileSync(cfg, "utf8");
    r = fire(proj);
    check(fs.readFileSync(cfg, "utf8") === before, "never overwrites an existing config");
    check((r.stdout || "").indexOf("additionalContext") === -1, "stays quiet once configured");

    const bare = path.join(root, "bare");
    fs.mkdirSync(bare);
    fire(bare, "some-other-skill");
    check(!fs.existsSync(path.join(bare, ".claude", "pm-cadence.json")),
      "another skill does not create a config");

    // a folder that CONTAINS projects is not a project: no marker, no counter
    const container = path.join(root, "container");
    fs.mkdirSync(path.join(container, "someproject"), { recursive: true });
    fs.writeFileSync(path.join(container, "someproject", "HANDOFF.md"), "# Handoff\n");
    r = fire(container);
    check(!fs.existsSync(path.join(container, ".claude", "pm-cadence.json")),
      "marker-less container dir gets NO counter");
    check(/no project marker/.test(r.stdout || ""),
      "and says why, rather than skipping silently");

    // every marker in the list must actually be recognised
    let markersOk = true;
    for (const m of PROJECT_MARKERS) {
      const d = path.join(root, "m-" + m.replace(/[^\w]/g, "_"));
      fs.mkdirSync(d, { recursive: true });
      if (m === ".git") fs.mkdirSync(path.join(d, ".git"));
      else fs.writeFileSync(path.join(d, m), "x");
      fire(d);
      if (!fs.existsSync(path.join(d, ".claude", "pm-cadence.json"))) {
        markersOk = false;
        console.log("    marker not honoured: " + m);
      }
    }
    check(markersOk, `all ${PROJECT_MARKERS.length} project markers are honoured`);

    r = spawnSync(process.execPath, [__filename], { input: "not json", encoding: "utf8" });
    check(r.status === 0, "malformed stdin never blocks the tool call");

    const ok = fail === 0;
    console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
    return ok;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
process.exit(main());
