/**
 * Shareable Research Data Brief links, stored nowhere.
 *
 * Like the PRISMA links, the content travels in the URL (deflate + base64url),
 * so nothing is written to a database and the user's question is never kept
 * on the server. Unlike a PRISMA diagram, a brief makes claims (licence
 * verdicts, "paper verified"), so the payload is signed: the page renders
 * only what this server produced, and an edited link is refused instead of
 * showing forged verdicts under the Phở name.
 *
 * The signing key is derived from QUOTA_SALT, the deployment's existing secret.
 * Rotating that salt invalidates every brief link along with the quota subjects.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { DatasetSource, DatasetsResult, IntendedUse, LicenceVerdict, MatchLevel, PaperStatus } from '@pho/scholar-core';
import { truncate } from './tools/shared';

export interface BriefItem {
  /** `dataset` | `model` */
  k: 'dataset' | 'model';
  /** Source: `huggingface` | `datacite` | `geo` | `cellxgene` | `cryoet` */
  s: DatasetSource;
  id: string;
  url: string;
  t: string;
  m: MatchLevel;
  w: string;
  l: LicenceVerdict;
  x?: string;
  ln?: string[];
  a: 'open' | 'gated' | 'unknown';
  f?: string;
  z?: string;
  p: { s: PaperStatus; id?: string; t?: string; n: string; c?: string };
  c: string;
  n: string;
}

export interface BriefPayload {
  v: 1;
  q: string;
  u: IntendedUse;
  /** Created, YYYY-MM-DD. */
  d: string;
  /** [candidates scanned, papers verified, warnings] */
  st: [number, number, number];
  r: BriefItem[];
  tk: string[];
  wn: string[];
}

/** Longest token accepted; keeps links under common URL limits (8 KB). */
export const MAX_BRIEF_TOKEN_CHARS = 7000;
const SIG_BYTES = 16;

function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('pho-research-brief-v1').digest();
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', key(secret)).update(data).digest().subarray(0, SIG_BYTES).toString('base64url');
}

export function briefPayload(r: DatasetsResult, today: string): BriefPayload {
  return {
    v: 1,
    q: truncate(r.question, 300),
    u: r.intendedUse,
    d: today,
    st: [r.stats.sourcesScanned, r.stats.papersVerified, r.stats.warnings],
    r: r.results.map((d) => {
      const paperId = d.paper.doi
        ? `doi:${d.paper.doi}`
        : d.paper.pmid
          ? `pmid:${d.paper.pmid}`
          : d.paper.arxiv
            ? `arxiv:${d.paper.arxiv}`
            : undefined;
      return {
        k: d.kind,
        s: d.source,
        id: d.id,
        url: d.url,
        t: truncate(d.title, 160),
        m: d.match,
        w: truncate(d.why, 240),
        l: d.licence.verdict,
        ...(d.licence.spdx ? { x: d.licence.spdx } : {}),
        ...(d.licence.notes.length ? { ln: d.licence.notes.map((n) => truncate(n, 200)) } : {}),
        a: d.access,
        ...(d.formats.length ? { f: truncate(d.formats.join(', '), 80) } : {}),
        ...(d.size ? { z: truncate(d.size, 60) } : {}),
        p: {
          s: d.paper.status,
          ...(paperId ? { id: paperId } : {}),
          ...(d.paper.title ? { t: truncate(d.paper.title, 200) } : {}),
          n: truncate(d.paper.note, 200),
          ...(d.paper.citation ? { c: truncate(d.paper.citation, 500) } : {}),
        },
        c: truncate(d.citation, 500),
        n: truncate(d.loadSnippet, 400),
      };
    }),
    tk: r.takeaways.map((t) => truncate(t, 300)),
    wn: r.warnings.slice(0, 5).map((w) => truncate(w, 200)),
  };
}

export function encodeBrief(p: BriefPayload, secret: string): string {
  const data = deflateRawSync(Buffer.from(JSON.stringify(p))).toString('base64url');
  return `${data}.${sign(data, secret)}`;
}

/**
 * A token that fits: when a long brief would exceed the URL budget, the
 * paper citations go first, then the results from the bottom up.
 */
export function briefToken(p: BriefPayload, secret: string): string | null {
  let current: BriefPayload = p;
  let token = encodeBrief(current, secret);
  if (token.length <= MAX_BRIEF_TOKEN_CHARS) return token;
  current = { ...current, r: current.r.map((i) => ({ ...i, p: { ...i.p, c: undefined } })) };
  token = encodeBrief(current, secret);
  while (token.length > MAX_BRIEF_TOKEN_CHARS && current.r.length > 1) {
    current = { ...current, r: current.r.slice(0, -1) };
    token = encodeBrief(current, secret);
  }
  return token.length <= MAX_BRIEF_TOKEN_CHARS ? token : null;
}

export function decodeBrief(token: string, secret: string): BriefPayload | null {
  if (!token || token.length > MAX_BRIEF_TOKEN_CHARS) return null;
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  const [, data, sig] = m as unknown as [string, string, string];
  const expected = Buffer.from(sign(data, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    // maxOutputLength guards against a decompression bomb.
    const json = inflateRawSync(Buffer.from(data, 'base64url'), { maxOutputLength: 128 * 1024 }).toString('utf8');
    const parsed = JSON.parse(json) as BriefPayload;
    return parsed && parsed.v === 1 && Array.isArray(parsed.r) ? parsed : null;
  } catch {
    return null;
  }
}

export function briefUrl(base: string, token: string): string {
  return `${base}/brief/${token}`;
}
