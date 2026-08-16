/**
 * Top-level stream layout. This comment plus the model file are the format:
 *
 *   version           {v1: 32760, ESC: 8} then ESC -> uniform 256
 *   mode              flags.mode        structured | raw
 *   raw:              href as text, start '\x7F'
 *   structured:
 *     scheme          flags.scheme
 *     www             flags.www
 *     hostMode        flags.hostMode    rank | suffix | literal
 *       rank:         rankBucket + uniform offset, then sub flag, sub text
 *       suffix:       suffix index, label text, sub flag, sub text
 *       literal:      host text
 *     port            flags.port, then uniform 65536
 *     rest            path+query+fragment as text, start = class char
 */

import { RangeDecoder, RangeEncoder, encodeUniform } from './rangecoder.ts';
import { bytesToText, textToBytes } from './radix.ts';
import { TOTAL, LOG2, COST_SCALE, cost } from './tables.ts';
import type { Model } from './model.ts';
import { structure, unstructure, type Structured } from './url.ts';

/**
 * Which model wrote this furl, coded first.
 *
 * Version 1 is nearly free (0.01 bits). Versions 2 and 3 have reserved slots
 * that cost about 7 and 10 bits, and anything beyond escapes to a byte.
 *
 * The reserved slots exist because of a hard fact about short codes: saying
 * "this is model 2" is information, and it has to be paid for. With a single
 * escape it costs 20 bits, over three characters, which is more than a better
 * model is likely to save on a 22 character furl. Reserving the slots now
 * makes a future upgrade cost roughly one character instead, and costs today's
 * furls nothing measurable.
 */
const VERSION_TABLE = [TOTAL - 256, 200, 40, 16];
const VERSION_ESCAPE = VERSION_TABLE.length - 1;

/** Table index for a version number, or the escape slot. */
function versionSlot(version: number): number {
  return version >= 1 && version <= VERSION_ESCAPE ? version - 1 : VERSION_ESCAPE;
}
export const START_LABEL = '\x01';
export const START_SUB = '\x02';
export const START_LITERAL = '\x03';
export const START_RAW = '\x7f';
export const CLASS_BASE = 0x80;

function encodeFlag(enc: RangeEncoder, freq: number[], i: number): void {
  let cum = 0;
  for (let k = 0; k < i; k++) cum += freq[k];
  enc.encode(cum, freq[i], TOTAL);
}

function decodeFlag(dec: RangeDecoder, freq: number[]): number {
  const v = dec.peek(TOTAL);
  let cum = 0;
  for (let i = 0; i < freq.length; i++) {
    if (v < cum + freq[i]) {
      dec.update(cum, freq[i]);
      return i;
    }
    cum += freq[i];
  }
  throw new Error('corrupt stream: flag');
}

function flagCost(freq: number[], i: number): number {
  return cost(freq[i], TOTAL);
}

export interface HostPlan {
  mode: 0 | 1 | 2;
  cost: number;
  rank?: number;
  suffix?: number;
  label?: string;
  sub?: string;
}

function rankCost(m: Model, rank: number): number {
  const b = 31 - Math.clz32(rank);
  return flagCost(m.rankBucket, b) + b * COST_SCALE;
}

export function planHost(m: Model, host: string): HostPlan {
  const plans: HostPlan[] = [];
  const subCost = (sub: string): number =>
    sub ? flagCost(m.flags.sub, 1) + m.host.parse(sub, START_SUB).cost : flagCost(m.flags.sub, 0);
  const consider = (label: string, suffixIdx: number, sub: string) => {
    const cand = label + '.' + m.suffixes[suffixIdx];
    const r = m.rankOf.get(cand);
    if (r) plans.push({ mode: 0, rank: r, sub, cost: flagCost(m.flags.hostMode, 0) + rankCost(m, r) + subCost(sub) });
    plans.push({
      mode: 1,
      suffix: suffixIdx,
      label,
      sub,
      cost:
        flagCost(m.flags.hostMode, 1) +
        cost(m.suffixFreq[suffixIdx], TOTAL) +
        m.host.parse(label, START_LABEL).cost +
        subCost(sub),
    });
  };
  // whole host as a ranked entry (Tranco lists some subdomains as entries)
  const whole = m.rankOf.get(host);
  if (whole) plans.push({ mode: 0, rank: whole, sub: '', cost: flagCost(m.flags.hostMode, 0) + rankCost(m, whole) + subCost('') });
  // suffix splits: try every suffix that matches
  const labels = host.split('.');
  for (let k = 1; k < labels.length; k++) {
    const suffix = labels.slice(k).join('.');
    const si = m.suffixOf.get(suffix);
    if (si === undefined) continue;
    const label = labels[k - 1];
    if (!label) continue;
    const sub = labels.slice(0, k - 1).join('.');
    consider(label, si, sub);
  }
  if (m.host.canCode(host)) {
    plans.push({ mode: 2, cost: flagCost(m.flags.hostMode, 2) + m.host.parse(host, START_LITERAL).cost });
  }
  if (plans.length === 0) throw new Error('host not codable');
  let best = plans[0];
  for (const p of plans) if (p.cost < best.cost) best = p;
  return best;
}

