/**
 * Sample URLs from the Common Crawl index.
 *
 *   node tools/train/src/fetch-commoncrawl.mjs [crawl] [files] [mbPerFile] [maxUrls]
 *   node tools/train/src/fetch-commoncrawl.mjs CC-MAIN-2026-30 50 2 700000
 *
 * Common Crawl publishes a CDX index of every page it fetched, split into ~300
 * files sorted by reversed host, so each file covers a slice of the alphabet.
 * Downloading them all would be hundreds of gigabytes; instead this takes the
 * first few megabytes of a spread of files, which decompresses cleanly because
 * gzip streams can be read until they are cut off.
 *
 * The result is a broad sample of the crawled web: hosts and path shapes the
 * link-sharing corpora never contain. It is a different distribution from
 * "links people send each other", which is why it is one corpus among several
 * rather than the only one.
 */
import { writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const crawl = process.argv[2] ?? 'CC-MAIN-2026-30';
const fileCount = Number(process.argv[3] ?? 24);
const mbPerFile = Number(process.argv[4] ?? 3);
const cap = Number(process.argv[5] ?? 400000);
const corpus = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
const base = 'https://data.commoncrawl.org/';

const pathsResponse = await fetch(`${base}crawl-data/${crawl}/cc-index.paths.gz`);
if (!pathsResponse.ok) throw new Error(`index paths: HTTP ${pathsResponse.status}`);
const pathsText = await new Response(Readable.fromWeb(pathsResponse.body).pipe(createGunzip())).text();
const cdxFiles = pathsText.split('\n').filter((l) => l.includes('cdx-'));
console.log(`${crawl}: ${cdxFiles.length} index files`);

/** Read the first `bytes` of a gzip member and return whatever lines survive. */
async function sampleFile(path, bytes) {
  const r = await fetch(base + path, { headers: { range: `bytes=0-${bytes - 1}` } });
  if (!r.ok && r.status !== 206) return [];
  const gunzip = createGunzip();
  const chunks = [];
  const stream = Readable.fromWeb(r.body).pipe(gunzip);
  gunzip.on('error', () => {}); // a truncated stream is expected; keep what decompressed
  await new Promise((resolve) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', resolve);
  });
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

const urls = new Set();
const step = Math.max(1, Math.floor(cdxFiles.length / fileCount));
for (let i = 0; i < cdxFiles.length && urls.size < cap; i += step) {
  const lines = await sampleFile(cdxFiles[i], mbPerFile * 1024 * 1024);
  let added = 0;
  for (const line of lines) {
    // Each line is: <sort key> <timestamp> <json>
    const brace = line.indexOf('{');
    if (brace < 0) continue;
    try {
      const rec = JSON.parse(line.slice(brace));
      if (rec.url && /^https?:\/\//i.test(rec.url) && rec.url.length < 2000) {
        if (!urls.has(rec.url)) added++;
        urls.add(rec.url);
      }
    } catch {
      /* the last line of a truncated stream is usually half a record */
    }
  }
  console.log(`${cdxFiles[i].split('/').pop()}: +${added} (total ${urls.size})`);
}

writeFileSync(join(corpus, 'cc_urls.txt'), [...urls].join('\n') + '\n');
console.log(`common crawl: wrote ${urls.size} urls`);
