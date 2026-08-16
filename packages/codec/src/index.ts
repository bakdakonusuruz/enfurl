/**
 * @enfurl/codec: furl a link, unfurl it anywhere.
 *
 *   const codec = new Codec([modelV1]);
 *   const { code } = codec.furl('https://en.wikipedia.org/wiki/Arithmetic_coding');
 *   codec.unfurl(code); // 'https://en.wikipedia.org/wiki/Arithmetic_coding'
 *
 * To furl a sail is to roll it tight against the spar. Nothing is thrown away,
 * the sail is only made small, and any sailor can unfurl it again. That is this
 * library: a URL rolled tight into a short string called a *furl*, and unfurled
 * by anyone holding it, offline, with no server and no database in between.
 *
 * `encode` and `decode` are kept as aliases for people who expect codec names.
 * The model files are the format; the stream layout is documented in format.ts.
 */

import { Model, type ModelJSON } from './model.ts';
import { encodeHref, decodeCode, codeVersion, estimateBits, explainHref, type ExplainPart } from './format.ts';
import { normalizeUrl, type NormalizeOptions } from './url.ts';
import { isCodeText } from './radix.ts';

export { Model, type ModelJSON } from './model.ts';
export { normalizeUrl, structure, TRACKING_PARAMS, type NormalizeOptions, type Normalized } from './url.ts';
export { ALPHABET, isCodeText, bytesToText, textToBytes } from './radix.ts';
export { RangeEncoder, RangeDecoder } from './rangecoder.ts';
export { ContextModel, type ContextModelJSON } from './context-model.ts';
export { TextCoder, RUN_TYPES, LEN_BUCKETS, type ExplainUnit } from './text-coder.ts';
export { TOTAL, quantize } from './tables.ts';
export { codeVersion, estimateBits, encodeHref, decodeCode, explainHref, type ExplainPart } from './format.ts';

export interface FurlResult {
  /** the furl: the whole URL rolled up, base64url characters only */
  code: string;
  /** the exact URL this furl unfurls to */
  href: string;
  /** tracking parameters removed, if stripTrackers was on */
  removedParams: string[];
  /** model version used */
  version: number;
}

/** @deprecated name kept for readers who expect codec vocabulary */
export type EncodeResult = FurlResult;

export class Codec {
  private readonly models = new Map<number, Model>();
  private readonly latest: Model;

  constructor(models: (ModelJSON | Model)[]) {
    if (models.length === 0) throw new Error('at least one model required');
    let latest: Model | null = null;
    for (const m of models) {
      const model = m instanceof Model ? m : new Model(m);
      this.models.set(model.version, model);
      if (!latest || model.version > latest.version) latest = model;
    }
    this.latest = latest!;
  }

  get version(): number {
    return this.latest.version;
  }

  /** Roll a URL up into a furl. Normalises first. Throws on invalid or disallowed URLs. */
  furl(input: string, opts: NormalizeOptions = {}): FurlResult {
    const n = normalizeUrl(input, opts);
    const code = encodeHref(this.latest, n.href);
    return { code, href: n.href, removedParams: n.removedParams, version: this.latest.version };
  }

  /**
   * Unroll a furl back into the URL it was made from. Accepts a bare furl, or one
   * carrying a leading '/' or '#', or a trailing '+'. Throws on a damaged furl or
   * an unknown version rather than handing back the wrong URL.
   */
  unfurl(code: string): string {
    let c = code.trim();
    if (c.startsWith('/') || c.startsWith('#')) c = c.slice(1);
    if (c.endsWith('+')) c = c.slice(0, -1);
    if (!isCodeText(c) || c.length === 0) throw new Error('not a furl');
    return decodeCode(this.models, c);
  }

  /** Alias of {@link Codec.furl}. */
  encode(input: string, opts: NormalizeOptions = {}): FurlResult {
    return this.furl(input, opts);
  }

  /** Alias of {@link Codec.unfurl}. */
  decode(code: string): string {
    return this.unfurl(code);
  }

  /** Version a furl claims, or -1 if it is not furl text. */
  versionOf(code: string): number {
    return isCodeText(code) && code.length > 0 ? codeVersion(code) : -1;
  }

  /** How many bits this URL would furl down to, without actually furling it. */
  estimateBits(input: string, opts: NormalizeOptions = {}): number {
    return estimateBits(this.latest, normalizeUrl(input, opts).href);
  }

  /**
   * Where the bits went, part by part: the site, each piece of the path, each
   * run of random-looking characters. Informational, never needed to unfurl.
   */
  explain(input: string, opts: NormalizeOptions = {}): { href: string; bits: number; parts: ExplainPart[] } {
    const n = normalizeUrl(input, opts);
    return { href: n.href, ...explainHref(this.latest, n.href) };
  }
}
