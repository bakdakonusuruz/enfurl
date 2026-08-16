/**
 * The QR encoder is hand-written, so it is checked against an independent
 * decoder (jsqr, dev dependency only, never shipped). If a symbol we draw does
 * not decode back to the text we put in, the test fails: that is the whole
 * contract a QR has to keep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { encodeQR, segmentsFor, qrToSvg } from '../src/qr.ts';
import type { Level } from '../src/qr-tables.ts';

/** Render a symbol into the RGBA bitmap jsqr expects, 3 pixels per module. */
function decode(text: string, level: Level = 'M'): string | null {
  const qr = encodeQR(text, level);
  const quiet = 4;
  const scale = 3;
  const dim = (qr.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx);
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, dim, dim)?.data ?? null;
}

/** Scheme and host are case-insensitive, so an uppercased prefix is the same link. */
function sameLink(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

test('furl.li links decode back to the same link', () => {
  for (const url of [
    'https://furl.li/fwd7A2',
    'https://furl.li/UQZeakbIUzM-c',
    'https://furl.li/AP0W05-WI6g4Mo',
    'https://furl.li/ShC-l2sLsO_otyu0tr9EgfICUSR_keLjIf9t1Oi5O4So6lEKW6hPKiyief2epGPoj3a5KVBD_BIlC38j4fqCh25Q1SFi7OHelVf7YgLoqFDVwPodZqstbs_JWrkcxuUIstD0nCRgyBBKG3x2B2hh81G1X32g',
    'https://furl.li/#UQZeakbIUzM-c',
    'https://example.com/a/very/ordinary/link?with=params&and=more',
  ]) {
    const got = decode(url);
    assert.ok(got && sameLink(got, url), `did not decode: ${url} -> ${got}`);
  }
});

test('every error-correction level works', () => {
  const url = 'https://furl.li/UQZeakbIUzM-c';
  for (const level of ['L', 'M', 'Q', 'H'] as Level[]) {
    const got = decode(url, level);
    assert.ok(got && sameLink(got, url), `level ${level}: ${got}`);
  }
});

test('symbols across the version range decode', () => {
  // Lengths chosen to walk up the versions, including the byte/alnum boundary.
  for (const n of [1, 5, 10, 25, 40, 60, 90, 130, 180, 250, 400, 700, 1200]) {
    const url = 'https://furl.li/' + 'aB3-_'.repeat(Math.ceil(n / 5)).slice(0, n);
    const got = decode(url);
    assert.ok(got && sameLink(got, url), `length ${n} (version ${encodeQR(url).version}): ${got}`);
  }
});

test('the uppercase prefix is only used when it buys a smaller square', () => {
  const segs = segmentsFor('https://furl.li/UQZeakbIUzM-c');
  assert.equal(segs[0].mode, 'alnum');
  assert.equal(segs[0].text, 'HTTPS://FURL.LI/');
  assert.equal(segs[1].mode, 'byte');
  // This one gains a version from the split, so the decoded text is uppercased.
  assert.equal(decode('https://furl.li/UQZeakbIUzM-c'), 'HTTPS://FURL.LI/UQZeakbIUzM-c');
  assert.equal(encodeQR('https://furl.li/UQZeakbIUzM-c').version, 2);
  // This one gains nothing, so the address is left alone.
  assert.equal(decode('https://furl.li/AP0W05-WI6g4Mo'), 'https://furl.li/AP0W05-WI6g4Mo');
});

test('svg output is well formed and self-contained', () => {
  const svg = qrToSvg(encodeQR('https://furl.li/fwd7A2'));
  const transparent = qrToSvg(encodeQR('https://furl.li/fwd7A2'), { light: null });
  assert.ok(svg.includes('<rect'), 'the default has a background');
  assert.ok(!transparent.includes('<rect'), 'transparent output has no background rectangle');
  assert.ok(qrToSvg(encodeQR('https://furl.li/fwd7A2'), { dark: '#191816' }).includes('#191816'));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(!svg.includes('http://localhost'), 'no external references');
});
