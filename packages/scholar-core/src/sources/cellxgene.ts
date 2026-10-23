/**
 * CZ CELLxGENE Discover collections, through the public Curation API.
 *
 * CELLxGENE holds curated single-cell datasets (H5AD, the same schema across
 * every dataset), grouped in collections that each come from one study. The
 * API has no search endpoint: one request returns every public collection,
 * and the caller ranks them locally. That response is large but changes a few
 * times a week, so the server caches it for a day.
 *
 * The paper link is the collection's own `doi` field, written by CELLxGENE's
 * curators, never inferred. Cell-type labels are not read: they run to
 * hundreds per collection and the description already names the cell types
 * a study is about. Every dataset on CELLxGENE Discover is published
 * under CC BY 4.0.
 */

import type { HttpClient } from '../http';
import type { LookupOutcome } from './crossref';

export const CELLXGENE_COLLECTIONS_URL =
  'https://api.cellxgene.cziscience.com/curation/v1/collections?visibility=PUBLIC';
export const CELLXGENE_LICENCE = 'CC-BY-4.0';

interface Labelled {
  label?: string;
}

interface CxgDataset {
  dataset_id?: string;
  title?: string;
  cell_count?: number;
  organism?: Labelled[];
  tissue?: Labelled[];
  disease?: Labelled[];
  assay?: Labelled[];
}

interface CxgAuthor {
  family?: string;
  given?: string;
  name?: string;
}

interface CxgCollection {
  collection_id?: string;
  collection_url?: string;
  name?: string;
  description?: string;
  doi?: string | null;
  consortia?: string[];
  published_at?: string;
  publisher_metadata?: {
    authors?: CxgAuthor[];
    journal?: string;
    published_year?: number;
    is_preprint?: boolean;
  } | null;
  datasets?: CxgDataset[];
}

export interface CellxgeneCollection {
  id: string;
  url: string;
  name: string;
  description?: string;
  /** The study's paper, as CELLxGENE's curators recorded it. */
  doi?: string;
  journal?: string;
  isPreprint: boolean;
  authors: { family?: string; given?: string; literal?: string }[];
  /** Year the collection was published on CELLxGENE. */
  year?: number;
  consortia: string[];
  organisms: string[];
  tissues: string[];
  diseases: string[];
  assays: string[];
  datasetIds: string[];
  /** Sum of the datasets' cell counts, only when every dataset states one. */
  cellCount?: number;
}

function labels(ds: CxgDataset[], key: 'organism' | 'tissue' | 'disease' | 'assay'): string[] {
  const out = new Set<string>();
  for (const d of ds) for (const x of d[key] ?? []) if (x?.label) out.add(x.label);
  return [...out];
}

export function mapCollection(c: CxgCollection): CellxgeneCollection | null {
  const id = c.collection_id?.trim();
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !c.name) return null;
  const ds = Array.isArray(c.datasets) ? c.datasets : [];
  const year = Number(/^(\d{4})/.exec(c.published_at ?? '')?.[1]);
  const doi = c.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  const counts = ds.map((d) => d.cell_count);
  const cellCount =
    ds.length > 0 && counts.every((n) => typeof n === 'number' && n > 0)
      ? counts.reduce<number>((a, n) => a + (n as number), 0)
      : undefined;
  const pm = c.publisher_metadata ?? undefined;
  return {
    id,
    // Built from the validated id, never copied: the URL is pasted into a
    // code snippet, where a newline in an upstream string would become code.
    url: `https://cellxgene.cziscience.com/collections/${id}`,
    name: c.name.trim(),
    ...(c.description ? { description: c.description.trim() } : {}),
    ...(doi && /^10\.\d{4,9}\//.test(doi) ? { doi } : {}),
    ...(pm?.journal ? { journal: pm.journal } : {}),
    isPreprint: pm?.is_preprint === true,
    authors: (pm?.authors ?? [])
      .map((a) =>
        a.family
          ? { family: a.family, ...(a.given ? { given: a.given } : {}) }
          : { literal: a.name ?? '' },
      )
      .filter((a) => ('literal' in a ? !!a.literal : true)),
    ...(Number.isFinite(year) && year > 2000 ? { year } : {}),
    consortia: Array.isArray(c.consortia) ? c.consortia : [],
    organisms: labels(ds, 'organism'),
    tissues: labels(ds, 'tissue'),
    diseases: labels(ds, 'disease'),
    assays: labels(ds, 'assay'),
    datasetIds: ds
      .map((d) => d.dataset_id)
      .filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)),
    ...(cellCount ? { cellCount } : {}),
  };
}

/** Every public CELLxGENE collection. Ranking is the caller's job. */
export async function cellxgeneCollections(
  http: HttpClient,
): Promise<LookupOutcome<CellxgeneCollection[]>> {
  const res = await http({ url: CELLXGENE_COLLECTIONS_URL });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200 || !Array.isArray(res.body)) return { ok: false, reason: 'error' };
  return {
    ok: true,
    value: (res.body as CxgCollection[])
      .map(mapCollection)
      .filter((c): c is CellxgeneCollection => !!c),
  };
}
