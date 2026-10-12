/**
 * PubMed E-utilities: title search and PMID lookup.
 * https://www.ncbi.nlm.nih.gov/books/NBK25499/ — 3 req/s without a key, 10 with.
 */

import type { HttpClient } from '../http';
import { normalize } from '../text';
import type { Author, RetractionNotice, Work } from '../types';
import type { LookupOutcome } from './crossref';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

export interface PubmedOptions {
  apiKey?: string;
  contactEmail?: string;
}

function common(opts: PubmedOptions): Record<string, string> {
  const p: Record<string, string> = { db: 'pubmed', retmode: 'json', tool: 'pho-scholar' };
  if (opts.apiKey) p.api_key = opts.apiKey;
  if (opts.contactEmail) p.email = opts.contactEmail;
  return p;
}

interface EsummaryDoc {
  uid?: string;
  title?: string;
  authors?: { name?: string; authtype?: string }[];
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  epubdate?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  elocationid?: string;
  articleids?: { idtype?: string; value?: string }[];
  pubtype?: string[];
}

/** `Drysdale SB` → { family: 'Drysdale', given: 'SB' }; collective names stay whole. */
export function splitPubmedName(name: string): Author {
  const parts = name.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? '';
  if (parts.length > 1 && /^[A-Z]{1,4}$/.test(last)) {
    return { family: parts.slice(0, -1).join(' '), given: last };
  }
  return { family: name.trim() };
}

function yearFrom(s?: string): number | undefined {
  const m = /\b(1[89]\d\d|20\d\d)\b/.exec(s ?? '');
  return m ? Number(m[1]) : undefined;
}

export function mapEsummary(d: EsummaryDoc): Work {
  const doi = d.articleids?.find((a) => a.idtype === 'doi')?.value?.toLowerCase();
  const pmcid = d.articleids?.find((a) => a.idtype === 'pmc')?.value?.match(/PMC\d+/)?.[0];
  const authors = (d.authors ?? [])
    .filter((a) => a.name && (a.authtype ?? 'Author') === 'Author')
    .map((a) => splitPubmedName(a.name!));
  const years = [...new Set([yearFrom(d.pubdate), yearFrom(d.epubdate)])].filter(
    (y): y is number => typeof y === 'number',
  );
  const notices: RetractionNotice[] = (d.pubtype ?? []).includes('Retracted Publication')
    ? [{ type: 'retraction', label: 'PubMed: Retracted Publication', source: 'pubmed' }]
    : [];
  const title = (d.title ?? '').replace(/\.$/, '').trim();
  // `elocationid` is "doi: 10.x/y" or "pii: e076309"; only a bare e-locator is a page.
  const eloc = (d.elocationid ?? '').trim();
  const pages = d.pages || (/^[a-z]?\d+$/i.test(eloc) ? eloc : '');
  return {
    source: 'pubmed',
    title,
    authors,
    years,
    journals: [d.fulljournalname, d.source].filter((x): x is string => !!x),
    ...(d.volume ? { volume: d.volume } : {}),
    ...(d.issue ? { issue: d.issue } : {}),
    ...(pages ? { pages } : {}),
    ...(doi ? { doi } : {}),
    ...(d.uid ? { pmid: d.uid } : {}),
    ...(pmcid ? { pmcid } : {}),
    ...((d.pubtype ?? []).includes('Preprint') ? { type: 'preprint' } : {}),
    notices,
    ...((d.pubtype ?? []).some((t) => /^(Retraction of Publication|Published Erratum)$/.test(t))
      ? { isNotice: true }
      : {}),
  };
}

export async function pubmedSummaries(
  http: HttpClient,
  pmids: string[],
  opts: PubmedOptions = {},
): Promise<LookupOutcome<Work[]>> {
  if (pmids.length === 0) return { ok: true, value: [] };
  const q = new URLSearchParams({ ...common(opts), id: pmids.join(',') });
  const res = await http({ url: `${EUTILS}/esummary.fcgi?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const result = (res.body as { result?: Record<string, unknown> } | null)?.result;
  if (!result) return { ok: false, reason: 'error' };
  const docs = pmids
    .map((id) => result[id] as EsummaryDoc | undefined)
    .filter((d): d is EsummaryDoc => !!d && typeof d.title === 'string');
  return { ok: true, value: docs.map(mapEsummary) };
}

/**
 * Title search. The title is reduced to plain words: PubMed's query syntax
 * gives meaning to brackets, quotes and boolean words, and a cited title is
 * not a query.
 */
export async function pubmedSearchTitle(
  http: HttpClient,
  title: string,
  opts: PubmedOptions & { retmax?: number } = {},
): Promise<LookupOutcome<Work[]>> {
  const words = normalize(title)
    .split(' ')
    .filter((w) => w && !['and', 'or', 'not'].includes(w))
    .slice(0, 30);
  if (words.length < 2) return { ok: true, value: [] };
  const q = new URLSearchParams({
    ...common(opts),
    term: words.join(' '),
    retmax: String(opts.retmax ?? 5),
    sort: 'relevance',
  });
  const res = await http({ url: `${EUTILS}/esearch.fcgi?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const ids = (res.body as { esearchresult?: { idlist?: string[] } } | null)?.esearchresult?.idlist;
  if (!Array.isArray(ids)) return { ok: false, reason: 'error' };
  return pubmedSummaries(http, ids, opts);
}

/** The PubMed record for a DOI, if PubMed has one. */
export async function pubmedByDoi(
  http: HttpClient,
  doi: string,
  opts: PubmedOptions = {},
): Promise<LookupOutcome<Work[]>> {
  const q = new URLSearchParams({ ...common(opts), term: `${doi}[doi]`, retmax: '2' });
  const res = await http({ url: `${EUTILS}/esearch.fcgi?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const ids = (res.body as { esearchresult?: { idlist?: string[] } } | null)?.esearchresult?.idlist;
  if (!Array.isArray(ids)) return { ok: false, reason: 'error' };
  const r = await pubmedSummaries(http, ids, opts);
  return r.ok ? { ok: true, value: r.value.filter((w) => w.doi === doi.toLowerCase()) } : r;
}

/**
 * Search with a full PubMed query (the caller's words plus filter clauses),
 * then fetch the summaries. Unlike `pubmedSearchTitle`, the term is a real
 * query and keeps its syntax.
 */
export async function pubmedSearch(
  http: HttpClient,
  term: string,
  opts: PubmedOptions & { retmax?: number } = {},
): Promise<LookupOutcome<Work[]>> {
  const q = new URLSearchParams({
    ...common(opts),
    term,
    retmax: String(opts.retmax ?? 10),
    sort: 'relevance',
  });
  const res = await http({ url: `${EUTILS}/esearch.fcgi?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const ids = (res.body as { esearchresult?: { idlist?: string[] } } | null)?.esearchresult?.idlist;
  if (!Array.isArray(ids)) return { ok: false, reason: 'error' };
  return pubmedSummaries(http, ids, opts);
}
