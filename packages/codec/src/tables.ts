/**
 * Frequency tables and the fixed-point cost function shared by encoder,
 * decoder, and trainer.
 *
 * Every stored table sums to TOTAL (2^15). Costs are integers in units of
 * 1/4096 bit so that parse decisions are identical on every platform.
 */

export const TOTAL_BITS = 15;
export const TOTAL = 1 << TOTAL_BITS;
export const COST_SCALE = 4096;

/** LOG2[x] = round(log2(x) * COST_SCALE) for x in [1, 65536]. LOG2[0] is unused. */
export const LOG2: Int32Array = (() => {
  const t = new Int32Array(65537);
  for (let x = 1; x <= 65536; x++) t[x] = Math.round(Math.log2(x) * COST_SCALE);
  return t;
})();

/** Cost in 1/4096 bits of a symbol with frequency f in a table with total t. */
export function cost(f: number, t: number): number {
  return LOG2[t] - LOG2[f];
}

/**
 * A static distribution over a subset of symbol ids. `syms` ascending.
 * `esc` is the escape frequency (0 when the table is exhaustive).
 * sum(freq) + esc === total.
 */
export interface FreqTable {
  syms: number[];
  freq: number[];
  esc: number;
  total: number;
}

export function makeTable(syms: number[], freq: number[], esc: number): FreqTable {
  let total = esc;
  for (const f of freq) total += f;
  return { syms, freq, esc, total };
}

/** Binary search: index of sym in table.syms, or -1. */
export function indexOf(t: FreqTable, sym: number): number {
  let lo = 0;
  let hi = t.syms.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = t.syms[mid];
    if (v === sym) return mid;
    if (v < sym) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Scale integer counts to sum exactly to `total`, every nonzero count >= 1.
 * Deterministic: remainder goes to the largest entries, ties by index.
 */
export function quantize(counts: number[], total: number): number[] {
  const n = counts.length;
  let sum = 0;
  for (const c of counts) sum += c;
  if (sum === 0) throw new Error('quantize: empty distribution');
  const out = new Array<number>(n).fill(0);
  let assigned = 0;
  const frac: { i: number; f: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (counts[i] <= 0) continue;
    const exact = (counts[i] * total) / sum;
    let q = Math.floor(exact);
    if (q < 1) q = 1;
    out[i] = q;
    assigned += q;
    frac.push({ i, f: exact - q });
  }
  // Fix overshoot (many tiny counts forced to 1) by taking from the largest.
  while (assigned > total) {
    let best = -1;
    for (let i = 0; i < n; i++) if (out[i] > 1 && (best < 0 || out[i] > out[best])) best = i;
    if (best < 0) throw new Error('quantize: total too small for symbol count');
    out[best]--;
    assigned--;
  }
  frac.sort((a, b) => b.f - a.f || a.i - b.i);
  let k = 0;
  while (assigned < total) {
    out[frac[k % frac.length].i]++;
    assigned++;
    k++;
  }
  return out;
}
