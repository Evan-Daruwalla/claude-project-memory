#!/usr/bin/env node
/*
 * project-memory — deterministic cadence hook (UserPromptSubmit).
 *
 * CHANGE-DRIVEN since 2026-09-01. Previously this fired every Nth prompt
 * regardless of whether anything had happened, so a session of pure questions
 * paid a full /project-memory load (~7k tokens) to be told there was nothing to
 * record. Now the record/handoff/bins reminders fire only when project files
 * are NEWER than the doc that should describe them; N became a debounce (at
 * most one reminder per N prompts per subpart) instead of the trigger.
 *
 * mtime is a PROXY, not truth: a formatter, a `git checkout`, or a touch will
 * look like new work. Cost of a false positive is one wasted reminder. The
 * alternative considered was asking a model via `claude -p`, measured
 * 2026-09-01 at ~31k tokens / ~7.4s / ~$0.024 PER PROMPT even with every
 * context-stripping flag — 13x the cost of the skill load it was meant to
 * avoid, and over the hook timeout. Rejected on those numbers.
 *
 * One-prompt lag by design: the scan runs at the START of the next prompt, so
 * the work being judged has already finished.
 *
 * State + config: <project>/.claude/pm-cadence.json (project found via the
 * `cwd` field on the hook's stdin JSON, falling back to process.cwd()).
 * If that file is absent, the project hasn't been set up — exit silently, so
 * one global registration stays dormant everywhere until a project opts in.
 *
 * Config schema (0 / missing = that subpart is off):
 *   { "record_entry": 3, "handoff": 15, "prd_next_task": 0, "bins": 3,
 *     "bins_max_age_days": 21, "_floor": 0, "_count": 0, "_last_fired": {},
 *     "_last_reminder_iso": null }
 *   record_entry/handoff/bins : min prompts between repeat reminders (debounce)
 *   prd_next_task             : pure prompt counter, unchanged — nothing on
 *                               disk says "the next PRD task is ready"
 *   bins_max_age_days         : a bin older than this is stale even when some
 *                               OTHER bin is fresh (0 = off, default 21)
 *   _floor                    : remind every M prompts even with no file
 *                               change (0 = off). Safety net for a long
 *                               chat-only session that still needs a handoff.
 *
 * handoff defaults to a LONG debounce (15), not 3: HANDOFF.md is the
 * end-of-session snapshot, so mid-session drift is expected and normal. The
 * signal is real but the right rate is "occasionally", not "constantly".
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
  record_entry: "append a timestamped record entry",
  handoff: "run the end-of-session handoff sync",
  prd_next_task: "execute the next PRD task",
  bins: "update the codebase-memory bins",
  drift_check: "verify HANDOFF's claims against reality — drift check",
};

// Which SKILL.md section covers each subpart. Obeying a reminder used to mean
// invoking /project-memory, which loads the whole ~28 KB skill (~7k tokens) to
// do a job one section answers (§2 RECORD ENTRY is 43 lines, under 1k). The
// reminder now carries LINE NUMBERS so the model can read just that part.
const SECTIONS = {
  record_entry: "2",
  handoff: "3",
  prd_next_task: "4",
  bins: "5",
  drift_check: "6",
};

const SKILL_PATH = path.join(__dirname, "..", "SKILL.md");

// Subparts whose due-ness is decided by comparing mtimes. prd_next_task is
// absent deliberately: a roadmap task becoming "next" is not a file event.
const MTIME_KEYS = new Set(["record_entry", "handoff", "bins", "drift_check"]);

// must match pm-cadence-autoinit.js's DEFAULTS — used only to recover from an
// unreadable config, never to create one (autoinit owns creation).
const DEFAULTS = {
  record_entry: 3,
  handoff: 15,
  prd_next_task: 0,
  bins: 3,
  bins_max_age_days: 21,
  drift_check: 15,
  drift_check_days: 14,
  _floor: 0,
  _count: 0,
  _last_fired: {},
  _last_reminder_iso: null,
};

// Not source. `.claude` matters most: this hook rewrites pm-cadence.json on
// every prompt, so scanning it would make the project eternally "just changed".
const SKIP_DIRS = new Set([
  ".git", ".claude", "node_modules", "__pycache__", ".venv", "venv", "env",
  "dist", "build", "out", ".next", "target", "coverage", "vendor",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".idea", ".vscode", ".cache",
]);

// The memory docs are the COMPARISON TARGETS. Counting them as source would
// mean updating HANDOFF.md looks like fresh work that needs a record entry.
const SKIP_FILE_RE = /^(HANDOFF\.md|PRD_ROADMAP\.md)$/i;

// Generated on build/run, not by anyone doing work. Seen live: a stray
// `tsconfig.tsbuildinfo` was the newest file in a real project (2026-09-01), which
// on a quieter day would have been a reminder about nothing. Lock files are
// deliberately NOT here — a dependency change is real work worth recording.
const ARTIFACT_RE = /(\.tsbuildinfo|\.log|\.pyc|\.pyo|\.map|\.tmp|\.bak|\.orig)$|^(\.DS_Store|Thumbs\.db)$/i;
const SKIP_PATH_RE = /[\\/]docs[\\/][^\\/]*(record|chronological)[^\\/]*\.(md|html)$/i;

const CODE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".sh",
  ".ps1", ".sql", ".ino",
]);

// The hook runs under a hard timeout on every prompt, so the walk is bounded.
// 4000 was the first try and was far too low: measured 2026-09-01, a 15k-file
// tree with ONE stale file detected it in only 4 of 12 placements — the cap
// stopped the walk before reaching the change. Real projects here scan much
// smaller than their raw file count (largest real project: 4,939 after exclusions, next
// largest 801), so 25000 clears them all with room. Past the cap the walk
// degrades to the old prompt-counter rather than going silent (see `capped`).
const MAX_ENTRIES = 25000;
const MAX_DEPTH = 12;

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

// Map "2" -> [firstLine, lastLine] (1-indexed, inclusive) for each numbered
// SKILL.md section, plus "rules" for the trailing rules-for-all-workflows
// block. Read at FIRE time, never cached and never hardcoded: a fixed range
// would silently drift to the wrong text the next time SKILL.md is edited,
// which is worse than no pointer at all. Returns null if unreadable — the
// caller then falls back to naming the section instead of its lines.
function sectionRanges(skillPath) {
  let lines;
  try {
    lines = fs.readFileSync(skillPath, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^## (?:(\d+)\.|(Rules))/.exec(lines[i]);
    if (m) heads.push({ key: m[1] || "rules", line: i + 1 });
  }
  if (!heads.length) return null;
  // last real line — a trailing newline yields an empty final element, and the
  // final section's range would otherwise point one line past the content
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  const out = {};
  for (let i = 0; i < heads.length; i++) {
    // a section runs to the line before the next `## ` heading (`###`
    // subsections stay inside it, e.g. §5.1 belongs to §5)
    // back off the blank lines that separate sections, so a cited range ends
    // on real text rather than whitespace
    let last = i + 1 < heads.length ? heads[i + 1].line - 1 : end;
    while (last > heads[i].line && lines[last - 1].trim() === "") last--;
    out[heads[i].key] = [heads[i].line, last];
  }
  return out;
}

// "append a timestamped record entry (SKILL.md:140-182)" when the range is
// known, else the original "(/project-memory §2)" pointer.
function describe(key, ranges) {
  const sec = SECTIONS[key];
  const r = ranges && sec ? ranges[sec] : null;
  if (!r) return `${LABELS[key]} (/project-memory §${sec})`;
  return `${LABELS[key]} (SKILL.md:${r[0]}-${r[1]})`;
}

function mtimeOf(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Projects do not always keep everything at the root. One real project keeps its
// config and record at the root but HANDOFF.md AND the bins one level down in
// a versioned subdirectory (measured 2026-09-02) — so a root-only lookup found the record
// and silently missed the other two. Root always wins when present; otherwise
// take the NEWEST match one level down, which picks the live tree over a
// retired sibling (that project also has an older "<name> website/HANDOFF.md" from
// 2026-07-08). Depth 1 only: a full search would undo the walk bound above.
function maxOverSubdirs(root, fn) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  let newest = 0;
  for (const e of ents) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const m = fn(path.join(root, e.name));
    if (m > newest) newest = m;
  }
  return newest;
}

// mtime of <root>/<name>, else the newest <root>/*/<name>
function findNearestFile(root, name) {
  const direct = mtimeOf(path.join(root, name));
  if (direct > 0) return direct;
  return maxOverSubdirs(root, (d) => mtimeOf(path.join(d, name)));
}

