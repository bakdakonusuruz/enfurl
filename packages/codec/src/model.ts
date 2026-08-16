/**
 * Model file shape and loader. A model file is immutable once released:
 * the tables in it *are* the format for that version.
 */

import { ContextModel, type ContextModelJSON } from './context-model.ts';
import { TextCoder, runLenTable, type Alphabet } from './text-coder.ts';
import { TOTAL } from './tables.ts';

/** Printable ASCII 0x21..0x7E, which is every character a WHATWG href can contain. */
export const URL_CHARS: string = (() => {
  let s = '';
  for (let c = 0x21; c <= 0x7e; c++) s += String.fromCharCode(c);
  return s;
})();

/** Hostname characters after WHATWG normalisation. */
export const HOST_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-.';

export interface FlagsJSON {
  /** [structured, raw] */
  mode: number[];
  /** [https, http] */
  scheme: number[];
  /** [no www, www] */
  www: number[];
  /** [rank, suffix, literal] */
  hostMode: number[];
  /** [no subdomain, subdomain] */
  sub: number[];
  /** [no port, port] */
  port: number[];
}

export interface ModelJSON {
  version: number;
  meta: Record<string, unknown>;
  /** number of top ranks that get their own start context for the path */
  classes: number;
  flags: FlagsJSON;
  text: { model: ContextModelJSON; phrases: string[]; runLen: number[][] };
  host: {
    model: ContextModelJSON;
    phrases: string[];
    ranks: string[];
    /** bucket table over floor(log2(rank)), exhaustive */
    rankBucket: number[];
    suffixes: string[];
    /** exhaustive over suffixes */
    suffixFreq: number[];
  };
}

export class Model {
  readonly version: number;
  readonly classes: number;
  readonly flags: FlagsJSON;
  readonly text: TextCoder;
  readonly host: TextCoder;
  readonly ranks: string[];
  readonly rankOf = new Map<string, number>();
  readonly rankBucket: number[];
  readonly suffixes: string[];
  readonly suffixOf = new Map<string, number>();
  readonly suffixFreq: number[];
  readonly json: ModelJSON;

  constructor(json: ModelJSON) {
    this.json = json;
    this.version = json.version;
    this.classes = json.classes;
    this.flags = json.flags;
    for (const k of Object.keys(json.flags) as (keyof FlagsJSON)[]) checkTotal(json.flags[k], `flags.${k}`);
    checkTotal(json.host.rankBucket, 'rankBucket');
    checkTotal(json.host.suffixFreq, 'suffixFreq');
    const urlAlpha: Alphabet = { chars: URL_CHARS };
    const hostAlpha: Alphabet = { chars: HOST_CHARS };
    this.text = new TextCoder({
      model: new ContextModel(json.text.model),
      alphabet: urlAlpha,
      phrases: json.text.phrases,
      runLen: json.text.runLen.map(runLenTable),
    });
    this.host = new TextCoder({
      model: new ContextModel(json.host.model),
      alphabet: hostAlpha,
      phrases: json.host.phrases,
    });
    this.ranks = json.host.ranks;
    this.ranks.forEach((d, i) => this.rankOf.set(d, i + 1));
    this.rankBucket = json.host.rankBucket;
    this.suffixes = json.host.suffixes;
    this.suffixes.forEach((s, i) => this.suffixOf.set(s, i));
    this.suffixFreq = json.host.suffixFreq;
    if (this.suffixFreq.length !== this.suffixes.length) throw new Error('suffixFreq length');
  }
}

function checkTotal(freq: number[], name: string): void {
  let t = 0;
  for (const f of freq) {
    if (f < 1) throw new Error(`${name}: zero frequency`);
    t += f;
  }
  if (t !== TOTAL) throw new Error(`${name}: total ${t} != ${TOTAL}`);
}
