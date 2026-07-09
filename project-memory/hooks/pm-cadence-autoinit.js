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

process.exit(main());
