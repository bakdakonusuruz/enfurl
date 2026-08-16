/**
 * Extra corpora, fetched from public APIs and public files.
 *
 *   node tools/train/src/fetch-more.mjs [hn] [wiki] [curated]
 *
 * Why more than the Reddit sample: that one is a snapshot of 2016 to 2018, so
 * it knows imgur and old YouTube and has never seen a modern host. These three
 * pull in different distributions:
 *
 *   hn       Hacker News story links, via the public Algolia index. Recent,
 *            human-shared, heavy on articles, papers, repositories.
 *   wiki     external links cited by Wikipedia articles. News, universities,
 *            government sites, PDFs, the long tail of the real web.
 *   curated  links harvested from well-known curated lists on GitHub. Wide
 *            host variety, very few query strings.
 *
 * Everything lands in tools/train/corpus/ and is gitignored: the trainer reads
 * whatever is present, so a fresh clone can rebuild the model from scratch.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const corpus = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['hn', 'wiki', 'curated']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (want.has('hn')) {
  const urls = new Set();
  let before = Math.floor(Date.now() / 1000);
  for (let round = 0; round < 220 && urls.size < 150000; round++) {
    const r = await fetch(`https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=1000&numericFilters=created_at_i<${before}`);
    if (!r.ok) {
      await sleep(2000);
      continue;
    }
    const j = await r.json();
    if (!j.hits.length) break;
    for (const h of j.hits) if (h.url && /^https?:\/\//i.test(h.url)) urls.add(h.url);
    before = Math.min(...j.hits.map((h) => h.created_at_i)) - 1;
    if (round % 25 === 0) console.log(`hn: ${urls.size} urls, back to ${new Date(before * 1000).toISOString().slice(0, 10)}`);
  }
  writeFileSync(join(corpus, 'hn_urls.txt'), [...urls].join('\n') + '\n');
  console.log(`hn: wrote ${urls.size}`);
}

if (want.has('wiki')) {
  // The API rate-limits hard; one request a second is polite and still fast enough.
  const urls = new Set();
  let cont = {};
  for (let round = 0; round < 400 && urls.size < 120000; round++) {
    const u = new URL('https://en.wikipedia.org/w/api.php');
    const params = { action: 'query', list: 'exturlusage', euprop: 'url', eulimit: '500', eunamespace: '0', format: 'json', ...cont };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const r = await fetch(u, { headers: { 'user-agent': 'enfurl-corpus-builder/0.1 (URL compression research)' } });
    if (r.status === 429) {
      await sleep(6000);
      continue;
    }
    if (!r.ok) break;
    const j = await r.json();
    for (const e of j.query?.exturlusage ?? []) if (e.url && /^https?:\/\//i.test(e.url)) urls.add(e.url);
    if (!j.continue) break;
    cont = j.continue;
    await sleep(1100);
    if (round % 50 === 0) console.log(`wiki: ${urls.size} urls`);
  }
  writeFileSync(join(corpus, 'wiki_urls.txt'), [...urls].join('\n') + '\n');
  console.log(`wiki: wrote ${urls.size}`);
}

if (want.has('curated')) {
  const lists = [
    'sindresorhus/awesome/main/readme.md',
    'vinta/awesome-python/master/README.md',
    'sorrycc/awesome-javascript/master/README.md',
    'enaqx/awesome-react/master/README.md',
    'avelino/awesome-go/main/README.md',
    'rust-unofficial/awesome-rust/main/README.md',
    'akullpp/awesome-java/master/README.md',
    'ziadoz/awesome-php/master/README.md',
    'awesome-selfhosted/awesome-selfhosted/master/README.md',
    'jnv/lists/master/README.md',
    'Hack-with-Github/Awesome-Hacking/master/README.md',
    'sdmg15/Best-websites-a-programmer-should-visit/master/README.md',
    'kilimchoi/engineering-blogs/master/README.md',
    'jaywcjlove/awesome-mac/master/README.md',
    'agarrharr/awesome-cli-apps/master/readme.md',
    'sindresorhus/awesome-nodejs/main/readme.md',
    'veggiemonk/awesome-docker/master/README.md',
    'ripienaar/free-for-dev/master/README.md',
    'public-apis/public-apis/master/README.md',
    'trimstray/the-book-of-secret-knowledge/master/README.md',
    'awesome-css-group/awesome-css/master/README.md',
    'matteocrippa/awesome-swift/master/README.md',
    'vsouza/awesome-ios/master/README.md',
    'JStumpp/awesome-android/master/README.md',
    'josephmisiti/awesome-machine-learning/master/README.md',
    'academic/awesome-datascience/master/README.md',
    'awesomedata/awesome-public-datasets/master/README.rst',
    'papers-we-love/papers-we-love/main/README.md',
    'MunGell/awesome-for-beginners/main/README.md',
    'tiimgreen/github-cheat-sheet/master/README.md',
    'Awesome-Windows/Awesome/master/README.md',
    'Solido/awesome-flutter/master/README.md',
    'brillout/awesome-react-components/master/README.md',
    'unicodeveloper/awesome-nextjs/master/README.md',
    'sindresorhus/awesome-electron/main/readme.md',
    'dypsilon/frontend-dev-bookmarks/master/README.md',
    'thedaviddias/Front-End-Checklist/master/README.md',
    'kdeldycke/awesome-falsehood/main/readme.md',
    'awesome-foss/awesome-sysadmin/master/README.md',
    'Awesome-Linux-Software/Awesome-Linux-Software/master/README.md',
  ];
  const urls = new Set();
  for (const path of lists) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${path}`);
      if (!r.ok) continue;
      const text = await r.text();
      for (const m of text.matchAll(/https?:\/\/[^\s)>\]"'`|]+/g)) {
        const u = m[0].replace(/[.,;:]+$/, '');
        if (u.length < 2000) urls.add(u);
      }
    } catch {
      /* a list that moved is not worth failing the run over */
    }
  }
  writeFileSync(join(corpus, 'curated_urls.txt'), [...urls].join('\n') + '\n');
  console.log(`curated: wrote ${urls.size}`);
}
