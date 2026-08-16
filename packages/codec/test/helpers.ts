import { TOTAL, quantize } from '../src/tables.ts';
import type { ContextModelJSON } from '../src/context-model.ts';
import type { ModelJSON } from '../src/model.ts';
import { URL_CHARS, HOST_CHARS } from '../src/model.ts';
import { NRUN, LEN_BUCKETS } from '../src/text-coder.ts';

export function uniformContextModel(nsym: number): ContextModelJSON {
  const syms = Array.from({ length: nsym }, (_, i) => i);
  const freq = quantize(new Array(nsym).fill(1), TOTAL);
  return { nsym, excl: true, order0: { syms, freq }, order1: {}, order2: {} };
}

export function uniform(n: number): number[] {
  return quantize(new Array(n).fill(1), TOTAL);
}

/** A tiny synthetic model: every table uniform. Only for round-trip tests. */
export function toyModel(version = 1): ModelJSON {
  const textPhrases = ['/wiki/', '.html', 'watch?v=', '/status/', 'utm_source='];
  const hostPhrases = ['en', 'api', 'blog'];
  return {
    version,
    meta: { toy: true },
    classes: 3,
    flags: {
      mode: uniform(2),
      scheme: uniform(2),
      www: uniform(2),
      hostMode: uniform(3),
      sub: uniform(2),
      port: uniform(2),
    },
    text: {
      model: uniformContextModel(URL_CHARS.length + 1 + NRUN + textPhrases.length),
      phrases: textPhrases,
      runLen: Array.from({ length: NRUN }, () => uniform(LEN_BUCKETS)),
    },
    host: {
      model: uniformContextModel(HOST_CHARS.length + 1 + hostPhrases.length),
      phrases: hostPhrases,
      ranks: ['google.com', 'youtube.com', 'wikipedia.org', 'reddit.com', 'imgur.com'],
      rankBucket: uniform(15),
      suffixes: ['com', 'org', 'net', 'co.uk', 'io', 'de', 'gov'],
      suffixFreq: uniform(7),
    },
  };
}
