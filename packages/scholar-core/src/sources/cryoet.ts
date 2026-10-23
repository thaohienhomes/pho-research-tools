/**
 * CZ CryoET Data Portal datasets, through its public GraphQL API.
 *
 * The portal publishes cryo-electron tomography data (tilt series,
 * tomograms, annotations) under CC0. Each dataset lists the DOIs of the papers
 * that describe it in `datasetPublications` and related archive entries
 * (EMPIAR, EMDB) in `relatedDatabaseEntries`; those are the only paper links
 * used.
 *
 * GraphQL has no OR across fields, so one request asks three questions under
 * aliases (title, description, organism) with the same case-insensitive
 * pattern, and the caller ranks the union locally. The pattern is passed as a
 * variable, never pasted into the query text.
 */

import type { HttpClient } from '../http';
import type { LookupOutcome } from './crossref';

export const CRYOET_GRAPHQL_URL = 'https://graphql.cryoetdataportal.czscience.com/graphql';
export const CRYOET_LICENCE = 'CC0-1.0';
const PER_FIELD = 10;
const MAX_TERMS = 4;

const FIELDS =
  'id title description organismName tissueName cellName cellComponentName sampleType releaseDate datasetPublications relatedDatabaseEntries fileSize';

export const CRYOET_QUERY =
  `query Datasets($p: String!, $n: Int!) {` +
  ` byTitle: datasets(where: {title: {_iregex: $p}}, limitOffset: {limit: $n}) { ${FIELDS} }` +
  ` byDescription: datasets(where: {description: {_iregex: $p}}, limitOffset: {limit: $n}) { ${FIELDS} }` +
  ` byOrganism: datasets(where: {organismName: {_iregex: $p}}, limitOffset: {limit: $n}) { ${FIELDS} }` +
  ` }`;

interface CryoetDoc {
  id?: number;
  title?: string;
  description?: string;
  organismName?: string | null;
  tissueName?: string | null;
  cellName?: string | null;
  cellComponentName?: string | null;
  sampleType?: string | null;
  releaseDate?: string;
  datasetPublications?: string | null;
  relatedDatabaseEntries?: string | null;
  fileSize?: number | null;
}

export interface CryoetDataset {
  id: number;
  /** `CZCDP-10000`: the identifier the portal asks you to cite. */
  accession: string;
  url: string;
  title: string;
  description?: string;
  organism?: string;
  tissue?: string;
  cell?: string;
  cellComponent?: string;
  sampleType?: string;
  year?: number;
  /** Paper DOIs the portal lists for this dataset. */
  paperDois: string[];
  /** EMPIAR / EMDB / PDB entries the portal lists. */
  relatedEntries: string[];
  fileSizeBytes?: number;
}

const DOI_RE = /10\.\d{4,9}\/[^\s,;"<>]+/g;

export function mapCryoet(d: CryoetDoc): CryoetDataset | null {
  if (typeof d.id !== 'number' || !Number.isInteger(d.id) || d.id <= 0 || !d.title) return null;
  const year = Number(/^(\d{4})/.exec(d.releaseDate ?? '')?.[1]);
  const str = (v: string | null | undefined) => (v && v.trim() ? v.trim() : undefined);
  const dois = [...new Set((d.datasetPublications ?? '').match(DOI_RE) ?? [])].map((x) =>
    x.replace(/[.)\]]+$/, ''),
  );
  const related = (d.relatedDatabaseEntries ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^(EMPIAR-\d+|EMD-\d+|PDB-\w+|\d\w{3})$/i.test(s));
  const organism = str(d.organismName);
  const tissue = str(d.tissueName);
  const cell = str(d.cellName);
  const cellComponent = str(d.cellComponentName);
  const sampleType = str(d.sampleType);
  const description = str(d.description);
  return {
    id: d.id,
    accession: `CZCDP-${d.id}`,
    url: `https://cryoetdataportal.czscience.com/datasets/${d.id}`,
    title: d.title.trim(),
    ...(description ? { description } : {}),
    ...(organism ? { organism } : {}),
    ...(tissue ? { tissue } : {}),
    ...(cell ? { cell } : {}),
    ...(cellComponent ? { cellComponent } : {}),
    ...(sampleType ? { sampleType } : {}),
    ...(Number.isFinite(year) && year > 2000 ? { year } : {}),
    paperDois: dois,
    relatedEntries: related,
    ...(typeof d.fileSize === 'number' && d.fileSize > 0 ? { fileSizeBytes: d.fileSize } : {}),
  };
}

/** A case-insensitive "any of these words" pattern, made only of letters, digits and hyphens. */
export function cryoetPattern(terms: string[]): string | undefined {
  const words = [
    ...new Set(
      terms.map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter((t) => t.length >= 3),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_TERMS);
  return words.length ? `(${words.join('|')})` : undefined;
}

/** Datasets whose title, description or organism mentions any of the terms. */
export async function cryoetSearchDatasets(
  http: HttpClient,
  terms: string[],
  opts: { perField?: number } = {},
): Promise<LookupOutcome<CryoetDataset[]>> {
  const p = cryoetPattern(terms);
  if (!p) return { ok: true, value: [] };
  const res = await http({
    url: CRYOET_GRAPHQL_URL,
    body: JSON.stringify({ query: CRYOET_QUERY, variables: { p, n: opts.perField ?? PER_FIELD } }),
  });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const body = res.body as {
    data?: Record<string, CryoetDoc[] | null> | null;
    errors?: unknown[];
  } | null;
  if (!body?.data || (Array.isArray(body.errors) && body.errors.length > 0))
    return { ok: false, reason: 'error' };
  const seen = new Set<number>();
  const out: CryoetDataset[] = [];
  for (const list of [body.data.byTitle, body.data.byDescription, body.data.byOrganism]) {
    for (const d of list ?? []) {
      const m = mapCryoet(d);
      if (m && !seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
  }
  return { ok: true, value: out };
}
