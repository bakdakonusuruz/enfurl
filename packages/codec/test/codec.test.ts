import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Codec } from '../src/index.ts';
import { toyModel } from './helpers.ts';

const URLS = [
  'https://en.wikipedia.org/wiki/Arithmetic_coding',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://google.com/',
  'http://example.com/',
  'https://api.github.com/repos/foo/bar/issues?state=open&page=2',
  'https://i.imgur.com/sK8AqFM.jpg?2',
  'https://twitter.com/user/status/1234567890123456789',
  'https://example.co.uk/a/b/c.html#section-2',
  'https://host.with-dash.io:8443/path?x=1',
  'https://example.com/id/550e8400-e29b-41d4-a716-446655440000/edit',
  'https://example.com/hash/3fa4c1e0d2b8a9f7c6e5d4c3b2a1f0e9d8c7b6a5',
  'https://tr.wikipedia.org/wiki/%C4%B0stanbul_Bo%C4%9Fazi%C3%A7i_K%C3%B6pr%C3%BCs%C3%BC',
  'https://example.com/lower/%c3%bc%c3%b6',
  'https://example.com/?',
  'https://example.com/#',
  'https://example.com/#frag',
  'https://user:pw@example.com/secret',
  'https://[2001:db8::1]/ipv6',
  'https://192.168.0.1:8080/router?x=%20y',
  'https://xn--bcher-kva.example/ümlaut',
  'https://example.com/a%2Fb/c d',
  'https://sub.sub2.sub3.example.org/deep/./path/../x',
  'http://www.com/',
  'https://www.example.com./trailing-dot',
  'https://EXAMPLE.com/Mixed/Case?Q=1',
  'https://example.com/' + 'a'.repeat(1500),
  'https://example.com/tokens/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'https://example.com/pct/%41%42%43%ff%FE',
  'https://example.com/pct/%zz%4',
  'https://example.com/~user/!$&\'()*+,;=:@[]',
  'https://example.com/^|`{}\\',
  'https://example.com/?a=1&a=2&b=%26',
];

test('toy model: every URL round-trips to its normalised href', () => {
  const codec = new Codec([toyModel()]);
  for (const u of URLS) {
    const r = codec.encode(u);
    assert.equal(r.href, new URL(u).href, u);
    const back = codec.decode(r.code);
    assert.equal(back, r.href, `round trip failed for ${u} (code ${r.code})`);
    assert.equal(codec.decode('/' + r.code + '+'), r.href);
    assert.equal(codec.versionOf(r.code), 1);
  }
});

test('toy model: fuzzed paths round-trip', () => {
  const codec = new Codec([toyModel()]);
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&\'()*+,;=%';
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 500; i++) {
    const n = Math.floor(rand() * 60);
    let p = '/';
    for (let k = 0; k < n; k++) p += chars[Math.floor(rand() * chars.length)];
    const u = 'https://ex' + Math.floor(rand() * 5) + '.org' + p;
    let href: string;
    try {
      href = new URL(u).href;
    } catch {
      continue;
    }
    const r = codec.encode(u);
    assert.equal(codec.decode(r.code), href, `fuzz ${u}`);
  }
});

test('rejects non-http schemes and empty input', () => {
  const codec = new Codec([toyModel()]);
  assert.throws(() => codec.encode('javascript:alert(1)'));
  assert.throws(() => codec.encode('data:text/plain,hi'));
  assert.throws(() => codec.encode('   '));
  assert.throws(() => codec.encode('not a url'));
  assert.equal(codec.encode('example.com/x', { addScheme: true }).href, 'https://example.com/x');
});

test('tracker stripping removes only known params and keeps the rest verbatim', () => {
  const codec = new Codec([toyModel()]);
  const r = codec.encode('https://a.com/p?utm_source=x&keep=%2Fy&fbclid=abc&z', { stripTrackers: true });
  assert.equal(r.href, 'https://a.com/p?keep=%2Fy&z');
  assert.deepEqual(r.removedParams, ['utm_source', 'fbclid']);
  const r2 = codec.encode('https://a.com/p?utm_source=x', { stripTrackers: true });
  assert.equal(r2.href, 'https://a.com/p');
});

test('unknown version and corrupt codes throw instead of returning garbage', () => {
  const codec = new Codec([toyModel()]);
  assert.throws(() => codec.decode('!!!'));
  assert.throws(() => codec.decode(''));
  // A code produced by a different model version must be refused, not misdecoded.
  const other = new Codec([toyModel(2)]);
  const c2 = other.encode('https://example.com/x').code;
  assert.equal(other.decode(c2), 'https://example.com/x');
  assert.throws(() => codec.decode(c2), /unknown code version 2/);
});

test('hosts with empty labels round-trip (regression from corpus)', () => {
  const codec = new Codec([toyModel()]);
  for (const u of ['http://www..nfllivestream.com/', 'http://a..b.example.com/x', 'http://example.com./y', 'http://..example.com/']) {
    const href = new URL(u).href;
    assert.equal(codec.decode(codec.encode(u).code), href, u);
  }
});

