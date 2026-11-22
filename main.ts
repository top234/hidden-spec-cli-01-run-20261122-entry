// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

// ---------- SPEC section 3: a file as lines, its own break, its final break ----------
interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---------- SPEC section 5: matching lines at three tiers ----------
function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(file: string[], old: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(file[i + j]!, tier) !== normLine(old[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(file: string[], old: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrencesAt(file, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a replacement: a context line (written as the file's own line) or a new line. */
interface NewItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function applyReplace(file: string[], pos: number, oLen: number, items: NewItem[], tier: number, oldLead: string): string[] {
  const out = file.slice(0, pos);
  const fLead = pos < file.length ? leadWS(file[pos]!) : '';
  for (const it of items) {
    if (it.ctx) out.push(file[pos + it.oIdx]!);
    else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(oldLead)) out.push(fLead + it.text.slice(oldLead.length));
    else out.push(it.text);
  }
  out.push(...file.slice(pos + oLen));
  return out;
}

// ---------- SPEC section 6: unified diffs ----------
interface HunkOp {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNL: boolean;
}

interface Hunk {
  a: number;
  ops: HunkOp[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  pairSeen: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.*) b\/(.*?)\s*$/;

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    let sec: UnifiedSection;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, pairSeen: false, hunks: [] };
      i++;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: null, newPath: null, isCreate: false, isDelete: false, pairSeen: true, hunks: [] };
      const oldRaw = headerPath(l);
      const newRaw = headerPath(lines[i + 1]!);
      sec.oldPath = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
      sec.newPath = newRaw === '/dev/null' ? null : stripAB(newRaw);
      i += 2;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    let inHeader = true;
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('@@')) {
        const hm = HUNK_HEAD.exec(h);
        if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
        const hunk: Hunk = { a: parseInt(hm[1]!, 10), ops: [] };
        i++;
        const body: string[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') { body.push(b); i++; }
          else break;
        }
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
        for (const bl of body) {
          if (bl.startsWith('\\')) {
            const prev = hunk.ops[hunk.ops.length - 1];
            if (prev !== undefined && (prev.kind === 'ctx' || prev.kind === 'new')) prev.noNL = true;
            continue;
          }
          if (bl === '') hunk.ops.push({ kind: 'ctx', text: '', noNL: false });
          else if (bl[0] === ' ') hunk.ops.push({ kind: 'ctx', text: bl.slice(1), noNL: false });
          else if (bl[0] === '-') hunk.ops.push({ kind: 'old', text: bl.slice(1), noNL: false });
          else hunk.ops.push({ kind: 'new', text: bl.slice(1), noNL: false });
        }
        sec.hunks.push(hunk);
        inHeader = false;
        continue;
      }
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        if (inHeader) {
          if ((lines[i + 1] ?? '').startsWith('+++ ')) {
            if (!sec.pairSeen) {
              const oldRaw = headerPath(h);
              const newRaw = headerPath(lines[i + 1]!);
              sec.oldPath = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
              sec.newPath = newRaw === '/dev/null' ? null : stripAB(newRaw);
              sec.pairSeen = true;
              i += 2;
              continue;
            }
            break;
          }
          throw new Exit2(`error: parse ${i + 2}`);
        }
        if ((lines[i + 1] ?? '').startsWith('+++ ')) break;
        i++;
        continue;
      }
      if (inHeader) {
        if (h.startsWith('+++ ')) {
          if (!sec.pairSeen) {
            const newRaw = headerPath(h);
            sec.newPath = newRaw === '/dev/null' ? null : stripAB(newRaw);
          }
          i++;
          continue;
        }
        if (h.startsWith('rename from ')) {
          if (!sec.pairSeen) sec.oldPath = h.slice('rename from '.length).trim();
          i++;
          continue;
        }
        if (h.startsWith('rename to ')) {
          if (!sec.pairSeen) sec.newPath = h.slice('rename to '.length).trim();
          i++;
          continue;
        }
        if (h.startsWith('new file mode')) { sec.isCreate = true; i++; continue; }
        if (h.startsWith('deleted file mode')) { sec.isDelete = true; i++; continue; }
      }
      i++;
    }
    sections.push(sec);
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyUnifiedHunk(file: FileLines, h: Hunk, d: number, strict: boolean, errPath: string): FileLines {
  const oTexts: string[] = [];
  const nItems: NewItem[] = [];
  let oIdx = 0;
  for (const op of h.ops) {
    if (op.kind === 'ctx') { oTexts.push(op.text); nItems.push({ text: op.text, ctx: true, oIdx }); oIdx++; }
    else if (op.kind === 'old') { oTexts.push(op.text); oIdx++; }
    else nItems.push({ text: op.text, ctx: false, oIdx: -1 });
  }
  let trailingNoNL = false;
  for (let k = h.ops.length - 1; k >= 0; k--) {
    const op = h.ops[k]!;
    if (op.kind === 'ctx' || op.kind === 'new') { trailingNoNL = op.noNL; break; }
  }
  if (oTexts.length > 0) {
    const found = findTier(file.lines, oTexts, strict);
    if (found === null) throw new Fail('no-match', errPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const o of found.occ) if (Math.abs(o - target) < Math.abs(best - target)) best = o;
    const newLines = applyReplace(file.lines, best, oTexts.length, nItems, found.tier, leadWS(oTexts[0]!));
    const touchesEnd = best + oTexts.length === file.lines.length;
    return { lines: newLines, br: file.br, finalBreak: touchesEnd ? !trailingNoNL : file.finalBreak };
  }
  const at = Math.max(0, Math.min(h.a + d, file.lines.length));
  const newLines = [...file.lines.slice(0, at), ...nItems.map((it) => it.text), ...file.lines.slice(at)];
  const touchesEnd = at === file.lines.length;
  return { lines: newLines, br: file.br, finalBreak: touchesEnd ? !trailingNoNL : file.finalBreak };
}

function applyUnifiedHunks(file: FileLines, hunks: Hunk[], strict: boolean, errPath: string): FileLines {
  let cur = file;
  let d = 0;
  for (const h of hunks) {
    cur = applyUnifiedHunk(cur, h, d, strict, errPath);
    let oLen = 0;
    let nLen = 0;
    for (const op of h.ops) {
      if (op.kind !== 'new') oLen++;
      if (op.kind !== 'old') nLen++;
    }
    d += nLen - oLen;
  }
  return cur;
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = !isCreate && (newP === null || sec.isDelete);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusNoNL = false;
      for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'new') { plus.push(op.text); lastPlusNoNL = op.noNL; }
      tree.now.set(p, joinFile({ lines: plus, br: '\n', finalBreak: !lastPlusNoNL }));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const text = tree.get(oldP!);
      if (text === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const f = applyUnifiedHunks(splitFile(text), sec.hunks, strict, oldP!);
      tree.now.set(oldP!, null);
      tree.now.set(newP!, joinFile(f));
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const text = tree.get(oldP!);
    if (text === null) throw new Fail('missing', oldP!);
    const f = applyUnifiedHunks(splitFile(text), sec.hunks, strict, oldP!);
    tree.now.set(oldP!, joinFile(f));
  };
}

