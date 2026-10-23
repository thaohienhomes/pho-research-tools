/**
 * NCBI GEO (Gene Expression Omnibus) series, through E-utilities `db=gds`.
 *
 * GEO is where most published gene-expression data lives, and every series
 * lists the PubMed ids of the papers that describe it (`pubmedids`), so the
 * "source paper" link is NCBI's own. Only series (GSE) are searched: they are
 * what a paper cites and what `GEOparse` / `GEOquery` load.
 */

import type { HttpClient } from '../http';
import type { LookupOutcome } from './crossref';
import type { PubmedOptions } from './pubmed';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

interface GdsDoc {
  uid?: string;
  accession?: string;
  title?: string;
  summary?: string;
  taxon?: string;
  entrytype?: string;
  gdstype?: string;
  pdat?: string;
  suppfile?: string;
  n_samples?: number | string;
  pubmedids?: (string | number)[];
}

export interface GeoSeries {
  accession: string;
  title: string;
  summary?: string;
  organism?: string;
  /** "Expression profiling by array; Expression profiling by high throughput sequencing" */
  studyType?: string;
  year?: number;
  /** Supplementary file types as GEO lists them: "CEL, TXT". */
  suppFiles: string[];
  nSamples?: number;
  pmids: string[];
}

function common(opts: PubmedOptions): Record<string, string> {
  const p: Record<string, string> = { db: 'gds', retmode: 'json', tool: 'pho-scholar' };
  if (opts.apiKey) p.api_key = opts.apiKey;
  if (opts.contactEmail) p.email = opts.contactEmail;
  return p;
}

export function mapGds(d: GdsDoc): GeoSeries | null {
  const accession = d.accession?.trim();
  if (!accession || !/^GSE\d+$/.test(accession) || !d.title) return null;
  const year = Number(/^(\d{4})/.exec(d.pdat ?? '')?.[1]);
  const n = Number(d.n_samples);
  return {
    accession,
    title: d.title.trim(),
    ...(d.summary ? { summary: d.summary.trim() } : {}),
    ...(d.taxon ? { organism: d.taxon } : {}),
    ...(d.gdstype ? { studyType: d.gdstype } : {}),
    ...(Number.isFinite(year) && year > 1990 ? { year } : {}),
    suppFiles: (d.suppfile ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(Number.isFinite(n) && n > 0 ? { nSamples: n } : {}),
    pmids: (d.pubmedids ?? []).map(String).filter((p) => /^\d+$/.test(p)),
  };
}

/** GEO series for a keyword query, most relevant first. */
export async function geoSearchSeries(
  http: HttpClient,
  terms: string,
  opts: PubmedOptions & { retmax?: number } = {},
): Promise<LookupOutcome<GeoSeries[]>> {
  const q = new URLSearchParams({
    ...common(opts),
    term: `(${terms}) AND gse[ETYP]`,
    retmax: String(opts.retmax ?? 12),
    sort: 'relevance',
  });
  const search = await http({ url: `${EUTILS}/esearch.fcgi?${q.toString()}` });
  if (search.status === 429) return { ok: false, reason: 'rate_limited' };
  if (search.status !== 200) return { ok: false, reason: 'error' };
  const ids = (search.body as { esearchresult?: { idlist?: string[] } } | null)?.esearchresult?.idlist;
  if (!Array.isArray(ids)) return { ok: false, reason: 'error' };
  if (ids.length === 0) return { ok: true, value: [] };
  const s = new URLSearchParams({ ...common(opts), id: ids.join(',') });
  const res = await http({ url: `${EUTILS}/esummary.fcgi?${s.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const result = (res.body as { result?: Record<string, unknown> } | null)?.result;
  if (!result) return { ok: false, reason: 'error' };
  return {
    ok: true,
    value: ids.map((id) => mapGds((result[id] ?? {}) as GdsDoc)).filter((g): g is GeoSeries => !!g),
  };
}
