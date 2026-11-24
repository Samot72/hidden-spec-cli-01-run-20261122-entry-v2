// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies the edits AI models
// write, in four formats, to a tree of text files. It reads a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON; it finds
// the lines each edit names at the first of three matching tiers, and writes every change or none.
// Node 22+, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

/* ------------------------------------------------------------------ */
/* Files: a file's lines, its line break, and whether it ends with one */
/* ------------------------------------------------------------------ */

interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/* ---------------------------------------------------------- */
/* Matching lines (SPEC.md section 5): three tiers, re-indent */
/* ---------------------------------------------------------- */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** All 0-based positions where O occurs in lines, at a tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length - from) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (tier 0 only with --strict). */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  /** Index into O for context lines. */
  oIdx: number;
}

/**
 * Build the replacement lines for N. Context lines come from the file's own matched lines.
 * At tier 2 every other line is re-indented: its leading spaces/tabs P (those of O's first
 * line) are replaced by F (those of the file's first matched line).
 */
function buildReplacement(n: NLine[], o: string[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadWs(fileLines[at] ?? '') : '';
  const p = tier === 2 ? leadWs(o[0] ?? '') : '';
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[at + e.oIdx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Split a hunk/chunk body into its old lines O and its new lines N. */
function bodyON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
  /** True when the patch line itself was empty (used to trim trailing empty body lines). */
  raw?: boolean;
}

/**
 * Whether a `\` line follows the body's last context or `+` line: then a hunk that runs to
 * the end of the file leaves the result without a final line break.
 */
function backslashAfterLastOut(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      return k + 1 < body.length && body[k + 1]!.kind === 'back';
    }
  }
  return false;
}

/* ------------------------------------------ */
/* Unified diffs (SPEC.md section 6)          */
/* ------------------------------------------ */

interface Hunk {
  /** Old start line, 1-based, from the `@@ -A ... @@` header. */
  a: number;
  body: BodyLine[];
}

