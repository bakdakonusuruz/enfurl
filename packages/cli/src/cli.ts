#!/usr/bin/env node
/**
 * enfurl / unfurl on the command line.
 *
 *   enfurl <url>                  roll a URL up into a furl (prints the furl)
 *   enfurl <url> --host furl.li   print the full short link
 *   enfurl <url> --strip          drop known tracking parameters first
 *   enfurl --bits <url>           how small it would furl, without furling
 *   unfurl <furl-or-link>         open a furl back into its URL
 *   enfurl -d <furl-or-link>      same as unfurl, for people who like flags
 *   --json                        machine-readable output for any of the above
 *
 * Reads nothing but its arguments. Never touches the network. Nothing is stored.
 */
import { basename } from 'node:path';
import { Codec, parseFurlLink } from '@enfurl/codec';
import modelV1 from '@enfurl/codec/models/v1';

const invokedAsUnfurl = /unfurl/i.test(basename(process.argv[1] ?? ''));
const argv = process.argv.slice(2);
const flags = new Set<string>();
let host = '';
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--host') host = argv[++i] ?? '';
  else if (a.startsWith('--') || a === '-d' || a === '-h') flags.add(a);
  else positional.push(a);
}
// `enfurl unfurl <furl>` also works, for the curious.
if (positional[0] === 'unfurl') {
  positional.shift();
  flags.add('-d');
}
const wantsUnfurl = invokedAsUnfurl || flags.has('-d');

if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
  console.log(`enfurl: roll a link up. unfurl: open it again. Nothing stored, nothing tracked.

  enfurl <url> [--host furl.li] [--strip] [--json]     make a furl
  unfurl <furl-or-link> [--json]                       open a furl
  enfurl --bits <url>                                  size estimate, no furl made

A furl is the URL itself, rolled up tight. Anyone with this tool can unfurl it,
offline, with no server in between. https://furl.li`);
  process.exit(positional.length === 0 && !flags.has('-h') && !flags.has('--help') ? 2 : 0);
}

const codec = new Codec([modelV1]);
const json = flags.has('--json');

try {
  if (wantsUnfurl) {
    // a bare furl or a full link, from any host
    const link = parseFurlLink(positional[0]);
    if (!link) throw new Error('not a furl');
    const href = codec.unfurl(link.code);
    console.log(json ? JSON.stringify({ href }) : href);
  } else if (flags.has('--bits')) {
    const bits = codec.estimateBits(positional[0], { addScheme: true });
    console.log(json ? JSON.stringify({ bits }) : `${bits.toFixed(1)} bits, a furl of about ${Math.ceil(bits / 6)} characters`);
  } else {
    const r = codec.furl(positional[0], { addScheme: true, stripTrackers: flags.has('--strip') });
    const link = host ? `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}/${r.code}` : r.code;
    if (json) console.log(JSON.stringify({ furl: r.code, link: host ? link : undefined, href: r.href, removedParams: r.removedParams, version: r.version }));
    else {
      console.log(link);
      if (r.removedParams.length) console.error(`removed tracking parameters: ${r.removedParams.join(', ')}`);
    }
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
