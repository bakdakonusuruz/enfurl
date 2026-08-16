/**
 * furl.li: the page where you enfurl a link, and where a furl unfurls itself.
 *
 *   /              the tool
 *   /#<furl>       the browser unfurls it and goes there; the server never saw the furl
 *   /<furl>        the worker answers a 302; on a plain static host this script does it
 *   /<furl>+       peek: show where it leads, do not go
 *
 * Nothing here talks to a server. The model is bundled into this file.
 */
import { Codec, type ExplainPart } from '@enfurl/codec';
import { encodeQR, qrToSvg, qrToCanvas, type RenderOptions } from './qr.ts';
import type { Level } from './qr-tables.ts';
import modelV1 from '@enfurl/codec/models/v1';

const codec = new Codec([modelV1]);
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

/**
 * The home of the project, used for recognising our own links when somebody
 * pastes one. Links this page *hands out* always point at wherever the page is
 * actually served from, so a copy of it on any host produces links that work.
 */
const HOST = 'furl.li';
const FURL_RE = /^[A-Za-z0-9_-]+\+?$/;

// ---------------------------------------------------------------- unfurl view

function furlFromLocation(): { furl: string; peek: boolean } | null {
  let raw = '';
  if (location.hash.length > 1) raw = location.hash.slice(1);
  else if (location.pathname.length > 1) raw = location.pathname.slice(1);
  raw = raw.replace(/\/+$/, '');
  if (!raw) return null;
  const peek = raw.endsWith('+');
  return { furl: peek ? raw.slice(0, -1) : raw, peek };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function showUnfurlPage(furl: string, peek: boolean): void {
  $('#app').hidden = true;
  $('#redirect').hidden = false;
  let target: string;
  try {
    target = codec.unfurl(furl);
  } catch (e) {
    $('#redirect-title').textContent = 'This furl will not unfurl';
    $('#redirect-body').innerHTML =
      `<p class="note"><code>${escapeHtml(furl)}</code> could not be unfurled (${escapeHtml((e as Error).message)}). ` +
      `A furl is the link itself, rolled up, so one wrong character breaks it.</p>` +
      `<p><a href="/">Enfurl a link instead</a></p>`;
    return;
  }
  const a = document.createElement('a');
  a.href = target;
  a.rel = 'noreferrer noopener';
  a.textContent = target;
  $('#redirect-target').replaceChildren(a);
  if (peek) {
    $('#redirect-title').textContent = 'This furl unfurls to';
    $('#redirect-hint').textContent = 'Peek mode: you put a + on the end, so nothing happens until you click.';
  } else {
    $('#redirect-title').textContent = 'Unfurling';
    $('#redirect-hint').innerHTML =
      '<span class="spinner"></span>Unfurled in your browser. Nothing was looked up, nothing was logged.';
    setTimeout(() => location.replace(target), 450);
  }
}

// ---------------------------------------------------------------- the tool

const EXAMPLES: [string, string][] = [
  ['a Wikipedia article', 'https://en.wikipedia.org/wiki/Arithmetic_coding'],
  ['a YouTube video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  [
    'a shop link full of trackers',
    'https://www.amazon.com/dp/B0BSHF7WHW?ref_=ast_sto_dp&utm_source=newsletter&utm_medium=email&utm_campaign=spring&fbclid=IwAR2x9',
  ],
  ['a furl, to unfurl', 'fe4mgo'],
];

interface Row {
  label: string;
  detail: string;
  bits: number;
  colour: string;
}

/** Turn the codec's per-unit costs into rows a person can read. */
function toRows(parts: ExplainPart[]): Row[] {
  const rows: Row[] = [];
  let overhead = 0;
  let typed: { text: string; bits: number } | null = null;
  const flush = () => {
    if (!typed) return;
    rows.push({ label: 'text somebody typed', detail: typed.text, bits: typed.bits, colour: 'var(--c-typed)' });
    typed = null;
  };
  for (const p of parts) {
    if (p.kind === 'format' || p.unit === 'end') {
      overhead += p.bits;
      continue;
    }
    if (p.kind === 'site') {
      flush();
      rows.push({ label: p.label, detail: p.text, bits: p.bits, colour: 'var(--c-site)' });
      continue;
    }
    if (p.unit === 'char') {
      typed = typed ? { text: typed.text + p.text, bits: typed.bits + p.bits } : { text: p.text, bits: p.bits };
      continue;
    }
    flush();
    if (p.unit === 'phrase') {
      rows.push({ label: 'a piece the model already knew', detail: p.text, bits: p.bits, colour: 'var(--c-known)' });
    } else if (p.run === 'B64TEXT') {
      // A blob that looked like noise but turned out to hold text.
      rows.push({
        label: 'a base64 blob, opened up and compressed inside',
        detail: p.text,
        bits: p.bits,
        colour: 'var(--c-known)',
      });
    } else {
      const what =
        p.run === 'UUID'
          ? 'a UUID'
          : p.run === 'PCT'
            ? 'non-Latin characters'
            : `${p.text.length} random-looking characters`;
      rows.push({ label: `${what}, nothing to squeeze`, detail: p.text, bits: p.bits, colour: 'var(--c-random)' });
    }
  }
  flush();
  rows.push({ label: 'bookkeeping (version, end marker)', detail: '', bits: overhead, colour: 'var(--c-over)' });
  return rows;
}

const fmtBits = (b: number): string => (b < 1 ? `${b.toFixed(2)} bits` : `${b.toFixed(1)} bits`);

function renderExplain(parts: ExplainPart[], bits: number, code: string, href: string): void {
  const rows = toRows(parts).filter((r) => r.bits > 0.004);
  const total = rows.reduce((a, r) => a + r.bits, 0);

  $('#stack').replaceChildren(
    ...rows.map((r) => {
      const s = document.createElement('span');
      s.style.width = `${(r.bits / total) * 100}%`;
      s.style.background = r.colour;
      s.title = `${r.label}: ${fmtBits(r.bits)}`;
      return s;
    }),
  );

  $('#legend').replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = r.colour;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = r.label;
      if (r.detail) {
        const em = document.createElement('em');
        em.className = 'mono';
        em.textContent = r.detail.length > 64 ? r.detail.slice(0, 61) + '…' : r.detail;
        what.append(em);
      }
      const b = document.createElement('span');
      b.className = 'bits';
      b.textContent = fmtBits(r.bits);
      li.append(dot, what, b);
      return li;
    }),
  );

  $('#explain-sub').textContent =
    `The whole link came to ${bits.toFixed(0)} bits, which is ${code.length} characters of furl. Here is where every bit went.`;

  const sum = (c: string) => rows.filter((r) => r.colour === c).reduce((a, r) => a + r.bits, 0);
  const random = sum('var(--c-random)');
  const typed = sum('var(--c-typed)');
  const known = sum('var(--c-site)') + sum('var(--c-known)');
  const biggestRandom = rows.filter((r) => r.colour === 'var(--c-random)').sort((a, b) => b.bits - a.bits)[0];
  const biggestTyped = rows.filter((r) => r.colour === 'var(--c-typed)').sort((a, b) => b.bits - a.bits)[0];
  const nested = rows.filter((r) => r.label.startsWith('a base64 blob'));
  let punch: string;
  if (biggestRandom && (random >= total * 0.35 || biggestRandom.bits >= total * 0.25)) {
    punch =
      `<code>${escapeHtml(biggestRandom.detail.slice(0, 28))}</code> is random, so it costs its full ${fmtBits(biggestRandom.bits)} ` +
      `and no compressor on earth could do better. ` +
      (known <= total * 0.15
        ? `The site and the well-known pieces came to ${fmtBits(known)} between them: nearly free, because the model has seen links like yours a hundred thousand times.`
        : `The rest of the link came to ${fmtBits(total - random)}.`);
  } else if (typed >= total * 0.4 && biggestTyped) {
    punch =
      `The site and the familiar pieces cost almost nothing (${fmtBits(known)}). Most of the size is text nobody could have guessed, ` +
      `like <code>${escapeHtml(biggestTyped.detail.slice(0, 28))}</code>. That part has to be written out letter by letter, ` +
      `here and in any other tool.`;
  } else {
    punch =
      `Almost every piece of this link was something the model already expected, which is why it rolls up so small. ` +
      `Only ${fmtBits(random + typed)} of it could not be guessed.`;
  }
  if (nested.length) {
    // The interesting half of a token-carrying link: we looked inside the base64.
    punch +=
      ` One of those blobs held text rather than noise, so it was unpacked and the text inside compressed instead: ` +
      `${fmtBits(nested.reduce((a, r) => a + r.bits, 0))} for what would otherwise have cost ` +
      `${fmtBits(nested.reduce((a, r) => a + r.detail.length * 6, 0))}.`;
  }
  $('#punch').innerHTML = punch;

  const curious = $('#curious');
  curious.replaceChildren();
  const add = (k: string, v: string) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.className = 'mono';
    dd.textContent = v;
    curious.append(dt, dd);
  };
  add('furl', code);
  add('unfurls to', href);
  add('size', `${bits.toFixed(1)} bits, written in A-Z a-z 0-9 - _ as ${code.length} characters`);
  add('model', `v${codec.version}, frozen, bundled in this page`);
  add('sent to a server', 'nothing');
  $('#explain').hidden = false;
}