export function classChar(m: Model, rank: number | undefined): string {
  const cls = rank && rank <= m.classes ? rank : 0;
  return String.fromCharCode(CLASS_BASE + cls);
}

/** Encode a normalised href with the given model. Returns the code text. */
export function encodeHref(m: Model, href: string): string {
  const enc = new RangeEncoder();
  const slot = versionSlot(m.version);
  encodeFlag(enc, VERSION_TABLE, slot);
  if (slot === VERSION_ESCAPE) encodeUniform(enc, m.version, 256);
  const url = new URL(href);
  if (url.href !== href) throw new Error('href is not normalised');
  const s = structure(url);
  if (!s || !m.text.canCode(s.rest) || !m.host.canCode(s.host)) {
    if (!m.text.canCode(href)) throw new Error('URL contains characters outside the codec alphabet');
    encodeFlag(enc, m.flags.mode, 1);
    m.text.encode(enc, href, START_RAW);
    return bytesToText(enc.finish());
  }
  encodeFlag(enc, m.flags.mode, 0);
  encodeFlag(enc, m.flags.scheme, s.https ? 0 : 1);
  encodeFlag(enc, m.flags.www, s.www ? 1 : 0);
  const plan = planHost(m, s.host);
  encodeFlag(enc, m.flags.hostMode, plan.mode);
  if (plan.mode === 0) {
    const r = plan.rank!;
    const b = 31 - Math.clz32(r);
    encodeFlag(enc, m.rankBucket, b);
    if (b > 0) encodeUniform(enc, r - (1 << b), 1 << b);
  } else if (plan.mode === 1) {
    encodeFlag(enc, m.suffixFreq, plan.suffix!);
    m.host.encode(enc, plan.label!, START_LABEL);
  } else {
    m.host.encode(enc, s.host, START_LITERAL);
  }
  if (plan.mode !== 2) {
    encodeFlag(enc, m.flags.sub, plan.sub ? 1 : 0);
    if (plan.sub) m.host.encode(enc, plan.sub, START_SUB);
  }
  encodeFlag(enc, m.flags.port, s.port ? 1 : 0);
  if (s.port) encodeUniform(enc, s.port, 65536);
  m.text.encode(enc, s.rest, classChar(m, plan.mode === 0 ? plan.rank : undefined));
  return bytesToText(enc.finish());
}

/** Peek the version of a code without a model. */
export function codeVersion(code: string): number {
  const dec = new RangeDecoder(textToBytes(code));
  const slot = decodeFlag(dec, VERSION_TABLE);
  return slot === VERSION_ESCAPE ? dec.uniform(256) : slot + 1;
}

/** Decode a code with the model matching its version. Returns the href. */
export function decodeCode(models: Map<number, Model>, code: string): string {
  const dec = new RangeDecoder(textToBytes(code));
  const slot = decodeFlag(dec, VERSION_TABLE);
  const v = slot === VERSION_ESCAPE ? dec.uniform(256) : slot + 1;
  const m = models.get(v);
  if (!m) throw new Error(`unknown code version ${v}`);
  const mode = decodeFlag(dec, m.flags.mode);
  let href: string;
  if (mode === 1) {
    href = m.text.decode(dec, START_RAW);
  } else {
    const s: Structured = { https: decodeFlag(dec, m.flags.scheme) === 0, www: false, host: '', port: 0, rest: '' };
    s.www = decodeFlag(dec, m.flags.www) === 1;
    const hostMode = decodeFlag(dec, m.flags.hostMode);
    let rank: number | undefined;
    if (hostMode === 0) {
      const b = decodeFlag(dec, m.rankBucket);
      rank = (1 << b) + (b > 0 ? dec.uniform(1 << b) : 0);
      const d = m.ranks[rank - 1];
      if (!d) throw new Error('corrupt stream: rank');
      s.host = d;
    } else if (hostMode === 1) {
      const si = decodeFlag(dec, m.suffixFreq);
      const label = m.host.decode(dec, START_LABEL);
      s.host = label + '.' + m.suffixes[si];
    } else {
      s.host = m.host.decode(dec, START_LITERAL);
    }
    if (hostMode !== 2 && decodeFlag(dec, m.flags.sub) === 1) {
      s.host = m.host.decode(dec, START_SUB) + '.' + s.host;
    }
    if (decodeFlag(dec, m.flags.port) === 1) s.port = dec.uniform(65536);
    s.rest = m.text.decode(dec, classChar(m, rank));
    href = unstructure(s);
  }
  let check: URL;
  try {
    check = new URL(href);
  } catch {
    throw new Error('corrupt code: not a URL');
  }
  if (check.href !== href) throw new Error('corrupt code: not normalised');
  return href;
}