// Locate `.claude/codebase-memory/`. Usually at the project root — but not
// always, and the fixed-path version was silently wrong: one real project keeps its
// config at `<proj>/.claude/` and its bins one level down at
// `<proj>/<subdir>/.claude/codebase-memory/` (measured 2026-09-01).
// A missing target reads as mtime 0, so every code file looks newer — the
// reminder would fire on every prompt and could NEVER go quiet, because
// updating the real bins cannot move a target that does not exist.
// Root first (one stat, the common case), then one level of subdirectories.
function findBinsDir(root) {
  const direct = path.join(root, ".claude", "codebase-memory");
  if (isDir(direct)) return direct;
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const nested = path.join(root, e.name, ".claude", "codebase-memory");
    if (isDir(nested)) return nested;
  }
  return null;
}

// Bin freshness, measured two ways because they catch different rot:
//   newest — the newest bin overall, compared against the newest CODE file.
//            Catches "work happened and NO bin was touched at all".
//   stale  — individual bins older than `maxAgeDays`. This is the one that
//            matters: taking only the NEWEST bin means touching any single
//            file silences the whole subpart while the rest decay. Measured
//            2026-09-01 — one project had conventions.md fresh that day while
//            features.md sat 13 days old and performance.md 52; another project
//            had gotchas.md fresh and security.md 40 days old.
// A bin that is reviewed and still accurate is kept fresh by touching it —
// that is the intended escape from a permanent age reminder.
function binsState(dir, maxAgeDays, now) {
  const out = { newest: 0, stale: [] };
  if (!dir) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 86400000 : null;
  for (const e of ents) {
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    const m = mtimeOf(path.join(dir, e.name));
    if (m > out.newest) out.newest = m;
    if (cutoff !== null && m > 0 && m < cutoff) {
      out.stale.push({ name: e.name, days: Math.floor((now - m) / 86400000) });
    }
  }
  out.stale.sort((a, b) => b.days - a.days);
  return out;
}

