import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFurlLink } from '../../../packages/codec/src/index.ts';
import { pastedFurl } from '../src/paste.ts';

const ours = ['furl.li', 'www.furl.li', 'localhost:8787'];
const pasted = (raw: string) => pastedFurl(raw, parseFurlLink(raw), ours);

test('the paste box unfurls bare furls and our own links, and furls everything else', () => {
  const x = 'FUHrBKaqKBtK';
  assert.deepEqual(pasted(x), { code: x, wrapped: false });
  assert.deepEqual(pasted(`${x}+`), { code: x, wrapped: false });
  assert.deepEqual(pasted(`https://furl.li/${x}/`), { code: x, wrapped: true });
  assert.deepEqual(pasted(`https://www.furl.li/#${x}+`), { code: x, wrapped: true });
  assert.deepEqual(pasted(`http://localhost:8787/${x}`), { code: x, wrapped: true });
  // A word with a slash or a hash goes to the enfurl path, never unfurls to a
  // garbage URL: "intranet.corp/" is furled, "intranet/" gets the "not a link
  // yet" note, both as before parseFurlLink.
  for (const raw of ['intranet/', 'intranet.corp/', '/word', '#word', `https://example.com/${x}`, 'example.com', 'not a url']) {
    assert.equal(pasted(raw), null, raw);
  }
});