// ---------- SPEC section 7: SEARCH/REPLACE blocks ----------
interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ lines: [...b.newLines], br: '\n', finalBreak: true }));
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const f = splitFile(text);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const nItems: NewItem[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const newLines = applyReplace(f.lines, found.occ[0]!, b.oldLines.length, nItems, found.tier, leadWS(b.oldLines[0]!));
    tree.now.set(p, joinFile({ lines: newLines, br: f.br, finalBreak: f.finalBreak }));
  };
}

// ---------- SPEC section 8: V4A patches ----------
interface V4AOp {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  rawBlank: boolean;
}

interface V4AChunk {
  anchor: string | null;
  ops: V4AOp[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  lines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  let curChunk: V4AChunk | null = null;
  let seenBody = false;
  const closeSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    } else if (cur.kind === 'update' && cur.chunks.length > 0) {
      const lc = cur.chunks[cur.chunks.length - 1]!;
      while (lc.ops.length > 0 && lc.ops[lc.ops.length - 1]!.rawBlank) lc.ops.pop();
    }
    if (cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.lineNo}`);
    sections.push(cur);
    cur = null;
    curChunk = null;
    seenBody = false;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const lineNo = i + 1;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      closeSection();
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: l.slice(prefix.length).trim(), lineNo, lines: [], moveTo: null, chunks: [] };
      i++;
      continue;
    }
    if (cur === null) {
      if (blank(l)) { i++; continue; }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (cur.kind === 'add') {
      if (l.startsWith('+')) { cur.lines.push(l.slice(1)); i++; }
      else if (blank(l)) { cur.lines.push(''); i++; }
      else throw new Exit2(`error: parse ${lineNo}`);
      continue;
    }
    if (cur.kind === 'delete') {
      if (blank(l)) { i++; continue; }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (l.startsWith('*** Move to: ')) {
      if (!seenBody && cur.moveTo === null) { cur.moveTo = l.slice('*** Move to: '.length).trim(); i++; continue; }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (l.startsWith('@@')) {
      const chunk: V4AChunk = { anchor: l.slice(2).trim(), ops: [], eof: false };
      cur.chunks.push(chunk);
      curChunk = chunk;
      seenBody = true;
      i++;
      continue;
    }
    if (l === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${lineNo}`);
      curChunk.eof = true;
      curChunk = null;
      i++;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (curChunk === null) {
        if (cur.chunks.length === 0) {
          const chunk: V4AChunk = { anchor: null, ops: [], eof: false };
          cur.chunks.push(chunk);
          curChunk = chunk;
        } else throw new Exit2(`error: parse ${lineNo}`);
      }
      seenBody = true;
      if (l === '') curChunk.ops.push({ kind: 'ctx', text: '', rawBlank: true });
      else if (l.startsWith(' ')) curChunk.ops.push({ kind: 'ctx', text: l.slice(1), rawBlank: blank(l) });
      else if (l.startsWith('-')) curChunk.ops.push({ kind: 'old', text: l.slice(1), rawBlank: false });
      else curChunk.ops.push({ kind: 'new', text: l.slice(1), rawBlank: false });
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  closeSection();
  return sections.map((s) => v4aEdit(s, strict));
}

