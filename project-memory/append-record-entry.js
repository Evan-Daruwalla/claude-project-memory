#!/usr/bin/env node
/*
 * append-record-entry — the ONE way to append an appendix to an append-only
 * project record. Replaces hand-written splice scripts.
 *
 * WHY THIS EXISTS. §2 told sessions to `grep "^# Appendix"` for the last letter.
 * That is the correct instruction and it still failed, twice, in one week:
 *
 *   - A session derived "next letter" from the last entry IT had read rather
 *     than from the live file, and appended a duplicate "BM" over an entry three
 *     other sessions had written in between (record BT).
 *   - The guard meant to catch that matched the literal string `# Appendix BM -`
 *     (ASCII hyphen). The colliding entry used an em dash. The record currently
 *     holds both styles, so a literal-string duplicate check is structurally
 *     blind to exactly the collision it exists to prevent.
 *
 * Both are gate failures wearing a skill's clothes. The suite's own thesis —
 * skill the judgment, hook the gates — says this belongs in a script.
 *
 * WHAT IS MECHANICAL HERE (cannot be skipped by a model in a hurry):
 *   - the next letter is computed from a LIVE scan, never supplied by a caller
 *   - the duplicate check is dash-agnostic (-, en, em) so style drift cannot
 *     hide a collision
 *   - new headings are normalised to one dash style, so the drift stops
 *   - the TOC line lands after the LAST appendix line, found by scanning
 *   - after writing, four invariants are re-checked against disk and the write
 *     is rolled back if any fails
 *
 * USAGE
 *   node append-record-entry.js --record <path> --title "<t>" --body <file>
 *                               [--date "2026-08-19, ~16:41 CDT"] [--dry-run]
 *   node append-record-entry.js --record <path> --next-letter
 *   node append-record-entry.js --canary
 *
 * Exit: 0 ok · 1 refused (collision / invariant failure) · 2 usage error.
 *
 * SCOPE: records using `# Appendix <LETTERS> <dash> <title>` headings (the
 * a lettered-appendix project/Skills convention). Records using `## YYYY-MM-DD — <title>` sections
 * (a dated-section convention) are NOT handled — this refuses rather than
 * guessing, because silently appending in the wrong shape is worse than an abort.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// any dash a human or a model might type in a heading
const DASH = '[-‐‑‒–—―]';
const HEADING_RE = new RegExp('^# Appendix ([A-Z]+)\\s*' + DASH);
const CANON_DASH = '-';        // 65 of 72 existing headings use ASCII hyphen
const TOC_DASH = '—';     // TOC titles use an em dash (established pattern)

// ---- letters: bijective base-26, A..Z, AA, AB, ... BZ, CA ------------------
function letterToIndex(s) {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;                                   // A=1
}
function indexToLetter(n) {
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ---- slug: mirrors render_record_html.py's slugify EXACTLY -----------------
// Python: lower -> drop [^\w\s-] -> each \s becomes one hyphen.
// \p{L}\p{N}_ is the unicode-aware equivalent of Python's \w.
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/gu, '-');
}

// ---- scanning --------------------------------------------------------------
function scanAppendices(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) out.push({ letter: m[1], index: letterToIndex(m[1]), line: i, text: line });
  });
  return out;
}

function nextFreeLetter(text) {
  const found = scanAppendices(text);
  if (!found.length) return 'A';
  const max = found.reduce((a, b) => (b.index > a.index ? b : a));
  return indexToLetter(max.index + 1);
}

// ---- the append ------------------------------------------------------------
function appendEntry(opts) {
  const { recordPath, title, date, body, dryRun } = opts;
  const before = fs.readFileSync(recordPath, 'utf8');

  if (!HEADING_RE.test(before) && !/^# Appendix /m.test(before)) {
    return { ok: false, code: 2, msg: 'not an Appendix-style record (no "# Appendix" headings) — refusing rather than guessing the convention' };
  }

  const letter = nextFreeLetter(before);

  // dash-agnostic collision check on the letter we are about to use
  const dupe = new RegExp('^# Appendix ' + letter + '\\s*' + DASH, 'm');
  if (dupe.test(before)) {
    return { ok: false, code: 1, msg: `Appendix ${letter} already exists (any dash style) — refusing` };
  }

  const heading = `# Appendix ${letter} ${CANON_DASH} ${title} (${date})`;
  const slug = slugify(heading.replace(/^#\s*/, ''));
  const mmdd = (/(\d{4})-(\d{2})-(\d{2})/.exec(date) || [null, null, '??', '??']).slice(2).join('-');
  const tocLine = `- [${letter} ${TOC_DASH} ${title}](#${slug}) (${mmdd})`;

  // TOC line goes after the LAST appendix TOC line, located by scanning —
  // not after "the last one this session happens to know about".
  const lines = before.split('\n');
  let lastToc = -1;
  const tocRe = /^- \[([A-Z]+) /;
  lines.forEach((l, i) => { if (tocRe.test(l)) lastToc = i; });
  if (lastToc === -1) return { ok: false, code: 1, msg: 'no appendix TOC lines found — refusing to guess placement' };

  lines.splice(lastToc + 1, 0, tocLine);
  const after =
    lines.join('\n').replace(/\s*$/, '\n') + '\n' + heading + '\n' + body.replace(/^\n+/, '').replace(/\s*$/, '\n');

  if (dryRun) return { ok: true, letter, heading, tocLine, slug, dryRun: true };

  fs.writeFileSync(recordPath, after, 'utf8');

  const check = verifyInvariants(before, fs.readFileSync(recordPath, 'utf8'), letter);
  if (!check.ok) {
    fs.writeFileSync(recordPath, before, 'utf8');       // roll back
    return { ok: false, code: 1, msg: 'invariant failed AFTER write, rolled back: ' + check.msg };
  }
  return { ok: true, letter, heading, tocLine, slug };
}

