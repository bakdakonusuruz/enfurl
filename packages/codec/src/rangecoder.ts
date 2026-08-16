/**
 * 32-bit range coder, LZMA style (carry propagation through a cache byte).
 *
 * All arithmetic is exact in JavaScript numbers: `range` is a uint32, `low`
 * never exceeds 2^33, products never exceed 2^48. No floating point is used
 * anywhere in the coding path, so ports to integer-only languages are direct.
 *
 * Framing conventions that keep the output short:
 *  - The leading zero byte the classic LZMA encoder emits is never written.
 *  - On finish the encoder chooses the value inside its final interval with
 *    the most trailing zero bits, and trailing zero bytes are trimmed.
 *  - The decoder reads zero bytes past the end of its input.
 */

const TOP = 2 ** 24;
const RANGE_INIT = 0xffffffff;

export class RangeEncoder {
  private low = 0;
  private range = RANGE_INIT;
  private cache = 0;
  private cacheSize = 1;
  private first = true;
  private out: number[] = [];

  /**
   * Encode a symbol occupying [cumFreq, cumFreq + freq) out of totFreq.
   * totFreq must be <= 65536 and freq >= 1.
   */
  encode(cumFreq: number, freq: number, totFreq: number): void {
    const r = Math.floor(this.range / totFreq);
    this.low += r * cumFreq;
    this.range = r * freq;
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.shiftLow();
    }
  }

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let c = this.cache;
      do {
        if (this.first) this.first = false;
        else this.out.push((c + carry) & 0xff);
        c = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / 0x1000000) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % 0x1000000) * 256;
  }

  /** Flush and return the coded bytes with trailing zero bytes removed. */
  finish(): Uint8Array {
    // Pick the value in [low, low + range) with the most trailing zero bits.
    // range >= 2^24 here, so at least the low 24 bits can be zeroed.
    let bits = 32;
    while (bits > 0) {
      const unit = 2 ** bits;
      const v = Math.ceil(this.low / unit) * unit;
      if (v < this.low + this.range) {
        this.low = v;
        break;
      }
      bits--;
    }
    for (let i = 0; i < 5; i++) this.shiftLow();
    let n = this.out.length;
    while (n > 0 && this.out[n - 1] === 0) n--;
    return Uint8Array.from(this.out.slice(0, n));
  }
}

export class RangeDecoder {
  private range = RANGE_INIT;
  private code = 0;
  private pos = 0;
  private r = 0;
  private readonly input: Uint8Array;

  constructor(input: Uint8Array) {
    this.input = input;
    for (let i = 0; i < 4; i++) this.code = (this.code * 256 + this.nextByte()) >>> 0;
  }

  private nextByte(): number {
    return this.pos < this.input.length ? this.input[this.pos++] : 0;
  }

  /**
   * Return the cumulative frequency value the current code falls on, for a
   * table with total totFreq. Caller finds the symbol and calls update().
   */
  peek(totFreq: number): number {
    this.r = Math.floor(this.range / totFreq);
    const v = Math.floor(this.code / this.r);
    return v < totFreq ? v : totFreq - 1;
  }

  update(cumFreq: number, freq: number): void {
    this.code -= this.r * cumFreq;
    this.range = this.r * freq;
    while (this.range < TOP) {
      this.code = (this.code * 256 + this.nextByte()) >>> 0;
      this.range = (this.range * 256) >>> 0;
    }
  }

  /** Decode a uniformly distributed value in [0, n), n <= 65536. */
  uniform(n: number): number {
    const v = this.peek(n);
    this.update(v, 1);
    return v;
  }
}

/** Encode a uniformly distributed value v in [0, n), n <= 65536. */
export function encodeUniform(enc: RangeEncoder, v: number, n: number): void {
  enc.encode(v, 1, n);
}
