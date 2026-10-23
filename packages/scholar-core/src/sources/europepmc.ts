/**
 * Europe PMC: abstracts and publication types for PubMed records.
 *
 * PubMed's E-utilities serve abstracts only as XML, and the HttpClient seam
 * parses JSON. Europe PMC mirrors every PubMed record and returns the abstract,
 * the publication types and the citation count as JSON (`resultType=core`), so
 * it is used to hydrate PMIDs that PubMed already ranked. It is never the
 * ranking source itself: Europe PMC has no relevance sort.
 * https://europepmc.org/RestfulWebService — no key, "considerate use".
 */

import type { HttpClient } from '../http';
import type { LookupOutcome } from './crossref';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

/** Keep URLs short and one request per call: 25 ids is the cap of `findEvidence`. */
export const EUROPEPMC_MAX_IDS = 40;

interface EpmcRecord {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  pubYear?: string;
  abstractText?: string;
  citedByCount?: number;
  isOpenAccess?: string;
  journalInfo?: { yearOfPublication?: number; journal?: { title?: string; medlineAbbreviation?: string } };
  pubTypeList?: { pubType?: string[] | string };
}

export interface EpmcPaper {
  pmid: string;
  pmcid?: string;
  doi?: string;
  title: string;
  /** "Ding M, Bhupathiraju SN, Chen M" as Europe PMC writes it. */
  authorString?: string;
  year?: number;
  journal?: string;
  /** Plain text: tags removed, section headings kept as "CONCLUSIONS:" labels. */
  abstract?: string;
  pubTypes: string[];
  citedByCount?: number;
  isOpenAccess: boolean;
}

/**
 * Europe PMC abstracts carry markup: `<h4>Conclusions</h4>`, `<b>`, `<i>`,
 * `<sup>`. Headings become `CONCLUSIONS:` so a reader (and `conclusionOf`) can
 * still find the sections; everything else is unwrapped.
 */
export function cleanAbstract(raw: string): string {
  return raw
    .replace(/<h\d[^>]*>\s*([^<]+?)\s*:?\s*<\/h\d>/gi, (_m, h: string) => ` ${h.trim().toUpperCase()}: `)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function mapEpmc(r: EpmcRecord): EpmcPaper | null {
  if (!r.pmid || !r.title) return null;
  const pt = r.pubTypeList?.pubType;
  const year = r.journalInfo?.yearOfPublication ?? (r.pubYear ? Number(r.pubYear) : undefined);
  return {
    pmid: r.pmid,
    ...(r.pmcid ? { pmcid: r.pmcid } : {}),
    ...(r.doi ? { doi: r.doi.toLowerCase() } : {}),
    title: cleanAbstract(r.title).replace(/\.$/, ''),
    ...(r.authorString ? { authorString: r.authorString.replace(/\.$/, '') } : {}),
    ...(year && Number.isFinite(year) ? { year } : {}),
    ...(r.journalInfo?.journal?.title ? { journal: r.journalInfo.journal.title } : {}),
    ...(r.abstractText ? { abstract: cleanAbstract(r.abstractText) } : {}),
    pubTypes: Array.isArray(pt) ? pt : pt ? [pt] : [],
    ...(typeof r.citedByCount === 'number' ? { citedByCount: r.citedByCount } : {}),
    isOpenAccess: r.isOpenAccess === 'Y',
  };
}

/** Abstracts and publication types for a set of PMIDs, in one request. */
export async function europepmcByPmids(
  http: HttpClient,
  pmids: string[],
  opts: { contactEmail?: string } = {},
): Promise<LookupOutcome<EpmcPaper[]>> {
  const ids = [...new Set(pmids.filter((p) => /^\d+$/.test(p)))].slice(0, EUROPEPMC_MAX_IDS);
  if (ids.length === 0) return { ok: true, value: [] };
  const q = new URLSearchParams({
    query: `(${ids.map((id) => `EXT_ID:${id}`).join(' OR ')}) AND SRC:MED`,
    resultType: 'core',
    format: 'json',
    pageSize: String(ids.length),
  });
  if (opts.contactEmail) q.set('email', opts.contactEmail);
  const res = await http({ url: `${BASE}?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const body = res.body as { hitCount?: number; resultList?: { result?: EpmcRecord[] } } | null;
  // A rejected request comes back 200 with no hitCount (see research-engine's
  // europepmc adapter); reading that as "no records" would silently drop abstracts.
  if (typeof body?.hitCount !== 'number') return { ok: false, reason: 'error' };
  const papers = (body.resultList?.result ?? []).map(mapEpmc).filter((p): p is EpmcPaper => !!p);
  return { ok: true, value: papers };
}
