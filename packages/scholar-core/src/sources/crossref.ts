/**
 * Crossref REST: DOI lookup and bibliographic matching.
 * https://api.crossref.org — polite pool via `mailto` when a contact is configured.
 */

import type { HttpClient } from '../http';
import {
  CROSSREF_BASE,
  crossrefWorkUrl,
  isWorkFor,
  parseUpdatedBy,
  withTitleNotice,
} from '../retractions';
import type { Author, Work } from '../types';

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

interface CrossrefDate {
  'date-parts'?: (number | null)[][];
}

interface CrossrefMessage {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  'container-title'?: string[];
  'short-container-title'?: string[];
  issued?: CrossrefDate;
  'published-print'?: CrossrefDate;
  'published-online'?: CrossrefDate;
  volume?: string;
  issue?: string;
  page?: string;
  'article-number'?: string;
  type?: string;
  'update-to'?: unknown[];
  /** The issue's own cover date: MDPI's Jan-2025 issue holds papers first posted Dec 2024. */
  'journal-issue'?: { 'published-print'?: CrossrefDate; 'published-online'?: CrossrefDate };
}

/**
 * Fields we read from search results. Keeps responses small and cassettes
 * reviewable. `journal-issue` is not selectable (measured: the search answers
 * an error), so the issue cover date only comes with a full /works/{doi} record.
 */
const SELECT = [
  'DOI',
  'title',
  'author',
  'container-title',
  'short-container-title',
  'issued',
  'published-print',
  'published-online',
  'volume',
  'issue',
  'page',
  'article-number',
  'type',
  'updated-by',
  'update-to',
].join(',');

function yearOf(d?: CrossrefDate): number | undefined {
  const y = d?.['date-parts']?.[0]?.[0];
  return typeof y === 'number' && y > 1000 ? y : undefined;
}

export function mapCrossrefWork(m: CrossrefMessage): Work {
  const title = (m.title?.[0] ?? '').replace(/\s+/g, ' ').trim();
  const authors: Author[] = (m.author ?? [])
    .map((a) => ({ family: (a.family ?? a.name ?? '').trim(), ...(a.given ? { given: a.given.trim() } : {}) }))
    .filter((a) => a.family);
  const issue = m['journal-issue'];
  const years = [
    ...new Set([
      yearOf(m['published-print']),
      yearOf(m['published-online']),
      yearOf(m.issued),
      yearOf(issue?.['published-print']),
      yearOf(issue?.['published-online']),
    ]),
  ].filter(
    (y): y is number => typeof y === 'number',
  );
  const journals = [...(m['container-title'] ?? []), ...(m['short-container-title'] ?? [])].filter(Boolean);
  const notices = withTitleNotice(parseUpdatedBy(m), title);
  return {
    source: 'crossref',
    title,
    authors,
    years,
    journals,
    ...(m.volume ? { volume: m.volume } : {}),
    ...(m.issue ? { issue: m.issue } : {}),
    ...(m.page || m['article-number'] ? { pages: m.page ?? m['article-number'] } : {}),
    ...(m.DOI ? { doi: m.DOI.toLowerCase() } : {}),
    ...(m.type ? { type: m.type } : {}),
    notices,
    ...(Array.isArray(m['update-to']) && m['update-to'].length > 0 ? { isNotice: true } : {}),
  };
}

export type LookupOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'rate_limited' | 'error' };

export async function crossrefGetWork(
  http: HttpClient,
  doi: string,
  contactEmail?: string,
): Promise<LookupOutcome<Work>> {
  const res = await http({ url: crossrefWorkUrl(doi, contactEmail) });
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200 || !isWorkFor(res.body, doi)) return { ok: false, reason: 'error' };
  return { ok: true, value: mapCrossrefWork((res.body as { message: CrossrefMessage }).message) };
}

/**
 * `query.bibliographic` is Crossref's own citation matcher: it takes the whole
 * reference string, so it still finds the paper when our parser misread a
 * field. That robustness is why the raw string, not the parsed title, is sent.
 */
export async function crossrefSearchBibliographic(
  http: HttpClient,
  citation: string,
  opts: { rows?: number; contactEmail?: string } = {},
): Promise<LookupOutcome<Work[]>> {
  const q = new URLSearchParams({
    'query.bibliographic': citation.slice(0, 500),
    rows: String(opts.rows ?? 5),
    select: SELECT,
  });
  if (opts.contactEmail) q.set('mailto', opts.contactEmail);
  const res = await http({ url: `${CROSSREF_BASE}/works?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const items = (res.body as { message?: { items?: CrossrefMessage[] } } | null)?.message?.items;
  if (!Array.isArray(items)) return { ok: false, reason: 'error' };
  return { ok: true, value: items.map(mapCrossrefWork) };
}
