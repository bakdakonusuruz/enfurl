/**
 * Text coder: codes a string as a sequence of *units* under a static context
 * model, choosing the cheapest unit sequence by dynamic programming.
 *
 * Units:
 *   char     one character of the coder's alphabet
 *   END      end of text
 *   run      a typed run (decimal, hex, base64url, alnum, UUID, percent-bytes)
 *            packed at its inherent entropy: run-type symbol, length, payload
 *   phrase   one entry of a frozen phrase dictionary
 *
 * Symbol ids: [0, nchars) chars, nchars = END, then run types (if enabled),
 * then phrases. Contexts are the two preceding characters of the *text*; the
 * first two positions use a caller-supplied start character so that, for
 * example, the path of a youtube.com link starts in its own context.
 */

import { ContextModel } from './context-model.ts';
import { RangeDecoder, RangeEncoder, encodeUniform } from './rangecoder.ts';
import { LOG2, COST_SCALE, TOTAL, indexOf, type FreqTable } from './tables.ts';
import { b64urlToBytes, bytesToB64url, bytesToPrintable, printableToBytes } from './base64.ts';

export const START = '\0';

export interface Alphabet {
  /** the characters this coder can emit, index = symbol id */
  chars: string;
}

/**
 * Runs. Order is part of the format.
 *
 * B64TEXT is the odd one: a base64url blob whose contents turn out to be text
 * (a JWT payload, a JSON state parameter). Instead of paying six bits per
 * character for what looks like noise, the coder unpacks it and codes the text
 * inside through this same model, then packs it back on the way out. The
 * encoder only uses it when re-packing reproduces the original characters
 * exactly, so a URL can never come back altered.
 */
export const RUN_TYPES = ['DEC', 'HEXL', 'HEXU', 'B64', 'ALNUML', 'ALNUMU', 'UUID', 'PCT', 'B64TEXT'] as const;
export type RunType = (typeof RUN_TYPES)[number];
export const NRUN = RUN_TYPES.length;

const RUN_ALPHABET: Record<string, string> = {
  DEC: '0123456789',
  HEXL: '0123456789abcdef',
  HEXU: '0123456789ABCDEF',
  B64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  ALNUML: 'abcdefghijklmnopqrstuvwxyz0123456789',
  ALNUMU: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
};

const RUN_MIN: Record<string, number> = { DEC: 2, HEXL: 4, HEXU: 4, B64: 4, ALNUML: 4, ALNUMU: 4, UUID: 36, PCT: 1, B64TEXT: 16 };

/** Start character for the text hidden inside a B64TEXT blob. */
export const START_NESTED = String.fromCharCode(4);
/** A blob larger than this is left alone; nothing sane hides megabytes in a URL. */
const B64TEXT_MAX = 4096;

/** Length buckets: b = floor(log2(n)), n in [1, 4095]. */
export const LEN_BUCKETS = 12;

function runIndex(alpha: string): Int8Array {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < alpha.length; i++) t[alpha.charCodeAt(i)] = i;
  return t;
}
const RUN_INDEX: Record<string, Int8Array> = {};
for (const k of Object.keys(RUN_ALPHABET)) RUN_INDEX[k] = runIndex(RUN_ALPHABET[k]);

const HEX_ANY = runIndex('0123456789abcdefABCDEF');

export interface TextCoderOptions {
  model: ContextModel;
  alphabet: Alphabet;
  phrases: string[];
  /** length tables per run type (exhaustive over LEN_BUCKETS). Omit to disable runs. */
  runLen?: FreqTable[];
}

export interface Unit {
  kind: 'char' | 'end' | 'phrase' | 'run';
  len: number;
  sym: number;
  /** run only */
  run?: number;
  /** PCT/UUID case flag: 1 = lowercase hex letters */
  lower?: number;
}

interface TrieNode {
  next: Map<string, TrieNode>;
  id: number;
}

/** One unit of an optimal parse with what it cost, for {@link TextCoder.explain}. */
export interface ExplainUnit {
  kind: Unit['kind'];
  /** the characters this unit produced ('' for END) */
  text: string;
  bits: number;
  /** run type name, when kind === 'run' */
  run?: RunType;
}

export class TextCoder {
  readonly model: ContextModel;
  readonly chars: string;
  readonly nchars: number;
  readonly END: number;
  readonly RUN_BASE: number;
  readonly PHRASE_BASE: number;
  readonly phrases: string[];
  readonly runLen: FreqTable[] | null;
  private readonly charSym = new Int16Array(128).fill(-1);
  private readonly trie: TrieNode = { next: new Map(), id: -1 };
  /** true while coding the text found inside a B64TEXT blob: no blob inside a blob */
  private nested = false;
  /** memo of nested-parse results per (position, length) during one parse */
  private b64memo = new Map<string, { text: string; cost: number } | null>();

