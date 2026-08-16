/**
 * enfurl edge worker (Cloudflare Workers).
 *
 *   GET /<code>     302 to the decoded URL. Cache-Control: no-store, Referrer-Policy: no-referrer.
 *   GET /<code>+    HTML preview showing the target; no redirect.
 *   anything else   the static app from the ASSETS binding (encoder UI, #code redirect page).
 *
 * The worker keeps no state and needs no bindings beyond ASSETS. Do not add
 * logging of request paths: the path *is* the destination URL.
 */
import { Codec, isCodeText } from '@enfurl/codec';
import modelV1 from '@enfurl/codec/models/v1';

const codec = new Codec([modelV1]);

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

/** Optional target host blocklist hook: return a reason string to refuse. Kept static and empty by default. */
function blocked(target: URL): string | null {
  void target;
  return null;
}

const COMMON_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>body{margin:0;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f8f7f4;color:#191816}main{max-width:40rem;margin:0 auto;padding:4rem 1.25rem;text-align:center}h1{font-family:ui-serif,Georgia,serif;font-weight:400}a{color:#191816;text-underline-offset:.18em;word-break:break-all}a:hover{color:#a8502e}.muted{color:#6d6b65}@media(prefers-color-scheme:dark){body{background:#131211;color:#eceae5}a{color:#eceae5}a:hover{color:#d98a63}.muted{color:#96938c}}</style>
</head><body><main><h1>${esc(title)}</h1>${body}<p class="muted"><a href="/">enfurl</a>: a furl is the link, rolled up. Nothing stored, nothing tracked.</p></main></body></html>`;
  return new Response(html, { status, headers: { ...COMMON_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    // Only bare codes: one path segment of base64url characters, optional trailing "+".
    const m = /^\/([A-Za-z0-9_-]+)(\+?)$/.exec(path);
    if (!m || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return env.ASSETS.fetch(request);
    }
    const code = m[1];
    const preview = m[2] === '+';
    if (!isCodeText(code)) return env.ASSETS.fetch(request);
    let target: string;
    try {
      target = codec.unfurl(code);
    } catch {
      // Not a code (or a typo): let the static app explain, it has the same decoder.
      return env.ASSETS.fetch(request);
    }
    const t = new URL(target);
    if (t.protocol !== 'http:' && t.protocol !== 'https:') return page('Refused', '<p>Only http and https targets are served.</p>', 400);
    const reason = blocked(t);
    if (reason) return page('Refused', `<p>${esc(reason)}</p>`, 451);
    if (preview) {
      return page('This furl unfurls to', `<p><a href="${esc(target)}" rel="noreferrer noopener">${esc(target)}</a></p><p class="muted">Peek mode (the + at the end): nothing happens until you click.</p>`);
    }
    return new Response(null, { status: 302, headers: { ...COMMON_HEADERS, Location: target } });
  },
};
