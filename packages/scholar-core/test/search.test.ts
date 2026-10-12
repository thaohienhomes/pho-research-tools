/**
 * searchPapers against recorded OpenAlex / PubMed / doi.org responses.
 *
 * The brief's bar for search is "every result must carry a resolvable DOI or
 * PMID". Format is not enough for a DOI, so every returned DOI is resolved
 * through the doi.org handle API; PMIDs come straight from PubMed's own index.
 */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFetchHttp } from '../src/http';
import { searchPapers, type SearchResult } from '../src/search';
import { doiRegistration } from '../src/sources/doi-handle';
import { openCassette } from './support/cassette';
import { SEARCH_QUERIES } from './support/search-queries';

const LIVE = process.env.SCHOLAR_LIVE === '1';
const contactEmail = process.env.SCHOLAR_CONTACT_EMAIL || undefined;
const cassette = openCassette(join(__dirname, 'fixtures', 'cassettes-search'), { contactEmail });
const http = LIVE ? createFetchHttp({ contactEmail, timeoutMs: 20_000 }) : cassette.http;

const runs = new Map<string, SearchResult>();

describe('searchPapers on real databases', () => {
  afterAll(() => cassette.save());

  it(
    'runs every query and resolves every DOI',
    async () => {
      const unresolved: string[] = [];
      for (const q of SEARCH_QUERIES) {
        const r = await searchPapers(q.query, q.filters, { http, contactEmail });
        runs.set(q.id, r);
        for (const p of r.results) {
          if (p.doi && (await doiRegistration(http, p.doi)) !== 'registered') unresolved.push(`${q.id}: ${p.doi}`);
        }
        console.log(
          `${q.id}: ${r.results.length} results (${r.lookups.map((l) => `${l.source} ${l.ok ? l.hits : 'failed'}`).join(', ')}); excluded ${JSON.stringify(r.excluded)}`,
        );
      }
      cassette.save();
      if (!LIVE) expect(cassette.misses, 'requests with no recording — run the record workflow').toEqual([]);
      expect(unresolved).toEqual([]);
    },
    30 * 60_000,
  );

  it('answers every query from both sources', () => {
    for (const q of SEARCH_QUERIES) {
      const r = runs.get(q.id)!;
      expect(r.status, q.id).toBe('ok');
      expect(r.lookups.every((l) => l.ok), q.id).toBe(true);
      expect(r.results.length, q.id).toBeGreaterThan(0);
      expect(r.results.length, q.id).toBeLessThanOrEqual(q.filters.maxResults ?? 10);
    }
  });

  it('gives every result a DOI or PMID and never repeats a paper', () => {
    for (const r of runs.values()) {
      const ids = new Set<string>();
      for (const p of r.results) {
        expect(p.doi || p.pmid).toBeTruthy();
        if (p.doi) expect(p.doi).toMatch(/^10\.\d{4,9}\/\S+$/);
        if (p.pmid) expect(p.pmid).toMatch(/^\d+$/);
        for (const k of [p.doi && `d:${p.doi}`, p.pmid && `p:${p.pmid}`]) {
          if (!k) continue;
          expect(ids.has(k), k).toBe(false);
          ids.add(k);
        }
        expect(p.retracted).toBe(false);
      }
    }
  });

  it('applies year, open-access and study-type filters', () => {
    for (const p of runs.get('sepsis-years')!.results) {
      if (p.year) expect(p.year).toBeGreaterThanOrEqual(2018);
      if (p.year) expect(p.year).toBeLessThanOrEqual(2024);
    }
    const af = runs.get('af-rct-oa')!.results;
    expect(af.every((p) => p.openAccess.isOa)).toBe(true);
    expect(af.filter((p) => p.foundIn.includes('pubmed')).every((p) => p.studyTypeMatch === 'publication-type')).toBe(true);
  });
});