  constructor(opts: TextCoderOptions) {
    this.model = opts.model;
    this.chars = opts.alphabet.chars;
    this.nchars = this.chars.length;
    this.END = this.nchars;
    this.runLen = opts.runLen ?? null;
    this.RUN_BASE = this.END + 1;
    this.PHRASE_BASE = this.RUN_BASE + (this.runLen ? NRUN : 0);
    this.phrases = opts.phrases;
    for (let i = 0; i < this.nchars; i++) this.charSym[this.chars.charCodeAt(i)] = i;
    for (let i = 0; i < this.phrases.length; i++) {
      let node = this.trie;
      for (const ch of this.phrases[i]) {
        let n = node.next.get(ch);
        if (!n) {
          n = { next: new Map(), id: -1 };
          node.next.set(ch, n);
        }
        node = n;
      }
      node.id = i;
    }
    const expected = this.PHRASE_BASE + this.phrases.length;
    if (this.model.nsym !== expected) throw new Error(`model nsym ${this.model.nsym} != ${expected}`);
  }

  canCode(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 128 || this.charSym[c] < 0) return false;
    }
    return true;
  }

  ctx2(text: string, i: number, start: string): string {
    if (i >= 2) return text[i - 2] + text[i - 1];
    if (i === 1) return start + text[0];
    return start + START;
  }

  // ---- runs -------------------------------------------------------------

  /**
   * The text hidden inside the base64url blob starting at i, with what it would
   * cost to code that text, or null when there is no blob, it does not hold
   * printable text, or re-packing would not reproduce the original characters.
   */
  private b64TextAt(text: string, i: number): { text: string; cost: number; len: number } | null {
    if (this.nested) return null;
    const idx = RUN_INDEX.B64;
    let k = i;
    while (k < text.length) {
      const c = text.charCodeAt(k);
      if (c >= 128 || idx[c] < 0) break;
      k++;
    }
    const len = k - i;
    if (len < RUN_MIN.B64TEXT || len > B64TEXT_MAX) return null;
    const key = i + ':' + len;
    const hit = this.b64memo.get(key);
    if (hit !== undefined) return hit ? { ...hit, len } : null;
    let out: { text: string; cost: number } | null = null;
    const blob = text.slice(i, k);
    const bytes = b64urlToBytes(blob);
    const inner = bytes && bytesToPrintable(bytes);
    if (inner && this.canCode(inner) && bytesToB64url(printableToBytes(inner)) === blob) {
      this.nested = true;
      try {
        out = { text: inner, cost: this.parse(inner, START_NESTED).cost };
      } finally {
        this.nested = false;
      }
    }
    this.b64memo.set(key, out);
    return out ? { ...out, len } : null;
  }

  /** Maximal run length of `type` starting at i (0 if none / below minimum). */
  private runLenAt(text: string, i: number, type: number): { len: number; lower: number } {
    const name = RUN_TYPES[type];
    const n = text.length;
    if (name === 'B64TEXT') {
      const b = this.b64TextAt(text, i);
      return { len: b ? b.len : 0, lower: 0 };
    }
    if (name === 'UUID') {
      if (i + 36 > n) return { len: 0, lower: 0 };
      let lower = -1;
      for (let k = 0; k < 36; k++) {
        const c = text.charCodeAt(i + k);
        const dash = k === 8 || k === 13 || k === 18 || k === 23;
        if (dash) {
          if (c !== 45) return { len: 0, lower: 0 };
          continue;
        }
        if (c >= 128 || HEX_ANY[c] < 0) return { len: 0, lower: 0 };
        if (c >= 97) {
          if (lower === 0) return { len: 0, lower: 0 };
          lower = 1;
        } else if (c >= 65) {
          if (lower === 1) return { len: 0, lower: 0 };
          lower = 0;
        }
      }
      return { len: 36, lower: lower < 0 ? 0 : lower };
    }
    if (name === 'PCT') {
      let k = i;
      let lower = -1;
      while (k + 2 < n && text.charCodeAt(k) === 37) {
        const a = text.charCodeAt(k + 1);
        const b = text.charCodeAt(k + 2);
        if (a >= 128 || b >= 128 || HEX_ANY[a] < 0 || HEX_ANY[b] < 0) break;
        let l = -1;
        for (const c of [a, b]) {
          if (c >= 97) l = l === 0 ? -2 : 1;
          else if (c >= 65) l = l === 1 ? -2 : 0;
        }
        if (l === -2) break;
        if (l >= 0) {
          if (lower >= 0 && lower !== l) break;
          lower = l;
        }
        k += 3;
      }
      return { len: (k - i) / 3, lower: lower < 0 ? 0 : lower };
    }
    const idx = RUN_INDEX[name];
    let k = i;
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c >= 128 || idx[c] < 0) break;
      k++;
    }
    const len = k - i;
    return { len: len >= RUN_MIN[name] ? len : 0, lower: 0 };
  }

  private lenBucket(len: number): number {
    return 31 - Math.clz32(len);
  }

  private runCost(type: number, len: number, nested?: { cost: number }): number {
    const name = RUN_TYPES[type];
    if (name === 'B64TEXT') return nested ? nested.cost : Infinity;
    if (name === 'UUID') return LOG2[65536] * 8 + COST_SCALE;
    const b = this.lenBucket(len);
    const lt = this.runLen![type];
    let c = LOG2[TOTAL] - LOG2[lt.freq[b]] + b * COST_SCALE;
    if (name === 'PCT') c += COST_SCALE + len * LOG2[256];
    else c += len * LOG2[RUN_ALPHABET[name].length];
    return c;
  }

  private encodeRunPayload(enc: RangeEncoder, text: string, i: number, u: Unit): void {
    const name = RUN_TYPES[u.run!];
    if (name === 'B64TEXT') {
      const b = this.b64TextAt(text, i);
      if (!b) throw new Error('B64TEXT chosen but the blob does not hold text');
      this.nested = true;
      try {
        this.encode(enc, b.text, START_NESTED);
      } finally {
        this.nested = false;
      }
      return;
    }
    if (name === 'UUID') {
      const hex = text.slice(i, i + 36).replace(/-/g, '');
      for (let k = 0; k < 8; k++) encodeUniform(enc, parseInt(hex.slice(k * 4, k * 4 + 4), 16), 65536);
      encodeUniform(enc, u.lower!, 2);
      return;
    }
    const b = this.lenBucket(u.len);
    const lt = this.runLen![u.run!];
    let cum = 0;
    for (let k = 0; k < b; k++) cum += lt.freq[k];
    enc.encode(cum, lt.freq[b], TOTAL);
    if (b > 0) encodeUniform(enc, u.len - (1 << b), 1 << b);
    if (name === 'PCT') {
      encodeUniform(enc, u.lower!, 2);
      for (let k = 0; k < u.len; k++) {
        const p = i + k * 3;
        encodeUniform(enc, parseInt(text.slice(p + 1, p + 3), 16), 256);
      }
      return;
    }
    const idx = RUN_INDEX[name];
    const base = RUN_ALPHABET[name].length;
    for (let k = 0; k < u.len; k++) encodeUniform(enc, idx[text.charCodeAt(i + k)], base);
  }

  private decodeRun(dec: RangeDecoder, type: number): string {
    const name = RUN_TYPES[type];
    if (name === 'B64TEXT') {
      this.nested = true;
      let inner: string;
      try {
        inner = this.decode(dec, START_NESTED, B64TEXT_MAX);
      } finally {
        this.nested = false;
      }
      return bytesToB64url(printableToBytes(inner));
    }
    if (name === 'UUID') {
      let hex = '';
      for (let k = 0; k < 8; k++) hex += dec.uniform(65536).toString(16).padStart(4, '0');
      const lower = dec.uniform(2);
      if (!lower) hex = hex.toUpperCase();
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    const lt = this.runLen![type];
    const v = dec.peek(TOTAL);
    let cum = 0;
    let b = 0;
    for (; b < LEN_BUCKETS; b++) {
      if (v < cum + lt.freq[b]) break;
      cum += lt.freq[b];
    }
    dec.update(cum, lt.freq[b]);
    const len = (1 << b) + (b > 0 ? dec.uniform(1 << b) : 0);
    if (name === 'PCT') {
      const lower = dec.uniform(2);
      let s = '';
      for (let k = 0; k < len; k++) {
        const h = dec.uniform(256).toString(16).padStart(2, '0');
        s += '%' + (lower ? h : h.toUpperCase());
      }
      return s;
    }
    const alpha = RUN_ALPHABET[name];
    let s = '';
    for (let k = 0; k < len; k++) s += alpha[dec.uniform(alpha.length)];
    return s;
  }

  // ---- parse ------------------------------------------------------------

  /** Optimal parse. Returns the unit list and its total cost (1/4096 bits). */
  parse(text: string, start: string): { units: Unit[]; cost: number } {
    if (!this.nested) this.b64memo.clear();
    const n = text.length;
    const best = new Float64Array(n + 1);
    const choice: Unit[] = new Array(n + 1);
    best[n] = this.model.costs(this.ctx2(text, n, start))[this.END];
    choice[n] = { kind: 'end', len: 0, sym: this.END };
    for (let i = n - 1; i >= 0; i--) {
      const row = this.model.costs(this.ctx2(text, i, start));
      const c = text.charCodeAt(i);
      const cs = c < 128 ? this.charSym[c] : -1;
      if (cs < 0) throw new Error(`character ${JSON.stringify(text[i])} not in alphabet`);
      let bc = row[cs] + best[i + 1];
      let bu: Unit = { kind: 'char', len: 1, sym: cs };
      // phrases
      let node: TrieNode | undefined = this.trie;
      for (let k = i; k < n && node; k++) {
        node = node.next.get(text[k]);
        if (node && node.id >= 0) {
          const len = k - i + 1;
          const cc = row[this.PHRASE_BASE + node.id] + best[i + len];
          if (cc < bc) {
            bc = cc;
            bu = { kind: 'phrase', len, sym: this.PHRASE_BASE + node.id };
          }
        }
      }
      // runs
      if (this.runLen) {
        for (let t = 0; t < NRUN; t++) {
          if (RUN_TYPES[t] === 'B64TEXT') {
            const b = this.b64TextAt(text, i);
            if (!b) continue;
            const cc = row[this.RUN_BASE + t] + b.cost + best[i + b.len];
            if (cc < bc) {
              bc = cc;
              bu = { kind: 'run', len: b.len, sym: this.RUN_BASE + t, run: t, lower: 0 };
            }
            continue;
          }
          const r = this.runLenAt(text, i, t);
          if (r.len === 0) continue;
          const chars = RUN_TYPES[t] === 'PCT' ? r.len * 3 : r.len;
          const cc = row[this.RUN_BASE + t] + this.runCost(t, r.len) + best[i + chars];
          if (cc < bc) {
            bc = cc;
            bu = { kind: 'run', len: chars, sym: this.RUN_BASE + t, run: t, lower: r.lower };
            if (RUN_TYPES[t] === 'PCT') bu.len = chars;
          }
        }
      }
      best[i] = bc;
      choice[i] = bu;
    }
    const units: Unit[] = [];
    let i = 0;
    while (true) {
      const u = choice[i];
      units.push(u);
      if (u.kind === 'end') break;
      i += u.len;
    }
    return { units, cost: best[0] };
  }

  /** Cost in bits (float) of coding `text` from `start`. */
  cost(text: string, start: string): number {
    return this.parse(text, start).cost / COST_SCALE;
  }

  /**
   * Per-unit breakdown of the optimal parse, for showing a reader where the
   * bits of their link actually went. Purely informational: it re-walks the
   * same parse the encoder uses and never affects the output.
   */
  explain(text: string, start: string): ExplainUnit[] {
    const { units } = this.parse(text, start);
    const out: ExplainUnit[] = [];
    let i = 0;
    for (const u of units) {
      const row = this.model.costs(this.ctx2(text, i, start));
      let cost = row[u.sym];
      if (u.kind === 'run') {
        if (RUN_TYPES[u.run!] === 'B64TEXT') {
          cost += this.b64TextAt(text, i)!.cost;
        } else {
          const byteLen = RUN_TYPES[u.run!] === 'PCT' ? u.len / 3 : u.len;
          cost += this.runCost(u.run!, byteLen);
        }
      }
      out.push({
        kind: u.kind,
        text: text.slice(i, i + u.len),
        bits: cost / COST_SCALE,
        run: u.kind === 'run' ? RUN_TYPES[u.run!] : undefined,
      });
      i += u.len;
    }
    return out;
  }

  encode(enc: RangeEncoder, text: string, start: string): void {
    const { units } = this.parse(text, start);
    let i = 0;
    for (const u of units) {
      this.model.encode(enc, this.ctx2(text, i, start), u.sym);
      if (u.kind === 'run') {
        // PCT unit length in text chars is 3 per byte; payload wants byte count
        const byteLen = RUN_TYPES[u.run!] === 'PCT' ? u.len / 3 : u.len;
        this.encodeRunPayload(enc, text, i, { ...u, len: byteLen });
      }
      i += u.len;
    }
  }

  decode(dec: RangeDecoder, start: string, maxLen = 8192): string {
    let text = '';
    while (true) {
      const sym = this.model.decode(dec, this.ctx2(text, text.length, start));
      if (sym === this.END) return text;
      if (sym < this.nchars) text += this.chars[sym];
      else if (sym >= this.PHRASE_BASE) text += this.phrases[sym - this.PHRASE_BASE];
      else text += this.decodeRun(dec, sym - this.RUN_BASE);
      if (text.length > maxLen) throw new Error('decoded text too long');
    }
  }
}

/** Build a FreqTable for a run-length bucket table stored as a plain freq array. */
export function runLenTable(freq: number[]): FreqTable {
  if (freq.length !== LEN_BUCKETS) throw new Error('runLen table must have 12 buckets');
  const syms = freq.map((_, i) => i);
  let total = 0;
  for (const f of freq) total += f;
  if (total !== TOTAL) throw new Error('runLen table total');
  return { syms, freq, esc: 0, total };
}

export { indexOf };
