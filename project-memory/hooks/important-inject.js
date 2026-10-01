#!/usr/bin/env node
/*
 * important-inject - put a project's important.md in front of the model.
 *
 * WHAT: injects the current project's `important.md` (the few facts that must
 * never be missed) into the model's context, ONCE per project per session.
 * important.md lives in the project's bins directory (see pm-cadence.js
 * findBinsDir: cfg.bins_dir, else .claude/project-memory, else the legacy
 * .claude/codebase-memory, then one level of subdirectories).
 *
 * WHY: a critical fact that sits in a bin nobody opens is a fact that gets
 * missed. Sessions often start OUTSIDE any project (a workspace root, a home
 * directory) and only move into a project later, so a SessionStart-only hook
 * would never fire for them. This hook therefore runs on SessionStart AND on
 * every UserPromptSubmit, re-resolves the project from the cwd each time, and
 * injects once per project per session. SessionStart (any source: startup,
 * resume, clear, compact) resets the session's record, so a compacted or
 * cleared context gets the file again.
 *
 * Behaviour:
 *   - project root = nearest ancestor of cwd (inclusive) that holds
 *     .claude/pm-cadence.json OR DIRECT bins (.claude/project-memory, or the
 *     legacy .claude/codebase-memory); no project -> prints nothing. A folder
 *     that merely CONTAINS projects is not itself a project. The one-level-down
 *     bins search runs only after a root was found through its config.
 *   - important.md present -> a header line, then the file (capped at
 *     MAX_LINES lines or MAX_CHARS chars, whichever comes first, with a notice).
 *   - bins present but no important.md -> a one-line "create it" notice.
 *   - plain stdout is the context-injection channel. Always exits 0: a hook
 *     must never block a prompt. Errors go to stderr as one line.
 *
 * Escape hatch: IMPORTANT_INJECT_OFF=1 in the environment -> prints nothing.
 *
 * Reuses findBinsDir from pm-cadence.js (same directory), so the two hooks can
 * never disagree about where the bins are.
 *
 * State: <state dir>/<safe session id>.json = {"injected": [<paths>]}, one path
 * per important.md injected (the bins dir itself when important.md is missing),
 * so two roots that resolve to the same bins inject once.
 * The state dir is ~/.claude/state/important-inject, overridable with
 * IMPORTANT_INJECT_STATE_DIR (the canary uses that). State files older than 7
 * days are deleted whenever state is written.
 *
 * Register (global ~/.claude/settings.json), on both events:
 *   "SessionStart":     [ { "hooks": [ { "type": "command",
 *       "command": "node \"<abs path to this file>\"", "timeout": 5000 } ] } ]
 *   "UserPromptSubmit": [ { "hooks": [ { "type": "command",
 *       "command": "node \"<abs path to this file>\"", "timeout": 5000 } ] } ]
 *
 * Self-test: node important-inject.js --canary
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { findBinsDir } = require("./pm-cadence.js");

const MAX_LINES = 200;
const MAX_CHARS = 16000;
const STATE_MAX_AGE_MS = 7 * 86400000;
const TRUNC_NOTICE =
  "[IMPORTANT] truncated at the injection cap - move detail into other bins " +
  "and keep a one-line pointer in important.md.";

const stateDir = () =>
  process.env.IMPORTANT_INJECT_STATE_DIR ||
  path.join(os.homedir(), ".claude", "state", "important-inject");

// ids come from the hook payload: never let one steer the path
const stateFileFor = (sid) =>
  path.join(stateDir(), String(sid || "nosession").replace(/[^A-Za-z0-9_-]/g, "_") + ".json");

// Windows paths differ by drive-letter case only; compare without it
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function parseInput(raw) {
  try {
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

// Same folder names as pm-cadence.js's BIN_DIR_NAMES (not exported there).
const DIRECT_BIN_NAMES = ["project-memory", "codebase-memory"];

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// First ancestor (inclusive) that is a project root: it has a cadence config,
// or DIRECT bins (<dir>/.claude/project-memory or the legacy codebase-memory).
// findBinsDir's one-level-down search is NOT a root test: a workspace folder
// that merely contains projects would otherwise count as one itself. It is only
// used to LOCATE the bins once a root was found through its config (a project
// whose config sits at the top and whose bins sit in a subfolder). A damaged
// config still marks a root; findBinsDir then just sees {}.
function resolveProject(cwd) {
  let dir;
  try { dir = path.resolve(cwd); } catch { return null; }
  for (;;) {
    const cfgFile = path.join(dir, ".claude", "pm-cadence.json");
    if (fs.existsSync(cfgFile)) {
      let cfg = {};
      try {
        const j = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
        if (j && typeof j === "object") cfg = j;
      } catch { /* unreadable config: still a root, defaults apply */ }
      return { root: dir, bins: findBinsDir(dir, cfg) };
    }
    const direct = DIRECT_BIN_NAMES.map((n) => path.join(dir, ".claude", n)).find(isDir);
    if (direct) return { root: dir, bins: direct };
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