/** What the QR panel is showing, so the option controls can redraw it. */
let qrState: { link: string; href: string } | null = null;

function qrOptions(): { level: Level; render: RenderOptions } {
  const light = $<HTMLSelectElement>('#qr-light').value;
  return {
    level: $<HTMLSelectElement>('#qr-level').value as Level,
    render: {
      dark: $<HTMLSelectElement>('#qr-dark').value,
      light: light === '' ? null : light,
      quiet: Number($<HTMLSelectElement>('#qr-quiet').value),
    },
  };
}

/**
 * Draw the furl as a QR code, and say how much smaller it is than the square
 * the original link would have needed. This is the one place where a shorter
 * link is worth something you can see across a room.
 */
function renderQR(link: string, href: string): void {
  const panel = $('#qr');
  qrState = { link, href };
  const { level, render } = qrOptions();
  try {
    const qr = encodeQR(link, level);
    const img = $('#qr-img');
    img.innerHTML = qrToSvg(qr, render);
    img.classList.toggle('checker', render.light === null);
    $('#qr-size').textContent = `${qr.size} x ${qr.size} squares, version ${qr.version}, level ${level}`;
    let note = 'Point a camera at it. Nothing is looked up when it is scanned: the furl is the link.';
    try {
      const plain = encodeQR(href, level);
      if (plain.size > qr.size) {
        note =
          `The original link needs a ${plain.size} x ${plain.size} code; this one needs ${qr.size} x ${qr.size}. ` +
          `Fewer squares means a bigger, more forgiving pattern at the same printed size.`;
      }
    } catch {
      note = 'The original link is too long for a QR code at all. The furl fits.';
    }
    $('#qr-note').textContent = note;
    panel.hidden = false;
  } catch {
    panel.hidden = true;
  }
}