test('explain accounts for every bit and every character of the URL', () => {
  const codec = new Codec([toyModel()]);
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://en.wikipedia.org/wiki/Arithmetic_coding',
    'https://example.com/id/550e8400-e29b-41d4-a716-446655440000/edit',
    'https://user:pw@example.com/raw-mode-please',
    'https://example.com/',
  ]) {
    const ex = codec.explain(u);
    const href = new URL(u).href;
    assert.equal(ex.href, href);
    // Parts cover the whole URL: site part plus every path unit, in order.
    const covered = ex.parts.map((p) => p.text).join('');
    assert.ok(href.startsWith(covered) || covered === href, `parts do not reconstruct ${href}: ${covered}`);
    // Total agrees with the independent size estimate, and with the real furl.
    // Tolerance is float rounding only: explain divides each part by the cost
    // scale separately, estimateBits divides the integer total once.
    const sum = ex.parts.reduce((a, p) => a + p.bits, 0);
    assert.ok(Math.abs(sum - ex.bits) < 1e-9);
    assert.ok(Math.abs(ex.bits - codec.estimateBits(u)) < 0.001, `${ex.bits} vs ${codec.estimateBits(u)}`);
    const chars = codec.furl(u).code.length;
    assert.ok(chars <= Math.ceil(ex.bits / 6) + 2, `furl ${chars} chars vs ${ex.bits} bits`);
  }
});

test('base64 blobs holding text round-trip through the nested coder', () => {
  const codec = new Codec([toyModel()]);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'abc', iat: 1755204800 })}.DW7PMJHyU7QVdtc4mfpbvB1-30ChAmPEJYbnSKkKa8w`;
  for (const u of [
    `https://tenant.example.app/register?token=${jwt}`,
    `https://x.example/s?state=${b64({ a: 1, b: 'two', c: [3, 4] })}`,
    // blobs that must NOT take the nested path: not text, odd length, padded
    'https://x.example/?b=SGVsbG8sIHdvcmxkIQ',
    'https://x.example/?b=SGVsbG8sIHdvcmxkIQ==',
    'https://x.example/?b=_-_-_-_-_-_-_-_-_-_-',
    'https://x.example/?b=AAAAAAAAAAAAAAAAAAAB',
    `https://x.example/?deep=${Buffer.from(`{"inner":"${b64({ nested: 'yes' })}"}`).toString('base64url')}`,
  ]) {
    const r = codec.furl(u);
    assert.equal(codec.unfurl(r.code), new URL(u).href, `nested round trip failed for ${u}`);
  }
});

test('nested coder makes JWT links substantially smaller', () => {
  const codec = new Codec([toyModel()]);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = b64({ businessId: '66f1c2a999123456789abcd0', memberId: '66f1c2a999123456789abcd1', iat: 1755204800, exp: 1755291200 });
  const url = `https://tenant.example.app/register?token=${b64({ alg: 'HS256', typ: 'JWT' })}.${payload}.DW7PMJHyU7QVdtc4mfpbvB1-30ChAmPEJYbnSKkKa8w`;
  const parts = codec.explain(url).parts;
  assert.ok(parts.some((p) => p.run === 'B64TEXT'), 'the JWT payload should be coded as nested text');
  // Even under the toy (uniform) model, unpacking beats 6 bits per character.
  assert.ok(codec.furl(url).code.length < url.length, 'furl should be shorter than the link');
});

test('low percent escapes keep both hex digits', () => {
  const codec = new Codec([toyModel()]);
  // A byte below 0x10 written as one hex digit would swallow the next character:
  // "a%0Ab" would come back as "a%ab". Every byte must produce two digits.
  for (const u of [
    'https://example.com/a%0Ab',
    'https://example.com/%00%01%02%0f%10',
    'https://example.com/%09tab%0Anewline',
    'https://example.com/?q=%0A%0D&x=%7F',
    'https://example.com/#%0a%0A%aA',
  ]) {
    const href = new URL(u).href;
    assert.equal(codec.unfurl(codec.furl(u).code), href, u);
  }
});

test('every printable character round-trips, wherever it lands', () => {
  const codec = new Codec([toyModel()]);
  // The whole printable range, not a curated subset: a character the coder
  // cannot place must send the URL down the raw path, never corrupt it.
  let alphabet = '';
  for (let c = 0x20; c <= 0x7e; c++) alphabet += String.fromCharCode(c);
  let seed = 20260816;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let checked = 0;
  for (let i = 0; i < 1500; i++) {
    let s = '';
    const n = 1 + Math.floor(rand() * 30);
    for (let k = 0; k < n; k++) {
      s += rand() < 0.12 ? '%' + '0123456789abcdefABCDEF'[Math.floor(rand() * 22)] + '0123456789abcdefABCDEF'[Math.floor(rand() * 22)] : alphabet[Math.floor(rand() * alphabet.length)];
    }
    const where = ['/', '/?', '/#', '/p/'][Math.floor(rand() * 4)];
    let href: string;
    try {
      href = new URL(`https://ex.org${where}${s}`).href;
    } catch {
      continue;
    }
    checked++;
    assert.equal(codec.unfurl(codec.furl(href).code), href, `round trip failed for ${JSON.stringify(href)}`);
  }
  assert.ok(checked > 1000, `only checked ${checked}`);
});