function applyV4AChunk(f: FileLines, chunk: V4AChunk, cursor: number, strict: boolean, errPath: string): { file: FileLines; cursor: number } {
  const oTexts: string[] = [];
  const nItems: NewItem[] = [];
  let oIdx = 0;
  for (const op of chunk.ops) {
    if (op.kind === 'ctx') { oTexts.push(op.text); nItems.push({ text: op.text, ctx: true, oIdx }); oIdx++; }
    else if (op.kind === 'old') { oTexts.push(op.text); oIdx++; }
    else nItems.push({ text: op.text, ctx: false, oIdx: -1 });
  }
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    let foundIdx = -1;
    const top = strict ? 0 : 2;
    for (let t = 0; t <= top && foundIdx < 0; t++) {
      for (let k = cur; k < f.lines.length; k++) {
        if (normLine(f.lines[k]!, t) === normLine(chunk.anchor, t)) { foundIdx = k; break; }
      }
    }
    if (foundIdx < 0) throw new Fail('no-match', errPath);
    cur = foundIdx + 1;
  }
  if (oTexts.length > 0) {
    let found: { tier: number; pos: number } | null = null;
    const top = strict ? 0 : 2;
    for (let t = 0; t <= top && found === null; t++) {
      const occ = occurrencesAt(f.lines, oTexts, t, cur);
      for (const o of occ) {
        if (!chunk.eof || o + oTexts.length === f.lines.length) { found = { tier: t, pos: o }; break; }
      }
    }
    if (found === null) throw new Fail('no-match', errPath);
    const newLines = applyReplace(f.lines, found.pos, oTexts.length, nItems, found.tier, leadWS(oTexts[0]!));
    return { file: { lines: newLines, br: f.br, finalBreak: f.finalBreak }, cursor: found.pos + nItems.length };
  }
  const at = chunk.eof ? f.lines.length : cur;
  const newLines = [...f.lines.slice(0, at), ...nItems.map((it) => it.text), ...f.lines.slice(at)];
  return { file: { lines: newLines, br: f.br, finalBreak: f.finalBreak }, cursor: at + nItems.length };
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ lines: [...sec.lines], br: '\n', finalBreak: true }));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    let newP: string | null = null;
    if (sec.moveTo !== null) {
      newP = sec.moveTo;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
    }
    let f = splitFile(text);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      const r = applyV4AChunk(f, chunk, cursor, strict, p);
      f = r.file;
      cursor = r.cursor;
    }
    if (newP !== null) {
      tree.now.set(p, null);
      tree.now.set(newP, joinFile(f));
      tree.moves.push([p, newP]);
    } else {
      tree.now.set(p, joinFile(f));
    }
  };
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4A(lines, strict);
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
  const byKey = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const entries: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byKey)) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => byKey(a.key, b.key));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
