/**
 * findEvidence against recorded PubMed / Europe PMC / OpenAlex responses.
 *
 * The bar: every paper is real (PMID or DOI), the strongest designs come
 * first, and most papers carry an abstract conclusion a reader can quote.
 */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findEvidence, EVIDENCE_LEVELS, type EvidenceResult } from '../src/evidence';
import { createFetchHttp } from '../src/http';
import { openCassette } from './support/cassette';

const LIVE = process.env.SCHOLAR_LIVE === '1';
const contactEmail = process.env.SCHOLAR_CONTACT_EMAIL || undefined;
const cassette = openCassette(join(__dirname, 'fixtures', 'cassettes-evidence'), { contactEmail });
const http = LIVE ? createFetchHttp({ contactEmail, timeoutMs: 20_000 }) : cassette.http;

export const EVIDENCE_CLAIMS: { id: string; claim: string; query?: string }[] = [
  {
    id: 'coffee-diabetes',
    claim: 'Drinking coffee reduces the risk of type 2 diabetes.',
    query: 'coffee consumption type 2 diabetes risk',
  },
  {
    id: 'vitd-fracture',
    claim: 'Vitamin D supplements prevent fractures in older adults.',
    query: 'vitamin D supplementation fracture prevention older adults',
  },
  {
    id: 'ivermectin-covid',
    claim: 'Ivermectin is an effective treatment for COVID-19.',
    query: 'ivermectin COVID-19 treatment',
  },
  { id: 'no-query', claim: 'Does metformin lower cancer risk in people with diabetes?' },
];

const runs = new Map<string, EvidenceResult>();

describe('findEvidence on real databases', () => {
  afterAll(() => cassette.save());

  it(
    'answers every claim',
    async () => {
      for (const c of EVIDENCE_CLAIMS) {
        const r = await findEvidence(c.claim, { ...(c.query ? { query: c.query } : {}) }, { http, contactEmail });
        runs.set(c.id, r);
        console.log(
          `${c.id}: ${r.papers.length} papers ${JSON.stringify(r.byLevel)}; ${r.withoutAbstract} without abstract; excluded ${JSON.stringify(r.excluded)}; ${r.lookups.map((l) => `${l.source} ${l.ok ? l.hits : 'failed'}`).join(', ')}`,
        );
      }
      cassette.save();
      if (!LIVE) expect(cassette.misses, 'requests with no recording — run the record workflow').toEqual([]);
    },
    30 * 60_000,
  );

  it('returns real, unique, ranked papers', () => {
    for (const [id, r] of runs) {
      expect(r.status, id).toBe('ok');
      expect(
        r.lookups.every((l) => l.ok),
        id,
      ).toBe(true);
      expect(r.papers.length, id).toBeGreaterThanOrEqual(5);
      const keys = new Set<string>();
      let prev = -1;
      for (const p of r.papers) {
        expect(p.pmid || p.doi, id).toBeTruthy();
        const k = p.pmid ? `p:${p.pmid}` : `d:${p.doi}`;
        expect(keys.has(k), `${id} ${k}`).toBe(false);
        keys.add(k);
        const lv = EVIDENCE_LEVELS.indexOf(p.level);
        expect(lv, id).toBeGreaterThanOrEqual(prev);
        prev = lv;
      }
    }
  });

  it('finds syntheses for well-studied claims and quotes their conclusions', () => {
    for (const id of ['coffee-diabetes', 'vitd-fracture', 'ivermectin-covid']) {
      const r = runs.get(id)!;
      const top = r.papers.slice(0, 5);
      expect(
        top.some((p) => ['meta-analysis', 'systematic-review', 'guideline'].includes(p.level)),
        id,
      ).toBe(true);
      const withConclusion = r.papers.filter((p) => p.conclusion).length;
      expect(withConclusion / r.papers.length, id).toBeGreaterThanOrEqual(0.6);
    }
  });
});
