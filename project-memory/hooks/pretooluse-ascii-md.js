#!/usr/bin/env node
/*
 * pretooluse-ascii-md.js - PreToolUse guard: a Write, Edit or MultiEdit to a
 * .md file may not ADD non-ASCII characters (rule added 2026-09-23: every .md a
 * skill creates or writes to is ASCII only, bytes 0x00-0x7F).
 *
 * "Add" is measured per character. The write is denied when some non-ASCII
 * character occurs more often in the new text than in the text it replaces:
 * Edit compares new_string with old_string, MultiEdit sums its edits, and Write
 * compares the new content with the file on disk. So an edit that carries an
 * existing em dash through unchanged passes, and an old file can be rewritten
 * without first converting it - converting old files is a separate, explicit
 * job.
 *
 * Limits, stated:
 *   - It sees only the Write, Edit and MultiEdit tools. A .md written by a Bash
 *     heredoc or a script is not checked here. append-record-entry.js and
 *     decision-log.js refuse non-ASCII themselves; nothing else does.
 *   - A change that removes one em dash and adds another nets to zero and
 *     passes.
 *
 * Fails OPEN, loudly, on input it cannot parse: a crashed guard must not wedge
 * every write in the session. Always exits 0; a block is expressed as
 * permissionDecision "deny".
 *
 * Escape hatch: ASCII_MD_GUARD_OFF=1 in the environment.
 * Self-check:   node pretooluse-ascii-md.js --canary
 */
"use strict";
const fs = require("fs");

const MD_RE = /\.(md|markdown)$/i;

// The usual offenders and what to write instead.
const HINT = {
  "\u2014": "-", "\u2013": "-", "\u2192": "->", "\u2190": "<-", "\u2026": "...",
  "\u201C": "\"", "\u201D": "\"", "\u2018": "'", "\u2019": "'", "\u00D7": "x",
  "\u00B1": "+/-", "\u2264": "<=", "\u2265": ">=", "\u00B7": ";", "\u00A7": "section",
  "\u2713": "[x]", "\u2705": "[x]", "\u2248": "~",
};

// character -> count, non-ASCII characters only. Iterating a string by code
// point keeps an emoji as one character instead of two surrogate halves.
function census(s) {
  const m = new Map();
  for (const ch of String(s || "")) if (ch.codePointAt(0) > 0x7f) m.set(ch, (m.get(ch) || 0) + 1);
  return m;
}

// The non-ASCII characters that occur more often in `after` than in `before`.
function added(before, after) {
  const b = census(before), out = [];
  for (const [ch, n] of census(after)) if (n > (b.get(ch) || 0)) out.push(ch);
  return out;
}

function describe(ch) {
  const cp = "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  return HINT[ch] ? `${cp} (use "${HINT[ch]}")` : cp;
}

function firstLineWith(text, chars) {
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (chars.some((c) => lines[i].includes(c))) return { n: i + 1, text: lines[i] };
  }
  return null;
}

// The whole decision, pure, so the canary can drive every branch.
// readCurrent(file) returns the file's text on disk, or null.
function decide(raw, env, readCurrent) {
  if ((env || {}).ASCII_MD_GUARD_OFF === "1") return { d: "allow" };
  if (!String(raw || "").trim()) {
    return { d: "warn", msg: "ascii-md WARNING: empty hook input - the ASCII-only .md check was SKIPPED for this call." };
  }
  let ev;
  try { ev = JSON.parse(raw); } catch (_) {
    return { d: "warn", msg: "ascii-md WARNING: unparseable hook input - the ASCII-only .md check was SKIPPED for this call." };
  }
  const ti = (ev && ev.tool_input) || {};
  const file = typeof ti.file_path === "string" ? ti.file_path : "";
  if (!MD_RE.test(file)) return { d: "allow" };

  let before = "", after = "";
  if (typeof ti.content === "string") {                    // Write
    after = ti.content;
    before = readCurrent(file) || "";
  } else if (Array.isArray(ti.edits)) {                     // MultiEdit
    for (const e of ti.edits) {
      before += (e && e.old_string) || "";
      after += (e && e.new_string) || "";
    }
  } else if (typeof ti.new_string === "string") {           // Edit
    before = ti.old_string || "";
    after = ti.new_string;
  } else {
    return { d: "allow" };
  }

  const bad = added(before, after);
  if (!bad.length) return { d: "allow" };
  const where = firstLineWith(after, bad);
  return {
    d: "deny",
    msg: `ASCII-only markdown (rule added 2026-09-23): this write to ${file} adds non-ASCII ` +
      `characters: ${bad.map(describe).join(", ")}.` +
      (where ? ` First at line ${where.n} of the new text: ${JSON.stringify(where.text.slice(0, 120))}.` : "") +
      " Replace them and retry. Non-ASCII already in the file that you did not add can stay.",
  };
}