function loadState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && Array.isArray(j.injected)) {
      return { injected: j.injected.filter((p) => typeof p === "string") };
    }
  } catch { /* missing or corrupt: start empty */ }
  return { injected: [] };
}

function pruneOld(dir) {
  const cutoff = Date.now() - STATE_MAX_AGE_MS;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!/\.(json|tmp)$/.test(n)) continue;
    const p = path.join(dir, n);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

// write+rename so a kill mid-write never leaves truncated JSON
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + "\n");
  fs.renameSync(tmp, file);
  pruneOld(path.dirname(file));
}

function buildOutput(root, bins) {
  const name = path.basename(root) || root;
  const file = path.join(bins, "important.md");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return `[IMPORTANT] ${name}: this project has project-memory bins but no ` +
        `important.md - create it (project-memory skill, section 5).\n`;
    }
    throw e;
  }
  const lines = (raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw).replace(/\s+$/, "").split(/\r?\n/);
  let shown = lines.slice(0, MAX_LINES).join("\n");
  const cut = lines.length > MAX_LINES || shown.length > MAX_CHARS;
  if (shown.length > MAX_CHARS) {
    shown = shown.slice(0, MAX_CHARS);
    // end on a whole line: half of a "never do X" is worse than none of it
    const nl = shown.lastIndexOf("\n");
    if (nl > 0) shown = shown.slice(0, nl);
  }
  return `[IMPORTANT - ${name}] (from ${file}; CLAUDE.md wins on conflict)\n` +
    `${shown}\n` + (cut ? TRUNC_NOTICE + "\n" : "");
}

function main(input) {
  if (process.env.IMPORTANT_INJECT_OFF === "1") return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const sid = typeof input.session_id === "string" && input.session_id ? input.session_id : "nosession";
  const stateFile = stateFileFor(sid);

  let state;
  if (input.hook_event_name === "SessionStart") {
    state = { injected: [] };
    // a failed reset must not stop the injection; the save after injecting
    // reports a persistent failure
    try { saveState(stateFile, state); } catch { /* reported below if it persists */ }
  } else {
    state = loadState(stateFile);
  }

  const proj = resolveProject(cwd);
  if (!proj || !proj.bins) return;
  // keyed by the file (or the bins dir when the file is missing), not by the
  // root: a config root and a nested project can resolve to the same bins
  const file = path.join(proj.bins, "important.md");
  const injectedPath = fs.existsSync(file) ? file : proj.bins;
  const key = norm(injectedPath);
  if (state.injected.some((p) => norm(p) === key)) return;

  process.stdout.write(buildOutput(proj.root, proj.bins));
  state.injected.push(injectedPath);
  saveState(stateFile, state);
}

