/**
 * Train a model version from the corpora in tools/train/corpus/.
 *
 *   node tools/train/src/train.ts [--out packages/codec/models/v1/model.json] [--limit N]
 *        [--ranks 8192] [--classes 256] [--phrases 768] [--hostPhrases 96]
 *        [--minCtx2 300] [--minCtx2Host 40] [--minSym2 20] [--minSym1 1] [--esc 1.0] [--rounds 3] [--excl 1]
 *
 * Deterministic for a fixed corpus and parameters. Never run this to "refresh"
 * a released model: a released model file is frozen; a retrain is a new version.
 *
 * Steps:
 *   1. load every corpus in tools/train/corpus/, normalise, dedupe across all of
 *      them, hash-split each into train (90%) and held-out (10%); ada is held
 *      out entirely. Held-out files are written to bench/corpus/.
 *   2. rank list from Tranco x corpus frequency; suffix list from PSL x corpus.
 *   3. phrase mining (boundary-aligned substrings, scored by count x (len-1)).
 *   4. bootstrap model (order-0), then R rounds of: parse corpus with the previous
 *      model -> count units per context -> build the next model.
 *   5. evaluate on a held-out sample and write the model.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { normalizeUrl, structure } from '../../../packages/codec/src/url.ts';
import { Model, URL_CHARS, HOST_CHARS, type ModelJSON } from '../../../packages/codec/src/model.ts';
import { NRUN, LEN_BUCKETS, RUN_TYPES } from '../../../packages/codec/src/text-coder.ts';
import type { ContextModelJSON } from '../../../packages/codec/src/context-model.ts';
import { TOTAL, quantize } from '../../../packages/codec/src/tables.ts';
import {
  planHost,
  classChar,
  START_LABEL,
  START_SUB,
  START_LITERAL,
  START_RAW,
  encodeHref,
  decodeCode,
} from '../../../packages/codec/src/format.ts';
import { START } from '../../../packages/codec/src/text-coder.ts';

// ---------------------------------------------------------------- args

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '1'), i++;
}
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const P = {
  out: args.get('out') ?? 'packages/codec/models/v1/model.json',
  version: num('version', 1),
  limit: num('limit', Infinity),
  ranks: num('ranks', 8192),
  classes: num('classes', 256),
  phrases: num('phrases', 768),
  hostPhrases: num('hostPhrases', 96),
  minCtx2: num('minCtx2', 300),
  minCtx2Host: num('minCtx2Host', 40),
  minSym2: num('minSym2', 20),
  minP2: num('minP2', 0),
  minSym1: num('minSym1', 1),
  esc: num('esc', 1.0),
  rounds: num('rounds', 3),
  excl: num('excl', 1) === 1,
  evalN: num('evalN', 20000),
};

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const corpusDir = join(here, '..', 'corpus');
const benchDir = join(root, 'bench', 'corpus');
mkdirSync(benchDir, { recursive: true });

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------------------------------------------------------------- 1. corpora

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function loadHrefs(file: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const h = normalizeUrl(s).href;
      if (h.length > 2048) continue;
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(h);
    } catch {
      /* skip */
    }
  }
  return out;
}

const corpusOverride = args.get('corpus');

/**
 * Training corpora. Each is split 90/10 by a hash of the URL, so the held-out
 * tenth is stable across runs and can never leak into training. `ada` is never
 * trained on at all: it is the "did this generalise" set.
 *
 * Reddit is the historical core (real shared links, 2016 to 2018). The others
 * exist because that snapshot has never seen a modern host: Hacker News brings
 * recent article and repository links, Wikipedia the long tail of news sites,
 * universities and PDFs, the curated lists host variety without query strings,
 * and the Common Crawl sample the shape of the crawled web at large.
 * Fetch them with tools/train/src/fetch-more.mjs.
 */
