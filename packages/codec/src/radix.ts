/**
 * Bijective radix conversion between byte strings and base64url text.
 *
 * Both directions are exact bijections, so a code carries no padding, no
 * length field, and no ambiguity about leading or trailing zero bytes:
 *
 *   bytes  <-> integer via bijective base 256 (empty = 0, [0] = 1, [255] = 256, [0,0] = 257 ...)
 *   integer <-> text via bijective base 64   (empty = 0, "A" = 1, ..., "_" = 64, "AA" = 65 ...)
 *
 * The alphabet is RFC 4648 base64url. Six bits per character.
 */

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const VALUE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUE[ALPHABET.charCodeAt(i)] = i;

export function isCodeText(s: string): boolean {
  if (s.length === 0) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 128 || VALUE[c] < 0) return false;
  }
  return true;
}

export function bytesToText(bytes: Uint8Array): string {
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = n * 256n + BigInt(bytes[i] + 1);
  let out = '';
  while (n > 0n) {
    n -= 1n;
    out = ALPHABET[Number(n % 64n)] + out;
    n /= 64n;
  }
  return out;
}

export function textToBytes(text: string): Uint8Array {
  let n = 0n;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? VALUE[c] : -1;
    if (v < 0) throw new Error(`invalid code character ${JSON.stringify(text[i])}`);
    n = n * 64n + BigInt(v + 1);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    n -= 1n;
    bytes.push(Number(n % 256n));
    n /= 256n;
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
}