/** One line of a bit budget: where part of a furl's size went. */
export interface ExplainPart {
  /** 'format' | 'site' | 'path' */
  kind: string;
  /** short human label */
  label: string;
  /** the piece of the URL this covers ('' for pure bookkeeping) */
  text: string;
  bits: number;
  /** for path units: 'char' | 'phrase' | 'run' | 'end', plus the run type */
  unit?: string;
  run?: string;
}

/**
 * Where the bits of a furl went, part by part. Informational only: it re-walks
 * the same decisions the encoder makes, changes nothing, and is never needed to
 * unfurl anything. Used by the web page to show a reader why their link cost
 * what it cost.
 */
export function explainHref(m: Model, href: string): { bits: number; parts: ExplainPart[] } {
  const url = new URL(href);
  const s = structure(url);
  const parts: ExplainPart[] = [];
  const versionBits = flagCost(VERSION_TABLE, versionSlot(m.version)) / COST_SCALE;
  if (!s || !m.text.canCode(s.rest) || !m.host.canCode(s.host)) {
    parts.push({ kind: 'format', label: 'format version and shape', text: '', bits: versionBits + flagCost(m.flags.mode, 1) / COST_SCALE });
    for (const u of m.text.explain(href, START_RAW)) {
      parts.push({ kind: 'path', label: 'unusual link, coded as plain text', text: u.text, bits: u.bits, unit: u.kind, run: u.run });
    }
  } else {
    const plan = planHost(m, s.host);
    const siteBits =
      (flagCost(m.flags.mode, 0) +
        flagCost(m.flags.scheme, s.https ? 0 : 1) +
        flagCost(m.flags.www, s.www ? 1 : 0) +
        plan.cost +
        flagCost(m.flags.port, s.port ? 1 : 0) +
        (s.port ? LOG2[65536] : 0)) /
      COST_SCALE;
    const hostLabel =
      plan.mode === 0
        ? `site (#${plan.rank} in the known-domain table)`
        : plan.mode === 1
          ? 'site (spelled out, known ending)'
          : 'site (spelled out)';
    parts.push({ kind: 'format', label: 'format version', text: '', bits: versionBits });
    parts.push({
      kind: 'site',
      label: hostLabel,
      text: `${s.https ? 'https://' : 'http://'}${s.www ? 'www.' : ''}${s.host}${s.port ? ':' + s.port : ''}`,
      bits: siteBits,
    });
    for (const u of m.text.explain(s.rest, classChar(m, plan.mode === 0 ? plan.rank : undefined))) {
      parts.push({ kind: 'path', label: 'path', text: u.text, bits: u.bits, unit: u.kind, run: u.run });
    }
  }
  let bits = 0;
  for (const p of parts) bits += p.bits;
  return { bits, parts };
}

/** Cost estimate in bits for a normalised href (no coding performed). */
export function estimateBits(m: Model, href: string): number {
  const url = new URL(href);
  const s = structure(url);
  // The version symbol is part of every stream, so it is part of every estimate.
  const version = flagCost(VERSION_TABLE, versionSlot(m.version));
  if (!s || !m.text.canCode(s.rest) || !m.host.canCode(s.host)) {
    return (version + flagCost(m.flags.mode, 1) + m.text.parse(href, START_RAW).cost) / COST_SCALE;
  }
  const plan = planHost(m, s.host);
  let c = version + flagCost(m.flags.mode, 0) + flagCost(m.flags.scheme, s.https ? 0 : 1) + flagCost(m.flags.www, s.www ? 1 : 0);
  c += plan.cost;
  c += flagCost(m.flags.port, s.port ? 1 : 0) + (s.port ? LOG2[65536] : 0);
  c += m.text.parse(s.rest, classChar(m, plan.mode === 0 ? plan.rank : undefined)).cost;
  return c / COST_SCALE;
}
