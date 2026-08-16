# Contributing

Thanks for looking. A few things are unusual about this project; please read them before opening a pull request.

## The format is a promise

A code issued today must decode in twenty years. So:

- `packages/codec/models/v*/model.json` files are frozen after release. Never edit one. Retraining, adding domains, fixing a phrase: all of that is a new version directory and a new entry in the version list of `Codec`.
- The stream layout is documented at the top of `packages/codec/src/format.ts`, and the model file is the rest of the definition. If your change alters how any symbol is coded it needs a version bump, and every older version must keep decoding. The golden test in `packages/codec/test/golden.test.ts` will fail if you break this; that is the point, do not update the vectors.

## What is welcome

- Bugs in URL normalisation, round-trip failures (please include the URL), decoder robustness against corrupt input.
- Ports of the decoder to other languages. If the source comments and the model file are not enough to write one, open an issue saying what is missing.
- Benchmark corpora that are public and redistributable, and improvements to `bench/`.
- Model improvements, as a *candidate* model with benchmark numbers on the held-out sets, discussed in an issue before it becomes `models/v2`.
- UI and worker improvements that keep the "nothing stored, nothing logged" property.

## What is not

- Anything that stores or logs codes or targets. Analytics, click counts, custom aliases: these are architecturally out.
- Runtime dependencies in `@enfurl/codec`.

## Layout

```
packages/codec/src/   rangecoder, radix, tables, context-model, text-coder, url, model, format, base64, index
packages/codec/test/  unit tests against a toy model, golden vectors against the real one
packages/cli/         the enfurl and unfurl commands
apps/web/             the static site: UI, client-side unfurl page, QR encoder
apps/edge/            Cloudflare Worker: 302 redirect, peek page, static assets
tools/train/          corpus fetch and model training (Node only, never shipped)
tools/qr-tables/      regenerates the QR error-correction tables
bench/                benchmark harness
```

Node 22.18 or newer runs the TypeScript sources directly through type stripping, so avoid syntax that needs a transpiler: no enums, no parameter properties, no namespaces.

## Running things

```bash
npm install
npm test
npm run typecheck
node tools/train/src/fetch.ts        # corpora
node bench/bench.ts
```

## Style

TypeScript, ESM, `.ts` import specifiers, no default exports except the model entry points. Comments explain why a thing is the way it is, and the invariant it protects, not what the line does. Plain English in prose, no em dashes. Small commits with a subject line that says what changed and why.
