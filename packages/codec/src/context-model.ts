/**
 * Static order-2 context model with PPM-style escapes and optional exclusion.
 *
 * Probabilities are frozen tables produced by the trainer. Contexts are the
 * two preceding *characters* (never the preceding units), so a decoder can
 * rebuild the context after any unit and an encoder can evaluate the cost of
 * any unit at any position independently of how it parsed the text before it.
 *
 * Coding a symbol s in context (c2, c1):
 *   order 2 table for c2 present?  s in it -> code s, done.  else code ESC, exclude its symbols
 *   order 1 table for c1 present?  s in it -> code s (with exclusions), done. else code ESC, exclude
 *   order 0 table (exhaustive)     code s with exclusions
 */

import { TOTAL, indexOf, cost as bitCost, type FreqTable } from './tables.ts';
import type { RangeDecoder, RangeEncoder } from './rangecoder.ts';

export interface ContextModelJSON {
  nsym: number;
  excl: boolean;
  order0: { syms: number[]; freq: number[] };
  order1: Record<string, { syms: number[]; freq: number[]; esc: number }>;
  order2: Record<string, { syms: number[]; freq: number[]; esc: number }>;
}

function fromJSON(t: { syms: number[]; freq: number[]; esc: number }): FreqTable {
  let total = t.esc;
  for (const f of t.freq) total += f;
  if (total !== TOTAL) throw new Error(`context table total ${total} != ${TOTAL}`);
  return { syms: t.syms, freq: t.freq, esc: t.esc, total };
}

export class ContextModel {
  readonly nsym: number;
  readonly excl: boolean;
  private readonly t0: FreqTable;
  private readonly t1 = new Map<string, FreqTable>();
  private readonly t2 = new Map<string, FreqTable>();
  private readonly costCache = new Map<string, Int32Array>();
  /** scratch: symbol -> excluded flag, reset per operation */
  private readonly exclFlag: Uint8Array;

  constructor(json: ContextModelJSON) {
    this.nsym = json.nsym;
    this.excl = json.excl;
    this.t0 = fromJSON({ ...json.order0, esc: 0 });
    if (this.t0.syms.length !== this.nsym) throw new Error('order0 must be exhaustive');
    for (const k of Object.keys(json.order1)) this.t1.set(k, fromJSON(json.order1[k]));
    for (const k of Object.keys(json.order2)) this.t2.set(k, fromJSON(json.order2[k]));
    this.exclFlag = new Uint8Array(this.nsym);
  }

  static ctx1Of(ctx2: string): string {
    return ctx2[1];
  }

  private clearExcl(marked: number[]): void {
    for (const s of marked) this.exclFlag[s] = 0;
    marked.length = 0;
  }

  private markExcl(t: FreqTable, marked: number[]): void {
    if (!this.excl) return;
    for (const s of t.syms) {
      this.exclFlag[s] = 1;
      marked.push(s);
    }
  }

  /** Cumulative frequency of `sym` in `t` skipping excluded symbols, and the effective total. */
  private locate(t: FreqTable, sym: number): { cum: number; freq: number; eff: number } {
    let cum = 0;
    let freq = 0;
    let removed = 0;
    let found = false;
    for (let i = 0; i < t.syms.length; i++) {
      const s = t.syms[i];
      if (this.exclFlag[s]) {
        removed += t.freq[i];
        continue;
      }
      if (s === sym) {
        freq = t.freq[i];
        found = true;
      } else if (!found) {
        cum += t.freq[i];
      }
    }
    const eff = t.total - removed;
    return found ? { cum, freq, eff } : { cum: eff - t.esc, freq: t.esc, eff };
  }

