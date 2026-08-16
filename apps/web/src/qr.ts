/**
 * A small QR encoder, written here so the page keeps its promise of shipping
 * nothing but itself. Enough of ISO/IEC 18004 to draw a URL: alphanumeric and
 * byte segments, versions 1 to 40, all four error-correction levels, the eight
 * masks with the standard penalty rules.
 *
 * Why bother when the link is already short: a QR is *not* compression, it adds
 * redundancy on purpose. What it does have is modes. The alphanumeric mode
 * packs two characters into 11 bits, the byte mode spends 8 bits per character.
 * A furl.li link is `HTTPS://FURL.LI/` (alphanumeric, since scheme and host are
 * case-insensitive) followed by a case-sensitive furl (byte), so we emit two
 * segments and the square comes out a size or two smaller than it would from a
 * one-mode encoder.
 *
 * Verified against an independent decoder in test/qr.test.ts.
 */
import { EC_BLOCKS, EC_PER_BLOCK, TOTAL_CODEWORDS, type Level } from './qr-tables.ts';

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// ---------------------------------------------------------------- GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR field polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon generator polynomial of the given degree. */
function generator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= mul(poly[i], EXP[d]);
    }
    poly = next;
  }
  return poly;
}

/** Error-correction codewords for one block. */
function ecc(data: Uint8Array, count: number): Uint8Array {
  const gen = generator(count);
  const rem = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[count - 1] = 0;
    for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ---------------------------------------------------------------- segments

interface Segment {
  mode: 'alnum' | 'byte';
  text: string;
  bits: number;
}

const canAlnum = (s: string): boolean => [...s].every((c) => ALNUM.includes(c));

function charCountBits(mode: Segment['mode'], version: number): number {
  const group = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return mode === 'alnum' ? [9, 11, 13][group] : [8, 16, 16][group];
}

/**
 * Split a URL into an uppercase alphanumeric prefix and a byte remainder.
 * Only the scheme and host may be uppercased: a path is case-sensitive.
 */
export function segmentsFor(url: string): Segment[] {
  const m = /^([a-z]+:\/\/[^/?#]+\/?)(.*)$/i.exec(url);
  if (m) {
    const head = m[1].toUpperCase();
    const tail = m[2];
    if (canAlnum(head) && head.length >= 4) {
      const segs: Segment[] = [{ mode: 'alnum', text: head, bits: 0 }];
      if (tail.length) segs.push(canAlnum(tail) ? { mode: 'alnum', text: tail, bits: 0 } : { mode: 'byte', text: tail, bits: 0 });
      return segs;
    }
  }
  return [canAlnum(url) ? { mode: 'alnum', text: url, bits: 0 } : { mode: 'byte', text: url, bits: 0 }];
}

function segmentDataBits(seg: Segment): number {
  if (seg.mode === 'alnum') {
    const pairs = Math.floor(seg.text.length / 2);
    return pairs * 11 + (seg.text.length % 2) * 6;
  }
  // Byte mode counts UTF-8 bytes; a furl.li link is ASCII, but stay correct.
  return new TextEncoder().encode(seg.text).length * 8;
}

class BitWriter {
  readonly bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

// ---------------------------------------------------------------- encoding

export interface QR {
  size: number;
  version: number;
  level: Level;
  /** row-major, true = dark */
  modules: boolean[][];
}

/**
 * Encode text as a QR symbol, smallest version that fits.
 *
 * The alphanumeric prefix trick only pays sometimes, and it costs a shouty
 * uppercase address in whatever the scanner shows the reader. So try both and
 * keep the split version only when it actually buys a smaller square.
 */
export function encodeQR(text: string, level: Level = 'M'): QR {
  const plain = encodeSegments([{ mode: canAlnum(text) ? 'alnum' : 'byte', text, bits: 0 }], level);
  const split = segmentsFor(text);
  if (split.length > 1) {
    const mixed = encodeSegments(split, level);
    if (mixed.version < plain.version) return mixed;
  }
  return plain;
}

function encodeSegments(segs: Segment[], level: Level): QR {
  let version = 0;
  let dataCodewords = 0;
  for (let v = 1; v <= 40; v++) {
    const capacity = (TOTAL_CODEWORDS[v] - EC_BLOCKS[level][v] * EC_PER_BLOCK[level][v]) * 8;
    let need = 0;
    for (const s of segs) need += 4 + charCountBits(s.mode, v) + segmentDataBits(s);
    if (need <= capacity) {
      version = v;
      dataCodewords = capacity / 8;
      break;
    }
  }
  if (!version) throw new Error('too long for a QR code');

  const bw = new BitWriter();
  for (const s of segs) {
    bw.put(s.mode === 'alnum' ? 0b0010 : 0b0100, 4);
    const count = s.mode === 'byte' ? new TextEncoder().encode(s.text).length : s.text.length;
    bw.put(count, charCountBits(s.mode, version));
    if (s.mode === 'alnum') {
      for (let i = 0; i + 1 < s.text.length; i += 2) {
        bw.put(ALNUM.indexOf(s.text[i]) * 45 + ALNUM.indexOf(s.text[i + 1]), 11);
      }
      if (s.text.length % 2) bw.put(ALNUM.indexOf(s.text[s.text.length - 1]), 6);
    } else {
      for (const b of new TextEncoder().encode(s.text)) bw.put(b, 8);
    }
  }
  // terminator, byte alignment, then the standard pad bytes
  const capacityBits = dataCodewords * 8;
  bw.put(0, Math.min(4, capacityBits - bw.bits.length));
  while (bw.bits.length % 8) bw.bits.push(0);
  const data = new Uint8Array(dataCodewords);
  for (let i = 0; i < bw.bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k++) byte = (byte << 1) | bw.bits[i + k];
    data[i / 8] = byte;
  }
  for (let i = bw.bits.length / 8, pad = 0; i < dataCodewords; i++, pad++) data[i] = pad % 2 ? 0x11 : 0xec;

  // split into blocks, compute ECC, interleave
  const numBlocks = EC_BLOCKS[level][version];
  const ecPerBlock = EC_PER_BLOCK[level][version];
  const shortLen = Math.floor(dataCodewords / numBlocks);
  const longBlocks = dataCodewords % numBlocks;
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let off = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = shortLen + (b >= numBlocks - longBlocks ? 1 : 0);
    const block = data.subarray(off, off + len);
    off += len;
    dataBlocks.push(block);
    eccBlocks.push(ecc(block, ecPerBlock));
  }
  const codewords: number[] = [];
  for (let i = 0; i < shortLen + 1; i++) {
    for (const b of dataBlocks) if (i < b.length) codewords.push(b[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of eccBlocks) codewords.push(b[i]);
  }

  return draw(version, level, codewords);
}

// ---------------------------------------------------------------- matrix

/** Alignment pattern centres for a version (the rule from ISO/IEC 18004 annex E). */
function alignmentCentres(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

function draw(version: number, level: Level, codewords: number[]): QR {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // finder patterns and separators
  for (const [fx, fy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = fx + dx;
        const y = fy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const inner = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const dark = inner && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        set(x, y, dark);
      }
    }
  }
  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  // alignment patterns
  const centres = alignmentCentres(version);
  for (const cy of centres) {
    for (const cx of centres) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // reserve format and version areas
  for (let i = 0; i < 9; i++) {
    if (!reserved[i][8]) set(8, i, false);
    if (!reserved[8][i]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[size - 1 - i][8]) set(8, size - 1 - i, false);
    if (!reserved[8][size - 1 - i]) set(size - 1 - i, 8, false);
  }
  set(8, size - 8, true); // the always-dark module
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, false);
      set(b, a, false);
    }
  }

  // data, upward-then-downward in two-column strips, skipping the timing column
  let bit = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[y][x]) continue;
        modules[y][x] = bit < total ? ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1 : false;
        bit++;
      }
    }
  }

  // pick the mask with the lowest penalty
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules = modules;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => row.slice());
    applyMask(candidate, reserved, mask);
    writeFormat(candidate, level, mask, size);
    if (version >= 7) writeVersion(candidate, version, size);
    const p = penalty(candidate);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
      bestModules = candidate;
    }
  }
  void bestMask;
  return { size, version, level, modules: bestModules };
}

