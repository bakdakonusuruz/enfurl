/**
 * base64url without padding, both directions, no dependencies and no atob.
 *
 * Used only by the B64TEXT unit (see text-coder.ts), which looks inside a
 * base64url blob in a URL and, when it turns out to hold text, compresses that
 * text instead of the 6-bits-per-character noise it looks like from outside.
 */

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VAL = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHA.length; i++) VAL[ALPHA.charCodeAt(i)] = i;

/** Decode base64url text to bytes, or null if the text is not valid base64url. */
export function b64urlToBytes(s: string): Uint8Array | null {
  const n = s.length;
  if (n % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? VAL[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Left-over bits of a non-multiple-of-4 length must be zero, otherwise
  // re-encoding would not reproduce the input and the unit must not be used.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return out.subarray(0, o);
}

export function bytesToB64url(bytes: Uint8Array): string {
  let s = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      s += ALPHA[(acc >> bits) & 63];
    }
  }
  if (bits > 0) s += ALPHA[(acc << (6 - bits)) & 63];
  return s;
}

/** Bytes -> string, only when every byte is a character the text coder can emit. */
export function bytesToPrintable(bytes: Uint8Array): string | null {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x21 || b > 0x7e) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

export function printableToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