const SOURCES = ['reddit', 'hn', 'wiki', 'curated', 'cc'] as const;
const corpora = new Map<string, string[]>();
if (corpusOverride) {
  corpora.set('reddit', loadHrefs(resolve(root, corpusOverride)));
} else {
  for (const name of SOURCES) {
    const file = join(corpusDir, `${name}_urls.txt`);
    if (!existsSync(file)) continue;
    const hrefs = loadHrefs(file);
    if (hrefs.length) corpora.set(name, hrefs);
  }
}
const ada = corpusOverride ? [] : loadHrefs(join(corpusDir, 'ada_urls.txt'));

const train: string[] = [];
const heldout: string[] = [];
const seenAll = new Set<string>();
for (const [name, hrefs] of corpora) {
  const held: string[] = [];
  let kept = 0;
  for (const h of hrefs) {
    if (seenAll.has(h)) continue; // a link shared in two places is still one link
    seenAll.add(h);
    if (fnv1a(h) % 10 === 0) held.push(h);
    else {
      train.push(h);
      kept++;
    }
  }
  if (name === 'reddit') heldout.push(...held);
  writeFileSync(join(benchDir, `${name}-heldout.txt`), held.join('\n') + '\n');
  log(`${name}: ${hrefs.length} unique, ${kept} train, ${held.length} held out`);
}
writeFileSync(join(benchDir, 'ada.txt'), ada.join('\n') + '\n');
// Deterministic shuffle so no single corpus dominates the early counting rounds.
train.sort((a, b) => fnv1a(a + '|') - fnv1a(b + '|'));
const trainSet = Number.isFinite(P.limit) ? train.slice(0, P.limit) : train;
log(`train ${trainSet.length} from ${corpora.size} corpora, reddit held-out ${heldout.length}, ada ${ada.length}`);

// ---------------------------------------------------------------- 2. PSL, ranks, suffixes

interface PSL {
  rules: Set<string>;
  wild: Set<string>;
  exc: Set<string>;
}
function loadPSL(file: string): PSL {
  const rules = new Set<string>();
  const wild = new Set<string>();
  const exc = new Set<string>();
  for (let line of readFileSync(file, 'utf8').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('!')) exc.add(line.slice(1));
    else if (line.startsWith('*.')) wild.add(line.slice(2));
    else rules.add(line);
  }
  return { rules, wild, exc };
}
const psl = loadPSL(join(corpusDir, 'public_suffix_list.dat'));

/** Public suffix of a host per PSL algorithm; returns '' if host is itself a suffix. */
function publicSuffix(host: string): string {
  const labels = host.split('.');
  let best = '';
  for (let i = 0; i < labels.length; i++) {
    const cand = labels.slice(i).join('.');
    if (psl.exc.has(cand)) return labels.slice(i + 1).join('.');
    if (psl.rules.has(cand)) {
      best = cand;
      break;
    }
    if (i + 1 < labels.length && psl.wild.has(labels.slice(i + 1).join('.'))) {
      best = cand;
      break;
    }
  }
  if (!best) best = labels[labels.length - 1];
  return best;
}
function registrable(host: string): { domain: string; suffix: string; sub: string } | null {
  const suffix = publicSuffix(host);
  if (host === suffix) return null;
  const rest = host.slice(0, host.length - suffix.length - 1);
  const labels = rest.split('.');
  const label = labels[labels.length - 1];
  return { domain: label + '.' + suffix, suffix, sub: labels.slice(0, -1).join('.') };
}

interface Split {
  href: string;
  s: ReturnType<typeof structure>;
}
const splits: Split[] = trainSet.map((href) => ({ href, s: structure(new URL(href)) }));

