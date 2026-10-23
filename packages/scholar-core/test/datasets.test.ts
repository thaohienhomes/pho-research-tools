/**
 * findDatasets against recorded DataCite / NCBI GEO / Hugging Face / Crossref
 * responses.
 *
 * The bar: the TNBC thesis question from the spec gets at least one dataset
 * whose source paper checks out; a nonsense question gets an empty brief; and
 * no identifier appears in a result unless a database response contained it.
 */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findDatasets, type DatasetQuery, type DatasetsResult } from '../src/datasets';
import { createFetchHttp, type HttpClient } from '../src/http';
import { openCassette } from './support/cassette';

const LIVE = process.env.SCHOLAR_LIVE === '1';
const contactEmail = process.env.SCHOLAR_CONTACT_EMAIL || undefined;
const cassette = openCassette(join(__dirname, 'fixtures', 'cassettes-datasets'), { contactEmail });
const inner = LIVE ? createFetchHttp({ contactEmail, timeoutMs: 20_000 }) : cassette.http;

/** Everything the databases said, to check that no identifier was made up. */
let seen = '';
const http: HttpClient = async (req) => {
  const res = await inner(req);
  seen += `${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}\n`.toLowerCase();
  return res;
};

export const DATASET_QUESTIONS: { id: string; q: DatasetQuery }[] = [
  {
    id: 'tnbc-thesis',
    q: {
      question:
        "I'm writing my master's thesis on gene expression in triple-negative breast cancer. Is there open data I can use and cite?",
      intendedUse: 'thesis',
    },
  },
  {
    id: 'tnbc-keywords',
    q: { question: 'TNBC expression data', keywords: 'triple negative breast cancer RNA-seq', domain: 'genomics' },
  },
  {
    id: 'lung-single-cell',
    q: { question: 'single-cell RNA-seq atlas of the human lung', domain: 'biology', maxResults: 5 },
  },
  {
    id: 'cryo-et',
    q: { question: 'cryo-electron tomography of ribosomes in cells', domain: 'biology' },
  },
  {
    id: 'protein-models',
    q: { question: 'protein structure prediction', domain: 'biology', includeModels: true, intendedUse: 'commercial' },
  },
  {
    id: 'climate',
    q: { question: 'global surface air temperature reanalysis', domain: 'earth_science' },
  },
  { id: 'nonsense', q: { question: 'zxqv blorf glimmering unicorn telemetry of quasar marmalade' } },
];

const runs = new Map<string, DatasetsResult>();

describe('findDatasets on real repositories', () => {
  afterAll(() => cassette.save());

  it(
    'answers every question',
    async () => {
      for (const { id, q } of DATASET_QUESTIONS) {
        const r = await findDatasets(q, { http, contactEmail });
        runs.set(id, r);
        console.log(
          `${id}: ${r.results.length} results from ${r.stats.sourcesScanned} candidates; ` +
            `${r.lookups.map((l) => `${l.source} ${l.ok ? l.hits : 'failed'}`).join(', ')}\n` +
            r.results
              .map(
                (d) =>
                  `  ${d.rank}. [${d.match}] ${d.source} ${d.id} rel=${d.relevance} licence=${d.licence.verdict} paper=${d.paper.status} — ${d.title.slice(0, 80)}`,
              )
              .join('\n'),
        );
      }
      cassette.save();
      if (!LIVE) expect(cassette.misses, 'requests with no recording — run the record workflow').toEqual([]);
    },
    30 * 60_000,
  );

  it('finds citable data with a verified paper for the TNBC thesis question', () => {
    const r = runs.get('tnbc-thesis')!;
    expect(r.status).toBe('ok');
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    expect(r.results.some((d) => d.paper.status === 'verified')).toBe(true);
    for (const d of r.results) {
      expect(d.licence.verdict).toBeTruthy();
      expect(d.citation.length).toBeGreaterThan(20);
      expect(d.loadSnippet.length).toBeGreaterThan(10);
    }
  });

  it('returns an honest empty brief for a nonsense question', () => {
    const r = runs.get('nonsense')!;
    expect(r.results).toEqual([]);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });

  it('never shows an identifier that no database returned', () => {
    for (const [id, r] of runs) {
      for (const d of r.results) {
        for (const ident of [d.paper.doi, d.paper.pmid, d.paper.arxiv, d.datasetDoi]) {
          if (ident) expect(seen.includes(ident.toLowerCase()), `${id}: ${ident}`).toBe(true);
        }
        expect(d.relevance, `${id}: ${d.id}`).toBeGreaterThanOrEqual(0.5);
        if (['retracted', 'correction', 'concern'].includes(d.paper.status)) expect(d.match).not.toBe('best');
      }
    }
  });

  it('demotes anything not cleared for commercial use when the use is commercial', () => {
    for (const d of runs.get('protein-models')!.results) {
      if (!['ok_publication_commercial', 'ok_share_alike'].includes(d.licence.verdict)) expect(d.match).toBe('use_with_care');
    }
  });
});
