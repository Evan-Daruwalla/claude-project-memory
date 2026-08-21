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
 *   - four invariants are checked BEFORE the file is touched, and the new text
 *     is published by temp-file + rename (there is no rollback path, because
 *     the rollback was itself the corruption — record BV.2)
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
// The trailing `\\s` is load-bearing. Without it, `\\s*` allowed ZERO spaces, so
// `# Appendix BR-note - CORRECTION to BR's claim` captured the letter `BR` with
// its own `-` serving as the dash — and a real record, which uses `X-note` as a
// deliberate correction convention, was reported as holding a duplicate `BR` and
// became permanently un-appendable. Requiring whitespace after the dash makes
// `BR-note` fall through to SUSPECT_RE instead, which refuses with the line
// number and the actual reason rather than libelling the record.
const HEADING_RE = new RegExp('^# Appendix ([A-Z]+)\\s*' + DASH + '\\s');
const CANON_DASH = '-';        // 65 of 72 existing headings use ASCII hyphen
const TOC_DASH = '—';     // TOC titles use an em dash (established pattern)

// A line that LOOKS like an appendix heading but does not match HEADING_RE is
// invisible to every check in this file — so nextFreeLetter can hand out a
// letter that already exists. Measured 2026-08-20: a record holding
// `# Appendix C: colon style` accepted a second `# Appendix C - ...`, and
// checkRecord then reported "3 appendices, letters unique and ordered, TOC
// balanced" over the duplicate. That is the BT collision reproduced through a
// style the dash-agnostic fix never covered. Both live records were checked
// before this landed: 0 suspect headings in either.
const SUSPECT_RE = /^#{1,2}\s+Appendix\s+[A-Za-z]+/;

// The record's line endings are whatever the checkout produced. `core.autocrlf`
// is true on this machine and no `.gitattributes` pins the record, so a fresh
// `git clone` yields CRLF — and building the new text with hardcoded '\n' then
// rewrote the last pre-existing line, tripping the append-only invariant on
// EVERY append. Verified: a CRLF record refused with "a pre-existing line was
// modified or removed" while the identical LF record appended fine.
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

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

// ---- slug: mirrors render_record_html.py's slugify for the headings we write -
// Python: lower -> drop [^\w\s-] -> each \s becomes one hyphen.
// \p{L}\p{N}_ is the unicode-aware equivalent of Python's \w.
//
// NOT "EXACTLY", as this comment claimed until 2026-08-20. Two real gaps: the
// Python side slugs the RENDERED heading (so markdown inline syntax — links,
// _emphasis_, <tags> — slugs differently), and it carries a cross-heading
// `used` counter that appends -1/-2 to duplicate titles, which a single-heading
// function structurally cannot reproduce. What IS measured: all 73 real
// headings match the twin's ids (record BU.3, re-verified in the 08-20 audit).
// Both gaps need markdown syntax or a duplicate title in the heading; the
// headings this script writes have neither.
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s/gu, '-');
}

// ---- scanning --------------------------------------------------------------
// Fenced blocks are skipped: entries quote heading formats in ``` blocks (BU
// does so today), and counting a quoted `# Appendix ZZ - example` as real
// wedges the record — every later append rolls back and every commit is
// blocked, because nextFreeLetter jumps past the quoted letter.
function scanAppendices(text) {
  const out = [];
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const m = HEADING_RE.exec(line);
    if (m) out.push({ letter: m[1], index: letterToIndex(m[1]), line: i, text: line });
  });
  return out;
}