// domain + suffix frequencies from the training corpus
const domCount = new Map<string, number>();
const sufCount = new Map<string, number>();
for (const { s } of splits) {
  if (!s) continue;
  const r = registrable(s.host);
  if (!r) continue;
  domCount.set(r.domain, (domCount.get(r.domain) ?? 0) + 1);
  sufCount.set(r.suffix, (sufCount.get(r.suffix) ?? 0) + 1);
}
// Tranco
const tranco: string[] = [];
for (const line of readFileSync(join(corpusDir, 'tranco.csv'), 'utf8').split('\n')) {
  const c = line.indexOf(',');
  if (c > 0) tranco.push(line.slice(c + 1).trim().toLowerCase());
}
const trancoRank = new Map<string, number>();
tranco.forEach((d, i) => trancoRank.set(d, i + 1));
// combined score: geometric mean of Tranco rank and corpus-frequency rank
const corpusOrder = [...domCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
const corpusRank = new Map<string, number>();
corpusOrder.forEach(([d], i) => corpusRank.set(d, i + 1));
const NMAX = 1_000_000;
const candidates = new Set<string>([...corpusRank.keys(), ...tranco.slice(0, P.ranks * 2)]);
const scored = [...candidates]
  .filter((d) => /^[a-z0-9.-]+$/.test(d) && d.includes('.'))
  .map((d) => ({ d, s: Math.log(trancoRank.get(d) ?? NMAX) + Math.log(corpusRank.get(d) ?? NMAX) }))
  .sort((a, b) => a.s - b.s || (a.d < b.d ? -1 : 1));
const ranks = scored.slice(0, P.ranks).map((x) => x.d);
log(`ranks: ${ranks.length}, top: ${ranks.slice(0, 12).join(' ')}`);

// suffix list: PSL suffixes seen in corpus, plus Tranco-derived ones, ordered by count
const sufFromTranco = new Map<string, number>();
for (const d of tranco.slice(0, 200000)) {
  const r = registrable(d);
  if (r) sufFromTranco.set(r.suffix, (sufFromTranco.get(r.suffix) ?? 0) + 1);
}
const sufAll = new Map<string, number>();
for (const [s, c] of sufCount) sufAll.set(s, (sufAll.get(s) ?? 0) + c * 4);
for (const [s, c] of sufFromTranco) sufAll.set(s, (sufAll.get(s) ?? 0) + c);
const suffixes = [...sufAll.entries()]
  .filter(([s, c]) => c >= 3 && /^[a-z0-9.-]+$/.test(s))
  .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  .slice(0, 2048)
  .map(([s]) => s);
log(`suffixes: ${suffixes.length}, top: ${suffixes.slice(0, 12).join(' ')}`);

// ---------------------------------------------------------------- 3. phrase mining

const BOUNDARY = new Set('/?&=#.-_+:'.split(''));
function minePhrases(texts: string[], max: number, minLen = 2, maxLen = 24, minCount = 8): string[] {
  const counts = new Map<string, number>();
  let n = 0;
  for (const t of texts) {
    // boundary positions: 0, after each delimiter, and end
    const starts: number[] = [0];
    for (let i = 0; i < t.length; i++) if (BOUNDARY.has(t[i])) starts.push(i), starts.push(i + 1);
    const ends = new Set<number>(starts);
    ends.add(t.length);
    const uniq = new Set<string>();
    for (const a of starts) {
      for (const b of ends) {
        const len = b - a;
        if (len < minLen || len > maxLen) continue;
        uniq.add(t.slice(a, b));
      }
    }
    for (const u of uniq) counts.set(u, (counts.get(u) ?? 0) + 1);
    if (++n % 50000 === 0 && counts.size > 4_000_000) {
      for (const [k, v] of counts) if (v < 2) counts.delete(k);
    }
  }
  const scored = [...counts.entries()]
    .filter(([s, c]) => c >= minCount && s.length >= minLen && !/^[0-9]+$/.test(s))
    .map(([s, c]) => ({ s, score: c * (s.length - 1) }))
    .sort((a, b) => b.score - a.score || (a.s < b.s ? -1 : 1));
  return scored.slice(0, max).map((x) => x.s);
}
/**
 * Phrases the corpus cannot teach us. Reddit links from 2016 contain almost no
 * JWTs, but the text *inside* a base64 blob (see the B64TEXT unit) is JSON, and
 * these fragments are what JSON is made of. Seeds are never pruned; they cost a
 * symbol each and are what makes an SSO or magic-link URL worth furling.
 */
const SEED_PHRASES = [
  '{"alg":"HS256","typ":"JWT"}',
  '{"alg":"RS256","typ":"JWT"}',
  '{"alg":"HS512","typ":"JWT"}',
  '{"typ":"JWT","alg":"HS256"}',
  '{"alg":"none","typ":"JWT"}',
  '","typ":"JWT"}',
  '{"alg":"',
  '","iat":',
  '","exp":',
  '"iat":',
  '"exp":',
  '"iss":"',
  '"aud":"',
  '"sub":"',
  '"jti":"',
  '"nbf":',
  '"email":"',
  '"name":"',
  '"role":"',
  '"scope":"',
  '"type":"',
  '"id":"',
  '"userId":"',
  '"memberId":"',
  '"businessId":"',
  '"tenantId":"',
  '"token":"',
  '"redirect":"',
  '","',
  '":"',
  '":',
  '"}',
  '":[',
  '":{',
  ',"',
  '{"',
  'true',
  'false',
  'null',
];

const rests = splits.filter((x) => x.s).map((x) => x.s!.rest);
let phrases = minePhrases(rests.slice(0, 400000), P.phrases);
{
  // Seeds first, mined phrases after, no duplicates.
  const mined = phrases.filter((x) => !SEED_PHRASES.includes(x));
  phrases = [...SEED_PHRASES, ...mined];
}
const SEED_COUNT = SEED_PHRASES.length;
log(`phrases: ${phrases.length}, sample: ${phrases.slice(0, 20).map((p) => JSON.stringify(p)).join(' ')}`);

// host phrases: whole subdomains and whole labels
const hostParts = new Map<string, number>();
for (const { s } of splits) {
  if (!s) continue;
  const r = registrable(s.host);
  if (!r) continue;
  if (r.sub) hostParts.set(r.sub, (hostParts.get(r.sub) ?? 0) + 1);
}
let hostPhrases = [...hostParts.entries()]
  .filter(([s, c]) => c >= 20 && s.length >= 1 && /^[a-z0-9.-]+$/.test(s))
  .sort((a, b) => b[1] * a[0].length - a[1] * b[0].length || (a[0] < b[0] ? -1 : 1))
  .slice(0, P.hostPhrases)
  .map(([s]) => s);
log(`host phrases: ${hostPhrases.length}, sample: ${hostPhrases.slice(0, 20).join(' ')}`);

// ---------------------------------------------------------------- 4. counting + building

const TEXT_NCHARS = URL_CHARS.length;
const TEXT_END = TEXT_NCHARS;
const TEXT_RUN_BASE = TEXT_END + 1;
const TEXT_PHRASE_BASE = TEXT_RUN_BASE + NRUN;
let TEXT_NSYM = TEXT_PHRASE_BASE + phrases.length;
const HOST_NCHARS = HOST_CHARS.length;
const HOST_END = HOST_NCHARS;
const HOST_PHRASE_BASE = HOST_END + 1;
let HOST_NSYM = HOST_PHRASE_BASE + hostPhrases.length;

/** Keep only phrases the parse actually used at least `minUse` times; returns the kept index list. */
function prunePhrases(list: string[], usage: Float64Array, base: number, minUse: number, max: number, keepFirst = 0): { kept: string[]; map: number[] } {
  const idx = list.map((_, i) => i).filter((i) => i < keepFirst || usage[base + i] >= minUse);
  idx.sort((a, b) => (a < keepFirst ? -1 : b < keepFirst ? 1 : usage[base + b] - usage[base + a] || a - b));
  const keep = idx.slice(0, Math.max(max, keepFirst)).sort((a, b) => a - b);
  return { kept: keep.map((i) => list[i]), map: keep };
}

class CtxCounter {
  readonly nsym: number;
  o0: Float64Array;
  o1 = new Map<string, Float64Array>();
  o2 = new Map<string, Float64Array>();
  constructor(nsym: number) {
    this.nsym = nsym;
    this.o0 = new Float64Array(nsym);
  }
  add(ctx2: string, sym: number, w = 1): void {
    this.o0[sym] += w;
    const c1 = ctx2[1];
    let a1 = this.o1.get(c1);
    if (!a1) this.o1.set(c1, (a1 = new Float64Array(this.nsym)));
    a1[sym] += w;
    let a2 = this.o2.get(ctx2);
    if (!a2) this.o2.set(ctx2, (a2 = new Float64Array(this.nsym)));
    a2[sym] += w;
  }
}

function buildContextModel(c: CtxCounter, minCtx2: number): ContextModelJSON {
  const nsym = c.nsym;
  const o0syms = Array.from({ length: nsym }, (_, i) => i);
  const o0counts = Array.from(c.o0, (v) => v + 1);
  const order0 = { syms: o0syms, freq: quantize(o0counts, TOTAL) };
  const buildCtx = (arr: Float64Array, minSym: number, minP: number) => {
    const syms: number[] = [];
    const counts: number[] = [];
    let distinct = 0;
    let total = 0;
    for (let s = 0; s < nsym; s++) total += arr[s];
    for (let s = 0; s < nsym; s++) {
      if (arr[s] <= 0) continue;
      distinct++;
      if (arr[s] >= minSym && arr[s] >= total * minP) {
        syms.push(s);
        counts.push(arr[s]);
      }
    }
    if (syms.length === 0) return null;
    const esc = Math.max(1, Math.round(distinct * P.esc));
    const q = quantize([...counts, esc], TOTAL);
    return { syms, freq: q.slice(0, -1), esc: q[q.length - 1] };
  };
  const order1: ContextModelJSON['order1'] = {};
  for (const [k, arr] of [...c.o1.entries()].sort()) {
    const t = buildCtx(arr, P.minSym1, 0);
    if (t) order1[k] = t;
  }
  const order2: ContextModelJSON['order2'] = {};
  for (const [k, arr] of [...c.o2.entries()].sort()) {
    let total = 0;
    for (const v of arr) total += v;
    if (total < minCtx2) continue;
    const t = buildCtx(arr, P.minSym2, P.minP2);
    if (t) order2[k] = t;
  }
  return { nsym, excl: P.excl, order0, order1, order2 };
}

interface Counts {
  text: CtxCounter;
  host: CtxCounter;
  runLen: number[][];
  flags: { mode: number[]; scheme: number[]; www: number[]; hostMode: number[]; sub: number[]; port: number[] };
  rankBucket: number[];
  suffixFreq: number[];
}
function newCounts(): Counts {
  return {
    text: new CtxCounter(TEXT_NSYM),
    host: new CtxCounter(HOST_NSYM),
    runLen: Array.from({ length: NRUN }, () => new Array(LEN_BUCKETS).fill(0)),
    flags: { mode: [0, 0], scheme: [0, 0], www: [0, 0], hostMode: [0, 0, 0], sub: [0, 0], port: [0, 0] },
    rankBucket: new Array(15).fill(0),
    suffixFreq: new Array(suffixes.length).fill(0),
  };
}

function smooth(counts: number[], add = 1): number[] {
  return quantize(counts.map((c) => c + add), TOTAL);
}

function buildModel(c: Counts): ModelJSON {
  return {
    version: P.version,
    meta: {},
    classes: P.classes,
    flags: {
      mode: smooth(c.flags.mode),
      scheme: smooth(c.flags.scheme),
      www: smooth(c.flags.www),
      hostMode: smooth(c.flags.hostMode),
      sub: smooth(c.flags.sub),
      port: smooth(c.flags.port),
    },
    text: {
      model: buildContextModel(c.text, P.minCtx2),
      phrases,
      runLen: c.runLen.map((r) => smooth(r)),
    },
    host: {
      model: buildContextModel(c.host, P.minCtx2Host),
      phrases: hostPhrases,
      ranks,
      rankBucket: smooth(c.rankBucket),
      suffixes,
      suffixFreq: smooth(c.suffixFreq),
    },
  };
}

/** Count the units a TextCoder's optimal parse produces for `text`. */
function countText(m: Model, coder: 'text' | 'host', ctr: CtxCounter, text: string, start: string, runLen?: number[][]): void {
  const tc = m[coder];
  const { units } = tc.parse(text, start);
  let i = 0;
  for (const u of units) {
    ctr.add(tc.ctx2(text, i, start), u.sym);
    if (u.kind === 'run' && runLen) {
      const len = RUN_TYPES[u.run!] === 'PCT' ? u.len / 3 : u.len;
      if (RUN_TYPES[u.run!] !== 'UUID') runLen[u.run!][31 - Math.clz32(len)]++;
    }
    i += u.len;
  }
}

function collect(m: Model): Counts {
  const c = newCounts();
  let n = 0;
  for (const { href, s } of splits) {
    if (!s || !m.text.canCode(s.rest) || !m.host.canCode(s.host)) {
      c.flags.mode[1]++;
      countText(m, 'text', c.text, href, START_RAW, c.runLen);
      continue;
    }
    c.flags.mode[0]++;
    c.flags.scheme[s.https ? 0 : 1]++;
    c.flags.www[s.www ? 1 : 0]++;
    const plan = planHost(m, s.host);
    c.flags.hostMode[plan.mode]++;
    let rank: number | undefined;
    if (plan.mode === 0) {
      rank = plan.rank!;
      c.rankBucket[31 - Math.clz32(rank)]++;
    } else if (plan.mode === 1) {
      c.suffixFreq[plan.suffix!]++;
      countText(m, 'host', c.host, plan.label!, START_LABEL);
    } else {
      countText(m, 'host', c.host, s.host, START_LITERAL);
    }
    if (plan.mode !== 2) {
      c.flags.sub[plan.sub ? 1 : 0]++;
      if (plan.sub) countText(m, 'host', c.host, plan.sub, START_SUB);
    }
    c.flags.port[s.port ? 1 : 0]++;
    countText(m, 'text', c.text, s.rest, classChar(m, rank), c.runLen);
    if (++n % 200000 === 0) log(`  collected ${n}`);
  }
  return c;
}

/** Bootstrap: order-0 character statistics with pseudo-counts for phrases and runs. */
function bootstrap(): ModelJSON {
  const c = newCounts();
  const n = splits.length;
  for (const { href, s } of splits) {
    const rest = s ? s.rest : href;
    for (let i = 0; i < rest.length; i++) {
      const code = rest.charCodeAt(i) - 0x21;
      if (code >= 0 && code < TEXT_NCHARS) c.text.o0[code]++;
    }
    c.text.o0[TEXT_END]++;
    if (s) {
      for (let i = 0; i < s.host.length; i++) {
        const k = HOST_CHARS.indexOf(s.host[i]);
        if (k >= 0) c.host.o0[k]++;
      }
      c.host.o0[HOST_END] += 2;
    }
  }
  for (let r = 0; r < NRUN; r++) c.text.o0[TEXT_RUN_BASE + r] = n / 50;
  for (let p = 0; p < phrases.length; p++) c.text.o0[TEXT_PHRASE_BASE + p] = n / 200;
  for (let p = 0; p < hostPhrases.length; p++) c.host.o0[HOST_PHRASE_BASE + p] = n / 200;
  return buildModel(c);
}

// ---------------------------------------------------------------- 5. rounds + eval

function evaluate(m: Model, hrefs: string[], label: string): { meanChars: number; medianChars: number; meanBits: number } {
  const models = new Map([[m.version, m]]);
  const lens: number[] = [];
  let bits = 0;
  let fails = 0;
  for (const h of hrefs) {
    const code = encodeHref(m, h);
    const back = decodeCode(models, code);
    if (back !== h) {
      fails++;
      if (fails <= 5) console.error('ROUND-TRIP FAILURE', h, code, back);
    }
    lens.push(code.length);
    bits += code.length * 6;
  }
  lens.sort((a, b) => a - b);
  const meanChars = lens.reduce((a, b) => a + b, 0) / lens.length;
  const medianChars = lens[Math.floor(lens.length / 2)];
  const meanIn = hrefs.reduce((a, h) => a + h.length, 0) / hrefs.length;
  log(
    `${label}: n=${hrefs.length} mean code ${meanChars.toFixed(2)} chars (median ${medianChars}), mean input ${meanIn.toFixed(1)} chars, ratio ${(meanChars / meanIn).toFixed(3)}, failures ${fails}`,
  );
  if (fails) throw new Error('round-trip failures');
  return { meanChars, medianChars, meanBits: bits / hrefs.length };
}

/**
 * A few thousand synthetic magic-link / SSO URLs. Real corpora of them do not
 * exist publicly (they are private by nature), and without any the model would
 * never see the inside of a token. Generated deterministically, mixed in at a
 * few per cent so it cannot distort ordinary links; the effect on the held-out
 * numbers is reported at the end of training either way.
 */
function syntheticTokenLinks(n: number): string[] {
  let seed = 20260816;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const hex = (k: number) => Array.from({ length: k }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hosts = ['tenant.example.app', 'app.example.com', 'login.example.org', 'my.example.net', 'tenant.example.app'];
  const paths = ['/register', '/sso', '/login', '/invite', '/magic', '/verify', '/auth/callback', '/join'];
  const keys = ['token', 'jwt', 't', 'code', 'auth', 'state'];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const claims: Record<string, unknown> = {
      sub: hex(24),
      iat: 1750000000 + Math.floor(rnd() * 9e6),
      exp: 1750000000 + Math.floor(rnd() * 9e6),
    };
    if (rnd() < 0.5) claims.businessId = hex(24);
    if (rnd() < 0.4) claims.memberId = hex(24);
    if (rnd() < 0.3) claims.role = pick(['member', 'admin', 'owner', 'staff']);
    if (rnd() < 0.3) claims.email = `user${Math.floor(rnd() * 99999)}@example.com`;
    if (rnd() < 0.2) claims.iss = pick(['example', 'auth.example.com', 'tenant']);
    const header = b64(rnd() < 0.85 ? { alg: 'HS256', typ: 'JWT' } : { alg: 'RS256', typ: 'JWT' });
    const sigLen = rnd() < 0.85 ? 43 : 342;
    const sig = Array.from({ length: sigLen }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(rnd() * 64)]).join('');
    out.push(`https://${pick(hosts)}${pick(paths)}?${pick(keys)}=${header}.${b64(claims)}.${sig}`);
  }
  return out;
}
const synthetic = corpusOverride ? [] : syntheticTokenLinks(Math.min(6000, Math.max(1000, Math.round(splits.length * 0.01))));
for (const href of synthetic) splits.push({ href, s: structure(new URL(href)) });
log(`synthetic token links added to training: ${synthetic.length}`);

