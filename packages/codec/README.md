# @enfurl/codec

Stateless URL compression: a URL becomes a short base64url code that *is* the URL, and back. Zero dependencies, no network, no storage. Runs in browsers, Node 22+, Deno, and edge workers.

```js
import { Codec } from '@enfurl/codec';
import modelV1 from '@enfurl/codec/models/v1';

const codec = new Codec([modelV1]);
const { code, href, removedParams } = codec.encode('https://en.wikipedia.org/wiki/Arithmetic_coding', {
  addScheme: true,      // "example.com/x" -> https://example.com/x
  stripTrackers: false, // drop utm_* and friends (reported in removedParams)
});
codec.decode(code); // === href
codec.estimateBits('https://example.com/'); // size estimate without coding
```

`explain(url)` returns the same size, broken down part by part (the site, each phrase, each run of random-looking characters), for showing a reader where their bits went. It is informational and never needed to unfurl.

`decode` accepts a bare code, `/code`, `#code`, or a code with a trailing `+`. It throws on corrupt input or an unknown version instead of returning a wrong URL.

Model files under `models/` are frozen per version; the tables in them are the format, and the stream layout is documented at the top of `src/format.ts`.

MIT.
