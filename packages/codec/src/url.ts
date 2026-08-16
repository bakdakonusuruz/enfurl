/**
 * URL normalisation and structural split.
 *
 * "Lossless" is defined against the WHATWG URL serialisation: for any input
 * we accept, decode(encode(input)) === new URL(input).href, optionally after
 * tracking-parameter removal.
 */

export interface NormalizeOptions {
  /** Prepend https:// when the input has no scheme (UI convenience). Default false. */
  addScheme?: boolean;
  /** Remove well-known tracking parameters. Default false. */
  stripTrackers?: boolean;
  /** Allowed protocols. Default ['http:', 'https:']. */
  protocols?: string[];
}

export interface Normalized {
  href: string;
  url: URL;
  removedParams: string[];
}

/** Parameters that are analytics-only and safe to drop. Kept short and conservative. */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'twclid', 'ttclid',
  'igshid', 'igsh', 'mc_cid', 'mc_eid', 'yclid', '_hsenc', '_hsmi', 'hsCtaTracking',
  'vero_id', 'oly_anon_id', 'oly_enc_id', '_openstat', 'ref_src', 'ref_url', 'si',
]);

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function normalizeUrl(input: string, opts: NormalizeOptions = {}): Normalized {
  let s = input.trim();
  if (s.length === 0) throw new Error('empty URL');
  if (opts.addScheme && !SCHEME_RE.test(s)) s = 'https://' + s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error('not a valid absolute URL');
  }
  const protocols = opts.protocols ?? ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) throw new Error(`scheme ${url.protocol} not allowed`);
  const removed: string[] = [];
  if (opts.stripTrackers && url.search) {
    const keep: [string, string][] = [];
    for (const [k, v] of url.searchParams) {
      if (TRACKING_PARAMS.has(k)) removed.push(k);
      else keep.push([k, v]);
    }
    if (removed.length) {
      // Rebuild by removing only the matched pairs from the raw query, so
      // untouched parameters keep their original encoding.
      const raw = url.search.slice(1).split('&');
      const kept = raw.filter((part) => {
        const eq = part.indexOf('=');
        const key = decodeURIComponentSafe(eq < 0 ? part : part.slice(0, eq));
        return !TRACKING_PARAMS.has(key);
      });
      url.search = kept.length ? '?' + kept.join('&') : '';
    }
  }
  return { href: url.href, url, removedParams: removed };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

export interface Structured {
  https: boolean;
  www: boolean;
  host: string;
  port: number; // 0 = none
  rest: string; // pathname + search + hash
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * Split an already normalised URL into the structured form, or return null
 * when it cannot be represented that way (then raw mode is used).
 */
export function structure(url: URL): Structured | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  let host = url.hostname;
  if (!HOST_RE.test(host)) return null;
  const port = url.port ? Number(url.port) : 0;
  if (port < 0 || port > 65535) return null;
  let www = false;
  if (host.startsWith('www.') && host.indexOf('.', 4) >= 0) {
    www = true;
    host = host.slice(4);
  }
  // An empty leading label ("www..example.com" is a valid WHATWG host) would be
  // lost by the subdomain split; such hosts take the raw path instead.
  if (host.startsWith('.')) return null;
  // Take the rest straight from the serialisation so that an empty "?" or "#"
  // (which .search / .hash report as "") survives.
  const prefix = `${url.protocol}//${url.host}`;
  if (!url.href.startsWith(prefix)) return null;
  return { https: url.protocol === 'https:', www, host, port, rest: url.href.slice(prefix.length) };
}

export function unstructure(s: Structured): string {
  return `${s.https ? 'https' : 'http'}://${s.www ? 'www.' : ''}${s.host}${s.port ? ':' + s.port : ''}${s.rest}`;
}