const evalSet = heldout.slice(0, P.evalN);
const adaEval = ada.slice(0, Math.min(P.evalN, ada.length));

/** Drop the phrase columns not in `keep` from a counter (chars, END, runs stay). */
function remapCounter(c: CtxCounter, base: number, keep: number[]): CtxCounter {
  const out = new CtxCounter(base + keep.length);
  const copy = (src: Float64Array, dst: Float64Array) => {
    for (let s = 0; s < base; s++) dst[s] = src[s];
    for (let k = 0; k < keep.length; k++) dst[base + k] = src[base + keep[k]];
  };
  copy(c.o0, out.o0);
  for (const [k, a] of c.o1) {
    const d = new Float64Array(out.nsym);
    copy(a, d);
    out.o1.set(k, d);
  }
  for (const [k, a] of c.o2) {
    const d = new Float64Array(out.nsym);
    copy(a, d);
    out.o2.set(k, d);
  }
  return out;
}

let json = bootstrap();
let model = new Model(json);
log('bootstrap built');
for (let r = 1; r <= P.rounds; r++) {
  let counts = collect(model);
  if (r === 1) {
    // Prune phrases the optimal parse does not use enough to earn their symbol.
    const minUse = Math.max(20, splits.length / 20000);
    const tp = prunePhrases(phrases, counts.text.o0, TEXT_PHRASE_BASE, minUse, P.phrases, SEED_COUNT);
    const hp = prunePhrases(hostPhrases, counts.host.o0, HOST_PHRASE_BASE, minUse, P.hostPhrases);
    log(`phrase pruning: text ${phrases.length} -> ${tp.kept.length}, host ${hostPhrases.length} -> ${hp.kept.length}`);
    counts = { ...counts, text: remapCounter(counts.text, TEXT_PHRASE_BASE, tp.map), host: remapCounter(counts.host, HOST_PHRASE_BASE, hp.map) };
    phrases = tp.kept;
    hostPhrases = hp.kept;
    TEXT_NSYM = TEXT_PHRASE_BASE + phrases.length;
    HOST_NSYM = HOST_PHRASE_BASE + hostPhrases.length;
  }
  json = buildModel(counts);
  model = new Model(json);
  const o2 = Object.values(json.text.model.order2).reduce((a, t) => a + t.syms.length, 0);
  log(`round ${r}: text ctx2=${Object.keys(json.text.model.order2).length} (${o2} entries) host ctx2=${Object.keys(json.host.model.order2).length}`);
  evaluate(model, evalSet.slice(0, 5000), `  round ${r} held-out(5k)`);
}

