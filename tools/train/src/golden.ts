/**
 * Generate golden test vectors for a released model version.
 *
 *   node tools/train/src/golden.ts [--model packages/codec/models/v1/model.json]
 *                                  [--out packages/codec/test/golden-v1.json] [--n 1000]
 *
 * Takes URLs from bench/corpus (held-out) plus a fixed list of edge cases, encodes
 * them, verifies decode, and writes {href, code} pairs. Run once when a model
 * is frozen; the golden test then guards every future change to the codec.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codec } from '../../../packages/codec/src/index.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '1'), i++;
}
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const modelPath = resolve(root, args.get('model') ?? 'packages/codec/models/v1/model.json');
const outPath = resolve(root, args.get('out') ?? 'packages/codec/test/golden-v1.json');
const n = Number(args.get('n') ?? 1000);

const model = JSON.parse(readFileSync(modelPath, 'utf8'));
const codec = new Codec([model]);

const edge = [
  'https://en.wikipedia.org/wiki/Arithmetic_coding',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://google.com/',
  'http://example.com/',
  'https://example.com/?',
  'https://example.com/#',
  'https://example.com/#frag',
  'https://user:pw@example.com/secret',
  'https://[2001:db8::1]/ipv6',
  'https://192.168.0.1:8080/router?x=%20y',
  'https://xn--bcher-kva.example/%C3%BCmlaut',
  'https://example.com/id/550e8400-e29b-41d4-a716-446655440000/edit',
  'https://example.com/hash/3fa4c1e0d2b8a9f7c6e5d4c3b2a1f0e9d8c7b6a5',
  'https://tr.wikipedia.org/wiki/%C4%B0stanbul_Bo%C4%9Fazi%C3%A7i_K%C3%B6pr%C3%BCs%C3%BC',
  'https://example.com/lower/%c3%bc%c3%b6',
  'https://sub.sub2.sub3.example.org/deep/path/x',
  'http://www.com/',
  'https://www.example.com./trailing-dot',
  'http://www..nfllivestream.com/',
  'https://example.com/' + 'a'.repeat(1500),
  'https://example.com/tokens/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  "https://example.com/~user/!$&'()*+,;=:@[]",
  'https://example.com/^|`{}\\',
  'https://host.with-dash.io:8443/path?x=1',
];
const held = readFileSync(join(root, 'bench', 'corpus', 'reddit-heldout.txt'), 'utf8').split('\n').filter(Boolean);
const ada = readFileSync(join(root, 'bench', 'corpus', 'ada.txt'), 'utf8').split('\n').filter(Boolean);
// deterministic spread: every k-th line
const pick = (arr: string[], count: number) => {
  const step = Math.max(1, Math.floor(arr.length / count));
  const out: string[] = [];
  for (let i = 0; i < arr.length && out.length < count; i += step) out.push(arr[i]);
  return out;
};
const inputs = [...edge, ...pick(held, Math.floor(n * 0.7)), ...pick(ada, Math.floor(n * 0.3))];
const vectors: { href: string; code: string }[] = [];
for (const u of inputs) {
  const r = codec.encode(u);
  const back = codec.decode(r.code);
  if (back !== r.href) throw new Error(`round trip failed: ${u}`);
  vectors.push({ href: r.href, code: r.code });
}
writeFileSync(outPath, JSON.stringify({ version: model.version, generated: new Date().toISOString().slice(0, 10), vectors }, null, 0) + '\n');
console.log(`wrote ${vectors.length} vectors to ${outPath}`);
