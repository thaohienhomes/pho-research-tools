/**
 * The public Research Data Brief page and its Open Graph image.
 *
 * Server-rendered from a signed link (see ./brief-link), so it needs no
 * database and no client framework. Every string from the payload is escaped;
 * the only script is a few lines for the copy and share buttons, allowed by a
 * per-response nonce. Briefs are `noindex`: a shared research question is
 * meant for the people it was sent to, not for search engines.
 */

import { LICENCE_LABELS, type LicenceVerdict, type MatchLevel, type PaperStatus } from '@pho/scholar-core';
import type { BriefItem, BriefPayload } from './brief-link';

export const TOOLS_LANDING_URL = 'https://pho.chat/tools/mcp/';

const MATCH_LABELS: Record<MatchLevel, string> = {
  best: 'Best match',
  good: 'Good match',
  use_with_care: 'Use with care',
};

const SOURCE_LABELS: Record<BriefItem['s'], string> = {
  huggingface: 'Hugging Face',
  datacite: 'DataCite',
  geo: 'NCBI GEO',
  cellxgene: 'CZ CELLxGENE Discover',
  cryoet: 'CZ CryoET Data Portal',
};

const PAPER_LABELS: Record<PaperStatus, string> = {
  verified: 'Source paper verified',
  correction: 'Source paper has a correction',
  concern: 'Expression of concern on the source paper',
  retracted: 'Source paper RETRACTED',
  not_found: 'Listed paper not found',
  unchecked: 'Source paper not fully checked',
  none_linked: 'No source paper linked',
};

type Tone = 'ok' | 'warn' | 'bad';

function licenceTone(v: LicenceVerdict): Tone {
  if (v === 'ok_publication_commercial' || v === 'ok_share_alike' || v === 'repository_terms') return 'ok';
  return v === 'unclear' ? 'bad' : 'warn';
}

function paperTone(s: PaperStatus): Tone {
  if (s === 'verified') return 'ok';
  return s === 'retracted' || s === 'not_found' ? 'bad' : 'warn';
}

const MARK: Record<Tone, string> = { ok: '✓', warn: '⚠', bad: '✕' };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function safeHref(url: string): string | undefined {
  return /^https:\/\/[^\s"'<>]+$/.test(url) ? url : undefined;
}

function paperHref(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const [kind, value] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'doi') return `https://doi.org/${encodeURI(value)}`;
  if (kind === 'pmid' && /^\d+$/.test(value)) return `https://pubmed.ncbi.nlm.nih.gov/${value}/`;
  if (kind === 'arxiv') return `https://arxiv.org/abs/${encodeURI(value)}`;
  return undefined;
}

export function briefTitle(p: BriefPayload): string {
  const q = p.q.length > 90 ? `${p.q.slice(0, 89).replace(/\s+\S*$/, '')}…` : p.q;
  return `Open data for “${q}”`;
}

