<h1 align="center">enfurl</h1>

<p align="center"><strong>Roll a link up. Unfurl it anywhere. Store nothing.</strong></p>

<p align="center">
  <a href="https://furl.li">furl.li</a> ·
  <a href="#use-it">use it</a> ·
  <a href="#numbers">numbers</a> ·
  <a href="#how-it-works">how it works</a> ·
  <a href="CONTRIBUTING.md">contribute</a>
</p>

<p align="center">
  <img alt="MIT" src="https://img.shields.io/badge/licence-MIT-blue">
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%3E%3D22.18-brightgreen">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-lightgrey">
  <img alt="model v1 frozen" src="https://img.shields.io/badge/model-v1%20frozen-8a2be2">
  <a href="https://github.com/bakdakonusuruz/enfurl/actions"><img alt="CI" src="https://github.com/bakdakonusuruz/enfurl/actions/workflows/ci.yml/badge.svg"></a>
</p>

```
https://en.wikipedia.org/wiki/Arithmetic_coding   ->  https://furl.li/FUHrBKaqKBtK
https://www.youtube.com/watch?v=dQw4w9WgXcQ       ->  https://furl.li/AY8bqi9XV_i_zQ
https://twitter.com/jack/status/20                ->  https://furl.li/DiIeQJCA
```

A **furl** is a URL rolled up tight. It looks like a shortened link and behaves like a compressed file: the short string *is* the whole URL, losslessly. There is no database, no ID, no lookup, no click counter. `furl.li` unfurls it and redirects; it keeps nothing. Anyone can unfurl a furl with this codec, offline, without ever contacting us, so a furl outlives the site that made it.

## The word

**enfurl** · /ɪnˈfɜːrl/ · *in-FURL* · rhymes with *unfurl* · verb

> **furl** (v.), 16th c., probably from Old French *ferlier*, "to bind firmly": to roll a sail or a flag up tight against its spar. Nothing is cut away. The thing is only made small, and any sailor can shake it out again. It is pronounced *f* + *url*, which is also, more or less, what one says at a 312-character tracking link. The nautical reading is the official one.
>
> **enfurl** (v.): to furl in; to wrap or swathe. Tolkien used it for mountains, *"in silence folded, mist-enfurled"* (The Lay of Leithian). We use it for links. Say it slowly and you hear the word *URL* inside.
>
> **unfurl** (v.): to open a furl back into the URL it came from. Also the word chat apps use when they expand a link into a preview. Everyone gets to unfurl; nobody needs our permission.
>
> **furl** (n., here): a rolled-up URL. They live at **furl.li**, which you read as *furly*.

So the vocabulary is honest: you *enfurl* a link, you get a *furl*, anyone can *unfurl* it. The library is `@enfurl/codec`, the commands are `enfurl` and `unfurl`.

## Why roll up instead of shorten

Every mainstream shortener stores `code -> URL` and therefore knows, forever, who clicked what. That knowledge is the product. Take away the database and the product is gone; what remains is the useful part, a link short enough for an SMS or a QR code, and a privacy property you can verify by reading the code instead of a policy.

The catch: a stateless furl must carry the whole URL's information, so it can only be as short as the URL's *entropy under the best model you can afford to ship*. That is the whole engineering problem, and it is a fun one. `https://www.` costs 0.2 bits, `youtube.com` costs 4, `/watch?v=` costs about 1, and the 11-character video id costs its full 66 bits because it is random. Everything a human did not type is nearly free; only the random parts remain.

## Numbers

Measured on held-out data (`node bench/bench.ts`). The model trains on a mix of Reddit outbound links, Hacker News stories and curated link lists; a tenth of each is held back, and the ada-url set is kept out of training entirely as a generalisation check.

<!-- BENCH:START -->
Model v1 (1160 KB JSON, 354 KB gzipped), `node bench/bench.ts --n 20000 --hamr <ha.mr clone>`, 2026-08-16. Every corpus below is the held-out tenth that training never saw, except ada, which training never saw at all.

**Links people share** (Reddit outbound links, 20 000 URLs, input mean 55.5 characters, median 47):

| coder | mean chars | median | p90 | vs input | shorter than input |
|---|---|---|---|---|---|
| base64url of the URL | 74.3 | 63 | 128 | 1.34x | 0% |
| deflate + base64url | 71.4 | 64 | 112 | 1.29x | 0.4% |
| brotli + base64url | 68.6 | 63 | 103 | 1.24x | 5% |
| ha.mr (its own 82-char alphabet) | 33.2 | 26 | 65 | 0.60x | 100% |
| **enfurl v1** | **23.1** | **18** | **43** | **0.42x** | **100%** |

**Links people post today** (Hacker News stories, 14 877 URLs, mean 63.4) and **curated lists** (3 406 URLs, mean 41.1):