  encode(enc: RangeEncoder, ctx2: string, sym: number): void {
    const marked: number[] = [];
    const t2 = this.t2.get(ctx2);
    if (t2) {
      const i = indexOf(t2, sym);
      if (i >= 0) {
        let cum = 0;
        for (let k = 0; k < i; k++) cum += t2.freq[k];
        enc.encode(cum, t2.freq[i], TOTAL);
        return;
      }
      enc.encode(TOTAL - t2.esc, t2.esc, TOTAL);
      this.markExcl(t2, marked);
    }
    const t1 = this.t1.get(ContextModel.ctx1Of(ctx2));
    if (t1) {
      const loc = this.locate(t1, sym);
      enc.encode(loc.cum, loc.freq, loc.eff);
      if (indexOf(t1, sym) >= 0) {
        this.clearExcl(marked);
        return;
      }
      this.markExcl(t1, marked);
    }
    const loc0 = this.locate(this.t0, sym);
    if (loc0.freq === 0) throw new Error(`symbol ${sym} not codable`);
    enc.encode(loc0.cum, loc0.freq, loc0.eff);
    this.clearExcl(marked);
  }

  /** Decode a symbol from a table, honouring exclusions. Returns -1 for escape. */
  private decodeFrom(dec: RangeDecoder, t: FreqTable): number {
    let eff = t.total;
    if (this.excl) {
      for (let i = 0; i < t.syms.length; i++) if (this.exclFlag[t.syms[i]]) eff -= t.freq[i];
    }
    const v = dec.peek(eff);
    let cum = 0;
    for (let i = 0; i < t.syms.length; i++) {
      const s = t.syms[i];
      if (this.exclFlag[s]) continue;
      const f = t.freq[i];
      if (v < cum + f) {
        dec.update(cum, f);
        return s;
      }
      cum += f;
    }
    dec.update(cum, t.esc);
    return -1;
  }

  decode(dec: RangeDecoder, ctx2: string): number {
    const marked: number[] = [];
    const t2 = this.t2.get(ctx2);
    if (t2) {
      const s = this.decodeFrom(dec, t2);
      if (s >= 0) return s;
      this.markExcl(t2, marked);
    }
    const t1 = this.t1.get(ContextModel.ctx1Of(ctx2));
    if (t1) {
      const s = this.decodeFrom(dec, t1);
      if (s >= 0) {
        this.clearExcl(marked);
        return s;
      }
      this.markExcl(t1, marked);
    }
    const s = this.decodeFrom(dec, this.t0);
    this.clearExcl(marked);
    if (s < 0) throw new Error('corrupt stream: escape at order 0');
    return s;
  }

  /** Cost row for a context: cost[sym] in 1/4096 bits. Cached. */
  costs(ctx2: string): Int32Array {
    const hit = this.costCache.get(ctx2);
    if (hit) return hit;
    const row = new Int32Array(this.nsym);
    const marked: number[] = [];
    let base = 0;
    const t2 = this.t2.get(ctx2);
    const done = new Uint8Array(this.nsym);
    if (t2) {
      for (let i = 0; i < t2.syms.length; i++) {
        row[t2.syms[i]] = bitCost(t2.freq[i], TOTAL);
        done[t2.syms[i]] = 1;
      }
      base += bitCost(t2.esc, TOTAL);
      this.markExcl(t2, marked);
    }
    const t1 = this.t1.get(ContextModel.ctx1Of(ctx2));
    if (t1) {
      let eff = t1.total;
      for (let i = 0; i < t1.syms.length; i++) if (this.exclFlag[t1.syms[i]]) eff -= t1.freq[i];
      for (let i = 0; i < t1.syms.length; i++) {
        const s = t1.syms[i];
        if (done[s] || this.exclFlag[s]) continue;
        row[s] = base + bitCost(t1.freq[i], eff);
        done[s] = 1;
      }
      base += bitCost(t1.esc, eff);
      this.markExcl(t1, marked);
    }
    let eff0 = this.t0.total;
    for (let i = 0; i < this.t0.syms.length; i++) if (this.exclFlag[this.t0.syms[i]]) eff0 -= this.t0.freq[i];
    for (let i = 0; i < this.t0.syms.length; i++) {
      const s = this.t0.syms[i];
      if (done[s]) continue;
      row[s] = base + bitCost(this.t0.freq[i], eff0);
    }
    this.clearExcl(marked);
    if (this.costCache.size > 4096) this.costCache.clear();
    this.costCache.set(ctx2, row);
    return row;
  }
}