function runCanary() {
  const path = require("path");
  const { spawnSync } = require("child_process");
  let pass = 0, total = 0;
  const check = (cond, name) => { total++; if (cond) pass++; else console.log("  FAIL: " + name); };
  const ev = (ti, tool) => JSON.stringify({ tool_name: tool || "Write", tool_input: ti });
  const none = () => null;
  const EM = "\u2014", AR = "\u2192";

  // 1. a new .md with an em dash is denied, and the reason is actionable
  const r1 = decide(ev({ file_path: "D:/x/new.md", content: "ok\na " + EM + " b\n" }), {}, none);
  check(r1.d === "deny", "a new .md with an em dash is denied");
  check(/U\+2014 \(use "-"\)/.test(r1.msg || ""), "the reason names U+2014 and its ASCII substitute");
  check(/line 2 of the new text/.test(r1.msg || ""), "the reason points at the first offending line");

  // 2. an all-ASCII .md is allowed; other file types are never checked
  check(decide(ev({ file_path: "D:/x/new.md", content: "plain - text\n" }), {}, none).d === "allow", "an all-ASCII .md is allowed");
  check(decide(ev({ file_path: "D:/x/notes.txt", content: EM }), {}, none).d === "allow", "a non-.md file is not checked");
  check(decide(ev({ file_path: "D:/x/README.MD", content: EM }), {}, none).d === "deny", "the extension match ignores case");

  // 3. Edit: carrying an existing em dash through passes; adding an arrow does not
  check(decide(ev({ file_path: "D:/x/h.md", old_string: "A " + EM + " B", new_string: "A " + EM + " C" }, "Edit"), {}, none).d === "allow",
    "an edit that keeps an existing em dash is allowed");
  check(decide(ev({ file_path: "D:/x/h.md", old_string: "A - B", new_string: "A " + AR + " B" }, "Edit"), {}, none).d === "deny",
    "an edit that adds an arrow is denied");

  // 4. MultiEdit: one bad edit among good ones is enough to deny
  check(decide(ev({ file_path: "D:/x/h.md", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d " + EM }] }, "MultiEdit"), {}, none).d === "deny",
    "a MultiEdit with one non-ASCII addition is denied");

  // 5. Write over an existing file: keeping its non-ASCII passes, adding more does not
  const disk = () => "old " + EM + " text\n";
  check(decide(ev({ file_path: "D:/x/old.md", content: "new " + EM + " text\n" }), {}, disk).d === "allow",
    "rewriting a file that keeps its existing em dash is allowed");
  check(decide(ev({ file_path: "D:/x/old.md", content: "new " + EM + EM + " text\n" }), {}, disk).d === "deny",
    "rewriting a file that adds a second em dash is denied");

  // 6. fail open, loudly; nothing to judge means allow
  check(decide("{not json", {}, none).d === "warn", "unparseable input fails open with a warning");
  check(decide("", {}, none).d === "warn", "empty input fails open with a warning");
  check(decide(ev({ content: EM }), {}, none).d === "allow", "no file_path is allowed");

  // 7. the escape hatch, and emoji counted as one character
  check(decide(ev({ file_path: "D:/x/new.md", content: EM }), { ASCII_MD_GUARD_OFF: "1" }, none).d === "allow",
    "ASCII_MD_GUARD_OFF=1 disables the check");
  check(added("", "\u{1F600}").length === 1, "an emoji counts as one character, not two surrogate halves");

  // 8. end to end through the real process: the deny JSON is what Claude Code reads
  const env = Object.assign({}, process.env);
  delete env.ASCII_MD_GUARD_OFF;
  const run = (input) => spawnSync(process.execPath, [path.resolve(__filename)], { input, env, encoding: "utf8" });
  const d = run(ev({ file_path: "D:/x/e2e.md", content: "x " + EM + "\n" }));
  let parsed = null;
  try { parsed = JSON.parse(d.stdout); } catch (_) { parsed = null; }
  check(d.status === 0 && parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === "deny",
    "the process exits 0 and prints permissionDecision deny");
  const a = run(ev({ file_path: "D:/x/e2e.md", content: "ascii only\n" }));
  check(a.status === 0 && a.stdout.trim() === "", "an allowed write prints nothing and exits 0");

  if (pass === total) { console.log(`CANARY PASS ${pass}/${total}`); return true; }
  console.log(`CANARY FAIL ${pass}/${total}`);
  return false;
}

function main() {
  let raw;
  try { raw = fs.readFileSync(0, "utf8"); } catch (_) { raw = ""; }
  const r = decide(raw, process.env, (f) => { try { return fs.readFileSync(f, "utf8"); } catch (_) { return null; } });
  if (r.d === "deny") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.msg },
    }) + "\n");
  } else if (r.d === "warn") {
    process.stdout.write(JSON.stringify({ systemMessage: r.msg }) + "\n");
  }
  process.exit(0);
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
main();
