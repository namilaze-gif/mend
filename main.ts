// main.ts is mend, the CLI SPEC.md specifies (MIT starter + sections 5-8 implemented here).
// It does sections 1 to 10 of SPEC.md: the command line, the output and exit codes, safe paths,
// format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as (old path, new path); used for the `R` output lines. */
  moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in lines at the given tier (occurrences may overlap). */
function occurrencesAt(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (normLine(lines[i + k]!, tier) !== nO[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `cursor` equal to the anchor (a single line) at the first tier with one. */
function findAnchor(anchor: string, lines: string[], strict: boolean, cursor: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = normLine(anchor, t);
    for (let i = cursor; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === a) return i;
    }
  }
  return null;
}

/**
 * Tier-2 re-indentation (SPEC.md section 5, literal): F is the leading spaces and tabs of the
 * file's first matched line, P those of O's first line. A line that is not empty and not only
 * whitespace, and starts with P, has that P replaced by F; any other line is written as it is.
 * (Practice u-indent: N line "  } // page" starts with P="  " -> F + "} // page" = "} // page"
 * with F="". A line that does NOT start with P is NOT shifted: it is written as it is.)
 */
function reindent(line: string, F: string, P: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

type OpKind = 'ctx' | 'del' | 'add' | 'bs';
interface Op {
  kind: OpKind;
  text: string;
}

/** O (old lines) and N (new lines) of a hunk or chunk, with each N line's context mapping. */
interface ON {
  o: string[];
  n: string[];
  nCtx: boolean[];
  nCtxOIdx: number[];
}

function opsToON(ops: Op[]): ON {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  const nCtxOIdx: number[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      o.push(op.text);
      nCtxOIdx.push(o.length - 1);
      n.push(op.text);
      nCtx.push(true);
    } else if (op.kind === 'del') {
      o.push(op.text);
    } else if (op.kind === 'add') {
      n.push(op.text);
      nCtx.push(false);
      nCtxOIdx.push(-1);
    }
    // 'bs' lines carry no content.
  }
  return { o, n, nCtx, nCtxOIdx };
}

/** Build N's lines for a match at `pos`: context lines are the file's own lines; tier 2 re-indents the rest. */
function buildNew(on: ON, fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const F = leadingWS(fileLines[pos] ?? '');
  const P = leadingWS(on.o[0] ?? '');
  for (let i = 0; i < on.n.length; i++) {
    if (on.nCtx[i]) {
      out.push(fileLines[pos + on.nCtxOIdx[i]]!);
      continue;
    }
    const line = on.n[i]!;
    out.push(tier === 2 ? reindent(line, F, P) : line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start line A (1-based) from the hunk header. */
  a: number;
  ops: Op[];
  /** Whether a `\` line follows the hunk's last context or `+` line. */
  backslashAfterLast: boolean;
}

type SectionKind = 'create' | 'delete' | 'move' | 'change';

interface Section {
  kind: SectionKind;
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
  /** Whether a `\` line follows the section's last `+` line (for creations). */
  createNoFinal: boolean;
}

function cleanHeaderPath(raw: string): string {
  return raw.split('\t')[0]!.trim();
}

function stripABPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPathOrNull(raw: string): string | null {
  const p = cleanHeaderPath(raw);
  return p === '/dev/null' ? null : stripABPrefix(p);
}

/** `diff --git a/<X> b/<Y>` paths, or null when the line is not of that form. */
function diffGitPaths(l: string): [string, string] | null {
  const parts = l.trimEnd().split(' ');
  if (parts.length !== 4 || parts[0] !== 'diff' || parts[1] !== '--git') return null;
  if (!parts[2]!.startsWith('a/') || parts[2]!.length <= 2) return null;
  if (!parts[3]!.startsWith('b/') || parts[3]!.length <= 2) return null;
  return [parts[2]!.slice(2), parts[3]!.slice(2)];
}

/** The old start A of a hunk header line, or null when it is not a valid hunk header. */
function hunkHeaderA(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  return m === null ? null : Number(m[1]);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  const isDiffGit = (l: string): boolean => l.startsWith('diff --git ');
  const isSectionStart = (idx: number): boolean => {
    if (idx >= n) return false;
    if (isDiffGit(lines[idx]!)) return true;
    return lines[idx]!.startsWith('--- ') && idx + 1 < n && lines[idx + 1]!.startsWith('+++ ');
  };

  /** Parse one section starting at `start`; return the index of the next section (or n). */
  const parseSection = (start: number, dg: [string, string] | null): number => {
    let idx = start;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let havePair = false;
    let newFileMode = false;
    let deletedFileMode = false;
    const hunks: Hunk[] = [];
    if (dg !== null) idx += 1;
    let inHeader = true;

    const kind = (): SectionKind => {
      if (newFileMode || oldPath === null) return 'create';
      if (deletedFileMode || newPath === null) return 'delete';
      if (oldPath !== newPath) return 'move';
      return 'change';
    };

    /** Read one hunk body at idx (idx points at the header line); consume it and return the hunk. */
    const readHunk = (): Hunk => {
      const a = hunkHeaderA(lines[idx]!);
      if (a === null) throw new Exit2(`error: parse ${idx + 1}`);
      idx += 1;
      const ops: Op[] = [];
      while (idx < n) {
        const l = lines[idx]!;
        if (isDiffGit(l)) break;
        if (l.startsWith('--- ') && idx + 1 < n && lines[idx + 1]!.startsWith('+++ ')) break;
        if (l.startsWith(' ')) {
          ops.push({ kind: 'ctx', text: l.slice(1) });
          idx += 1;
        } else if (l.startsWith('-')) {
          ops.push({ kind: 'del', text: l.slice(1) });
          idx += 1;
        } else if (l.startsWith('+')) {
          ops.push({ kind: 'add', text: l.slice(1) });
          idx += 1;
        } else if (l.startsWith('\\')) {
          ops.push({ kind: 'bs', text: l.slice(1) });
          idx += 1;
        } else if (l === '') {
          ops.push({ kind: 'ctx', text: '' });
          idx += 1;
        } else break;
      }
      while (ops.length > 0) {
        const last = ops[ops.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') ops.pop();
        else break;
      }
      let backslashAfterLast = false;
      for (let k = ops.length - 1; k >= 0; k--) {
        if (ops[k]!.kind === 'ctx' || ops[k]!.kind === 'add') {
          backslashAfterLast = k + 1 < ops.length && ops[k + 1]!.kind === 'bs';
          break;
        }
      }
      return { a, ops, backslashAfterLast };
    };

    while (idx < n) {
      const line = lines[idx]!;
      if (inHeader) {
        if (line.startsWith('--- ')) {
          // A second `--- `+`+++ ` pair is not part of this section's header: it starts
          // the next section (SPEC.md section 6: a section starts at a pair "not already
          // part of a section's header"). Without this, a no-hunk section would swallow
          // the next section's paths and hunks. A lone `--- ` here is still a parse error.
          if (havePair) {
            if (idx + 1 < n && lines[idx + 1]!.startsWith('+++ ')) break;
            throw new Exit2(`error: parse ${idx + 2}`);
          }
          if (idx + 1 >= n || !lines[idx + 1]!.startsWith('+++ ')) throw new Exit2(`error: parse ${idx + 2}`);
          oldPath = headerPathOrNull(line.slice(4));
          newPath = headerPathOrNull(lines[idx + 1]!.slice(4));
          havePair = true;
          idx += 2;
          continue;
        }
        if (line.startsWith('rename from ')) {
          renameFrom = line.slice('rename from '.length).trim();
          idx += 1;
          continue;
        }
        if (line.startsWith('rename to ')) {
          renameTo = line.slice('rename to '.length).trim();
          idx += 1;
          continue;
        }
        if (line.startsWith('new file mode')) {
          newFileMode = true;
          idx += 1;
          continue;
        }
        if (line.startsWith('deleted file mode')) {
          deletedFileMode = true;
          idx += 1;
          continue;
        }
        if (line.startsWith('@@')) {
          inHeader = false;
          if (kind() === 'delete') {
            // A deletion's hunks are not read: skip to the next section.
            while (idx < n && !isSectionStart(idx)) idx += 1;
            break;
          }
          hunks.push(readHunk());
          continue;
        }
        if (isDiffGit(line)) {
          if (diffGitPaths(line) === null) throw new Exit2(`error: parse ${idx + 1}`);
          break;
        }
        idx += 1; // any other header line is ignored
        continue;
      }
      // After a hunk body: a new section, a new hunk, or ignored prose.
      if (isSectionStart(idx)) break;
      if (line.startsWith('@@')) {
        if (kind() === 'delete') {
          while (idx < n && !isSectionStart(idx)) idx += 1;
          break;
        }
        hunks.push(readHunk());
        continue;
      }
      idx += 1;
    }

    if (!havePair) {
      if (renameFrom !== null) oldPath = renameFrom;
      else if (dg !== null) oldPath = dg[0];
      if (renameTo !== null) newPath = renameTo;
      else if (dg !== null) newPath = dg[1];
    }
    // Whether a `\` line follows the section's last `+` line (for creations).
    let createNoFinal = false;
    for (const h of hunks) {
      for (let k = 0; k < h.ops.length; k++) {
        if (h.ops[k]!.kind === 'add') {
          createNoFinal = k + 1 < h.ops.length && h.ops[k + 1]!.kind === 'bs';
        }
      }
    }
    const sec: Section = { kind: kind(), oldPath, newPath, hunks, createNoFinal };
    edits.push(sectionEdit(sec, strict));
    return idx;
  };

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const dg = diffGitPaths(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseSection(i, dg);
    } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      i = parseSection(i, null);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
    } else {
      i += 1; // prose before the first section
    }
  }
  return edits;
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const on = opsToON(h.ops);
    if (on.o.length > 0) {
      const found = findTier(on.o, f.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const pos = best;
      const runsToEnd = pos + on.o.length === f.lines.length;
      const rep = buildNew(on, f.lines, pos, found.tier);
      f.lines.splice(pos, on.o.length, ...rep);
      if (runsToEnd) f.final = !h.backslashAfterLast;
      d += on.n.length - on.o.length;
    } else {
      // Empty O: insert N after the first A+d lines (all of them when the file has fewer).
      const insertAt = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = insertAt === f.lines.length;
      f.lines.splice(insertAt, 0, ...on.n);
      if (atEnd) f.final = !h.backslashAfterLast;
      d += on.n.length;
    }
  }
  return joinFile(f);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'create') {
      const p = sec.newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'add') out.push(op.text);
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (sec.createNoFinal ? '' : '\n'));
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.kind === 'move') {
      const o = sec.oldPath ?? '';
      const np = sec.newPath ?? '';
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(before, sec.hunks, strict, o);
      tree.now.set(np, result);
      tree.now.set(o, null);
      tree.moves.push([o, np]);
      return;
    }
    const p = sec.oldPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(oldLines, f.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const on: ON = { o: oldLines, n: newLines, nCtx: newLines.map(() => false), nCtxOIdx: newLines.map(() => -1) };
    const rep = buildNew(on, f.lines, pos, found.tier);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (sep === -1 && t === '=======') {
        sep = j;
        continue;
      }
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (sep === -1 || end === -1 || sep > end) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  /** Anchor text after `@@` (trimmed), or null when the chunk has no anchor. */
  anchor: string | null;
  /** True when the chunk is closed by `*** End of File` (anchored to the end of the file). */
  eof: boolean;
  ops: Op[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const endIdx = last;
  const edits: Edit[] = [];

  /** Section content lines (with their 0-based indices) up to the next section start or End Patch. */
  const collectContent = (start: number): [[string, number][], number] => {
    const out: [string, number][] = [];
    let j = start;
    while (j < endIdx && !isV4aSectionStart(lines[j]!)) {
      out.push([lines[j]!, j]);
      j += 1;
    }
    while (out.length > 0 && blank(out[out.length - 1]![0])) out.pop();
    return [out, j];
  };

  const addEdit = (path: string, fileLines: string[]): Edit => {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  };
  const deleteEdit = (path: string): Edit => {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  };

  /** Parse an Update File section's chunks from its content lines. */
  const parseUpdateChunks = (content: [string, number][], updateLineNo: number): { moveTo: string | null; chunks: VChunk[] } => {
    let k = 0;
    let moveTo: string | null = null;
    if (content.length > 0 && content[0]![0].startsWith('*** Move to: ')) {
      moveTo = content[0]![0].slice('*** Move to: '.length).trim();
      k = 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    const closeChunk = (): void => {
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
    };
    for (; k < content.length; k++) {
      const [l, idx] = content[k]!;
      if (l.startsWith('@@')) {
        closeChunk();
        // SPEC.md section 8: an empty text after `@@` is no anchor (not an empty-string anchor).
        const anchorText = l.slice(2).trim();
        cur = { anchor: anchorText === '' ? null : anchorText, eof: false, ops: [] };
      } else if (l === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
        cur.eof = true;
        closeChunk();
      } else if (l.startsWith('*** ')) {
        throw new Exit2(`error: parse ${idx + 1}`);
      } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
          cur = { anchor: null, eof: false, ops: [] };
        }
        if (l === '') cur.ops.push({ kind: 'ctx', text: '' });
        else if (l.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: l.slice(1) });
        else if (l.startsWith('-')) cur.ops.push({ kind: 'del', text: l.slice(1) });
        else cur.ops.push({ kind: 'add', text: l.slice(1) });
      } else {
        throw new Exit2(`error: parse ${idx + 1}`);
      }
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
    return { moveTo, chunks };
  };

  const updateEdit = (path: string, moveTo: string | null, chunks: VChunk[]): Edit => {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const f = splitFile(before);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const at = findAnchor(ch.anchor, f.lines, strict, cursor);
          if (at === null) throw new Fail('no-match', path);
          cursor = at + 1;
        }
        const on = opsToON(ch.ops);
        if (on.o.length === 0) {
          const insertAt = ch.eof ? f.lines.length : cursor;
          f.lines.splice(insertAt, 0, ...on.n);
          cursor = insertAt + on.n.length;
        } else {
          const tiers = strict ? [0] : [0, 1, 2];
          let found: { tier: number; pos: number } | null = null;
          for (const t of tiers) {
            const occ = occurrencesAt(on.o, f.lines, t, cursor).filter((pos) => !ch.eof || pos + on.o.length === f.lines.length);
            if (occ.length > 0) {
              found = { tier: t, pos: occ[0]! };
              break;
            }
          }
          if (found === null) throw new Fail('no-match', path);
          const rep = buildNew(on, f.lines, found.pos, found.tier);
          f.lines.splice(found.pos, on.o.length, ...rep);
          cursor = found.pos + rep.length;
        }
      }
      const result = joinFile(f);
      if (moveTo !== null) {
        tree.now.set(moveTo, result);
        tree.now.set(path, null);
        tree.moves.push([path, moveTo]);
      } else {
        tree.now.set(path, result);
      }
    };
  };

  let i = first + 1;
  while (i < endIdx) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i += 1;
      const [content, nextI] = collectContent(i);
      i = nextI;
      const fileLines: string[] = [];
      for (const [cl, idx] of content) {
        if (cl.startsWith('+')) fileLines.push(cl.slice(1));
        else if (cl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(addEdit(p, fileLines));
    } else if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i += 1;
      const [content, nextI] = collectContent(i);
      i = nextI;
      for (const [cl, idx] of content) {
        if (!blank(cl)) throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(deleteEdit(p));
    } else if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i += 1;
      const [content, nextI] = collectContent(i);
      i = nextI;
      const { moveTo, chunks } = parseUpdateChunks(content, updateLineNo);
      edits.push(updateEdit(p, moveTo, chunks));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: `R <old> -> <new>` replaces the D/A pair of a move edit that succeeded, when
  // the old path existed before the patch and does not after it, and the new path did not exist
  // before it and does after it. Rows sort by byte order of the path (R rows by <new>).
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      if (rOld.has(o) || rNew.has(n)) continue;
      rOld.add(o);
      rNew.add(n);
      rows.push({ key: n, text: `R ${o} -> ${n}` });
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