interface Section {
  kind: 'create' | 'delete' | 'move' | 'change';
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The path text after `--- ` / `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(s: string): string {
  let t = s;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface SecWork {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  diffOld: string | null;
  diffNew: string | null;
  hasHunk: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): Section[] {
  const n = lines.length;
  const sections: SecWork[] = [];
  let cur: SecWork | null = null;
  const startSection = (): SecWork => {
    const s: SecWork = {
      oldPath: null,
      newPath: null,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      delFile: false,
      diffOld: null,
      diffNew: null,
      hasHunk: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  const parseDiffGit = (l: string, idx: number): [string, string] => {
    const rest = l.slice('diff --git '.length);
    if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${idx + 1}`);
    const k = rest.indexOf(' b/', 2);
    if (k < 0) throw new Exit2(`error: parse ${idx + 1}`);
    return [rest.slice(2, k), rest.slice(k + 3)];
  };
  const isBodyLine = (l: string): boolean =>
    l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';

  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (cur === null) {
      // Outside any section: prose is ignored.
      if (l.startsWith('diff --git ')) {
        const s = startSection();
        const [o, w] = parseDiffGit(l, i);
        s.diffOld = o;
        s.diffNew = w;
        i++;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = startSection();
        s.oldPath = stripAB(headerPath(l.slice(4)));
        s.newPath = stripAB(headerPath(lines[i + 1]!.slice(4)));
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    // Inside a section.
    if (l.startsWith('diff --git ')) {
      const s = startSection();
      const [o, w] = parseDiffGit(l, i);
      s.diffOld = o;
      s.diffNew = w;
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!cur.hasHunk) {
          // Part of this section's header.
          cur.oldPath = stripAB(headerPath(l.slice(4)));
          cur.newPath = stripAB(headerPath(lines[i + 1]!.slice(4)));
          i += 2;
          continue;
        }
        // After hunks: a new bare section starts here.
        const s = startSection();
        s.oldPath = stripAB(headerPath(l.slice(4)));
        s.newPath = stripAB(headerPath(lines[i + 1]!.slice(4)));
        i += 2;
        continue;
      }
      if (!cur.hasHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: BodyLine[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(bl)) break;
        if (bl === '') body.push({ kind: 'ctx', text: '', raw: true });
        else if (bl[0] === ' ') body.push({ kind: 'ctx', text: bl.slice(1), raw: false });
        else if (bl[0] === '-') body.push({ kind: 'old', text: bl.slice(1), raw: false });
        else if (bl[0] === '+') body.push({ kind: 'new', text: bl.slice(1), raw: false });
        else body.push({ kind: 'back', text: bl.slice(1), raw: false });
        i++;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.raw) body.pop();
      cur.hunks.push({ a, body });
      cur.hasHunk = true;
      continue;
    }
    if (!cur.hasHunk) {
      // Section header lines, before the first hunk.
      if (l.startsWith('+++ ')) {
        cur.newPath = stripAB(headerPath(l.slice(4)));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.delFile = true;
        i++;
        continue;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`,
      // `Index:` and any other line are ignored.
      i++;
      continue;
    }
    // Between hunks: lines that are not part of a section header are ignored.
    i++;
  }

  const out: Section[] = [];
  for (const s of sections) {
    const oldP = s.oldPath ?? s.renameFrom ?? s.diffOld ?? s.newPath ?? s.renameTo ?? s.diffNew ?? '';
    const newP = s.newPath ?? s.renameTo ?? s.diffNew ?? s.oldPath ?? s.renameFrom ?? s.diffOld ?? '';
    let kind: Section['kind'];
    if (s.newFile || oldP === '/dev/null') kind = 'create';
    else if (s.delFile || newP === '/dev/null') kind = 'delete';
    else if (oldP !== newP) kind = 'move';
    else kind = 'change';
    out.push({ kind, oldPath: oldP, newPath: newP, hunks: s.hunks });
  }
  return out;
}

/** Apply a section's hunks, in order, to a file's text. */
function applyUnifiedHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const m = parseFile(before);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = bodyON(h.body);
    if (o.length === 0) {
      const beforeLen = m.lines.length;
      const pos = Math.min(Math.max(h.a + d, 0), beforeLen);
      const ins = n.map((e) => e.text);
      m.lines.splice(pos, 0, ...ins);
      if (ins.length > 0 && pos === beforeLen) m.finalBreak = !backslashAfterLastOut(h.body);
      d += n.length;
      continue;
    }
    const found = findTier(m.lines, o, strict);
    if (!found) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const beforeLen = m.lines.length;
    const atEnd = best + o.length === beforeLen;
    const rep = buildReplacement(n, o, m.lines, best, found.tier);
    m.lines.splice(best, o.length, ...rep);
    if (atEnd) m.finalBreak = !backslashAfterLastOut(h.body);
    d += n.length - o.length;
  }
  return renderFile(m);
}

/** The text of a created file: the `+` lines of all its hunks, in order. */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  for (const h of hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
  if (plus.length === 0) return '';
  let fb = true;
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const h = hunks[hi]!;
    let lastPlus = -1;
    for (let k = h.body.length - 1; k >= 0; k--) {
      if (h.body[k]!.kind === 'new') {
        lastPlus = k;
        break;
      }
    }
    if (lastPlus >= 0) {
      fb = !(lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.kind === 'back');
      break;
    }
  }
  return plus.join('\n') + (fb ? '\n' : '');
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs = parseUnified(lines);
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => {
    if (s.kind === 'create') {
      const newPath = s.newPath;
      const text = creationText(s.hunks);
      return (tree: Tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        tree.now.set(newPath, text);
      };
    }
    if (s.kind === 'delete') {
      const oldPath = s.oldPath;
      return (tree: Tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }
    if (s.kind === 'move') {
      const oldPath = s.oldPath;
      const newPath = s.newPath;
      return (tree: Tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyUnifiedHunks(before, s.hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push([oldPath, newPath]);
      };
    }
    const p = s.oldPath;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const out = applyUnifiedHunks(before, s.hunks, strict, p);
      tree.now.set(p, out);
    };
  });
}

/* ------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)  */
/* ------------------------------------------ */

function makeSrEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const m = parseFile(before);
    const found = findTier(m.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nEntries: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = buildReplacement(nEntries, oldLines, m.lines, pos, found.tier);
    m.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, renderFile(m));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      const t = cand.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(makeSrEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------ */
/* V4A patches (SPEC.md section 8)            */
/* ------------------------------------------ */

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function makeVAdd(path: string, fileLines: string[]): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeVDelete(path: string): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeVUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < m.lines.length; k++) {
            if (lineEq(m.lines[k]!, ch.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const { o, n } = bodyON(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? m.lines.length : cursor;
        const ins = n.map((e) => e.text);
        m.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const occ = occurrences(m.lines, o, t, cursor);
        const good = ch.eof ? occ.filter((p) => p + o.length === m.lines.length) : occ;
        if (good.length > 0) {
          found = { tier: t, pos: good[0]! };
          break;
        }
      }
      if (!found) throw new Fail('no-match', path);
      const rep = buildReplacement(n, o, m.lines, found.pos, found.tier);
      m.lines.splice(found.pos, o.length, ...rep);
      cursor = found.pos + rep.length;
    }
    const out = renderFile(m);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const isVBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
  const readVBody = (start: number, end: number): { body: BodyLine[]; next: number; eof: boolean } => {
    const body: BodyLine[] = [];
    let k = start;
    while (k < end) {
      const bl = lines[k]!;
      if (bl.startsWith('@@') || bl === '*** End of File') break;
      if (!isVBodyLine(bl)) throw new Exit2(`error: parse ${k + 1}`);
      if (bl === '') body.push({ kind: 'ctx', text: '' });
      else if (bl[0] === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
      else if (bl[0] === '-') body.push({ kind: 'old', text: bl.slice(1) });
      else body.push({ kind: 'new', text: bl.slice(1) });
      k++;
    }
    let eof = false;
    if (k < end && lines[k] === '*** End of File') {
      eof = true;
      k++;
    }
    return { body, next: k, eof };
  };

  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const startIdx = i;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    }
    i++;
    let j = i;
    while (j < end && !isSectionStart(lines[j]!)) j++;
    // Blank lines at the end of a section are not part of it.
    let e = j;
    while (e > i && blank(lines[e - 1]!)) e--;
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = i; k < e; k++) {
        const rl = lines[k]!;
        if (rl === '') fileLines.push('');
        else if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(makeVAdd(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = i; k < e; k++) {
        if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(makeVDelete(path));
    } else {
      let moveTo: string | null = null;
      let k = i;
      if (k < e && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      while (k < e) {
        const cl = lines[k]!;
        if (cl === '*** End of File') {
          chunks.push({ anchor: null, body: [], eof: true });
          k++;
          continue;
        }
        if (cl.startsWith('@@')) {
          const anchor = cl.slice(2).trim();
          const r = readVBody(k + 1, e);
          chunks.push({ anchor: anchor === '' ? null : anchor, body: r.body, eof: r.eof });
          k = r.next;
          continue;
        }
        if (chunks.length === 0 && isVBodyLine(cl)) {
          const r = readVBody(k, e);
          chunks.push({ anchor: null, body: r.body, eof: r.eof });
          k = r.next;
          continue;
        }
        throw new Exit2(`error: parse ${k + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startIdx + 1}`);
      edits.push(makeVUpdate(path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------ */
/* JSON edits (SPEC.md section 9)             */
/* ------------------------------------------ */

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

/* ------------------------------------------ */
/* Run (SPEC.md sections 1, 2 and 10)         */
/* ------------------------------------------ */

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const rowByPath = new Map<string, Row>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    rowByPath.set(p, row);
  }
  // A successful move replaces its `D` and `A` lines with one `R` line, sorted by the new path.
  for (const [oldP, newP] of tree.moves) {
    const dRow = rowByPath.get(oldP);
    const aRow = rowByPath.get(newP);
    if (dRow !== undefined && dRow.line.startsWith('D ') && aRow !== undefined && aRow.line.startsWith('A ')) {
      rows.splice(rows.indexOf(dRow), 1);
      rows.splice(rows.indexOf(aRow), 1);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      rowByPath.delete(oldP);
      rowByPath.delete(newP);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
