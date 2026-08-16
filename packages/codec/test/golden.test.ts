/**
 * Golden vectors: the released model must produce exactly these codes and
 * decode them back. If this test fails after a codec change, the change broke
 * the format for every code ever issued. Do not update the vectors; fix the code
 * or ship a new version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codec } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

for (const v of [1]) {
  const modelPath = join(here, '..', 'models', `v${v}`, 'model.json');
  const goldenPath = join(here, `golden-v${v}.json`);
  test(`model v${v}: golden vectors encode and decode exactly`, { skip: !existsSync(modelPath) || !existsSync(goldenPath) }, () => {
    const model = JSON.parse(readFileSync(modelPath, 'utf8'));
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { version: number; vectors: { href: string; code: string }[] };
    assert.equal(model.version, v);
    assert.equal(golden.version, v);
    const codec = new Codec([model]);
    for (const { href, code } of golden.vectors) {
      assert.equal(codec.decode(code), href, `decode ${code}`);
      assert.equal(codec.encode(href).code, code, `encode ${href}`);
    }
  });

  test(`model v${v}: real-model edge cases round-trip`, { skip: !existsSync(modelPath) }, () => {
    const codec = new Codec([JSON.parse(readFileSync(modelPath, 'utf8'))]);
    for (const u of [
      'https://example.com/?a=1&a=2&b=%26',
      'https://example.com/pct/%41%42%43%ff%FE',
      'https://example.com/pct/%zz%4',
      'https://EXAMPLE.com/Mixed/Case?Q=1',
      'https://a.b.c.d.e.f.g.example.co.uk/x',
      'http://localhost/',
      'http://localhost:3000/api?x=1',
      'https://1.2.3.4/',
      'https://xn--80ak6aa92e.com/',
    ]) {
      const href = new URL(u).href;
      assert.equal(codec.decode(codec.encode(u).code), href, u);
    }
  });
}