| coder | HN mean | HN median | curated mean | curated median |
|---|---|---|---|---|
| brotli + base64url | 71.2 | 68 | 52.8 | 50 |
| ha.mr | 39.3 | 35 | 22.3 | 19 |
| **enfurl v1** | **26.1** | **23** | **16.2** | **15** |

**A distribution nobody trained on** (ada-url dataset, crawled from top-100 sites, 20 000 URLs, mean 97.4):

| coder | mean chars | median | p90 | vs input |
|---|---|---|---|---|
| brotli + base64url | 93.9 | 76 | 183 | 0.96x |
| ha.mr | 62.1 | 41 | 156 | 0.64x |
| **enfurl v1** | **49.5** | **32** | **131** | **0.51x** |

**Magic-link / SSO URLs** (5 000 generated links carrying a JWT; no public corpus of these exists, so the benchmark generates them with a different seed from the trainer's synthetic mix; input mean 257.5):

| coder | mean chars | median | p90 | vs input |
|---|---|---|---|---|
| brotli + base64url | 285.1 | 286 | 351 | 1.11x |
| ha.mr | 241.2 | 243 | 300 | 0.94x |
| **enfurl v1** | **136.3** | **136** | **167** | **0.53x** |

Those carry a signature, which is random by construction: 256 bits stay 43 characters here and everywhere else. What enfurl saves is the readable half, by unpacking base64 that turns out to hold text. For links like these the real lever is a smaller token, not a better compressor.

By input length (Reddit held-out, enfurl mean furl length): under 40 chars -> 11.5, 40-59 -> 17.4, 60-89 -> 31.2, 90-139 -> 47.8. Round trip verified on every held-out URL, zero failures, about 13 000 furl+unfurl per second in Node.

| URL | furl |
|---|---|
| `https://twitter.com/jack/status/20` | `DiIeQJCA` |
| `https://en.wikipedia.org/wiki/Arithmetic_coding` | `FUHrBKaqKBtK` |
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | `AY8bqi9XV_i_zQ` |
| `https://news.ycombinator.com/item?id=546530` | `L4w5kbrNTysA` |
| `https://www.reddit.com/r/programming/comments/1abc2de/some_title_here/` | `XEeHLXlfJTJPwUx2OxgA` |
<!-- BENCH:END -->

General-purpose compressors (deflate, brotli) make short URLs *longer*: their framing costs more than the input. [ha.mr](https://github.com/p2r3/ha.mr) is the one existing tool with the same premise and the fair comparison; furls come out shorter because enfurl uses a context model with a range coder rather than order-0 Huffman, plus an optimal parse over characters, phrases and typed runs.

## Use it

**In the browser:** [furl.li](https://furl.li). Paste a link, get a furl and a QR code for it. Everything happens on your device; the page has no backend and fetches nothing.

**Library** (zero dependencies, browser / Node / Deno / edge):

```js
import { Codec } from '@enfurl/codec';
import modelV1 from '@enfurl/codec/models/v1';

const codec = new Codec([modelV1]);
const { code, href } = codec.furl('https://en.wikipedia.org/wiki/Arithmetic_coding');
codec.unfurl(code) === href;   // true, offline

codec.explain(href).parts;     // where every bit of that furl went
// [ { kind: 'site',  text: 'https://en.wikipedia.org', bits: 10.9 },
//   { kind: 'path',  text: '/wiki/', unit: 'phrase',   bits:  0.07 }, ... ]
```

`explain()` is informational: it re-walks the same decisions the encoder makes and is never needed to unfurl anything. It is what draws the bit budget on the site.

`encode` / `decode` exist as aliases for people who expect codec names.

**Command line:**

```bash
npx enfurl https://en.wikipedia.org/wiki/Arithmetic_coding     # -> FUHrBKaqKBtK
npx enfurl unfurl FUHrBKaqKBtK                                 # -> the URL
npx enfurl unfurl https://furl.li/FUHrBKaqKBtK                 # full links work too
npx enfurl --strip "https://shop.example/p?id=1&utm_source=x"   # shake off tracking parameters first
npx enfurl --bits https://example.com/                          # how small it would furl
```

`npm i -g enfurl` also gives you a plain `unfurl` command. (`npx unfurl` alone runs an unrelated package of that name.)

**Two link shapes**, both work everywhere the code runs:

| shape | who sees the furl | when to use |
|---|---|---|
| `https://furl.li/FUHrBKaqKBtK` | furl.li receives it, answers a 302, keeps nothing | default: link previews, curl, no-JavaScript clients |
| `https://furl.li/#FUHrBKaqKBtK` | nobody but your browser (fragments are never sent) | when even the redirect host should not see where you go |
| `https://furl.li/FUHrBKaqKBtK+` | same as the first | peek at where a furl leads before going there |

**Self-host:** `apps/web` is a static site with the model bundled; `apps/edge` is a Cloudflare Worker that serves it and answers `GET /<furl>` with a 302 (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`). No KV, no D1, no logs.

## How it works

In one paragraph: parse the URL (WHATWG). Code the host as a rank in a frozen table of common domains, or as `label + suffix` through a small character model. Code path + query + fragment as one character stream through a static order-2 context model with PPM-style escapes and exclusion, whose unit set is characters, a dictionary of about two thousand phrases and ordinary English words (`/wiki/`, `.html`, `watch?v=`, `research`, `history`, ...), and typed runs (decimal, hex, base64url, UUID, percent-encoded bytes) packed at their inherent entropy; the encoder picks the cheapest unit sequence by dynamic programming. A base64url blob that turns out to hold text (a JWT payload, a JSON state parameter) is unpacked and its contents coded through the same model, then packed back on the way out, which is what makes token-carrying links worth furling. Every symbol goes through a 32-bit range coder; trailing zeros are trimmed; bytes become bijective base64url with no padding or length field. A version symbol comes first, and every released model is immutable forever.

The stream layout, symbol by symbol, is documented at the top of [`packages/codec/src/format.ts`](packages/codec/src/format.ts); together with `packages/codec/models/v1/model.json` that is the whole definition of what a furl means.

### QR codes

Every furl gets one, drawn by a QR encoder written for this project (`apps/web/src/qr.ts`, no library, verified against an independent decoder in the tests). A QR is not compression, it is redundancy: what a short link buys you is *fewer modules*, which means a bigger, more forgiving pattern at the same printed size. A 70-character Reddit link needs a 37x37 symbol; its furl needs 33x33.

The encoder emits two segments where it pays: the address in alphanumeric mode (11 bits per two characters, which requires uppercase, and scheme and host are case-insensitive so nothing changes) and the furl itself in byte mode, because its case matters. That is used only when it actually saves a version, so most codes keep the address in lowercase.

## Honest limits

- A furl cannot be edited, expired, or revoked. Nothing is stored, so there is nothing to change. Abuse is handled by a static blocklist at redirect time and the `+` peek form.
- Random data does not roll up smaller. Links that are mostly a token or a hash shrink only around the token.
- A furl is rolled, not locked. Anyone holding it has the link. Secrets are a different tool (see [docs/ROADMAP.md](docs/ROADMAP.md)).
- With the `/furl` shape the redirect host sees the furl and could unfurl it. It does not log; the code is open; run your own.

## Repository

```
packages/codec/   @enfurl/codec: the codec and the frozen models (zero dependencies)
packages/cli/     enfurl and unfurl commands
apps/web/         furl.li: static UI, client-side unfurl page, QR encoder
apps/edge/        Cloudflare Worker: 302 redirect, peek page, static assets
tools/train/      corpus fetch + model training (Node only, never shipped)
tools/qr-tables/  regenerates the QR error-correction tables
bench/            benchmark harness (held-out corpora)
```

Requires Node 22.18+ (TypeScript runs directly via type stripping).

```bash
npm install
npm test                       # codec unit tests + golden vectors
npm run build                  # codec, cli, web (esbuild), edge
node tools/train/src/fetch.ts       # base corpora (once)
node tools/train/src/fetch-more.mjs # Hacker News, Wikipedia, curated lists
node tools/train/src/train.ts  # retrain -> a NEW model version, never overwrite a released one
node bench/bench.ts            # numbers for this README
```

Contributions welcome, with one hard rule: a released model file never changes, because a furl issued today must unfurl in twenty years. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

[p2r3/ha.mr](https://github.com/p2r3/ha.mr) built a stateless link compressor with Huffman codes and hand-built dictionaries. It is worth your time, and it is the comparison used throughout the benchmark.

The codec itself ships with **no runtime dependencies**. Everything below is either a build and test tool, or a public list the model needed:

| | |
|---|---|
| [TypeScript](https://www.typescriptlang.org/) | types, and `tsc` for the published builds |
| [esbuild](https://esbuild.github.io/) | bundles the site and the worker |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/) | deploys the worker |
| [jsQR](https://github.com/cozmo/jsQR) | decodes our own QR symbols in the tests, so the hand-written encoder is checked against something independent |
| [node-qrcode](https://github.com/soldair/node-qrcode) | source of the error-correction block tables from ISO/IEC 18004, extracted once by `tools/qr-tables/extract.mjs` |
| [Node's test runner](https://nodejs.org/api/test.html) | the entire test suite, no framework |
| [Public Suffix List](https://publicsuffix.org/) (MPL 2.0) | tells the host coder where a registrable domain ends |
| [Tranco](https://tranco-list.eu/) | orders the table of known domains |

QR encoding follows ISO/IEC 18004. The compression side stands on ordinary literature: arithmetic coding, PPM-style context modelling with escapes, and optimal parsing by dynamic programming.

## Licence

MIT. Corpora and lists used for training keep their own licences.