function topic(p: BriefPayload, max = 60): string {
  const q = p.q.replace(/\s+/g, ' ').trim();
  return q.length > max ? `${q.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : q;
}

export function ogHeadline(p: BriefPayload): string {
  const n = p.r.length;
  // The question is whatever the sharer typed, so it is always shown quoted, as
  // their words, never as a statement in Phở's voice.
  return n === 0
    ? `No open datasets yet for “${topic(p)}”`
    : `${n} open dataset${n === 1 ? '' : 's'} for “${topic(p)}”`;
}

function item(i: BriefItem, idx: number): string {
  const href = safeHref(i.url);
  const lt = licenceTone(i.l);
  const pt = paperTone(i.p.s);
  const pHref = paperHref(i.p.id);
  const facts = [
    SOURCE_LABELS[i.s],
    i.k === 'model' ? 'Model' : undefined,
    i.f,
    i.z,
    i.a === 'gated' ? 'Access request needed' : undefined,
  ]
    .filter(Boolean)
    .map((f) => esc(f!))
    .join(' · ');
  return `
<article class="card" id="r${idx + 1}">
  <div class="card-head">
    <span class="match match-${i.m}">${MATCH_LABELS[i.m]}</span>
    <span class="facts">${facts}</span>
  </div>
  <h2>${href ? `<a href="${esc(href)}" rel="noopener nofollow" target="_blank">${esc(i.t)}</a>` : esc(i.t)}</h2>
  <p class="id"><code>${esc(i.id)}</code></p>
  <p class="why">${esc(i.w)}</p>
  <ul class="checks">
    <li class="tone-${lt}"><span aria-hidden="true">${MARK[lt]}</span> <span>${esc(LICENCE_LABELS[i.l])}${i.x ? ` <code>${esc(i.x)}</code>` : ''}${(i.ln ?? []).map((n) => `<br><small>${esc(n)}</small>`).join('')}</span></li>
    <li class="tone-${pt}"><span aria-hidden="true">${MARK[pt]}</span> <span>${esc(PAPER_LABELS[i.p.s])}${i.p.t ? `: ${pHref ? `<a href="${esc(pHref)}" rel="noopener nofollow" target="_blank">${esc(i.p.t)}</a>` : esc(i.p.t)}` : pHref ? `: <a href="${esc(pHref)}" rel="noopener nofollow" target="_blank">${esc(i.p.id!)}</a>` : ''}<br><small>${esc(i.p.n)}</small></span></li>
  </ul>
  <div class="cite">
    <p class="label">Cite the data</p>
    <p class="cite-text" data-copy-src>${esc(i.c)}</p>
    ${i.p.c ? `<p class="label">Cite the paper</p><p class="cite-text">${esc(i.p.c)}</p>` : ''}
    <div class="actions">
      <button type="button" class="btn" data-copy="${esc(i.p.c ? `${i.c}\n${i.p.c}` : i.c)}" data-event="citation_copied">Copy citation</button>
      <details><summary class="btn">Load snippet</summary><pre><code>${esc(i.n)}</code></pre>
      <button type="button" class="btn small" data-copy="${esc(i.n)}" data-event="snippet_copied">Copy code</button></details>
    </div>
  </div>
</article>`;
}

export interface BriefPageUrls {
  page: string;
  og: string;
  event: string;
}

export function renderBriefHtml(p: BriefPayload, urls: BriefPageUrls, nonce: string): string {
  const title = briefTitle(p);
  const headline = ogHeadline(p);
  const [scanned, verified, warnings] = p.st;
  const shareText = `${headline}: licences and source papers checked with Phở Research Tools.`;
  const xHref = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(urls.page)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · Phở Research Tools</title>
<meta name="description" content="${esc(shareText)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(headline)}">
<meta property="og:description" content="${esc(`${verified} source papers verified · ${p.r.length} licences checked · works in Claude & ChatGPT`)}">
<meta property="og:url" content="${esc(urls.page)}">
<meta property="og:image" content="${esc(urls.og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<style>
:root{--bg-sunken:#f1eee4;--bg:#f9f6ee;--surface:#fffdf7;--border-dim:#e8e4d8;--border:#dbd6c8;--text:#1a211e;--text-2:#4e5955;--muted:#5f6965;--accent:#046a4e;--action:#047857;--action-hover:#065f46;--on-action:#fffdf7;--ok:#047454;--warn:#a64c08;--bad:#c81e1e;--focus:#059669;
--sans:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--serif:'Source Serif 4',Georgia,serif;--mono:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg-sunken:#0f1413;--bg:#171d1b;--surface:#1f2624;--border-dim:#2b3432;--border:#384240;--text:#f3f6f5;--text-2:#bfc9c6;--muted:#93a09c;--accent:#34d399;--on-action:#ecfdf5;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--focus:#10b981}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:400 15px/1.6 var(--sans)}
a{color:var(--accent);text-underline-offset:2px}:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
code,pre{font-family:var(--mono);font-size:13px}
.wrap{max-width:760px;margin:0 auto;padding:0 16px 48px}
header.top{border-bottom:1px solid var(--border-dim);background:var(--surface)}
header.top .wrap{padding-top:12px;padding-bottom:12px;display:flex;justify-content:space-between;gap:12px;align-items:center}
.brand{font-weight:600;color:var(--text);text-decoration:none}.brand span{color:var(--muted);font-weight:400}
h1{font:600 26px/1.3 var(--serif);margin:28px 0 6px;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:13px;margin:0 0 16px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px;padding:0;list-style:none}
.stats li{background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:13px;color:var(--text-2)}
.stats b{color:var(--text)}
section{margin:0 0 24px}
.takeaways{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 20px}
.takeaways h2,.warnings h2{font:600 15px/1.4 var(--sans);margin:0 0 8px}
.takeaways ul,.warnings ul{margin:0;padding-left:20px;color:var(--text-2)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin:0 0 16px}
.card-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--muted)}
.match{border:1px solid var(--border);border-radius:999px;padding:2px 10px;font-weight:600;color:var(--text-2)}
.match-best{color:var(--accent);border-color:var(--accent)}
.match-use_with_care{color:var(--warn)}
.card h2{font:600 17px/1.4 var(--sans);margin:10px 0 2px;overflow-wrap:anywhere}
.card h2 a{color:var(--text);text-decoration:none}.card h2 a:hover{text-decoration:underline}
.id{margin:0;color:var(--muted);overflow-wrap:anywhere}
.why{color:var(--text-2);margin:8px 0}
.checks{list-style:none;padding:0;margin:12px 0}
.checks li{display:flex;gap:8px;margin:0 0 8px;color:var(--text-2);overflow-wrap:anywhere}
.checks li>span:first-child{font-weight:700;width:1em;flex:none}
.tone-ok>span:first-child{color:var(--ok)}.tone-warn>span:first-child{color:var(--warn)}.tone-bad>span:first-child{color:var(--bad)}
small{color:var(--muted);font-size:12px}
.cite{border-top:1px solid var(--border-dim);padding-top:12px}
.label{font-size:12px;color:var(--muted);margin:0 0 2px;text-transform:uppercase;letter-spacing:.06em}
.cite-text{margin:0 0 10px;font-size:14px;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}
.btn{display:inline-block;font:500 13px/1 var(--sans);padding:9px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;text-decoration:none;min-height:36px}
.btn:hover{border-color:var(--text-2)}.btn.small{padding:6px 10px;min-height:30px;margin-top:6px}
.btn.primary{background:var(--action);border-color:var(--action);color:var(--on-action)}.btn.primary:hover{background:var(--action-hover)}
details{flex:1 1 100%}details summary{list-style:none}details summary::-webkit-details-marker{display:none}
pre{background:var(--bg-sunken);border:1px solid var(--border-dim);border-radius:8px;padding:12px;overflow-x:auto;margin:8px 0 0;white-space:pre}
.warnings{border:1px solid var(--border);border-radius:12px;padding:16px 20px}
.empty{color:var(--text-2)}
.share{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}
footer{color:var(--muted);font-size:13px;border-top:1px solid var(--border-dim);padding-top:16px}
.cta{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin:32px 0 24px}
.cta p{margin:0 0 12px;color:var(--text-2)}
</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${TOOLS_LANDING_URL}">Phở <span>Research Tools</span></a><span class="meta" style="margin:0">Research Data Brief</span></div></header>
<main class="wrap">
<h1>${esc(title)}</h1>
<p class="meta">Question as asked by whoever made this brief · Made ${esc(p.d)} · Intended use: ${esc(p.u)}</p>
<ul class="stats" aria-label="Summary">
  <li><b>${p.r.length}</b> result${p.r.length === 1 ? '' : 's'} from ${scanned} scanned</li>
  <li><b>${verified}</b> source paper${verified === 1 ? '' : 's'} verified</li>
  <li><b>${p.r.length}</b> licence${p.r.length === 1 ? '' : 's'} checked</li>
  <li><b>${warnings}</b> warning${warnings === 1 ? '' : 's'}</li>
</ul>
<div class="share">
  <button type="button" class="btn" data-copy="${esc(urls.page)}" data-event="share_clicked" data-channel="link">Copy share link</button>
  <a class="btn" href="${esc(xHref)}" target="_blank" rel="noopener" data-event="share_clicked" data-channel="x">Share to X</a>
</div>
${
  p.tk.length
    ? `<section class="takeaways"><h2>What this means for your research</h2><ul>${p.tk.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>`
    : ''
}
<section>
${p.r.length ? p.r.map(item).join('\n') : '<p class="empty">No open dataset matched this question closely enough to recommend. Try broader English keywords, or a repository specific to the field.</p>'}
</section>
${p.wn.length ? `<section class="warnings"><h2>Warnings</h2><ul>${p.wn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>` : ''}
<div class="cta">
  <p>Ask your own question. Phở Research Tools works inside Claude and ChatGPT: it finds open datasets, checks licences and source papers, and verifies references.</p>
  <a class="btn primary" href="${TOOLS_LANDING_URL}" data-event="cta_clicked">Ask your own question</a>
</div>
<footer>
  <p>Licence information is taken from each repository's metadata; it is not legal advice. Paper checks use Crossref, PubMed and DataCite.</p>
  <p>Made with Phở Research Tools · works in Claude &amp; ChatGPT</p>
</footer>
</main>
<script nonce="${nonce}">
(function(){
  var ev=${JSON.stringify(urls.event)};
  function send(e,extra){try{var b=JSON.stringify(Object.assign({e:e},extra||{}));if(navigator.sendBeacon){navigator.sendBeacon(ev,new Blob([b],{type:'text/plain'}))}else{fetch(ev,{method:'POST',body:b,keepalive:true})}}catch(_){}}
  document.addEventListener('click',function(t){
    var el=t.target.closest('[data-copy],[data-event]');if(!el)return;
    if(el.hasAttribute('data-copy')){var v=el.getAttribute('data-copy');if(navigator.clipboard){navigator.clipboard.writeText(v).then(function(){var o=el.textContent;el.textContent='Copied';setTimeout(function(){el.textContent=o},1500)})}}
    var e=el.getAttribute('data-event');if(e)send(e,{channel:el.getAttribute('data-channel')||undefined});
  });
  document.querySelectorAll('details').forEach(function(d){d.addEventListener('toggle',function(){if(d.open)send('snippet_opened')})});
})();
</script>
</body>
</html>`;
}

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line ? `${line} ${w}` : w).length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/\s+\S*$/, '')}…`;
    return kept;
  }
  return lines;
}

/** 1200×630 card for link previews, drawn in the dark Jade Mist palette. */
export function renderBriefOgSvg(p: BriefPayload): string {
  const lines = wrap(ogHeadline(p), 30, 3);
  const [, verified, warnings] = p.st;
  const pills = [
    `${verified} paper${verified === 1 ? '' : 's'} verified`,
    `${p.r.length} licence${p.r.length === 1 ? '' : 's'} checked`,
    `${warnings} warning${warnings === 1 ? '' : 's'}`,
  ];
  let x = 80;
  const pillSvg = pills
    .map((t) => {
      const w = Math.round(t.length * 15.5 + 48);
      const s = `<rect x="${x}" y="430" width="${w}" height="56" rx="28" fill="#1f2624" stroke="#384240" stroke-width="2"/><text x="${x + w / 2}" y="467" text-anchor="middle" font-size="26" fill="#f3f6f5">${esc(t)}</text>`;
      x += w + 16;
      return s;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Be Vietnam Pro">
<rect width="1200" height="630" fill="#171d1b"/>
<rect x="0" y="0" width="1200" height="8" fill="#047857"/>
<text x="80" y="110" font-size="26" fill="#93a09c" letter-spacing="2">RESEARCH DATA BRIEF</text>
${lines.map((l, i) => `<text x="80" y="${200 + i * 70}" font-size="56" font-weight="600" fill="#f3f6f5">${esc(l)}</text>`).join('\n')}
${pillSvg}
<line x1="80" y1="540" x2="1120" y2="540" stroke="#2b3432" stroke-width="2"/>
<text x="80" y="588" font-size="26" fill="#bfc9c6">Made with <tspan fill="#34d399" font-weight="600">Phở Research Tools</tspan> · works in Claude &amp; ChatGPT</text>
</svg>`;
}
