/**
 * Fetch the training corpora into tools/train/corpus/ (gitignored).
 *
 *   node tools/train/src/fetch.ts
 *
 * Sources:
 *   - Reddit outbound links sample: https://github.com/smythp/reddit_links_dataset (test.db, SQLite)
 *   - ada-url dataset:              https://github.com/ada-url/url-dataset (out.txt)
 *   - Tranco top-1M:                https://tranco-list.eu/top-1m.csv.zip
 *   - Public Suffix List:           https://publicsuffix.org/list/public_suffix_list.dat
 *
 * Requires git, curl and unzip on PATH. Node's built-in node:sqlite reads the Reddit DB.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = join(here, '..', 'corpus');
const work = join(here, '..', 'work');
mkdirSync(corpus, { recursive: true });
mkdirSync(work, { recursive: true });

function sh(cmd: string): void {
  console.log('> ' + cmd);
  execSync(cmd, { stdio: 'inherit', cwd: work });
}

if (!existsSync(join(corpus, 'public_suffix_list.dat'))) {
  sh(`curl -sL -o "${join(corpus, 'public_suffix_list.dat')}" https://publicsuffix.org/list/public_suffix_list.dat`);
}
if (!existsSync(join(corpus, 'tranco.csv'))) {
  sh('curl -sL -o tranco.zip https://tranco-list.eu/top-1m.csv.zip');
  sh('unzip -o -q tranco.zip');
  sh(`mv top-1m.csv "${join(corpus, 'tranco.csv')}"`);
}
if (!existsSync(join(corpus, 'ada_urls.txt'))) {
  if (!existsSync(join(work, 'ada'))) sh('git clone --depth 1 https://github.com/ada-url/url-dataset ada');
  sh(`cp ada/out.txt "${join(corpus, 'ada_urls.txt')}"`);
}
if (!existsSync(join(corpus, 'reddit_urls.txt'))) {
  if (!existsSync(join(work, 'reddit'))) sh('git clone --depth 1 https://github.com/smythp/reddit_links_dataset reddit');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(work, 'reddit', 'test.db'), { readOnly: true });
  const table = (db.prepare("select name from sqlite_master where type='table'").all()[0] as { name: string }).name;
  const rows = db.prepare(`select outbound_link as u from ${table}`).all() as { u: string }[];
  const out = createWriteStream(join(corpus, 'reddit_urls.txt'));
  let n = 0;
  for (const r of rows) {
    if (r.u && /^https?:\/\//i.test(r.u) && r.u.length < 2000 && !/\s/.test(r.u)) {
      out.write(r.u + '\n');
      n++;
    }
  }
  out.end();
  console.log(`reddit: ${n} urls`);
}
console.log('corpus ready in', corpus);