/** Hand the browser a file. Everything is built here; nothing is uploaded. */
function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setupQRControls(): void {
  for (const id of ['#qr-dark', '#qr-light', '#qr-quiet', '#qr-level']) {
    $(id).addEventListener('change', () => {
      if (qrState) renderQR(qrState.link, qrState.href);
    });
  }
  const fileName = () => {
    const tail = (qrState?.link.split('/').pop() ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    return 'furl-' + (tail || 'code');
  };
  $('#qr-svg').addEventListener('click', () => {
    if (!qrState) return;
    const { level, render } = qrOptions();
    download(fileName() + '.svg', new Blob([qrToSvg(encodeQR(qrState.link, level), render)], { type: 'image/svg+xml' }));
  });
  $('#qr-png').addEventListener('click', () => {
    if (!qrState) return;
    const { level, render } = qrOptions();
    qrToCanvas(encodeQR(qrState.link, level), 12, render).toBlob((blob) => {
      if (blob) download(fileName() + '.png', blob);
    }, 'image/png');
  });
  $('#qr-copy').addEventListener('click', async () => {
    if (!qrState) return;
    const button = $('#qr-copy');
    const { level, render } = qrOptions();
    const canvas = qrToCanvas(encodeQR(qrState.link, level), 12, render);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('no image');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      button.textContent = 'copied';
    } catch {
      button.textContent = 'clipboard refused';
    }
    setTimeout(() => (button.textContent = 'copy image'), 1600);
  });
}

