import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFurlLink } from '../src/index.ts';

test('parseFurlLink finds the furl however it was pasted', () => {
  const x = 'FUHrBKaqKBtK';
  const cases: [string, { code: string; peek: boolean; host: string } | null][] = [
    [x, { code: x, peek: false, host: '' }],
    [` /${x} `, { code: x, peek: false, host: '' }],
    [`#${x}+`, { code: x, peek: true, host: '' }],
    [`${x}+`, { code: x, peek: true, host: '' }],
    [`https://furl.li/${x}`, { code: x, peek: false, host: 'furl.li' }],
    [`https://furl.li/${x}/`, { code: x, peek: false, host: 'furl.li' }],
    [`https://FURL.li/${x}+`, { code: x, peek: true, host: 'furl.li' }],
    [`https://furl.li/#${x}+`, { code: x, peek: true, host: 'furl.li' }],
    [`https://furl.li/other#${x}`, { code: x, peek: false, host: 'furl.li' }],
    [`https://furl.li/${x}?utm_source=x`, { code: x, peek: false, host: 'furl.li' }],
    [`http://localhost:8787/${x}`, { code: x, peek: false, host: 'localhost:8787' }],
    ['', null],
    ['!!!', null],
    ['example.com', null],
    ['https://furl.li/', null],
    ['https://furl.li/a/b', null],
  ];
  for (const [input, want] of cases) assert.deepEqual(parseFurlLink(input), want, input);
});