// host-mode statistics on held-out, for the size trade-off decision
{
  const hm = [0, 0, 0];
  const rb = new Array(15).fill(0);
  let raw = 0;
  for (const h of evalSet) {
    const s = structure(new URL(h));
    if (!s || !model.host.canCode(s.host) || !model.text.canCode(s.rest)) {
      raw++;
      continue;
    }
    const p = planHost(model, s.host);
    hm[p.mode]++;
    if (p.mode === 0) rb[31 - Math.clz32(p.rank!)]++;
  }
  log(`held-out host modes: rank ${hm[0]} suffix ${hm[1]} literal ${hm[2]} raw ${raw}; rank buckets ${rb.join(' ')}`);
}

// Drop phrases the final parse never uses? Keep it simple and deterministic: keep all.
json.meta = {
  name: 'enfurl model v' + P.version,
  built: new Date().toISOString().slice(0, 10),
  params: { ...P, limit: Number.isFinite(P.limit) ? P.limit : null },
  corpora: {
    train: [...corpora.keys()].join(' + ') + ' (90% hash split each, deduped across sources)',
    ranks: 'Tranco top-1M snapshot x corpus frequency (geometric mean of ranks)',
    suffixes: 'Public Suffix List snapshot x corpus + Tranco',
  },
  trainUrls: splits.length,
};
const final = new Model(json);
const r1 = evaluate(final, evalSet, 'FINAL reddit held-out');
const r2 = adaEval.length ? evaluate(final, adaEval, 'FINAL ada (different distribution)') : null;
json.meta.heldout = { reddit: r1, ada: r2 };

const outPath = join(root, P.out);
mkdirSync(dirname(outPath), { recursive: true });
const text = JSON.stringify(json);
writeFileSync(outPath, text);
log(`wrote ${outPath}: ${(text.length / 1024).toFixed(0)} KB, gzip ${(gzipSync(text).length / 1024).toFixed(0)} KB`);