function setupTool(): void {
  const input = $<HTMLTextAreaElement>('#url');
  const strip = $<HTMLInputElement>('#strip');
  const formPath = $<HTMLInputElement>('#form-path');
  const out = $('#out-link');
  const copy = $<HTMLButtonElement>('#copy');
  // Whatever host this page is served from is the host its links must use.
  const origin = location.origin.startsWith('http') ? location.origin : `https://${HOST}`;
  const originHost = new URL(origin).host;

  $('#chips').replaceChildren(
    ...EXAMPLES.map(([label, value]) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        input.value = value;
        input.focus();
        update();
      });
      return b;
    }),
  );

  const hide = () => {
    $('#result').hidden = true;
    $('#qr').hidden = true;
    $('#unfurled').hidden = true;
    $('#explain').hidden = true;
    $('#error').textContent = '';
  };

  /** A furl wrapped in one of our own links, or null. */
  const furlInLink = (s: string): string | null => {
    const m = /^https?:\/\/([^/?#]+)(?:\/([^?#]*))?(?:#(.*))?$/i.exec(s);
    if (!m) return null;
    const host = m[1].toLowerCase();
    if (host !== HOST && host !== 'www.' + HOST && host !== location.host) return null;
    const cand = (m[3] || m[2] || '').replace(/\/+$/, '');
    return cand && FURL_RE.test(cand) ? cand : null;
  };

  const showUnfurled = (href: string, accidental: boolean) => {
    hide();
    const a = document.createElement('a');
    a.href = href;
    a.rel = 'noreferrer noopener';
    a.textContent = href;
    $('#unfurled-link').replaceChildren(a);
    // A furl carries no checksum, so any run of letters unfurls to *something*.
    // Say that out loud when someone has clearly typed a word rather than a furl.
    $('#unfurled-note').textContent = accidental
      ? 'Any run of letters is a valid furl, because a furl carries no checksum: this is what yours happens to mean. Add a dot to enfurl a link instead.'
      : 'Unfurled here in your browser. No server was asked, nothing was looked up.';
    $('#unfurled').hidden = false;
  };

  function update(): void {
    const raw = input.value.trim();
    hide();
    if (!raw) return;

    // A furl (bare, or inside a furl.li link) unfurls. Anything else enfurls.
    const wrapped = furlInLink(raw);
    const candidate = wrapped ?? (FURL_RE.test(raw) ? raw : null);
    if (candidate) {
      try {
        showUnfurled(codec.unfurl(candidate), !wrapped && /^[a-z]{1,10}$/i.test(raw));
        return;
      } catch (e) {
        if (wrapped) {
          $('#error').textContent = 'That is one of our links, but the furl inside it is damaged.';
          return;
        }
        // A bare word like "example" is not a furl; fall through and treat it as a host.
      }
    }

    // Prose is not a link. Without this, "not a url at all" becomes a hostname
    // with percent-encoded spaces and we would happily furl the nonsense.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && (/\s/.test(raw) || !raw.includes('.'))) {
      $('#error').textContent = 'That does not look like a link yet. Paste a full web address, or a furl to unfurl.';
      return;
    }

    try {
      const r = codec.furl(raw, { addScheme: true, stripTrackers: strip.checked });
      const link = `${origin}/${formPath.checked ? '' : '#'}${r.code}`;
      out.textContent = link;
      copy.textContent = 'Copy';
      $('#result').hidden = false;

      // Quote the length people will actually share, whatever origin this page runs on.
      const before = r.href.length;
      const shared = link.length;
      const pct = Math.round((1 - shared / before) * 100);
      $('#headline').innerHTML =
        pct > 0
          ? `<b>Rolled up to ${r.code.length} characters.</b> Your link was ${before}; the whole ${originHost} link is ${shared}, so ${pct}% shorter.`
          : `<b>Rolled up to ${r.code.length} characters.</b> Your link was ${before}, and it is mostly random data, so rolling it up cannot win much.`;

      const scale = Math.max(before, shared);
      $('#bars').innerHTML =
        `<div class="bar"><span class="cap">your link</span><span class="track"><span class="fill" style="width:${(before / scale) * 100}%"></span></span><span class="num">${before}</span></div>` +
        `<div class="bar now"><span class="cap">${originHost} link</span><span class="track"><span class="fill" style="width:${(shared / scale) * 100}%"></span></span><span class="num">${shared}</span></div>`;

      const after$ = $('#after');
      after$.replaceChildren();
      const peek = document.createElement('a');
      peek.href = `${origin}/${r.code}+`;
      peek.rel = 'noreferrer';
      peek.textContent = 'peek where it goes';
      const open = document.createElement('a');
      open.href = r.href;
      open.rel = 'noreferrer noopener';
      open.textContent = 'open the original';
      after$.append(peek, open);

      $('#shape-hint').textContent = formPath.checked
        ? `${originHost} sees this one, and stores nothing`
        : `${originHost} never receives this one`;

      const note = $('#note');
      note.replaceChildren();
      if (r.removedParams.length) {
        note.append(
          `Shook off ${r.removedParams.length} tracking parameter${r.removedParams.length > 1 ? 's' : ''} (${r.removedParams.join(', ')}), so the furl points at ${r.href}`,
        );
      } else if (r.href !== raw) {
        note.append(`Tidied up to ${r.href}`);
      }

      // If the leftover query string is what costs the space, say so and offer to drop it.
      const parsed = new URL(r.href);
      if (parsed.search) {
        const plain = parsed.origin + parsed.pathname + parsed.hash;
        const saved = r.code.length - codec.furl(plain).code.length;
        if (saved >= 3) {
          const line = document.createElement('span');
          line.append(` The ${parsed.search.length}-character ${parsed.search.slice(0, 1)}… part costs ${saved} characters of furl. `);
          const drop = document.createElement('button');
          drop.className = 'chip';
          drop.type = 'button';
          drop.textContent = 'try without it';
          drop.addEventListener('click', () => {
            input.value = plain;
            update();
          });
          line.append(drop);
          note.append(line);
        }
      }

      renderQR(link, r.href);

      const ex = codec.explain(raw, { addScheme: true, stripTrackers: strip.checked });
      renderExplain(ex.parts, ex.bits, r.code, r.href);
    } catch (e) {
      $('#error').textContent = `${(e as Error).message}. Paste a full web link, or a furl to unfurl.`;
    }
  }

  input.addEventListener('input', update);
  strip.addEventListener('change', update);
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name=form]')) el.addEventListener('change', update);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(out.textContent ?? '');
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1400);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(out);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
  });

  setupQRControls();

  const seed = new URLSearchParams(location.search).get('u');
  if (seed) {
    input.value = seed;
    update();
  }
}

const here = furlFromLocation();
if (here) showUnfurlPage(here.furl, here.peek);
else setupTool();
window.addEventListener('hashchange', () => {
  const l = furlFromLocation();
  if (l) showUnfurlPage(l.furl, l.peek);
});
