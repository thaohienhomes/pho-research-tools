/**
 * OpenAlex: a fallback index with broader coverage than PubMed (social
 * sciences, CS, engineering, non-English journals). Used only after Crossref
 * and PubMed fail to produce a convincing match, so a missing or throttled
 * OpenAlex never decides a verdict on its own.
 *
 * OpenAlex's access policy has been changing (API keys, usage pricing);
 * `apiKey` is passed when configured and the call is otherwise anonymous.
 */

import type { HttpClient } from '../http';
import type { Author, RetractionNotice, Work } from '../types';
import type { LookupOutcome } from './crossref';

const BASE = 'https://api.openalex.org';

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null };
  is_retracted?: boolean;
  type?: string;
  ids?: { pmid?: string };
}

const SELECT = 'id,doi,title,display_name,publication_year,authorships,primary_location,biblio,is_retracted,type,ids';

/** `Yann LeCun` → { family: 'LeCun', given: 'Yann' }. OpenAlex only gives display names. */
function splitDisplayName(n: string): Author {
  const parts = n.trim().split(/\s+/);
  if (parts.length === 1) return { family: parts[0]! };
  return { family: parts[parts.length - 1]!, given: parts.slice(0, -1).join(' ') };
}

export function mapOpenAlexWork(w: OpenAlexWork): Work {
  const title = (w.title ?? w.display_name ?? '').trim();
  const doi = w.doi?.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
  const pmid = w.ids?.pmid?.replace(/\D+/g, '') || undefined;
  const first = w.biblio?.first_page ?? undefined;
  const last = w.biblio?.last_page ?? undefined;
  const notices: RetractionNotice[] = w.is_retracted
    ? [{ type: 'retraction', label: 'OpenAlex: is_retracted', source: 'openalex' }]
    : [];
  const journal = w.primary_location?.source?.display_name;
  return {
    source: 'openalex',
    title,
    authors: (w.authorships ?? [])
      .map((a) => a.author?.display_name)
      .filter((n): n is string => !!n)
      .map(splitDisplayName),
    years: w.publication_year ? [w.publication_year] : [],
    journals: journal ? [journal] : [],
    ...(w.biblio?.volume ? { volume: w.biblio.volume } : {}),
    ...(w.biblio?.issue ? { issue: w.biblio.issue } : {}),
    ...(first ? { pages: last && last !== first ? `${first}-${last}` : first } : {}),
    ...(doi ? { doi } : {}),
    ...(pmid ? { pmid } : {}),
    ...(w.id ? { openalexId: w.id.replace(/^https?:\/\/openalex\.org\//, '') } : {}),
    ...(w.type ? { type: w.type } : {}),
    notices,
  };
}

export async function openalexSearchTitle(
  http: HttpClient,
  title: string,
  opts: { apiKey?: string; contactEmail?: string; perPage?: number } = {},
): Promise<LookupOutcome<Work[]>> {
  // `search` would also match abstracts; `title.search` keeps hits honest.
  const cleaned = title.replace(/[,:|()"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (cleaned.split(' ').length < 2) return { ok: true, value: [] };
  const q = new URLSearchParams({
    filter: `title.search:${cleaned}`,
    'per-page': String(opts.perPage ?? 5),
    select: SELECT,
  });
  if (opts.apiKey) q.set('api_key', opts.apiKey);
  if (opts.contactEmail) q.set('mailto', opts.contactEmail);
  const res = await http({ url: `${BASE}/works?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const results = (res.body as { results?: OpenAlexWork[] } | null)?.results;
  if (!Array.isArray(results)) return { ok: false, reason: 'error' };
  return { ok: true, value: results.map(mapOpenAlexWork) };
}

interface OpenAlexSearchWork extends OpenAlexWork {
  primary_location?: { source?: { display_name?: string | null; type?: string | null } | null } | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  cited_by_count?: number;
}

export interface OpenAlexHit {
  work: Work;
  /** Not peer reviewed: typed `preprint`, or first posted on a repository (medRxiv, Research Square…). */
  isPreprint: boolean;
  isOa: boolean;
  oaUrl?: string;
  citedByCount?: number;
}

export interface OpenAlexSearchOptions {
  apiKey?: string;
  contactEmail?: string;
  perPage?: number;
  yearFrom?: number;
  yearTo?: number;
  openAccessOnly?: boolean;
  /** OpenAlex work types to keep (`review`, `article`…). */
  types?: string[];
}

/**
 * Relevance search over titles, abstracts and full text. Paratext (covers,
 * tables of contents) and works without any DOI are excluded server-side, so
 * every hit can be resolved.
 */
export async function openalexSearchWorks(
  http: HttpClient,
  query: string,
  opts: OpenAlexSearchOptions = {},
): Promise<LookupOutcome<OpenAlexHit[]>> {
  const filters = ['is_paratext:false', 'has_doi:true'];
  if (opts.yearFrom && opts.yearTo) filters.push(`publication_year:${opts.yearFrom}-${opts.yearTo}`);
  else if (opts.yearFrom) filters.push(`publication_year:>${opts.yearFrom - 1}`);
  else if (opts.yearTo) filters.push(`publication_year:<${opts.yearTo + 1}`);
  if (opts.openAccessOnly) filters.push('is_oa:true');
  if (opts.types?.length) filters.push(`type:${opts.types.join('|')}`);
  const q = new URLSearchParams({
    search: query,
    filter: filters.join(','),
    'per-page': String(opts.perPage ?? 10),
    select: `${SELECT},open_access,cited_by_count`,
  });
  if (opts.apiKey) q.set('api_key', opts.apiKey);
  if (opts.contactEmail) q.set('mailto', opts.contactEmail);
  const res = await http({ url: `${BASE}/works?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const results = (res.body as { results?: OpenAlexSearchWork[] } | null)?.results;
  if (!Array.isArray(results)) return { ok: false, reason: 'error' };
  return {
    ok: true,
    value: results.map((w) => ({
      work: mapOpenAlexWork(w),
      isPreprint: w.type === 'preprint' || w.primary_location?.source?.type === 'repository',
      isOa: !!w.open_access?.is_oa,
      ...(w.open_access?.oa_url ? { oaUrl: w.open_access.oa_url } : {}),
      ...(typeof w.cited_by_count === 'number' ? { citedByCount: w.cited_by_count } : {}),
    })),
  };
}