// self-test: runs on every prompt, so a silent break is expensive.
function runCanary() {
  const { spawnSync } = require("child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "important-canary-"));
  const stateDirPath = path.join(root, "state");
  let pass = 0, fail = 0;
  const check = (c, d) => { if (c) pass++; else { fail++; console.log("  FAIL: " + d); } };
  const baseEnv = { ...process.env, IMPORTANT_INJECT_STATE_DIR: stateDirPath };
  delete baseEnv.IMPORTANT_INJECT_OFF;
  const run = (input, extraEnv) => spawnSync(process.execPath, [__filename], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8", env: { ...baseEnv, ...(extraEnv || {}) }, cwd: root,
  });
  const prompt = (sid, cwd, extraEnv) =>
    run({ session_id: sid, hook_event_name: "UserPromptSubmit", cwd }, extraEnv);
  const start = (sid, cwd, source) =>
    run({ session_id: sid, hook_event_name: "SessionStart", source, cwd });
  const mk = (...parts) => { const d = path.join(root, ...parts); fs.mkdirSync(d, { recursive: true }); return d; };
  const put = (dir, text) => fs.writeFileSync(path.join(dir, "important.md"), text);
  const out = (r) => r.stdout || "";
  try {
    // 1-4: once per project per session; SessionStart resets
    const p1 = path.join(root, "proj1");
    put(mk("proj1", ".claude", "project-memory"), "# critical\nSENTINEL-ALPHA never delete the data dir\n");
    const p2 = path.join(root, "proj2");
    put(mk("proj2", ".claude", "project-memory"), "SENTINEL-BETA\n");

    let r = prompt("s1", p1);
    check(out(r).includes("[IMPORTANT - proj1]") && out(r).includes("SENTINEL-ALPHA") &&
      out(r).includes("CLAUDE.md wins on conflict") &&
      out(r).includes(path.join(p1, ".claude", "project-memory", "important.md")),
      `1: first prompt injects header + file (got: ${out(r).slice(0, 200)})`);
    check(r.status === 0, "1: exit 0");

    r = prompt("s1", p1);
    check(out(r) === "", `2: second prompt, same session + root -> silent (got: ${out(r).slice(0, 100)})`);

    r = prompt("s1", p2);
    check(out(r).includes("[IMPORTANT - proj2]") && out(r).includes("SENTINEL-BETA"),
      "3: a second project root in the same session injects");
    check(out(prompt("s1", p1)) === "", "3: and the first root stays injected-once");

    r = start("s1", p1, "compact");
    check(out(r).includes("SENTINEL-ALPHA"), "4: SessionStart(compact) re-injects for the cwd root");
    check(out(prompt("s1", p1)) === "", "4: and a prompt right after is silent");
    check(out(prompt("s1", p2)).includes("SENTINEL-BETA"), "4: the reset also cleared the other root");
    check(out(start("s1", root, "startup")) === "", "4: SessionStart outside any project prints nothing");

    // 5: legacy folder name
    const pL = path.join(root, "projL");
    put(mk("projL", ".claude", "codebase-memory"), "SENTINEL-LEGACY\n");
    check(out(prompt("s-leg", pL)).includes("SENTINEL-LEGACY"), "5: legacy .claude/codebase-memory/important.md works");

    // 6: cfg.bins_dir, and a cwd in a subdirectory of the project
    const pC = path.join(root, "projC");
    put(mk("projC", "docs", "notes"), "SENTINEL-CFG\n");
    mk("projC", ".claude");
    fs.writeFileSync(path.join(pC, ".claude", "pm-cadence.json"), JSON.stringify({ bins_dir: "docs/notes" }));
    mk("projC", "src", "deep");
    check(out(prompt("s-cfg", pC)).includes("SENTINEL-CFG"), "6: cfg bins_dir docs/notes works");
    check(out(prompt("s-cfg2", path.join(pC, "src", "deep"))).includes("[IMPORTANT - projC]"),
      "6: a cwd below the project root resolves to the root");

    // 7: bins but no important.md
    const pN = path.join(root, "projN");
    mk("projN", ".claude", "project-memory");
    r = prompt("s-none", pN);
    check(out(r) ===
      "[IMPORTANT] projN: this project has project-memory bins but no important.md - create it (project-memory skill, section 5).\n",
      `7: no important.md -> the one-line create-it notice (got: ${out(r).slice(0, 200)})`);
    check(out(prompt("s-none", pN)) === "", "7: the notice is also once per session");

    // 8: cap. 300 lines -> 200 + notice; 150 lines -> whole; long lines -> char cap
    const NOTICE_RE = /\[IMPORTANT\] truncated at the injection cap - move detail into other bins and keep a one-line pointer in important\.md\./;
    const factLines = (n) => Array.from({ length: n }, (_, i) => `fact line ${i + 1}`).join("\n") + "\n";
    const countFacts = (s) => s.split("\n").filter((l) => /^fact line \d+$/.test(l)).length;
    const pBig = path.join(root, "projBig");
    put(mk("projBig", ".claude", "project-memory"), factLines(300));
    r = prompt("s-big", pBig);
    check(countFacts(out(r)) === 200 && NOTICE_RE.test(out(r)),
      `8: a 300-line file is cut to 200 content lines plus the notice (got ${countFacts(out(r))} lines)`);
    const pMid = path.join(root, "projMid");
    put(mk("projMid", ".claude", "project-memory"), factLines(150));
    r = prompt("s-mid", pMid);
    check(countFacts(out(r)) === 150 && !/truncated/.test(out(r)), "8: a 150-line file is injected whole, no notice");
    const pExact = path.join(root, "projExact");
    put(mk("projExact", ".claude", "project-memory"), factLines(200));
    r = prompt("s-exact", pExact);
    check(countFacts(out(r)) === 200 && !/truncated/.test(out(r)), "8: exactly 200 lines is not truncated");
    const pLong = path.join(root, "projLong");
    put(mk("projLong", ".claude", "project-memory"),
      Array.from({ length: 50 }, (_, i) => `L${i} ${"x".repeat(490)}`).join("\n") + "\n");
    r = prompt("s-long", pLong);
    const longLines = out(r).split("\n").filter((l) => /^L\d+ x+$/.test(l));
    check(longLines.length > 0 && longLines.length < 50 && longLines.join("\n").length <= MAX_CHARS &&
      longLines.every((l) => /x{490}$/.test(l)) && NOTICE_RE.test(out(r)),
      `8: the char cap cuts on a whole line and adds the notice (kept ${longLines.length} lines, ${longLines.join("\n").length} chars)`);

    // a leading BOM in important.md is not echoed into the context
    const bomChar = String.fromCharCode(0xFEFF);
    const pBom = path.join(root, "projBom");
    put(mk("projBom", ".claude", "project-memory"), bomChar + "SENTINEL-BOM\n");
    r = prompt("s-bom", pBom);
    check(out(r).includes("SENTINEL-BOM") && !out(r).includes(bomChar), "8: a leading BOM is stripped");

    // 9: no project anywhere up the tree. `root` itself CONTAINS projects (one
    // level down) but is not one: a folder that only holds projects must stay silent.
    r = prompt("s-bare", root);
    check(out(r) === "" && r.status === 0,
      `9: no project up the tree -> silent, exit 0 (got: ${out(r).slice(0, 200)}; stderr: ${(r.stderr || "").slice(0, 100)})`);

    // 9b: a parent whose CHILD has bins, with neither bins nor a config itself
    const ws = path.join(root, "ws");
    const child = path.join(ws, "childA");
    put(mk("ws", "childA", ".claude", "project-memory"), "SENTINEL-CHILD\n");
    mk("ws", "childA", "src");
    r = prompt("s-ws", ws);
    check(out(r) === "" && r.status === 0,
      `9b: a parent folder of a project is not a project (got: ${out(r).slice(0, 200)})`);
    // 9c: and a cwd inside the child still resolves to the child
    r = prompt("s-ws", path.join(child, "src"));
    check(out(r).includes("[IMPORTANT - childA]") && out(r).includes("SENTINEL-CHILD"),
      `9c: a cwd inside the child project injects the child (got: ${out(r).slice(0, 200)})`);
    // 9d: config at the top, bins one level down: still found (config-found roots keep the nested search)
    const cz = path.join(root, "citadel");
    put(mk("citadel", "citadel-v2", ".claude", "project-memory"), "SENTINEL-NESTED\n");
    mk("citadel", ".claude");
    fs.writeFileSync(path.join(cz, ".claude", "pm-cadence.json"), "{}\n");
    r = prompt("s-cz", cz);
    check(out(r).includes("[IMPORTANT - citadel]") && out(r).includes("SENTINEL-NESTED"),
      `9d: config at the root + bins one level down injects (got: ${out(r).slice(0, 200)})`);
    // 9f: two roots that resolve to the SAME bins (config root, then the nested
    // project itself) inject once per session, in either order
    r = prompt("s-cz", path.join(cz, "citadel-v2"));
    check(out(r) === "" && r.status === 0,
      `9f: the nested project after its config root is silent (got: ${out(r).slice(0, 200)})`);
    r = prompt("s-cz-rev", path.join(cz, "citadel-v2"));
    check(out(r).includes("SENTINEL-NESTED"), "9f: nested project first injects");
    check(out(prompt("s-cz-rev", cz)) === "", "9f: and its config root after it is silent");
    // the same holds when important.md is missing (keyed by the bins dir)
    const cy = path.join(root, "citadel-empty");
    mk("citadel-empty", "inner", ".claude", "project-memory");
    mk("citadel-empty", ".claude");
    fs.writeFileSync(path.join(cy, ".claude", "pm-cadence.json"), "{}\n");
    check(/no important\.md/.test(out(prompt("s-cy", cy))), "9f: missing important.md -> notice from the config root");
    r = prompt("s-cy", path.join(cy, "inner"));
    check(out(r) === "", `9f: and not again from the nested project (got: ${out(r).slice(0, 200)})`);
    // case-insensitive on Windows only
    if (process.platform === "win32") {
      check(out(prompt("s-case", cz)).includes("SENTINEL-NESTED") &&
        out(prompt("s-case", cz.toUpperCase())) === "", "9f: Windows paths compare case-insensitively");
    }
    // 9e: a config with no bins anywhere is a root with nothing to inject: silent, and it
    // does not fall through to a project further up
    // (fixture: a nested config-only project inside p1, which has bins of its own)
    const cn = path.join(p1, "sub");
    mk("proj1", "sub", ".claude");
    fs.writeFileSync(path.join(cn, ".claude", "pm-cadence.json"), "{}\n");
    r = prompt("s-cn", cn);
    check(out(r) === "" && r.status === 0, `9e: a config-only root with no bins is silent (got: ${out(r).slice(0, 200)})`);

    // 10: escape hatch
    r = prompt("s-off", p1, { IMPORTANT_INJECT_OFF: "1" });
    check(out(r) === "" && r.status === 0, "10: IMPORTANT_INJECT_OFF=1 -> silent");
    check(!fs.existsSync(path.join(stateDirPath, "s-off.json")), "10: and it leaves no state behind");

    // 11: malformed or empty stdin never blocks (falls back to the spawn cwd, `root`, which is not a project)
    r = run("not json");
    check(r.status === 0 && out(r) === "", "11: malformed stdin -> exit 0, silent");
    r = run("");
    check(r.status === 0 && out(r) === "", "11: empty stdin -> exit 0, silent");
    r = run('{"cwd": 5, "session_id": ["x"]}');
    check(r.status === 0 && out(r) === "", "11: wrong-typed fields -> exit 0, silent");

    // 12: state is per session
    check(out(prompt("s2", p1)).includes("SENTINEL-ALPHA"), "12: a different session_id gets its own injection");

    // state files: safe names, nosession, pruning, error path
    prompt("../evil/..", p1);
    check(fs.readdirSync(stateDirPath).every((f) => /^[A-Za-z0-9_.-]+\.json$/.test(f)) &&
      !fs.existsSync(path.join(root, "evil")), "state: a hostile session_id cannot steer the state path");
    r = run({ hook_event_name: "UserPromptSubmit", cwd: p1 });
    check(out(r).includes("SENTINEL-ALPHA") && fs.existsSync(path.join(stateDirPath, "nosession.json")),
      "state: no session_id -> uses nosession");
    const old = path.join(stateDirPath, "ancient.json");
    fs.writeFileSync(old, "{}\n");
    const eightDays = new Date(Date.now() - 8 * 86400000);
    fs.utimesSync(old, eightDays, eightDays);
    prompt("s-prune", p2);
    check(!fs.existsSync(old), "state: files older than 7 days are pruned");
    check(fs.existsSync(path.join(stateDirPath, "s-prune.json")), "state: the current session's file survives pruning");
    const blocker = path.join(root, "state-is-a-file");
    fs.writeFileSync(blocker, "x\n");
    r = prompt("s-err", p1, { IMPORTANT_INJECT_STATE_DIR: path.join(blocker, "sub") });
    check(r.status === 0 && /^important-inject: error: /m.test(r.stderr || ""),
      `state: an unwritable state dir -> one stderr line, still exit 0 (stderr: ${(r.stderr || "").slice(0, 120)})`);

    const ok = fail === 0;
    console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
    return ok;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes("--canary")) {
    process.exitCode = runCanary() ? 0 : 1;
  } else {
    // exit 0 on every path, and no process.exit(): let stdout flush
    try {
      main(parseInput(readStdin()));
    } catch (e) {
      process.stderr.write(`important-inject: error: ${e && e.message ? e.message : e}\n`);
    }
  }
}