// ---- invariants ------------------------------------------------------------
function verifyInvariants(before, after, letter) {
  const b = before.split('\n');
  const a = after.split('\n');

  // 1. append-only in the meaningful sense: every pre-existing line still
  //    present, in order (one TOC line inserted, body appended; nothing edited
  //    or deleted). A raw byte-prefix check cannot express this because the TOC
  //    insertion is mid-file by design.
  let i = 0;
  for (const line of b) {
    let found = false;
    while (i < a.length) { if (a[i++] === line) { found = true; break; } }
    if (!found) return { ok: false, msg: 'a pre-existing line was modified or removed' };
  }

  // 2. no duplicate letters, dash-agnostic
  const found = scanAppendices(after);
  const seen = new Set();
  for (const f of found) {
    if (seen.has(f.letter)) return { ok: false, msg: `duplicate Appendix ${f.letter}` };
    seen.add(f.letter);
  }

  // 3. letters strictly increasing in file order
  for (let k = 1; k < found.length; k++) {
    if (found[k].index <= found[k - 1].index) {
      return { ok: false, msg: `letters out of order: ${found[k - 1].letter} then ${found[k].letter}` };
    }
  }

  // 4. one TOC line per appendix heading
  const tocCount = a.filter((l) => /^- \[[A-Z]+ /.test(l)).length;
  if (tocCount !== found.length) {
    return { ok: false, msg: `TOC lines (${tocCount}) != appendix headings (${found.length})` };
  }

  if (!seen.has(letter)) return { ok: false, msg: `new letter ${letter} not present after write` };
  return { ok: true };
}

// ---- canary ----------------------------------------------------------------
function canary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log('  FAIL: ' + name); } };

  const mk = (entries) => {
    const toc = entries.map((e) => `- [${e.l} — ${e.t}](#x) (01-01)`).join('\n');
    const body = entries.map((e) => `# Appendix ${e.l} ${e.d} ${e.t} (2026-01-01, ~00:00 CST)\n\nbody ${e.l}\n`).join('\n');
    const p = path.join(dir, 'rec-' + Math.abs(letterToIndex(entries[entries.length - 1].l)) + '-' + pass + fail + '.md');
    fs.writeFileSync(p, `# Record\n\n# Table of Contents\n\n${toc}\n\n---\n\n${body}`, 'utf8');
    return p;
  };

  // 1. THE BM CASE: existing entry uses an em dash; next letter must see it
  const p1 = mk([{ l: 'BL', t: 'ascii one', d: '-' }, { l: 'BM', t: 'em dash one', d: '—' }]);
  t('next letter sees an em-dash heading (the BM collision)', nextFreeLetter(fs.readFileSync(p1, 'utf8')) === 'BN');

  // 2. and refuses to write over it even though styles differ
  const r2 = appendEntry({ recordPath: p1, title: 'new', date: '2026-01-02, ~00:00 CST', body: 'x\n' });
  t('append lands on BN, not a duplicate BM', r2.ok && r2.letter === 'BN');

  // 3. Z -> AA and BZ -> CA rollover
  t('Z rolls to AA', indexToLetter(letterToIndex('Z') + 1) === 'AA');
  t('BZ rolls to CA', indexToLetter(letterToIndex('BZ') + 1) === 'CA');
  t('letter round-trips', indexToLetter(letterToIndex('BT')) === 'BT');

  // 4. TOC line lands after the LAST toc line
  const after1 = fs.readFileSync(p1, 'utf8').split('\n');
  const tocIdx = after1.findIndex((l) => l.startsWith('- [BN '));
  const bmIdx = after1.findIndex((l) => l.startsWith('- [BM '));
  t('new TOC line follows the last existing TOC line', tocIdx > bmIdx && bmIdx !== -1);

  // 5. anchor matches the renderer's algorithm (em dash dropped, its spaces kept;
  //    ASCII hyphen kept — the two styles produce DIFFERENT anchors, which is
  //    itself why normalising the dash matters)
  t('slug drops em dash, keeps its spaces', slugify('Appendix BM — the fork (2026-01-01)') === 'appendix-bm--the-fork-2026-01-01');
  t('slug keeps ascii hyphen', slugify('Appendix BT - the fork (2026-01-01)') === 'appendix-bt---the-fork-2026-01-01');
  t('slug strips punctuation like the renderer', slugify('A, b: c~d (e)') === 'a-b-cd-e');

  // 6. append-only: every prior line survives
  const p6 = mk([{ l: 'A', t: 'first', d: '-' }]);
  const b6 = fs.readFileSync(p6, 'utf8');
  appendEntry({ recordPath: p6, title: 'second', date: '2026-01-02, ~00:00 CST', body: 'y\n' });
  const a6 = fs.readFileSync(p6, 'utf8');
  t('every pre-existing line survives the append', b6.split('\n').filter(Boolean).every((l) => a6.includes(l)));
  t('prior entry body still present', a6.includes('body A'));

  // 7. invariant catch: a doctored file with duplicate letters must be rejected
  const dupText = fs.readFileSync(p6, 'utf8') + '\n# Appendix A — sneaky dupe (2026-01-03, ~00:00 CST)\n';
  t('duplicate-letter invariant fires (dash-agnostic)', verifyInvariants(b6, dupText, 'B').ok === false);

  // 8. wrong-convention record is refused, not guessed at
  const p8 = path.join(dir, 'dated-section.md');
  fs.writeFileSync(p8, '# Record\n\n## 2026-01-01 — a section\n\nbody\n', 'utf8');
  const r8 = appendEntry({ recordPath: p8, title: 'x', date: '2026-01-02, ~00:00 CST', body: 'z\n' });
  t('non-Appendix record refused with exit 2', r8.ok === false && r8.code === 2);

  // 9. dry-run writes nothing
  const p9 = mk([{ l: 'A', t: 'only', d: '-' }]);
  const b9 = fs.readFileSync(p9, 'utf8');
  appendEntry({ recordPath: p9, title: 'nope', date: '2026-01-02, ~00:00 CST', body: 'q\n', dryRun: true });
  t('--dry-run leaves the file byte-identical', fs.readFileSync(p9, 'utf8') === b9);

  // 10. new heading is normalised to the canonical dash even in an em-dash file
  t('new heading uses the canonical ascii dash', fs.readFileSync(p1, 'utf8').includes('# Appendix BN - new'));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fail === 0 ? `CANARY PASS ${pass}/${pass + fail}` : `CANARY FAIL ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---- cli -------------------------------------------------------------------
function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = i + 1 < argv.length ? argv[i + 1] : null;
  if (v === null || v.startsWith('--')) {
    console.error(`error: ${flag} requires a value`);
    process.exit(2);
  }
  return v;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--canary')) return canary();

  const recordPath = getOpt(argv, '--record');
  if (!recordPath) { console.error('usage: --record <path> [--next-letter | --title <t> --body <file>]'); process.exit(2); }
  if (!fs.existsSync(recordPath)) { console.error('no such record: ' + recordPath); process.exit(2); }

  if (argv.includes('--next-letter')) {
    console.log(nextFreeLetter(fs.readFileSync(recordPath, 'utf8')));
    return;
  }

  const title = getOpt(argv, '--title');
  const bodyFile = getOpt(argv, '--body');
  if (!title || !bodyFile) { console.error('error: --title and --body are both required'); process.exit(2); }
  if (!fs.existsSync(bodyFile)) { console.error('no such body file: ' + bodyFile); process.exit(2); }

  const date = getOpt(argv, '--date');
  if (!date) { console.error('error: --date is required (e.g. "2026-08-19, ~16:41 CDT") — run `date` first, never guess it'); process.exit(2); }

  const res = appendEntry({
    recordPath,
    title,
    date,
    body: fs.readFileSync(bodyFile, 'utf8'),
    dryRun: argv.includes('--dry-run'),
  });

  if (!res.ok) { console.error('REFUSED: ' + res.msg); process.exit(res.code); }
  console.log(`${res.dryRun ? '[dry-run] ' : ''}Appendix ${res.letter}`);
  console.log('  heading: ' + res.heading);
  console.log('  toc    : ' + res.tocLine);
  console.log('  anchor : #' + res.slug);
  if (!res.dryRun) console.log('  invariants: append-only, no duplicate letters, letters ordered, TOC/heading counts match');
}

if (require.main === module) main();
module.exports = { letterToIndex, indexToLetter, slugify, nextFreeLetter, scanAppendices, appendEntry, verifyInvariants };
