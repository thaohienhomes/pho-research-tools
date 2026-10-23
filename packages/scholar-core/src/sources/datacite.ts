/**
 * DataCite: the DOI registry behind Zenodo, Figshare, Dryad, Mendeley Data,
 * Harvard Dataverse and most institutional data repositories.
 *
 * Records carry the licence (`rightsList`, usually an SPDX id) and the paper
 * the data supports (`relatedIdentifiers`, `IsSupplementTo` a journal DOI), so
 * both the licence verdict and the "source paper" come from the depositor's
 * own metadata, not from a guess.
 * https://support.datacite.org/docs/api — no key, JSON:API.
 */

import type { HttpClient } from '../http';
import type { LookupOutcome } from './crossref';

export const DATACITE_BASE = 'https://api.datacite.org';

interface DcName {
  name?: string;
  givenName?: string;
  familyName?: string;
  nameType?: string;
}

interface DcRelated {
  relatedIdentifier?: string;
  relatedIdentifierType?: string;
  relationType?: string;
}

interface DcAttributes {
  doi?: string;
  titles?: { title?: string }[];
  creators?: DcName[];
  publisher?: string | { name?: string };
  publicationYear?: number | string;
  descriptions?: { description?: string; descriptionType?: string }[];
  rightsList?: { rights?: string; rightsUri?: string; rightsIdentifier?: string }[];
  relatedIdentifiers?: DcRelated[];
  sizes?: string[];
  formats?: string[];
  subjects?: { subject?: string }[];
  url?: string;
  version?: string;
  types?: { resourceTypeGeneral?: string; resourceType?: string };
  updated?: string;
}

export interface DataCiteName {
  family?: string;
  given?: string;
  /** Organisations and names DataCite could not split. */
  literal?: string;
}

export interface DataCiteRecord {
  doi: string;
  title: string;
  creators: DataCiteName[];
  publisher?: string;
  year?: number;
  description?: string;
  /** The first licence that names one (SPDX id or URL), verbatim. */
  rights?: string;
  /** `info:eu-repo/semantics/restrictedAccess` and the like. */
  restricted: boolean;
  /** Journal DOIs / PMIDs the depositor says this data supports. */
  papers: { doi?: string; pmid?: string; relation: string }[];
  /** DOI of the record this one is a version or copy of. */
  versionOf?: string;
  sizes: string[];
  formats: string[];
  subjects: string[];
  url?: string;
  version?: string;
}

/** Relations that point from data to the paper describing it. */
const PAPER_RELATIONS = new Set(['IsSupplementTo', 'IsDescribedBy', 'IsDocumentedBy']);
const VERSION_RELATIONS = new Set(['IsVersionOf', 'IsIdenticalTo']);

const FIELDS = [
  'doi',
  'titles',
  'creators',
  'publisher',
  'publicationYear',
  'descriptions',
  'rightsList',
  'relatedIdentifiers',
  'sizes',
  'formats',
  'subjects',
  'url',
  'version',
  'types',
].join(',');

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapName(n: DcName): DataCiteName | null {
  if (n.nameType !== 'Organizational' && n.familyName) {
    return { family: n.familyName, ...(n.givenName ? { given: n.givenName } : {}) };
  }
  const name = n.name?.trim();
  if (!name) return null;
  if (n.nameType !== 'Organizational') {
    const m = /^([^,]+),\s*(.+)$/.exec(name);
    if (m) return { family: m[1]!.trim(), given: m[2]!.trim() };
  }
  return { literal: name };
}

export function mapDataCite(a: DcAttributes): DataCiteRecord | null {
  const doi = a.doi?.toLowerCase();
  const title = a.titles?.find((t) => t.title)?.title?.trim();
  if (!doi || !title) return null;
  const rights = (a.rightsList ?? []).map((r) => r.rightsIdentifier || r.rightsUri || r.rights || '').filter(Boolean);
  const licence = rights.find((r) => !/^info:eu-repo\/semantics\//i.test(r));
  const restricted = rights.some((r) => /(restricted|closed|embargoed)Access/i.test(r));
  const papers: DataCiteRecord['papers'] = [];
  let versionOf: string | undefined;
  for (const r of a.relatedIdentifiers ?? []) {
    const id = r.relatedIdentifier?.trim();
    if (!id || !r.relationType) continue;
    const type = r.relatedIdentifierType?.toUpperCase();
    if (VERSION_RELATIONS.has(r.relationType) && type === 'DOI') versionOf ??= id.toLowerCase();
    if (!PAPER_RELATIONS.has(r.relationType)) continue;
    if (type === 'DOI') papers.push({ doi: id.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''), relation: r.relationType });
    else if (type === 'PMID' && /^\d+$/.test(id)) papers.push({ pmid: id, relation: r.relationType });
  }
  const abstract = a.descriptions?.find((d) => d.descriptionType === 'Abstract' && d.description)?.description;
  const year = Number(a.publicationYear);
  const publisher = typeof a.publisher === 'string' ? a.publisher : a.publisher?.name;
  return {
    doi,
    title: stripTags(title),
    creators: (a.creators ?? []).map(mapName).filter((n): n is DataCiteName => !!n),
    ...(publisher ? { publisher } : {}),
    ...(Number.isFinite(year) && year > 1000 ? { year } : {}),
    ...(abstract ? { description: stripTags(abstract) } : {}),
    ...(licence ? { rights: licence } : {}),
    restricted,
    papers,
    ...(versionOf && versionOf !== doi ? { versionOf } : {}),
    sizes: (a.sizes ?? []).filter((s) => typeof s === 'string'),
    formats: (a.formats ?? []).filter((s) => typeof s === 'string'),
    subjects: (a.subjects ?? []).map((s) => s.subject ?? '').filter(Boolean),
    ...(a.url ? { url: a.url } : {}),
    ...(a.version ? { version: a.version } : {}),
  };
}

/** Datasets matching a free-text query, most relevant first. */
export async function dataciteSearchDatasets(
  http: HttpClient,
  query: string,
  opts: { pageSize?: number } = {},
): Promise<LookupOutcome<DataCiteRecord[]>> {
  const q = new URLSearchParams({
    query,
    'resource-type-id': 'dataset',
    'page[size]': String(opts.pageSize ?? 25),
    'fields[dois]': FIELDS,
  });
  const res = await http({ url: `${DATACITE_BASE}/dois?${q.toString()}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const data = (res.body as { data?: { attributes?: DcAttributes }[] } | null)?.data;
  if (!Array.isArray(data)) return { ok: false, reason: 'error' };
  return { ok: true, value: data.map((d) => (d.attributes ? mapDataCite(d.attributes) : null)).filter((r): r is DataCiteRecord => !!r) };
}

/** One DOI's DataCite record (arXiv preprints are DataCite DOIs). */
export async function dataciteGetDoi(http: HttpClient, doi: string): Promise<LookupOutcome<DataCiteRecord>> {
  const res = await http({ url: `${DATACITE_BASE}/dois/${encodeURIComponent(doi.toLowerCase())}?fields[dois]=${FIELDS}` });
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const a = (res.body as { data?: { attributes?: DcAttributes } } | null)?.data?.attributes;
  const rec = a ? mapDataCite(a) : null;
  return rec ? { ok: true, value: rec } : { ok: false, reason: 'error' };
}
