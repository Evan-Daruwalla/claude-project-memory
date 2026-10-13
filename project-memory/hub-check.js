#!/usr/bin/env node
/*
 * hub-check - cross-project "hub" drift checker.
 *
 * WHAT: a registry names facts. Each fact has one OWNER file (the hub, the
 * single place that is allowed to define the fact). Copies of the fact in other
 * files must agree with the owner. This tool walks the registry's roots, scans
 * the files it finds, and reports every copy that disagrees. It never edits
 * anything.
 *
 * WHY: a fact copied into many documents drifts: the owner changes and the
 * copies go stale without anyone noticing. A deterministic scan finds the stale
 * copies the same way every time.
 *
 * Usage:
 *   node hub-check.js --registry <file.json>   run the check
 *   node hub-check.js --canary                 self-test
 *   anything else                              usage on stderr, exit 2
 *
 * Exit codes: 0 = clean, 1 = drift found, 2 = usage or registry error.
 *
 * Registry (JSON). All keys are required except skipPaths and extensions:
 *   {
 *     "roots":      ["<dir or file>", ...],  a leading "~" is the home directory;
 *                                            a missing root is a registry error
 *     "skipDirs":   ["node_modules", ".git"],  directory BASENAMES, never entered
 *     "skipPaths":  ["Archive", "docs/old/"],  default []; a file or directory
 *                                            whose forward-slash path contains
 *                                            one of these is skipped
 *     "extensions": [".md"],                 default [".md"]; case-insensitive
 *     "facts": [
 *       { "id": "team-size",                 unique
 *         "owner": "<path>",                 the hub file; "~" expands
 *         "kind": "value",                   or "forbid"
 *         "pattern": "team size:\\s*(\\d+)", JS regex source, flag i
 *         "expect": "7" }                    value kind only: capture group 1
 *     ]                                      of every match must equal this
 *   }                                        (trimmed, case-insensitive)
 *
 * Semantics, per fact:
 *   - Owner missing (or unreadable)  -> OWNER MISSING, counts as drift.
 *   - kind value: the owner needs at least one match whose group 1 equals
 *     expect, else OWNER MISMATCH (drift). The owner is never reported as a
 *     copy. kind forbid: the owner only has to exist.
 *   - Copies = every other file the walk reaches (deduplicated by resolved
 *     path, so overlapping roots never double-count). Each file is scanned line
 *     by line, every match on a line:
 *       value:  group 1 equals expect -> good copy; differs -> DRIFT
 *       forbid: any match -> DRIFT
 *   - Files that cannot be read are skipped and counted on an "unreadable: N"
 *     line (printed only when N is not 0). Symbolic links are not followed.
 *
 * Output (stdout): a header, one block per fact, and a final CLEAN or DRIFT
 * line. Paths are printed with forward slashes.
 *
 * Self-test: node hub-check.js --canary
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const USAGE =
  "usage: node hub-check.js --registry <file.json>\n" +
  "       node hub-check.js --canary\n";

class RegistryError extends Error {}

const toSlash = (p) => p.replace(/\\/g, "/");

// Windows paths differ by case only; compare without it there
const keyOf = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

function expandPath(p) {
  if (p === "~" || /^~[\\/]/.test(p)) return path.resolve(path.join(os.homedir(), p.slice(1)));
  return path.resolve(p);
}

// ---------------------------------------------------------------- registry

function loadRegistry(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new RegistryError(`cannot read registry file: ${e.message}`);
  }
  let j;
  try {
    j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (e) {
    throw new RegistryError(`invalid JSON: ${e.message}`);
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    throw new RegistryError("registry must be a JSON object");
  }

  const strList = (key, dflt) => {
    if (j[key] === undefined) {
      if (dflt === null) throw new RegistryError(`missing key: ${key}`);
      return dflt;
    }
    if (!Array.isArray(j[key]) || !j[key].every((s) => typeof s === "string")) {
      throw new RegistryError(`${key} must be an array of strings`);
    }
    return j[key];
  };

  const roots = strList("roots", null).map(expandPath);
  const skipDirs = strList("skipDirs", null);
  const skipPaths = strList("skipPaths", []);
  const extensions = strList("extensions", [".md"]).map((e) => e.toLowerCase());
  for (const r of roots) {
    if (!fs.existsSync(r)) throw new RegistryError(`root does not exist: ${toSlash(r)}`);
  }

  if (!Array.isArray(j.facts)) throw new RegistryError("missing key: facts (must be an array)");
  const ids = new Set();
  const facts = j.facts.map((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      throw new RegistryError(`facts[${i}] must be an object`);
    }
    for (const k of ["id", "owner", "kind", "pattern"]) {
      if (typeof f[k] !== "string" || f[k] === "") {
        throw new RegistryError(`facts[${i}]: missing or non-string key: ${k}`);
      }
    }
    if (ids.has(f.id)) throw new RegistryError(`duplicate fact id: ${f.id}`);
    ids.add(f.id);
    if (f.kind !== "value" && f.kind !== "forbid") {
      throw new RegistryError(`fact ${f.id}: kind must be "value" or "forbid", got "${f.kind}"`);
    }
    let re;
    let groups;
    try {
      re = new RegExp(f.pattern, "ig");
      // appending an empty alternative never changes the group count
      groups = new RegExp(f.pattern + "|", "i").exec("").length - 1;
    } catch (e) {
      throw new RegistryError(`fact ${f.id}: pattern does not compile: ${e.message}`);
    }
    if (f.kind === "value") {
      if (typeof f.expect !== "string") {
        throw new RegistryError(`fact ${f.id}: kind value requires a string "expect"`);
      }
      if (groups < 1) {
        throw new RegistryError(`fact ${f.id}: kind value requires a capture group in pattern`);
      }
    }
    return {
      id: f.id,
      kind: f.kind,
      re,
      expect: f.kind === "value" ? f.expect.trim().toLowerCase() : null,
      expectRaw: f.kind === "value" ? f.expect : null,
      ownerAbs: expandPath(f.owner),
    };
  });

  return { roots, skipDirs, skipPaths, extensions, facts };
}

// -------------------------------------------------------------------- walk

function collectFiles(reg) {
  const seen = new Set();
  const files = [];
  const skippedPath = (p, isDir) => {
    const s = toSlash(p) + (isDir ? "/" : "");
    return reg.skipPaths.some((x) => s.includes(x));
  };
  const wantExt = (p) => reg.extensions.includes(path.extname(p).toLowerCase());
  const addFile = (p) => {
    const k = keyOf(p);
    if (seen.has(k) || skippedPath(p, false) || !wantExt(p)) return;
    seen.add(k);
    files.push(p);
  };
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: nothing to scan below it
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (reg.skipDirs.includes(e.name) || skippedPath(p, true)) continue;
        walk(p);
      } else if (e.isFile()) {
        addFile(p);
      }
    }
  };
  for (const r of reg.roots) {
    let st;
    try { st = fs.statSync(r); } catch { continue; }
    if (st.isDirectory()) {
      if (!skippedPath(r, true)) walk(r);
    } else if (st.isFile()) {
      addFile(r);
    }
  }
  return files;
}

function readLines(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return (raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw).split(/\r?\n/);
  } catch {
    return null;
  }
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// ------------------------------------------------------------------- check

// returns { out: <stdout text>, drifted: <number of drifted facts> }
function runCheck(reg) {
  const entries = [];
  let unreadable = 0;
  for (const abs of collectFiles(reg)) {
    const lines = readLines(abs);
    if (lines === null) unreadable++;
    else entries.push({ key: keyOf(abs), slash: toSlash(abs), lines });
  }

  const out = [];
  out.push(`hub-check: ${reg.facts.length} fact(s), ${entries.length} file(s) scanned`);
  if (unreadable > 0) out.push(`unreadable: ${unreadable}`);

  let drifted = 0;
  for (const f of reg.facts) {
    let status;
    if (!isFile(f.ownerAbs)) {
      status = "MISSING";
    } else if (f.kind === "forbid") {
      status = "OK";
    } else {
      const lines = readLines(f.ownerAbs);
      if (lines === null) {
        status = "MISSING";
      } else {
        const hit = lines.some((line) =>
          Array.from(line.matchAll(f.re)).some((m) => (m[1] || "").trim().toLowerCase() === f.expect));
        status = hit ? "OK" : "MISMATCH";
      }
    }

    const ownerKey = keyOf(f.ownerAbs);
    let good = 0;
    const drifts = [];
    for (const ent of entries) {
      if (ent.key === ownerKey) continue;
      for (let i = 0; i < ent.lines.length; i++) {
        for (const m of ent.lines[i].matchAll(f.re)) {
          if (f.kind === "value") {
            const g1 = m[1] === undefined ? "" : m[1];
            if (g1.trim().toLowerCase() === f.expect) good++;
            else drifts.push(`    DRIFT ${ent.slash}:${i + 1}: found ${g1.trim()}, owner says ${f.expectRaw.trim()}`);
          } else {
            drifts.push(`    DRIFT ${ent.slash}:${i + 1}: found forbidden text: ${m[0].slice(0, 80)}`);
          }
        }
      }
    }

    out.push(`[${f.id}] owner ${status} - ${toSlash(f.ownerAbs)}; ${good} good cop(ies), ${drifts.length} drift`);
    for (const d of drifts) out.push(d);
    if (status !== "OK" || drifts.length > 0) drifted++;
  }

  out.push(drifted === 0 ? "hub-check: CLEAN" : `hub-check: DRIFT in ${drifted} fact(s)`);
  return { out: out.join("\n") + "\n", drifted };
}

// --------------------------------------------------------------------- CLI

function main(argv) {
  let regFile = null;
  if (argv.length === 2 && argv[0] === "--registry" && argv[1] !== "" && !argv[1].startsWith("--")) {
    regFile = argv[1];
  } else {
    process.stderr.write(USAGE);
    return 2;
  }
  let reg;
  try {
    reg = loadRegistry(regFile);
  } catch (e) {
    if (!(e instanceof RegistryError)) throw e;
    process.stderr.write(`hub-check: registry error: ${e.message}\n`);
    return 2;
  }
  const res = runCheck(reg);
  process.stdout.write(res.out);
  return res.drifted === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ canary

function runCanary() {
  const { spawnSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubcheck-"));
  let pass = 0;
  const TOTAL = 14;
  const check = (n, cond, why) => {
    if (cond) pass++;
    else console.log(`FAIL ${n}: ${why}`);
  };
  const put = (rel, text) => {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  const regFile = path.join(dir, "registry.json");
  const writeReg = (obj) => fs.writeFileSync(regFile, typeof obj === "string" ? obj : JSON.stringify(obj));
  const run = (args) => {
    const r = spawnSync(process.execPath, [__filename, ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
  };
  const runReg = () => run(["--registry", regFile]);
  const teamFact = (ownerPath) =>
    ({ id: "team-size", owner: ownerPath, kind: "value", pattern: "team size:\\s*(\\d+)", expect: "7" });

  try {
    const ownerPath = put("hub/owner.md", "# Hub\nTeam size: 7\n");
    const toolsPath = put("hub/tools.md", "Deploys need a review.\n");
    put("proj-a/notes.md", "# A\nTeam size: 7\n");
    put("proj-b/notes.md", "# B\n\nteam size: 5\n");
    put("proj-b/Project Record.md", "Team size: 4\n");
    put("proj-c/node_modules/x.md", "Team size: 3\n");
    const readmePath = put("proj-c/readme.md", "the bot auto-deploys without review\n");
    put("proj-c/data.txt", "Team size: 2\n");

    const registry = {
      roots: [dir],
      skipDirs: ["node_modules"],
      skipPaths: ["Project Record"],
      facts: [
        teamFact(ownerPath),
        { id: "no-unreviewed-deploys", owner: toolsPath, kind: "forbid", pattern: "auto-deploys without review" },
      ],
    };
    writeReg(registry);

    let r = runReg();
    check(1, r.code === 1, `expected exit 1, got ${r.code} (stderr: ${r.err.slice(0, 120)})`);
    check(2, /^ {4}DRIFT [^\n]*proj-b\/notes\.md:3: [^\n]*found 5, owner says 7$/m.test(r.out),
      `no DRIFT line for proj-b/notes.md:3 (got: ${r.out.slice(0, 300)})`);
    check(3, /^ {4}DRIFT [^\n]*proj-c\/readme\.md:1: [^\n]*forbidden/m.test(r.out),
      `no forbidden DRIFT line for proj-c/readme.md:1 (got: ${r.out.slice(0, 300)})`);
    check(4, !r.out.includes("Project Record"), "output mentions Project Record");
    check(5, !r.out.includes("node_modules"), "output mentions node_modules");
    check(6, !r.out.includes("data.txt"), "output mentions data.txt");
    check(7, /^\[team-size\] owner OK - [^\n]*; 1 good cop/m.test(r.out),
      `team-size block is not owner OK with 1 good copy (got: ${r.out.slice(0, 300)})`);

    // 8: fix the stale copy, drop the forbidden line
    put("proj-b/notes.md", "# B\n\nTeam size: 7\n");
    fs.writeFileSync(readmePath, "all fine here\n");
    r = runReg();
    check(8, r.code === 0 && r.out.trimEnd().endsWith("hub-check: CLEAN"),
      `expected exit 0 and CLEAN, got exit ${r.code}: ${r.out.slice(-200)}`);

    // 9: owner changes
    fs.writeFileSync(ownerPath, "# Hub\nTeam size: 8\n");
    r = runReg();
    check(9, r.code === 1 && /^\[team-size\] owner MISMATCH/m.test(r.out),
      `expected exit 1 and owner MISMATCH, got exit ${r.code}: ${r.out.slice(0, 300)}`);

    // 10: owner deleted
    fs.unlinkSync(ownerPath);
    r = runReg();
    check(10, r.code === 1 && /^\[team-size\] owner MISSING/m.test(r.out),
      `expected exit 1 and owner MISSING, got exit ${r.code}: ${r.out.slice(0, 300)}`);

    // 11-13: registry errors exit 2
    writeReg({ ...registry, facts: [{ id: "x", owner: toolsPath, kind: "bogus", pattern: "x" }] });
    r = runReg();
    check(11, r.code === 2 && r.err.length > 0, `bogus kind: expected exit 2 with stderr, got ${r.code}`);

    writeReg({ ...registry, facts: [{ id: "x", owner: toolsPath, kind: "value", pattern: "team size: \\d+", expect: "7" }] });
    r = runReg();
    check(12, r.code === 2 && r.err.length > 0, `no capture group: expected exit 2 with stderr, got ${r.code}`);

    writeReg("{ this is not json");
    r = runReg();
    check(13, r.code === 2 && r.err.length > 0, `invalid JSON: expected exit 2 with stderr, got ${r.code}`);

    // 14: --registry with no value
    r = run(["--registry"]);
    check(14, r.code === 2 && r.err.length > 0, `--registry with no value: expected exit 2 with stderr, got ${r.code}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const ok = pass === TOTAL;
  console.log(ok ? `CANARY PASS ${pass}/${TOTAL}` : `CANARY FAIL ${pass}/${TOTAL}`);
  return ok;
}

if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === "--canary") {
    process.exitCode = runCanary() ? 0 : 1;
  } else {
    // process.exitCode, not process.exit(): let stdout flush
    try {
      process.exitCode = main(process.argv.slice(2));
    } catch (e) {
      process.stderr.write(`hub-check: error: ${e && e.message ? e.message : e}\n`);
      process.exitCode = 2;
    }
  }
}
