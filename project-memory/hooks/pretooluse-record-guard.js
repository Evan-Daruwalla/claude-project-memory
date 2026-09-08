#!/usr/bin/env node
/*
 * project-memory — PreToolUse hook (matcher: Edit|Write).
 *
 * DENIES a direct Edit/Write to an append-only project record. The record's
 * `# Appendix X - ...` heading and its front-matter TOC line must be written
 * TOGETHER, under an O_EXCL lock, by append-record-entry.js. Writing the
 * heading alone breaks the TOC/heading-count invariant and can duplicate an
 * appendix letter.
 *
 * WHY THIS EXISTS. Twice on 2026-09-01 a writer hand-wrote a heading with no
 * TOC line — once the daily-audit scheduled task, once an ordinary interactive
 * session. A broken record BLOCKS EVERY SUBSEQUENT APPEND, and the invariant
 * was enforced ONLY at `git commit` time (hooks/pre-commit-record), so it sat
 * on disk until someone happened to try to commit. This moves the gate to the
 * moment of the write, and covers every writer rather than the one task that
 * was noticed.
 *
 * NOT the tool's fault: append-record-entry.js already locks (O_EXCL) and
 * publishes by temp-file + rename. Both incidents were hand-splices that never
 * took the lock. It is spawned via Bash and writes with fs, so it never
 * produces an Edit/Write tool call for this matcher to see.
 *
 * FAIL DIRECTION. Once the target is KNOWN to be a record, any internal error
 * DENIES — a false block is recoverable (use the script), a false allow
 * re-opens the corruption path. When the target CANNOT be determined at all
 * (unparseable payload, no file_path), it allows LOUDLY: denying there would
 * deny every edit in the session, and pre-commit-record still fails closed.
 *
 * Always exits 0 — the block is expressed via permissionDecision:"deny" in the
 * JSON, never via a crash.
 *
 * Repair hatch: PM_RECORD_UNLOCK=1 in the environment that LAUNCHED Claude
 * Code. A model running `export` in a Bash call cannot reach this process.
 *
 * Self-check: node pretooluse-record-guard.js --canary
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "append-record-entry.js");

function allow() { process.exit(0); }
function allowWithWarning(msg) {
  process.stdout.write(JSON.stringify({ systemMessage: msg }) + "\n");
  process.exit(0);
}
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }) + "\n");
  process.exit(0);
}

// The record's filename carries an em dash (U+2014) and spaces. Following
// hooks/pre-commit-record, the pattern is ASCII-ONLY and anchored to the tail:
// embedding the literal filename is how the twin-sync grep in Skills' own hook
// got its bug. Nothing in the match path can throw — match first, stat later.
const RECORD_TAIL = "full chronological history.md";
// The OTHER convention (`## YYYY-MM-DD — <title>` sections), which
// append-record-entry.js explicitly REFUSES to handle. Never denied: a guard
// that forbids the only remaining legal action is a wedge, not a gate.
const OTHER_RECORD = /^record_\d{4}-\d{2}-\d{2}\.md$/;

// One cleaner, used by BOTH the name match and the existence check. Keeping
// them separate is a live bug, not a hypothetical: the canary caught a quoted
// path matching as a record and then failing existsSync on the raw string with
// its quotes still attached, which fell through to ALLOW — the guard's own
// match saying "record" while its stat said "new file".
function cleanPath(p) {
  return String(p).trim().replace(/^["']|["']$/g, "");
}
function basenameOf(p) {
  const parts = cleanPath(p).split(/[\\/]/);
  return (parts[parts.length - 1] || "").normalize("NFC").toLowerCase();
}
function isRecordPath(p) {
  return typeof p === "string" && !!p && basenameOf(p).endsWith(RECORD_TAIL);
}
function isOtherRecordPath(p) {
  return typeof p === "string" && !!p && OTHER_RECORD.test(basenameOf(p));
}

// Git Bash spells absolute paths `/d/ClaudeCode/...`; existsSync on that form
// returns false on win32, which would mis-read an EXISTING record as a new file
// and allow the write. Same drive mapping pretooluse-commit-gate.js uses.
function toNative(p) {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  return m ? m[1].toUpperCase() + ":" + (m[2] || "/") : p;
}

function blockMessage(file) {
  return (
    "project-memory: direct Edit/Write to an append-only project record is BLOCKED.\n" +
    "  " + file + "\n\n" +
    "The `# Appendix X - ...` heading and its front-matter TOC line must be " +
    "written TOGETHER, under a lock, by the append script. Hand-writing the " +
    "heading alone breaks the TOC/heading balance, can duplicate an appendix " +
    "letter (both happened on 2026-09-01), and BLOCKS EVERY LATER APPEND until " +
    "someone repairs it by hand.\n\n" +
    "Do this instead — write the entry body to a scratch .md file, then:\n" +
    "  node \"" + SCRIPT + "\" \\\n" +
    "    --record \"" + file + "\" \\\n" +
    "    --title \"<title>\" \\\n" +
    "    --body <bodyfile.md> \\\n" +
    "    --date \"<from a real `date` call - never guessed>\"\n" +
    "  (--dry-run previews; --next-letter just reports the next free letter)\n\n" +
    "It derives the next letter from a LIVE scan, refuses duplicates across any " +
    "dash style, places the TOC line after the last existing one, and re-checks " +
    "the invariants before publishing by temp-file + rename.\n" +
    "Append entries with append-record-entry.js; do not hand-splice.\n\n" +
    "Corrections are NEW entries — never edit a prior one.\n" +
    "Genuine repair of an ALREADY-broken record: relaunch Claude Code with " +
    "PM_RECORD_UNLOCK=1 set in the environment."
  );
}

function main() {
  let raw;
  try { raw = fs.readFileSync(0, "utf8"); } catch (_) { raw = ""; }
  if (!raw.trim()) {
    allowWithWarning(
      "record-guard WARNING: empty hook input - the record write-guard was " +
      "SKIPPED for this call. pre-commit-record still gates the commit.");
  }
  let ev;
  try { ev = JSON.parse(raw); } catch (_) {
    allowWithWarning(
      "record-guard WARNING: unparseable hook input - the record write-guard " +
      "was SKIPPED. If this wrote a project record it is UNCHECKED " +
      "(pre-commit-record still gates the commit).");
  }
  if (!ev || typeof ev !== "object") allow();

  const ti = ev.tool_input || {};
  // NotebookEdit carries notebook_path; the matcher is unanchored so cover it.
  const file =
    typeof ti.file_path === "string" && ti.file_path ? ti.file_path :
    typeof ti.notebook_path === "string" && ti.notebook_path ? ti.notebook_path :
    null;
  if (!file) allow();                    // nothing to judge

  if (isOtherRecordPath(file)) {
    allowWithWarning(
      "record-guard: " + basenameOf(file) + " uses the `## YYYY-MM-DD` record " +
      "convention, which append-record-entry.js does not handle - hand-append " +
      "is correct here. APPEND ONLY: never edit a prior entry; corrections are " +
      "new entries.");
  }
  if (!isRecordPath(file)) allow();

  if (process.env.PM_RECORD_UNLOCK) {
    allowWithWarning(
      "record-guard: PM_RECORD_UNLOCK is set - direct write to the project " +
      "record ALLOWED. This is the repair hatch; verify the result with:\n" +
      "  node \"" + SCRIPT + "\" --record \"" + file + "\" --next-letter");
  }

  // From here the target IS a record: every error path DENIES.
  let exists;
  try { exists = fs.existsSync(toNative(cleanPath(file))); }
  catch (_) {
    deny(blockMessage(file) +
         "\n(could not stat the file; denying on the safe side)");
  }

  // A record that does not exist yet has no appendices to corrupt, the script
  // refuses a missing --record, and BOOTSTRAP (SKILL.md 1.3) legitimately
  // creates this file with Write.
  if (!exists) allow();

  deny(blockMessage(file));
}

function runCanary() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  let pass = 0, fail = 0;
  const check = (c, d) => { if (c) pass++; else { fail++; console.log("  FAIL: " + d); } };
  const decide = (ev, env) => {
    const r = spawnSync(process.execPath, [__filename], {
      input: typeof ev === "string" ? ev : JSON.stringify(ev),
      encoding: "utf8",
      env: Object.assign({}, process.env, { PM_RECORD_UNLOCK: "" }, env || {}),
    });
    const o = (r.stdout || "").trim();
    return {
      d: !o ? "allow"
        : o.indexOf('"deny"') !== -1 ? "deny"
        : o.indexOf("systemMessage") !== -1 ? "warn" : "other",
      out: o, status: r.status,
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rg-canary-"));
  try {
    // Built from the code point, so this source holds no literal the matcher
    // could have been accidentally tuned to.
    const NAME = "Project Record — Full Chronological History.md";
    const rec = path.join(dir, NAME);
    fs.writeFileSync(rec, "# Project Record\n");
    const ev = (f, tool) => ({ tool_name: tool || "Edit", tool_input: { file_path: f } });

    // --- must BLOCK -------------------------------------------------------
    check(decide(ev(rec, "Edit")).d === "deny", "Edit on an existing record -> deny");
    check(decide(ev(rec, "Write")).d === "deny", "Write on an existing record -> deny");
    check(decide(ev(rec.replace(/\//g, "\\"))).d === "deny", "backslash spelling -> deny");
    check(decide(ev(rec.toLowerCase())).d === "deny", "case-insensitive match -> deny");
    check(decide(ev("  \"" + rec + "\"  ")).d === "deny", "quoted/padded path -> deny");
    // the Git Bash drive spelling of the SAME existing file must still deny;
    // without toNative() it reads as a new file and is allowed through
    const posix = "/" + rec[0].toLowerCase() + rec.slice(2).replace(/\\/g, "/");
    check(decide(ev(posix)).d === "deny", "/d/... Git Bash spelling -> deny");
    check(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: rec } }).d === "deny",
      "notebook_path fallback -> deny");

    // --- the deny must be ACTIONABLE, not just a refusal ------------------
    const msg = decide(ev(rec)).out;
    check(msg.indexOf("append-record-entry.js") !== -1, "deny names the script");
    check(["--record", "--title", "--body", "--date"].every(f => msg.indexOf(f) !== -1),
      "deny names all four flags");
    check(msg.indexOf("do not hand-splice") !== -1,
      "deny echoes pre-commit-record's remedy line");
    check(msg.indexOf("PM_RECORD_UNLOCK") !== -1, "deny names the repair hatch");

    // --- must NOT block ---------------------------------------------------
    check(decide(ev(path.join(dir, "HANDOFF.md"))).d === "allow", "another .md -> allow");
    check(decide(ev(path.join(dir, "main.py"))).d === "allow", "code file -> allow");
    check(decide(ev(rec.replace(/\.md$/, ".html"))).d === "allow",
      "the generated HTML twin -> allow");
    check(decide(ev(rec + ".bak")).d === "allow", "a .bak beside the record is not the record");
    check(decide(ev(path.join(dir, "gone", NAME))).d === "allow",
      "record that does not exist yet -> allow (BOOTSTRAP creates it with Write)");
    check(decide(ev(path.join(dir, "record_2026-07-16.md"))).d === "warn",
      "the `## YYYY-MM-DD` convention -> allow + reminder, never deny");
    check(decide({ tool_input: {} }).d === "allow", "no file_path -> allow");

    // --- fail directions --------------------------------------------------
    check(decide(ev(rec), { PM_RECORD_UNLOCK: "1" }).d === "warn",
      "PM_RECORD_UNLOCK=1 -> allow, loudly");
    check(decide("not json").d === "warn",
      "malformed stdin -> loud fail-OPEN, not a session-wide wedge");
    check(decide("").d === "warn", "empty stdin -> loud fail-open");
    check(decide(ev(rec + " ")).d !== "other", "junk suffix never crashes");

    // --- the contract -----------------------------------------------------
    check([decide(ev(rec)), decide("not json"), decide(ev("x.py"))]
      .every(r => r.status === 0),
      "always exits 0 - the block is the JSON, never a crash");

    const ok = fail === 0;
    console.log("CANARY " + (ok ? "PASS" : "FAIL") + " " + pass + "/" + (pass + fail));
    return ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
main();