function applyMask(m: boolean[][], reserved: boolean[][], mask: number): void {
  const size = m.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (reserved[y][x]) continue;
      let flip = false;
      switch (mask) {
        case 0: flip = (x + y) % 2 === 0; break;
        case 1: flip = y % 2 === 0; break;
        case 2: flip = x % 3 === 0; break;
        case 3: flip = (x + y) % 3 === 0; break;
        case 4: flip = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: flip = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (flip) m[y][x] = !m[y][x];
    }
  }
}

const LEVEL_BITS: Record<Level, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

function writeFormat(m: boolean[][], level: Level, mask: number, size: number): void {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const get = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = get(i);
  m[7][8] = get(6);
  m[8][8] = get(7);
  m[8][7] = get(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = get(i);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = get(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = get(i);
  m[size - 8][8] = true;
}

function writeVersion(m: boolean[][], version: number, size: number): void {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m[b][a] = bit;
    m[a][b] = bit;
  }
}

/** The four penalty rules, used only to choose a mask. */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      let last = get(i, 0);
      const history: number[] = [];
      for (let j = 1; j < size; j++) {
        const cur = get(i, j);
        if (cur === last) run++;
        else {
          if (run >= 5) score += run - 2;
          history.push(run);
          run = 1;
          last = cur;
        }
      }
      if (run >= 5) score += run - 2;
      history.push(run);
      // rule 3: 1:1:3:1:1 patterns with four light modules on one side
      for (let k = 0; k + 4 < history.length; k++) {
        const [a, b, c, d, e] = history.slice(k, k + 5);
        if (b === a && c === a * 3 && d === a && e === a) score += 40;
      }
    }
  };
  line((i, j) => m[i][j]);
  line((i, j) => m[j][i]);
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

// ---------------------------------------------------------------- rendering

export interface RenderOptions {
  /** quiet zone in modules; the standard asks for 4, and scanners need it */
  quiet?: number;
  /** module colour */
  dark?: string;
  /** background colour, or null for a transparent one */
  light?: string | null;
}

/** Draw the symbol as an SVG string, sized in CSS pixels by the caller. */
export function qrToSvg(qr: QR, options: RenderOptions = {}): string {
  const { quiet = 4, dark = '#000000', light = '#ffffff' } = options;
  const dim = qr.size + quiet * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code for this furl">` +
    (light === null ? '' : `<rect width="${dim}" height="${dim}" fill="${light}"/>`) +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

/**
 * Paint the symbol into a canvas at a whole number of pixels per module, so
 * the edges stay sharp. Used for the PNG download.
 */
export function qrToCanvas(qr: QR, scale: number, options: RenderOptions = {}): HTMLCanvasElement {
  const { quiet = 4, dark = '#000000', light = '#ffffff' } = options;
  const dim = (qr.size + quiet * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d')!;
  if (light !== null) {
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, dim, dim);
  }
  ctx.fillStyle = dark;
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
  return canvas;
}
