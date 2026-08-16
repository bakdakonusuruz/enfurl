import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeEncoder, RangeDecoder, encodeUniform } from '../src/rangecoder.ts';
import { bytesToText, textToBytes, isCodeText } from '../src/radix.ts';
import { quantize, TOTAL } from '../src/tables.ts';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('range coder round-trips skewed multi-symbol streams', () => {
  const rand = rng(1);
  for (let trial = 0; trial < 200; trial++) {
    const nsym = 2 + Math.floor(rand() * 40);
    const counts = Array.from({ length: nsym }, () => 1 + Math.floor(rand() ** 4 * 5000));
    const freq = quantize(counts, TOTAL);
    const cum = [0];
    for (const f of freq) cum.push(cum[cum.length - 1] + f);
    const len = Math.floor(rand() * 300);
    const syms: number[] = [];
    const enc = new RangeEncoder();
    for (let i = 0; i < len; i++) {
      // sample from the distribution
      const r = Math.floor(rand() * TOTAL);
      let s = 0;
      while (cum[s + 1] <= r) s++;
      syms.push(s);
      enc.encode(cum[s], freq[s], TOTAL);
      if (i % 7 === 0) encodeUniform(enc, i % 10, 10);
    }
    const bytes = enc.finish();
    const dec = new RangeDecoder(bytes);
    for (let i = 0; i < len; i++) {
      const v = dec.peek(TOTAL);
      let s = 0;
      while (cum[s + 1] <= v) s++;
      dec.update(cum[s], freq[s]);
      assert.equal(s, syms[i], `trial ${trial} symbol ${i}`);
      if (i % 7 === 0) assert.equal(dec.uniform(10), i % 10);
    }
  }
});

test('range coder output is close to entropy', () => {
  const freq = quantize([9000, 500, 300, 200], TOTAL);
  const cum = [0];
  for (const f of freq) cum.push(cum[cum.length - 1] + f);
  const p = freq.map((f) => f / TOTAL);
  const rand = rng(7);
  const enc = new RangeEncoder();
  let bits = 0;
  for (let i = 0; i < 5000; i++) {
    const r = rand();
    let s = 0;
    let acc = p[0];
    while (r > acc && s < 3) acc += p[++s];
    enc.encode(cum[s], freq[s], TOTAL);
    bits += -Math.log2(p[s]);
  }
  const out = enc.finish();
  assert.ok(out.length * 8 < bits + 24, `got ${out.length * 8} bits, entropy ${bits.toFixed(0)}`);
});

test('bijective base64url round-trips byte strings with leading and trailing zeros', () => {
  const rand = rng(3);
  const cases: Uint8Array[] = [new Uint8Array(0), new Uint8Array([0]), new Uint8Array([0, 0]), new Uint8Array([255]), new Uint8Array([0, 0, 1, 0, 0])];
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rand() * 40);
    const b = new Uint8Array(n);
    for (let k = 0; k < n; k++) b[k] = rand() < 0.3 ? 0 : Math.floor(rand() * 256);
    cases.push(b);
  }
  for (const b of cases) {
    const t = bytesToText(b);
    assert.ok(isCodeText(t));
    assert.deepEqual(Array.from(textToBytes(t)), Array.from(b));
  }
  // and text -> bytes -> text
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rand() * 30);
    let s = '';
    for (let k = 0; k < n; k++) s += alpha[Math.floor(rand() * 64)];
    assert.equal(bytesToText(textToBytes(s)), s);
  }
});

test('bijective base64url length is about 4/3 of the byte count', () => {
  const b = new Uint8Array(30).fill(0xa5);
  const t = bytesToText(b);
  assert.ok(t.length <= 41 && t.length >= 40, t.length);
});