// The append-only record. Both conventions in use are matched:
// "Project Record — Full Chronological History.md" and
// "record_<date>.md". Newest wins when a project has several.
function newestRecordIn(docsDir) {
  let ents;
  try { ents = fs.readdirSync(docsDir, { withFileTypes: true }); } catch { return 0; }
  let newest = 0;
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (!/\.md$/i.test(e.name)) continue;
    if (!/record|chronological/i.test(e.name)) continue;
    const m = mtimeOf(path.join(docsDir, e.name));
    if (m > newest) newest = m;
  }
  return newest;
}

function findRecord(root) {
  const direct = newestRecordIn(path.join(root, "docs"));
  if (direct > 0) return direct;
  return maxOverSubdirs(root, (d) => newestRecordIn(path.join(d, "docs")));
}

// Newest mtime across the project's own files, overall and code-only.
// `stopAbove` ends the walk early once nothing further can change an answer.
function scanSource(root, stopAbove) {
  let newestAny = 0, newestCode = 0, seen = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > MAX_ENTRIES) return { newestAny, newestCode, capped: true };
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (depth < MAX_DEPTH) stack.push([full, depth + 1]);
        continue;
      }
      if (!e.isFile()) continue;
      if (SKIP_FILE_RE.test(e.name) || ARTIFACT_RE.test(e.name)) continue;
      if (SKIP_PATH_RE.test(full)) continue;
      const m = mtimeOf(full);
      if (m > newestAny) newestAny = m;
      if (m > newestCode && CODE_EXT.has(path.extname(e.name).toLowerCase())) {
        newestCode = m;
      }
      if (newestAny > stopAbove && newestCode > stopAbove) {
        return { newestAny, newestCode, capped: false };
      }
    }
  }
  return { newestAny, newestCode, capped: false };
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
    cfg = { ...DEFAULTS, _last_fired: {} };
  }

  const count = (parseInt(cfg._count, 10) || 0) + 1;
  cfg._count = count;
  if (!cfg._last_fired || typeof cfg._last_fired !== "object") cfg._last_fired = {};

  // <root>/.claude/pm-cadence.json -> <root>
  const root = path.dirname(path.dirname(cfgPath));
  const floor = parseInt(cfg._floor, 10) || 0;
  const now = Date.now(); // one reading, so bins ages and drift age agree

  const enabled = [];
  for (const key of Object.keys(LABELS)) {
    const n = parseInt(cfg[key], 10);
    if (n > 0) enabled.push([key, n]);
  }

  // Only pay for the filesystem walk if some mtime-driven subpart is on.
  let targets = null, scan = null, bins = { newest: 0, stale: [] };
  if (enabled.some(([k]) => MTIME_KEYS.has(k))) {
    if (enabled.some(([k]) => k === "bins")) {
      const parsedAge = parseInt(cfg.bins_max_age_days, 10);
      const maxAge = Number.isFinite(parsedAge) ? parsedAge : DEFAULTS.bins_max_age_days;
      bins = binsState(findBinsDir(root), maxAge, now);
    }
    const handoffMtime = findNearestFile(root, "HANDOFF.md");
    targets = {
      record_entry: findRecord(root),
      handoff: handoffMtime,
      bins: bins.newest,
      // drift_check shares HANDOFF.md as its target ON PURPOSE. It could have
      // stored "when I last asked" in the config instead, but a hook cannot
      // verify the model actually complied, so that clock would reset on every
      // reminder whether or not the check happened — silencing itself for
      // `drift_check_days` on nothing. Keyed to the FILE, ignoring the reminder
      // changes nothing and it keeps firing until HANDOFF is really touched.
      drift_check: handoffMtime,
    };
    let stopAbove = 0;
    for (const [k] of enabled) {
      if (MTIME_KEYS.has(k)) stopAbove = Math.max(stopAbove, targets[k]);
    }
    scan = scanSource(root, stopAbove);
  }

  const due = [];
  let anyStale = false, anyCapped = false;
  for (const [key, n] of enabled) {
    if (!MTIME_KEYS.has(key)) {
      if (count % n === 0) due.push(key);
      continue;
    }
    const parsed = parseInt(cfg._last_fired[key], 10);
    const last = Number.isFinite(parsed) ? parsed : null;
    if (last !== null && count - last < n) continue; // debounce — stop nagging
    const newest = key === "bins" ? scan.newestCode : scan.newestAny;
    // A target that does not exist reads as mtime 0, which would make every
    // file look newer — firing forever at a project that simply does not use
    // that artifact (no HANDOFF.md, no codebase-memory/), with no action that
    // could ever silence it. Absent means "not in use here", not "infinitely
    // stale"; creating one is /project-memory §1 BOOTSTRAP's job, not a
    // per-prompt nag's.
    const present = targets[key] > 0;
    // For bins, an over-age bin counts as stale on its own — otherwise touching
    // any single bin silences the subpart while the others rot (the measured
    // conventions gap, 2026-09-01).
    let stale =
      (present && newest > targets[key]) || (key === "bins" && bins.stale.length > 0);
    // drift_check is §3's stricter sibling: `handoff` says "source moved, sync
    // the snapshot"; drift_check says "the snapshot has ALSO been untouched for
    // <drift_check_days>, so verify its CLAIMS, not just its state". The extra
    // age condition is what keeps it from being a duplicate handoff reminder on
    // a project that syncs regularly.
    if (key === "drift_check") {
      const parsedDays = parseInt(cfg.drift_check_days, 10);
      const driftDays = Number.isFinite(parsedDays) ? parsedDays : DEFAULTS.drift_check_days;
      stale = stale && driftDays > 0 && now - targets[key] >= driftDays * 86400000;
    }
    // A capped walk proves nothing: the change may sit past the cap. Fall back
    // to the pre-2026-09-01 prompt counter there, so an oversized project is
    // never WORSE off than before the change — just not smarter. Kept separate
    // from `stale` so the message never claims a change it did not observe.
    const cappedFallback = scan.capped && !stale && count % n === 0;
    const floorHit = floor > 0 && (last === null || count - last >= floor);
    if (stale || cappedFallback || floorHit) {
      due.push(key);
      cfg._last_fired[key] = count;
      if (stale) anyStale = true;
      if (cappedFallback) anyCapped = true;
    }
  }

  if (due.length) {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    cfg._last_reminder_iso = nowIso;
    const why = anyStale
      ? "project files are newer than the docs that should describe them"
      : anyCapped
        ? "periodic check (project too large to scan fully — falling back to a prompt count)"
        : "periodic check (no file changes detected)";
    // read SKILL.md only when something is actually due, not on every prompt
    const ranges = sectionRanges(SKILL_PATH);
    const items = due.map((k) => {
      const base = describe(k, ranges);
      // name the worst offenders: "update the codebase-memory bins" alone does
      // not say WHICH, and the whole point of the age rule is that the fresh
      // ones hide the rotten ones
      if (k !== "bins" || !bins.stale.length) return base;
      const worst = bins.stale.slice(0, 3).map((b) => `${b.name} ${b.days}d`).join(", ");
      const more = bins.stale.length > 3 ? `, +${bins.stale.length - 3} more` : "";
      return `${base} — stalest: ${worst}${more}`;
    }).join("; and ");
    let how = "";
    if (ranges) {
      const rules = ranges.rules
        ? ` Rules that apply to every workflow: SKILL.md:${ranges.rules[0]}-${ranges.rules[1]}.`
        : "";
      how =
        `${rules} Read those line ranges from ${SKILL_PATH} directly instead ` +
        `of invoking /project-memory — the whole skill is ~7k tokens, one ` +
        `section under 1k.`;
    }
    process.stdout.write(
      `[PM-CADENCE] Prompt #${count} — ${why}. Before continuing with ` +
        `the user's request, ${items}.${how} Then proceed. (${nowIso})\n`
    );
  }

  try {
    // write+rename, never a bare write: the hook has a hard timeout, and a kill
    // mid-write leaves truncated JSON that bricks the cadence. rename() is
    // atomic on the same filesystem, so no reader ever sees a partial file.
    //
    // The tmp name carries the pid. With a FIXED name, two sessions in one
    // project wrote the SAME tmp file and one could rename a half-written copy
    // over the live config — caught by the corrupt-config path, which silently
    // resets _count to 0 and skips a reminder cycle. This closes that.
    // It does NOT close the lost update on _count itself: two sessions can still
    // read the same value and both write count+1. That needs an O_EXCL lockfile,
    // not a rename, and is deliberately not attempted here.
    const tmp = `${cfgPath}.${process.pid}.tmp`;
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
  // explicit mtimes, not wall clock: the whole mechanism is an ordering test
  const setM = (p, secs) => fs.utimesSync(p, new Date(secs * 1000), new Date(secs * 1000));
  try {
    const proj = path.join(root, "proj");
    const deep = path.join(proj, "src", "deep");
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(proj, "docs"), { recursive: true });
    fs.mkdirSync(deep, { recursive: true });
    const cfg = path.join(proj, ".claude", "pm-cadence.json");
    const rec = path.join(proj, "docs", "record_2026-01-01.md");
    const src = path.join(deep, "app.py");
    const read = () => JSON.parse(fs.readFileSync(cfg, "utf8"));
    const write = (o) => fs.writeFileSync(cfg, JSON.stringify({ ...DEFAULTS, ...o }));

    fs.writeFileSync(rec, "# record\n");
    fs.writeFileSync(src, "print(1)\n");

    // --- change-driven core -------------------------------------------------
    write({});
    setM(rec, 2000); setM(src, 1000);          // record NEWER than source
    let r = fire(deep);
    check((r.stdout || "") === "", "silent when no project file is newer than the record");
    check(read()._count === 1, "still counts prompts while silent");

    setM(src, 3000);                            // source now newer
    r = fire(deep);
    check(/PM-CADENCE/.test(r.stdout || ""), "fires once a source file is newer than the record");
    check(/newer than the docs/.test(r.stdout || ""), "message names the change trigger");
    check(read()._last_fired.record_entry === 2, "records which prompt it fired on");

    r = fire(deep);
    check((r.stdout || "") === "", "debounce suppresses a repeat inside N prompts");

    setM(rec, 4000);                            // record updated -> caught up
    fire(deep); fire(deep);                     // walk past the debounce window
    r = fire(deep);
    check((r.stdout || "") === "", "stops firing once the record is updated");

    // --- floor: fires with no changes at all --------------------------------
    write({ record_entry: 1, _floor: 2, _count: 0, _last_fired: {} });
    setM(rec, 9000); setM(src, 1000);           // nothing stale
    r = fire(proj);
    check(/periodic check/.test(r.stdout || ""), "floor fires with no file change, and says so");

    // --- .claude is never source (this hook writes there every prompt) ------
    write({ _count: 0, _last_fired: {} });
    setM(rec, 9000); setM(src, 1000);
    fire(proj);
    r = fire(proj);
    check((r.stdout || "") === "", "its own config write does not count as a project change");

    // --- HANDOFF.md is a target, not source --------------------------------
    write({ _count: 0, _last_fired: {} });
    const ho = path.join(proj, "HANDOFF.md");
    fs.writeFileSync(ho, "# handoff\n");
    setM(rec, 9000); setM(src, 1000); setM(ho, 9500);
    r = fire(proj);
    check((r.stdout || "") === "", "updating HANDOFF.md does not itself demand a record entry");

    // --- build artifacts are not work --------------------------------------
    write({ _count: 0, _last_fired: {} });
    const art = path.join(deep, "tsconfig.tsbuildinfo");
    fs.writeFileSync(art, "{}\n");
    setM(rec, 9000); setM(src, 1000); setM(art, 9900);
    r = fire(proj);
    check((r.stdout || "") === "", "a newer build artifact alone does not trigger a reminder");
    setM(src, 9900);                            // real code, same mtime
    write({ _count: 0, _last_fired: {} });
    r = fire(proj);
    check(/PM-CADENCE/.test(r.stdout || ""), "real source at that same mtime still does trigger");
    fs.rmSync(art);

    // --- prd_next_task stays a pure counter --------------------------------
    write({ record_entry: 0, prd_next_task: 2, _count: 0, _last_fired: {} });
    fire(proj);
    r = fire(proj);
    check(/next PRD task/.test(r.stdout || ""), "prd_next_task still fires on its prompt count");

    // --- a walk that hits the cap degrades to the old counter, and says so --
    // MAX_ENTRIES files is too slow to build here, so drive the same branch by
    // pointing the hook at a tree deeper than MAX_DEPTH: the stale file is
    // unreachable, exactly like one sitting past the entry cap.
    write({ record_entry: 2, _count: 1, _last_fired: {} });
    let buried = proj;
    for (let i = 0; i < MAX_DEPTH + 3; i++) buried = path.join(buried, "d" + i);
    fs.mkdirSync(buried, { recursive: true });
    const deepSrc = path.join(buried, "late.py");
    fs.writeFileSync(deepSrc, "x\n");
    setM(rec, 9000); setM(src, 1000); setM(deepSrc, 9900);
    r = fire(proj);
    check((r.stdout || "") === "", "a change below MAX_DEPTH is genuinely invisible (known blind spot)");
    check(!/newer than the docs/.test(r.stdout || ""), "never claims a change it did not observe");
    fs.rmSync(path.join(proj, "d0"), { recursive: true, force: true });

    // --- preserved behaviours ----------------------------------------------
    write({});
    setM(rec, 2000); setM(src, 1000);
    fire(deep);
    const strays = fs.readdirSync(path.dirname(cfg)).filter((f) => f.endsWith(".tmp"));
    check(strays.length === 0, `atomic write leaves no .tmp behind (found: ${strays.join(", ") || "none"})`);

    fs.writeFileSync(cfg, '{"record_entry":3,"_cou');
    r = fire(proj);
    check(fs.existsSync(cfg + ".corrupt"), "corrupt config is preserved, not discarded");
    let valid = false;
    try { read(); valid = true; } catch { /* stays false */ }
    check(valid, "corrupt config is rewritten to valid defaults (cadence resumes)");
    check(/PM-CADENCE/.test(r.stderr || ""), "corruption is announced, not swallowed");

    // --- an ABSENT artifact means "not in use", never "infinitely stale" -----
    // mtime 0 would otherwise make every file look newer, nagging forever at a
    // project that has no HANDOFF.md / no bins, with no action able to stop it
    write({ record_entry: 0, handoff: 1, bins: 1, _count: 0, _last_fired: {} });
    const hoTmp = path.join(proj, "HANDOFF.md");
    if (fs.existsSync(hoTmp)) fs.rmSync(hoTmp);
    setM(src, 9000);
    r = fire(proj);
    check((r.stdout || "") === "", "no HANDOFF.md and no bins dir -> silent, not a permanent nag");

    // --- bins: nested location, and per-bin age ------------------------------
    // bins live one level down, the real nested layout this handles
    const nestedBins = path.join(proj, "app", ".claude", "codebase-memory");
    fs.mkdirSync(nestedBins, { recursive: true });
    const freshBin = path.join(nestedBins, "gotchas.md");
    const oldBin = path.join(nestedBins, "features.md");
    fs.writeFileSync(freshBin, "x\n");
    fs.writeFileSync(oldBin, "x\n");
    check(findBinsDir(proj) === nestedBins, "finds a codebase-memory dir one level below the root");

    const nowMs = Date.now();
    const days = (n) => new Date(nowMs - n * 86400000);
    fs.utimesSync(freshBin, days(0), days(0));
    fs.utimesSync(oldBin, days(40), days(40));
    let bs = binsState(nestedBins, 21, nowMs);
    check(bs.stale.length === 1 && bs.stale[0].name === "features.md",
      `an over-age bin is stale even though a sibling is fresh (got ${JSON.stringify(bs.stale)})`);
    check(bs.newest >= nowMs - 1000, "newest-bin still reflects the freshest file");
    check(binsState(nestedBins, 0, nowMs).stale.length === 0, "bins_max_age_days 0 disables the age rule");
    check(binsState(null, 21, nowMs).stale.length === 0, "a project with no bins dir yields no age findings");

    // whole flow: fresh code, fresh newest-bin, one rotten bin -> still fires,
    // and the message names the rotten one
    write({ record_entry: 0, handoff: 0, bins: 1, bins_max_age_days: 21, _count: 0, _last_fired: {} });
    setM(rec, 9000);
    fs.utimesSync(src, days(0), days(0));
    r = fire(proj);
    check(/features\.md 40d/.test(r.stdout || ""),
      `reminder names the stale bin and its age (got: ${(r.stdout || "").slice(0, 200)})`);
    check(/codebase-memory bins/.test(r.stdout || ""), "and still labels it as the bins subpart");

    // a fully fresh bin set stays silent
    fs.utimesSync(oldBin, days(1), days(1));
    write({ record_entry: 0, handoff: 0, bins: 1, bins_max_age_days: 21, _count: 0, _last_fired: {} });
    fs.utimesSync(src, days(5), days(5));   // code older than every bin
    r = fire(proj);
    check((r.stdout || "") === "", "no stale bins and no newer code -> silent");
    fs.rmSync(path.join(proj, "app"), { recursive: true, force: true });

    // --- nested layout: HANDOFF and the record found one level down ----------
    // A real project's shape: record at the root, HANDOFF.md inside a subdir,
    // plus a RETIRED sibling subdir holding an older HANDOFF.md
    const nestRoot = path.join(root, "nested");
    fs.mkdirSync(path.join(nestRoot, "live", "docs"), { recursive: true });
    fs.mkdirSync(path.join(nestRoot, "retired"), { recursive: true });
    const liveHo = path.join(nestRoot, "live", "HANDOFF.md");
    const deadHo = path.join(nestRoot, "retired", "HANDOFF.md");
    const nestRec = path.join(nestRoot, "live", "docs", "record_2026-01-01.md");
    fs.writeFileSync(liveHo, "x\n"); fs.writeFileSync(deadHo, "x\n"); fs.writeFileSync(nestRec, "x\n");
    setM(liveHo, 9000); setM(deadHo, 1000); setM(nestRec, 8000);
    check(findNearestFile(nestRoot, "HANDOFF.md") === 9000000,
      "a nested HANDOFF.md is found, newest wins over a retired sibling");
    check(findRecord(nestRoot) === 8000000, "a nested record is found when the root has none");
    const rootHo = path.join(nestRoot, "HANDOFF.md");
    fs.writeFileSync(rootHo, "x\n"); setM(rootHo, 5000);
    check(findNearestFile(nestRoot, "HANDOFF.md") === 5000000,
      "a root HANDOFF.md wins even when a newer one sits in a subdirectory");
    fs.rmSync(nestRoot, { recursive: true, force: true });

    // --- drift_check: handoff's stricter sibling -----------------------------
    const ho2 = path.join(proj, "HANDOFF.md");
    fs.writeFileSync(ho2, "# handoff\n");
    const dayAgo = (n) => new Date(Date.now() - n * 86400000);

    // recently-synced HANDOFF + newer source: handoff fires, drift_check does NOT
    write({ record_entry: 0, handoff: 1, bins: 0, drift_check: 1, drift_check_days: 14,
            _count: 0, _last_fired: {} });
    fs.utimesSync(ho2, dayAgo(2), dayAgo(2));
    fs.utimesSync(src, dayAgo(1), dayAgo(1));
    r = fire(proj);
    check(/handoff sync/.test(r.stdout || ""), "handoff fires when source is newer than HANDOFF.md");
    check(!/drift check/.test(r.stdout || ""),
      "drift_check stays quiet on a recently-synced HANDOFF (not a duplicate handoff nag)");

    // same drift, but HANDOFF untouched for longer than drift_check_days
    write({ record_entry: 0, handoff: 0, bins: 0, drift_check: 1, drift_check_days: 14,
            _count: 0, _last_fired: {} });
    fs.utimesSync(ho2, dayAgo(30), dayAgo(30));
    fs.utimesSync(src, dayAgo(1), dayAgo(1));
    r = fire(proj);
    check(/drift check/.test(r.stdout || ""), "drift_check fires once HANDOFF is older than drift_check_days");
    check(/SKILL\.md:\d+-\d+/.test(r.stdout || ""), "and cites §6's line range");

    // old HANDOFF but a dormant project: nothing changed since, so nothing to verify
    write({ record_entry: 0, handoff: 0, bins: 0, drift_check: 1, drift_check_days: 14,
            _count: 0, _last_fired: {} });
    fs.utimesSync(src, dayAgo(40), dayAgo(40));
    r = fire(proj);
    check((r.stdout || "") === "", "a dormant project does not drift — old HANDOFF alone is not enough");

    // firing must NOT silence it: the target is the FILE, not a written-back clock
    write({ record_entry: 0, handoff: 0, bins: 0, drift_check: 1, drift_check_days: 14,
            _count: 0, _last_fired: {} });
    fs.utimesSync(src, dayAgo(1), dayAgo(1));
    fire(proj);
    r = fire(proj);
    check(/drift check/.test(r.stdout || ""), "ignoring a drift reminder does not silence it");
    fs.utimesSync(ho2, dayAgo(0), dayAgo(0));   // actually do the check
    write({ record_entry: 0, handoff: 0, bins: 0, drift_check: 1, drift_check_days: 14,
            _count: 0, _last_fired: {} });
    r = fire(proj);
    check((r.stdout || "") === "", "touching HANDOFF clears it");

    check(/^\s*$/.test((() => {
      write({ record_entry: 0, handoff: 0, bins: 0, drift_check: 1, drift_check_days: 0,
              _count: 0, _last_fired: {} });
      fs.utimesSync(ho2, dayAgo(30), dayAgo(30));
      fs.utimesSync(src, dayAgo(1), dayAgo(1));
      return fire(proj).stdout || "";
    })()), "drift_check_days 0 disables the subpart");
    fs.rmSync(ho2);

    // --- line-range nudge ---------------------------------------------------
    write({ _count: 0, _last_fired: {} });
    setM(rec, 1000); setM(src, 9000);
    r = fire(proj);
    check(/SKILL\.md:\d+-\d+/.test(r.stdout || ""), "reminder carries a concrete line range");
    check(/instead of invoking \/project-memory/.test(r.stdout || ""), "reminder says not to load the whole skill");
    check(/Rules that apply to every workflow: SKILL\.md:\d+-\d+/.test(r.stdout || ""),
      "reminder also points at the rules-for-all-workflows block");

    // ranges are parsed live, so an edited SKILL.md yields different numbers —
    // this is what a hardcoded range would get wrong
    const fake = path.join(root, "fake-skill.md");
    fs.writeFileSync(fake, "intro\n## 1. ONE\na\n## 2. TWO\nb\nc\n## Rules (all workflows)\nr\n");
    const rg = sectionRanges(fake);
    check(rg["2"][0] === 4 && rg["2"][1] === 6, `§2 range parsed as lines 4-6 (got ${rg["2"]})`);
    fs.writeFileSync(fake, "intro\n## 1. ONE\na\n\n\n## 2. TWO\nb\n");
    check(sectionRanges(fake)["1"][1] === 3, "a range ends on real text, not the blank lines before the next heading");
    check(rg.rules[0] === 7 && rg.rules[1] === 8, `rules range parsed as 7-8 (got ${rg.rules})`);
    fs.writeFileSync(fake, "intro\nEXTRA\nEXTRA\n## 1. ONE\na\n## 2. TWO\nb\nc\n## Rules (all workflows)\nr\n");
    const rg2 = sectionRanges(fake);
    check(rg2["2"][0] === 6, `ranges shift when the file is edited, not hardcoded (got ${rg2["2"][0]}, want 6)`);
    check(sectionRanges(path.join(root, "nope.md")) === null, "unreadable SKILL.md -> null, not a throw");
    check(/\(\/project-memory §2\)/.test(describe("record_entry", null)),
      "falls back to naming the section when no ranges are available");

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
