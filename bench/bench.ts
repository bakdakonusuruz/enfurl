/**
 * Benchmark: code length of enfurl against baselines on held-out corpora.
 *
 *   node bench/bench.ts [--model packages/codec/models/v1/model.json] [--n 20000]
 *                       [--hamr <path to a clone of github.com/p2r3/ha.mr>]
 *
 * Corpora come from tools/train: the held-out tenth of every training corpus,
 * plus ada, which the model is never trained on at all.
 *
 * Baselines: base64url of the raw UTF-8, DEFLATE(raw, 9)+base64url, brotli(11)+base64url,
 * and optionally ha.mr's ASCII output (its own 82-character alphabet, so its numbers are
 * character counts in a denser alphabet, slightly flattering to it).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, brotliCompressSync, constants, gzipSync } from 'node:zlib';

import { Codec } from '../packages/codec/src/index.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '1'), i++;
}
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const modelPath = resolve(root, args.get('model') ?? 'packages/codec/models/v1/model.json');
const N = Number(args.get('n') ?? 20000);
const hamrPath = args.get('hamr');

const modelText = readFileSync(modelPath, 'utf8');
const codec = new Codec([JSON.parse(modelText)]);
console.log(`model: ${modelPath} (${(modelText.length / 1024).toFixed(0)} KB, gzip ${(gzipSync(modelText).length / 1024).toFixed(0)} KB)`);

let hamr: ((s: string, alphabet: string[]) => string) | null = null;
let hamrAlphabet: string[] | null = null;
if (hamrPath) {
  const mod = await import(pathToFileURL(join(hamrPath, 'compress.js')).href);
  const alph = await import(pathToFileURL(join(hamrPath, 'alphabets.js')).href);
  hamr = mod.compress;
  hamrAlphabet = alph.outputAlphabetASCII;
}

const b64len = (n: number) => Math.ceil((n * 8) / 6);
const baselines: Record<string, (href: string) => number> = {
  'base64url(raw)': (h) => b64len(Buffer.byteLength(h)),
  'deflate+b64': (h) => b64len(deflateRawSync(Buffer.from(h), { level: 9 }).length),
  'brotli+b64': (h) =>
    b64len(
      brotliCompressSync(Buffer.from(h), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT },
      }).length,
    ),
  enfurl: (h) => codec.encode(h).code.length,
};
if (hamr) baselines['ha.mr'] = (h) => hamr!(h, hamrAlphabet!).length;

function stats(xs: number[]): { mean: number; median: number; p90: number } {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)] };
}

/**
 * Magic-link / SSO URLs: a tenant host, a short path, and a JWT. No public
 * corpus of these exists (they are private by nature), so the benchmark
 * generates them deterministically. Same generator as the trainer's synthetic
 * mix but a different seed, so these are held out from it.
 */
function ssoLinks(n: number): string[] {
  let seed = 777333;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const hex = (k: number) => Array.from({ length: k }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const claims: Record<string, unknown> = { sub: hex(24), iat: 1750000000 + Math.floor(rnd() * 9e6), exp: 1750000000 + Math.floor(rnd() * 9e6) };
    if (rnd() < 0.5) claims.businessId = hex(24);
    if (rnd() < 0.4) claims.memberId = hex(24);
    if (rnd() < 0.3) claims.role = pick(['member', 'admin', 'owner']);
    const sig = Array.from({ length: 43 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(rnd() * 64)]).join('');
    out.push(
      `https://${pick(['tenant.example.app', 'shop.example.com', 'login.example.org'])}${pick(['/register', '/sso', '/invite', '/magic'])}?${pick(['token', 'jwt', 't'])}=${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.${sig}`,
    );
  }
  return out;
}

for (const file of ['reddit-heldout.txt', 'hn-heldout.txt', 'curated-heldout.txt', 'ada.txt', 'sso-synthetic']) {
  let hrefs: string[];
  if (file === 'sso-synthetic') {
    hrefs = ssoLinks(Math.min(N, 5000));
  } else {
    const p = join(root, 'bench', 'corpus', file);
    if (!existsSync(p)) {
      console.log(`missing ${p}: run node tools/train/src/train.ts first`);
      continue;
    }
    hrefs = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(0, N);
  }
  const inLen = stats(hrefs.map((h) => h.length));
  console.log(`\n## ${file}: ${hrefs.length} URLs, input mean ${inLen.mean.toFixed(1)} chars, median ${inLen.median}, p90 ${inLen.p90}\n`);
  console.log('| coder | mean chars | median | p90 | ratio (mean) | shorter than input |');
  console.log('|---|---|---|---|---|---|');
  for (const [name, f] of Object.entries(baselines)) {
    const out: number[] = [];
    let shorter = 0;
    let errors = 0;
    for (const h of hrefs) {
      try {
        const l = f(h);
        out.push(l);
        if (l < h.length) shorter++;
      } catch {
        errors++;
      }
    }
    const s = stats(out);
    console.log(
      `| ${name} | ${s.mean.toFixed(2)} | ${s.median} | ${s.p90} | ${(s.mean / inLen.mean).toFixed(3)} | ${((100 * shorter) / hrefs.length).toFixed(1)}%${errors ? ` (${errors} errors)` : ''} |`,
    );
  }
  // enfurl by input length bucket
  const buckets: [number, number][] = [
    [0, 40],
    [40, 60],
    [60, 90],
    [90, 140],
    [140, 5000],
  ];
  console.log('\n| input length | n | enfurl mean | brotli+b64 mean | base64url mean |');
  console.log('|---|---|---|---|---|');
  for (const [lo, hi] of buckets) {
    const sub = hrefs.filter((h) => h.length >= lo && h.length < hi);
    if (sub.length === 0) continue;
    const e = stats(sub.map(baselines['enfurl']));
    const b = stats(sub.map(baselines['brotli+b64']));
    const r = stats(sub.map(baselines['base64url(raw)']));
    console.log(`| ${lo}-${hi - 1} | ${sub.length} | ${e.mean.toFixed(1)} | ${b.mean.toFixed(1)} | ${r.mean.toFixed(1)} |`);
  }
}

// a few illustrative examples
console.log('\n## Examples\n');
console.log('| URL | enfurl | chars |');
console.log('|---|---|---|');
for (const u of [
  'https://en.wikipedia.org/wiki/Arithmetic_coding',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://github.com/p2r3/ha.mr',
  'https://www.amazon.com/dp/B0BSHF7WHW',
  'https://twitter.com/jack/status/20',
  'https://www.reddit.com/r/programming/comments/1abc2de/some_title_here/',
  'https://news.ycombinator.com/item?id=546530',
  'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit',
  'https://tr.wikipedia.org/wiki/%C4%B0stanbul',
  'https://example.com/',
]) {
  const c = codec.encode(u).code;
  console.log(`| \`${u}\` | \`${c}\` | ${c.length} / ${u.length} |`);
}