// Appendix-shaped headings this file's regex cannot see. Fenced lines are
// excluded for the same reason as above.
function suspectHeadings(text) {
  const out = [];
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    if (SUSPECT_RE.test(line) && !HEADING_RE.test(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

// TOC lines, counted ONLY in the contiguous block before the first appendix
// heading. `^- \[[A-Z]+ ` also matches ordinary body bullets — `- [BLOCKED ON
// SOMEONE] need a key` is a real shape here — and one such bullet silently
// inflates the count, which then either blocks every commit or cancels out a
// genuinely missing TOC line.
// `\*{0,2}` because a TOC bullet may be BOLD. One real record writes 103
// of its 166 appendix bullets as `- [**J — …**](#…)`, so the plain-only pattern
// counted 63, compared that to 166 headings, and called a perfectly balanced
// record INVALID — blocking every append to the largest record on the machine
// (927,990 B). The record was right and the parser was wrong, which is the
// worse of the two ways to be wrong.
const TOC_LINE_RE = /^- \[\*{0,2}[A-Z]+ /;
function tocLines(text) {
  const lines = text.split('\n');
  const heads = scanAppendices(text);
  const limit = heads.length ? heads[0].line : lines.length;
  const out = [];
  for (let i = 0; i < limit; i++) if (TOC_LINE_RE.test(lines[i])) out.push(i);
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

  const eol = detectEol(before);

  // A record that is still a bootstrap skeleton has TOC-shaped lines and no
  // headings yet. templates.md §2 produces exactly that, so the FIRST entry of
  // every new project could not be scripted — forcing the hand-splice SKILL.md
  // §2 forbids. Accept it; refuse only a record that is neither shape.
  const hasHeadings = HEADING_RE.test(before) || /^# Appendix /m.test(before);
  const hasToc = tocLines(before).length > 0 || /^#+\s*Table of Contents/mi.test(before);
  if (!hasHeadings && !hasToc) {
    return { ok: false, code: 2, msg: 'not an Appendix-style record (no "# Appendix" headings and no TOC) — refusing rather than guessing the convention' };
  }

  // Refuse on an appendix-shaped heading this file cannot parse, BEFORE
  // choosing a letter — such a heading is invisible to nextFreeLetter and to
  // every invariant below, so continuing would write a duplicate letter under
  // a green verdict.
  const suspects = suspectHeadings(before);
  if (suspects.length) {
    return { ok: false, code: 1, msg: `unparseable appendix heading at line ${suspects[0].line}: "${suspects[0].text}" — it is invisible to the letter scan, so a duplicate could be written. Normalise it to "# Appendix <LETTERS> - <title>" first` };
  }

  if (/[\r\n]/.test(title)) {
    return { ok: false, code: 2, msg: 'title contains a line break — the TOC line and the heading would each split across two lines' };
  }

  const letter = nextFreeLetter(before);

  // Dash-agnostic collision check on the letter we are about to use. NOTE: with
  // nextFreeLetter returning max+1 over the very headings this regex matches,
  // this can never fire for a dash-style heading — it is a backstop for the
  // non-dash case, which is now refused above, and for a future caller that
  // supplies a letter instead of deriving one.
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
  const tocIdx = tocLines(before);
  let insertAt;
  if (tocIdx.length) {
    insertAt = tocIdx[tocIdx.length - 1] + 1;
  } else {
    // Bootstrap: a brand-new record has the "Table of Contents" heading and no
    // entries under it yet. Land the first line just below the heading rather
    // than refusing — refusing is what forced the hand-splice on entry A.
    const tocHead = lines.findIndex((l) => /^#+\s*Table of Contents/i.test(l));
    if (tocHead === -1) return { ok: false, code: 1, msg: 'no appendix TOC lines and no "Table of Contents" heading — refusing to guess placement' };
    let k = tocHead + 1;
    while (k < lines.length && lines[k].trim() === '') k++;
    insertAt = k;
  }

  // Carry the file's own line ending onto the inserted line: `lines` were split
  // on '\n', so under CRLF every element still ends in '\r' and a bare insert
  // would be the one LF line in a CRLF file.
  lines.splice(insertAt, 0, eol === '\r\n' ? tocLine + '\r' : tocLine);

  // Do NOT trim the existing text. The old `.replace(/\s*$/, '\n')` collapsed
  // the trailing run of whitespace, which under CRLF (or a record ending in
  // two blank lines) rewrote a pre-existing line and tripped the append-only
  // invariant on every append. Terminate the last line if it is not, and
  // otherwise leave the prior bytes exactly as they were.
  let base = lines.join('\n');
  if (!base.endsWith(eol)) base += eol;
  const bodyText = body
    .replace(/^\uFEFF/, '')                 // a BOM in --body splices mid-record
    .split(/\r?\n/).join(eol)               // match the record's convention
    .replace(/^(?:\r?\n)+/, '')
    .replace(/\s*$/, '') + eol;
  const after = base + eol + heading + eol + bodyText;

  // Verify BEFORE touching the file, then publish atomically.
  //
  // The previous shape was: writeFileSync -> re-read -> verify -> on failure
  // writeFileSync(before) to "roll back". Every part of that was a hazard:
  //   * writeFileSync truncates then writes, so a concurrent reader could
  //     observe a half-file and treat it as authoritative. Measured directly:
  //     an 8-way run on a 1,046,856-byte record was caught at 458,878 bytes
  //     mid-write, and destroyed files landed on exact 4096-byte boundaries.
  //   * the "rollback" wrote a STALE in-memory snapshot over whatever another
  //     process had since committed — the rollback WAS the corruption.
  //   * it printed "rolled back", which reads as no-harm-done at the exact
  //     moment it may have destroyed the record.
  // Measured destruction was bimodal and scaled with size: none below ~130KB,
  // ~25% of trials at 350KB, 3 of 5 trials at 433KB losing up to 146 of 164
  // appendices, 10/10 at 1MB. The real records are 336KB-914KB.
  //
  // Now: an O_EXCL lockfile makes read-modify-write mutually exclusive, and a
  // temp-file + rename publishes in one step. There is nothing to roll back —
  // either the new file lands whole or the old one is untouched.
  const check = verifyInvariants(before, after, letter);
  if (!check.ok) {
    return { ok: false, code: 1, msg: 'invariant failed, file NOT modified: ' + check.msg };
  }

  // --dry-run returns HERE, after the invariants, not before them. Returning
  // early meant a dry run reported full success — letter, heading, TOC line,
  // anchor, exit 0 — for three records whose real append then refused. A dry
  // run that disagrees with the real run is worse than no dry run: it is a
  // green light for something that cannot happen.
  if (dryRun) return { ok: true, letter, heading, tocLine, slug, dryRun: true };

  const lockPath = recordPath + '.lock';
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');            // O_EXCL: fails if held
    // Who holds it, and since when. The lock used to be a 0-byte file, so
    // "remove it if it is stale" was unanswerable: staleness was undecidable
    // from the only artifact available. Windows delivers TerminateProcess
    // uncatchably, so a killed append leaves one behind and every future append
    // to that project refuses FOREVER — and the natural remedy under pressure
    // is the hand-splice this whole script exists to prevent.
    fs.writeSync(lockFd, `${process.pid} ${new Date().toISOString()}\n`);
  } catch (e) {
    if (e.code === 'EEXIST') {
      let held = '';
      try {
        const info = fs.readFileSync(lockPath, 'utf8').trim();
        const [pid, iso] = info.split(/\s+/);
        const ageMin = iso ? Math.round((Date.now() - Date.parse(iso)) / 60000) : null;
        held = info
          ? ` — held by pid ${pid}${Number.isFinite(ageMin) ? ` since ${iso} (${ageMin} min ago)` : ''}`
          : ' — the lock file is EMPTY, so it predates this check and is almost certainly stale';
      } catch (_) { held = ' — could not read the lock file'; }
      return {
        ok: false, code: 1,
        msg: `another append is in progress (${lockPath})${held}. If that process is gone, delete the lock file and re-run.`,
      };
    }
    return { ok: false, code: 1, msg: 'could not take the append lock: ' + (e.code || e.message) };
  }

  const tmp = recordPath + '.' + process.pid + '.tmp';
  try {
    // Re-read under the lock: another process may have appended between our
    // first read and acquiring it. Refuse rather than clobber.
    const current = fs.readFileSync(recordPath, 'utf8');
    if (current !== before) {
      return { ok: false, code: 1, msg: 'the record changed while this entry was being prepared — nothing written; re-run to pick up the new letter' };
    }
    fs.writeFileSync(tmp, after, 'utf8');
    fs.renameSync(tmp, recordPath);                   // atomic publish
  } catch (e) {
    return { ok: false, code: 1, msg: 'append failed, record NOT modified: ' + (e.code || e.message) };
  } finally {
    // tmp is declared outside the try so it is always reachable here: a
    // transient rename failure would otherwise leave it orphaned beside the
    // record. Unlinking a file that was successfully renamed is a no-op.
    try { fs.unlinkSync(tmp); } catch (_) {}
    try { fs.closeSync(lockFd); } catch (_) {}
    try { fs.unlinkSync(lockPath); } catch (_) {}
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
  // Same rule as checkRecord's, deliberately. These two functions enforce the
  // SAME invariant and used to differ: checkRecord guarded on `hasTocBlock`
  // while this one — the path appendEntry actually takes — was unconditional,
  // and the comment explaining the relaxation named two records that the
  // relaxation never applied to. Two siblings disagreeing about one contract is
  // the bug class this file's own header is about.
  const tocCount = tocLines(after).length;
  const hasTocBlock = tocCount > 0 || /^#+\s*Table of Contents/mi.test(after);
  if (hasTocBlock && tocCount !== found.length) {
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

  // ---- 2026-08-20 audit: every assertion below pins a defect that shipped
  // green past the 15 above. They are the point of this block, not decoration.

  // 11. a CRLF record (what a fresh clone produces) must still be appendable
  const mkEol = (eol, entries) => {
    const toc = entries.map((e) => `- [${e.l} — ${e.t}](#x) (01-01)`).join(eol);
    const body = entries.map((e) => `# Appendix ${e.l} ${e.d} ${e.t} (2026-01-01, ~00:00 CST)${eol}${eol}body ${e.l}${eol}`).join(eol);
    const p = path.join(dir, 'eol-' + (eol === '\r\n' ? 'crlf' : 'lf') + '-' + pass + fail + '.md');
    fs.writeFileSync(p, `# Record${eol}${eol}# Table of Contents${eol}${eol}${toc}${eol}${eol}---${eol}${eol}${body}`, 'utf8');
    return p;
  };
  const pCrlf = mkEol('\r\n', [{ l: 'A', t: 'first', d: '-' }]);
  const bCrlf = fs.readFileSync(pCrlf, 'utf8');
  const rCrlf = appendEntry({ recordPath: pCrlf, title: 'second', date: '2026-01-02, ~00:00 CST', body: 'y\n' });
  t('CRLF record appends (a fresh clone is CRLF here)', rCrlf.ok === true && rCrlf.letter === 'B');
  const aCrlf = fs.readFileSync(pCrlf, 'utf8');
  t('CRLF record keeps every pre-existing line byte-for-byte', bCrlf.split('\r\n').every((l) => aCrlf.includes(l)));
  t('CRLF record gains no lone-LF line', !/[^\r]\n/.test(aCrlf.replace(/\r\n/g, '')));

  // 12. a record ending in several blank lines must not have them trimmed
  const pBlank = mkEol('\n', [{ l: 'A', t: 'first', d: '-' }]);
  fs.appendFileSync(pBlank, '\n\n\n');
  const bBlank = fs.readFileSync(pBlank, 'utf8');
  const rBlank = appendEntry({ recordPath: pBlank, title: 'second', date: '2026-01-02, ~00:00 CST', body: 'y\n' });
  t('record ending in blank lines still appends', rBlank.ok === true);
  t('trailing blank lines are not eaten', bBlank.endsWith('body A\n\n\n\n') && fs.readFileSync(pBlank, 'utf8').includes('body A\n\n\n\n'));

  // 13. an appendix-shaped heading the parser cannot see must REFUSE, not
  //     silently hand out a letter that already exists (measured: it wrote a
  //     second "# Appendix C" and called the result "letters unique")
  const pSus = path.join(dir, 'suspect.md');
  fs.writeFileSync(pSus,
    '# Record\n\n# Table of Contents\n\n- [A — first](#x) (01-01)\n- [B — second](#x) (01-01)\n\n---\n\n' +
    '# Appendix A - first (2026-01-01, ~00:00 CST)\n\nbody A\n\n' +
    '# Appendix B - second (2026-01-01, ~00:00 CST)\n\nbody B\n\n' +
    '# Appendix C: colon style (2026-01-01, ~00:00 CST)\n\nbody C\n', 'utf8');
  const bSus = fs.readFileSync(pSus, 'utf8');
  const rSus = appendEntry({ recordPath: pSus, title: 'dupe', date: '2026-01-02, ~00:00 CST', body: 'z\n' });
  t('non-dash appendix heading refuses the append', rSus.ok === false);
  t('non-dash heading leaves the record untouched', fs.readFileSync(pSus, 'utf8') === bSus);
  t('checkRecord calls a non-dash heading INVALID', checkRecord(bSus).ok === false);

  // 14. a heading quoted inside a fence is not a real appendix
  const pFence = mkEol('\n', [{ l: 'A', t: 'first', d: '-' }]);
  fs.appendFileSync(pFence, '\n```\n# Appendix ZZ - quoted example (2026-01-01, ~00:00 CST)\n```\n');
  t('a fenced heading does not move the next letter', nextFreeLetter(fs.readFileSync(pFence, 'utf8')) === 'B');
  t('a fenced heading does not unbalance the TOC', checkRecord(fs.readFileSync(pFence, 'utf8')).ok === true);

  // 15. a TOC-shaped bullet in a BODY must not be counted as a TOC line
  const pBullet = mkEol('\n', [{ l: 'A', t: 'first', d: '-' }]);
  fs.appendFileSync(pBullet, '\n- [BLOCKED ON SOMEONE] need a key\n');
  t('a body bullet is not counted as a TOC line', checkRecord(fs.readFileSync(pBullet, 'utf8')).ok === true);

  // 16. a bootstrap skeleton (TOC placeholder, no headings yet) must accept
  //     its FIRST entry — templates.md §2 produces exactly this shape
  const pBoot = path.join(dir, 'bootstrap.md');
  fs.writeFileSync(pBoot, '# Record\n\n# Table of Contents\n\n<!-- appendix links land here -->\n\n---\n', 'utf8');
  const rBoot = appendEntry({ recordPath: pBoot, title: 'first ever', date: '2026-01-01, ~00:00 CST', body: 'hello\n' });
  t('a bootstrap skeleton accepts its first entry', rBoot.ok === true && rBoot.letter === 'A');

  // 17. a title carrying a newline would split the heading and the TOC line
  const pNl = mkEol('\n', [{ l: 'A', t: 'first', d: '-' }]);
  t('a newline in the title is refused', appendEntry({ recordPath: pNl, title: 'one\ntwo', date: '2026-01-02, ~00:00 CST', body: 'x\n' }).ok === false);

  // 18. a BOM at the head of --body must not be spliced into the record
  const pBom = mkEol('\n', [{ l: 'A', t: 'first', d: '-' }]);
  appendEntry({ recordPath: pBom, title: 'bom', date: '2026-01-02, ~00:00 CST', body: '﻿body text\n' });
  t('a BOM in the body is stripped', !fs.readFileSync(pBom, 'utf8').includes('﻿'));

  // 19. checkRecord must not demand TOC balance from a record with no TOC at
  //     all (some records in this family are in that shape)
  t('a record with no TOC block is not called INVALID',
    checkRecord('# Appendix A - one (2026-01-01)\n\nbody\n\n# Appendix B - two (2026-01-02)\n\nbody\n').ok === true);

  // 20. a flag NAME is a missing value; a flag-LOOKING string is a real value
  t('KNOWN_FLAGS rejects a real flag as a value', KNOWN_FLAGS.has('--body') === true);
  t('a flag-looking title is not a known flag', KNOWN_FLAGS.has('--check mode added') === false);

  // ---- 2026-08-20 cold audit: this script REFUSED 3 of the 5 appendix-style
  // records on this machine, and two of those refusals were its own fault.

  // 21. BOLD TOC bullets. One real record writes 103 of its 166 appendix
  //     bullets as `- [**J — …**](#…)`; the plain-only pattern counted 63,
  //     compared that to 166 headings, and called a balanced record INVALID.
  const boldToc =
    '# Record\n\n# Table of Contents\n\n' +
    '- [A — plain](#x) (01-01)\n- [**B — bold**](#y) (01-02)\n\n---\n\n' +
    '# Appendix A - plain (2026-01-01, ~00:00 CST)\n\nbody A\n\n' +
    '# Appendix B - bold (2026-01-02, ~00:00 CST)\n\nbody B\n';
  t('a BOLD TOC bullet is counted', tocLines(boldToc).length === 2);
  t('a record with bold TOC bullets is valid', checkRecord(boldToc).ok === true);

  // 22. `# Appendix BR-note` must NOT read as a duplicate `BR`. `\s*` before the
  //     dash let the letter's own hyphen serve as the dash, so a real
  //     correction convention was reported as record corruption.
  const noteRec =
    '# Record\n\n# Table of Contents\n\n- [BR — one](#x) (01-01)\n\n---\n\n' +
    '# Appendix BR - one (2026-01-01, ~00:00 CST)\n\nbody\n\n' +
    '# Appendix BR-note - CORRECTION to BR (2026-01-01, ~00:10 CST)\n\nfix\n';
  t('BR-note does not parse as the letter BR', scanAppendices(noteRec).length === 1);
  const noteVerdict = checkRecord(noteRec);
  t('BR-note is refused as UNPARSEABLE, not as a duplicate',
    noteVerdict.ok === false && /unparseable/.test(noteVerdict.msg) && !/duplicate/.test(noteVerdict.msg));
  t('a normal dashed heading still parses', scanAppendices('# Appendix BS - fine (2026-01-01)\n').length === 1);

  // 23. --dry-run must agree with the real run. It returned BEFORE the
  //     invariants, so it reported full success for records the real append
  //     then refused — a green light for something that cannot happen.
  const pDry = path.join(dir, 'dryrun-disagree.md');
  fs.writeFileSync(pDry,
    '# Record\n\n# Table of Contents\n\n- [A — one](#x) (01-01)\n\n---\n\n' +
    '# Appendix A - one (2026-01-01, ~00:00 CST)\n\nbody\n\n' +
    '# Appendix C: colon style (2026-01-01, ~00:00 CST)\n\nbody C\n', 'utf8');
  const dryV = appendEntry({ recordPath: pDry, title: 'x', date: '2026-01-02, ~00:00 CST', body: 'b\n', dryRun: true });
  const realV = appendEntry({ recordPath: pDry, title: 'x', date: '2026-01-02, ~00:00 CST', body: 'b\n' });
  t('--dry-run agrees with the real run', dryV.ok === realV.ok);
  t('...and both refuse this record', dryV.ok === false && realV.ok === false);
  // and on a HEALTHY record a dry run still succeeds and still writes nothing
  const pDryOk = mkEol('\n', [{ l: 'A', t: 'first', d: '-' }]);
  const bDryOk = fs.readFileSync(pDryOk, 'utf8');
  const dryOk = appendEntry({ recordPath: pDryOk, title: 'x', date: '2026-01-02, ~00:00 CST', body: 'b\n', dryRun: true });
  t('--dry-run still succeeds on a healthy record', dryOk.ok === true && dryOk.dryRun === true);
  t('--dry-run still writes nothing', fs.readFileSync(pDryOk, 'utf8') === bDryOk);

  // 24. the lock must say WHO holds it and SINCE WHEN, or "remove it if it is
  //     stale" is unanswerable — and a Windows kill leaves one behind.
  const pLock = mkEol('\n', [{ l: 'A', t: 'first', d: '-' }]);
  fs.writeFileSync(pLock + '.lock', '', 'utf8');                 // 0-byte, the old shape
  const emptyLock = appendEntry({ recordPath: pLock, title: 'x', date: '2026-01-02, ~00:00 CST', body: 'b\n' });
  t('an EMPTY lock is called out as almost certainly stale',
    emptyLock.ok === false && /EMPTY/.test(emptyLock.msg));
  fs.writeFileSync(pLock + '.lock', `4242 ${new Date(Date.now() - 3600000).toISOString()}\n`, 'utf8');
  const agedLock = appendEntry({ recordPath: pLock, title: 'x', date: '2026-01-02, ~00:00 CST', body: 'b\n' });
  t('a held lock reports the pid and the age',
    agedLock.ok === false && /pid 4242/.test(agedLock.msg) && /min ago/.test(agedLock.msg));
  fs.unlinkSync(pLock + '.lock');
  const freeLock = appendEntry({ recordPath: pLock, title: 'x', date: '2026-01-02, ~00:00 CST', body: 'b\n' });
  t('with the lock gone the append proceeds', freeLock.ok === true);
  t('the lock file is not left behind', !fs.existsSync(pLock + '.lock'));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fail === 0 ? `CANARY PASS ${pass}/${pass + fail}` : `CANARY FAIL ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
}


// ---- standalone check (what the pre-commit hook calls) ---------------------
// Validates a record file on its own terms, and — when a prior version is given
// — that the new one only ADDED to it. This is the same logic appendEntry()
// re-checks after writing, exposed so a gate can enforce it on a record that
// was edited by hand, by another tool, or by a session that skipped the script.
function checkRecord(text, priorText) {
  // The append-only comparison runs FIRST. Returning "nothing to check" before
  // looking at priorText meant a DELETED or emptied record passed the gate:
  // `git show` of a staged deletion yields a 0-byte file, which has no
  // headings, so the fail-closed pre-commit step printed "record invariants OK"
  // and allowed the record to be destroyed.
  if (priorText != null) {
    const pb = priorText.split('\n');
    const pa = text.split('\n');
    let pi = 0;
    for (const line of pb) {
      let ok = false;
      while (pi < pa.length) { if (pa[pi++] === line) { ok = true; break; } }
      if (!ok) {
        return { ok: false, msg: 'APPEND-ONLY VIOLATION: a previously committed line was modified or removed' };
      }
    }
  }

  // An appendix-shaped heading this file cannot parse is invisible to every
  // check below, so a duplicate letter passes as "unique and ordered". Fail on
  // it rather than certifying a record we cannot actually read.
  const suspects = suspectHeadings(text);
  if (suspects.length) {
    return { ok: false, msg: `unparseable appendix heading at line ${suspects[0].line}: "${suspects[0].text}" — normalise it to "# Appendix <LETTERS> - <title>"; letters cannot be checked while it is invisible to the scan` };
  }

  const found = scanAppendices(text);
  if (!found.length) return { ok: true, msg: 'no appendix headings — nothing to check' };

  const seen = new Set();
  for (const f of found) {
    if (seen.has(f.letter)) {
      return { ok: false, msg: `duplicate Appendix ${f.letter} (dash style is ignored — two entries share a letter)` };
    }
    seen.add(f.letter);
  }
  for (let k = 1; k < found.length; k++) {
    if (found[k].index <= found[k - 1].index) {
      return { ok: false, msg: `appendix letters out of order: ${found[k - 1].letter} appears before ${found[k].letter}` };
    }
  }
  // A record that carries no TOC block at all is not using one; demanding
  // balance there would block every commit in that repo over a convention it
  // never adopted. A record that HAS a TOC must keep it balanced — that is the
  // case this invariant exists for.
  //
  // The comment here used to justify this by naming two records as beneficiaries
  // of the relaxation. It never applied to either: both HAVE TOC blocks, so
  // `hasTocBlock` was true and the guard never fired for them. What was actually
  // wrong in those two was the PARSER — a bold-bullet TOC and an `X-note`
  // heading, both fixed above. A comment that explains a behaviour the code does
  // not have is worse than no comment; verified 2026-08-20.
  const tocCount = tocLines(text).length;
  const hasTocBlock = tocCount > 0 || /^#+\s*Table of Contents/mi.test(text);
  if (hasTocBlock && tocCount !== found.length) {
    return { ok: false, msg: `TOC lines (${tocCount}) != appendix headings (${found.length}) — an entry is missing its TOC line, or vice versa` };
  }

  const tocMsg = hasTocBlock ? 'TOC balanced' : 'no TOC block in use';
  return { ok: true, msg: `${found.length} appendices, letters unique and ordered, ${tocMsg}${priorText != null ? ', append-only preserved' : ''}` };
}

// ---- cli -------------------------------------------------------------------
// Every flag this script understands. A `--`-leading VALUE is only rejected
// when it is one of these — `--title "--check mode added"` is a legitimate
// title and used to be unusable, while `--title --body x.md` (a genuinely
// missing value) still errors.
const KNOWN_FLAGS = new Set([
  '--record', '--title', '--date', '--body', '--check', '--against',
  '--canary', '--next-letter', '--dry-run',
]);

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = i + 1 < argv.length ? argv[i + 1] : null;
  if (v === null || KNOWN_FLAGS.has(v)) {
    console.error(`error: ${flag} requires a value`);
    process.exit(2);
  }
  return v;
}

// fs.readFileSync on a DIRECTORY throws EISDIR as an uncaught exception, so a
// mistyped path blocked a commit with a raw Node stack trace instead of a
// message. Every caller here wants the same behaviour: name the file, exit 2.
function readOrExit(p, what) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    console.error(`error: cannot read ${what} ${p}: ${e.code || e.message}`);
    process.exit(2);
  }
}

function main() {
  const argv = process.argv.slice(2);
  // Mode flags are only honoured in a POSITION that is not a flag's value.
  // `argv.includes('--canary')` let `--title "--canary"` run the self-test and
  // exit 0 having appended nothing — a success exit on a silent no-op.
  const VALUE_FLAGS = new Set(['--record', '--title', '--date', '--body', '--check', '--against']);
  const positional = argv.filter((a, i) => !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
  if (positional.includes('--canary')) return canary();

  // --check <file> [--against <prior>] : verify a record, write nothing.
  const checkPath = getOpt(argv, '--check');
  if (checkPath) {
    if (!fs.existsSync(checkPath)) { console.error('no such file: ' + checkPath); process.exit(2); }
    const againstPath = positional.includes('--against') ? getOpt(argv, '--against') : null;
    if (againstPath && !fs.existsSync(againstPath)) { console.error('no such file: ' + againstPath); process.exit(2); }
    const res = checkRecord(
      readOrExit(checkPath, 'record'),
      againstPath ? readOrExit(againstPath, 'prior record') : null
    );
    console.log((res.ok ? 'record OK: ' : 'record INVALID: ') + res.msg);
    process.exit(res.ok ? 0 : 1);
  }

  const recordPath = getOpt(argv, '--record');
  if (!recordPath) { console.error('usage: --record <path> [--next-letter | --title <t> --body <file>]'); process.exit(2); }
  if (!fs.existsSync(recordPath)) { console.error('no such record: ' + recordPath); process.exit(2); }
  if (fs.statSync(recordPath).isDirectory()) { console.error('error: --record is a directory, not a file: ' + recordPath); process.exit(2); }

  if (positional.includes('--next-letter')) {
    console.log(nextFreeLetter(readOrExit(recordPath, 'record')));
    return;
  }

  const title = getOpt(argv, '--title');
  const bodyFile = getOpt(argv, '--body');
  if (!title || !bodyFile) { console.error('error: --title and --body are both required'); process.exit(2); }
  if (!fs.existsSync(bodyFile)) { console.error('no such body file: ' + bodyFile); process.exit(2); }

  const date = getOpt(argv, '--date');
  if (!date) { console.error('error: --date is required (e.g. "2026-08-19, ~16:41 CDT") — run `date` first, never guess it'); process.exit(2); }
  // --date went straight into the heading unvalidated, and the TOC's month-day
  // silently degraded to (??-??). `19-08-2026`, `Aug 19 2026` and `not a date at
  // all` were all accepted. That abuts the standing never-invent-timestamps
  // rule from the wrong side: a wrong date is worse than a refused one.
  const dm = /(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!dm) {
    console.error(`error: --date must contain an ISO date (YYYY-MM-DD); got "${date}". Run \`date\` and use its real output.`);
    process.exit(2);
  }
  if (+dm[2] < 1 || +dm[2] > 12 || +dm[3] < 1 || +dm[3] > 31) {
    console.error(`error: --date has an impossible month/day: ${dm[0]}`);
    process.exit(2);
  }

  const res = appendEntry({
    recordPath,
    title,
    date,
    body: readOrExit(bodyFile, 'body file'),
    dryRun: positional.includes('--dry-run'),
  });

  if (!res.ok) { console.error('REFUSED: ' + res.msg); process.exit(res.code); }
  console.log(`${res.dryRun ? '[dry-run] ' : ''}Appendix ${res.letter}`);
  console.log('  heading: ' + res.heading);
  console.log('  toc    : ' + res.tocLine);
  console.log('  anchor : #' + res.slug);
  if (!res.dryRun) console.log('  invariants: append-only, no duplicate letters, letters ordered, TOC/heading counts match');
}

if (require.main === module) main();
module.exports = { checkRecord, letterToIndex, indexToLetter, slugify, nextFreeLetter, scanAppendices, appendEntry, verifyInvariants };
