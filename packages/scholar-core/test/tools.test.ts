/**
 * findTools against recorded bio.tools / GitHub / Crossref responses.
 *
 * The bar: a single-cell clustering question returns tools whose paper checks
 * out and whose install line comes from a registry link; a nonsense question
 * gets an empty brief; no identifier or command appears unless a database
 * response contained the link it was built from.
 */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFetchHttp, type HttpClient } from '../src/http';
import { findTools, type ToolQuery, type ToolsResult } from '../src/tools';
import { openCassette } from './support/cassette';

const LIVE = process.env.SCHOLAR_LIVE === '1';
const contactEmail = process.env.SCHOLAR_CONTACT_EMAIL || undefined;
const cassette = openCassette(join(__dirname, 'fixtures', 'cassettes-tools'), { contactEmail });
const inner = LIVE ? createFetchHttp({ contactEmail, timeoutMs: 20_000 }) : cassette.http;

/** Everything the databases said, to check that nothing was made up. */
let seen = '';
const http: HttpClient = async (req) => {
  const res = await inner(req);
  seen += `${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}\n`.toLowerCase();
  return res;
};

/** The clock is fixed so the maintenance labels in the recordings stay stable. */
const now = new Date('2026-10-09T00:00:00Z');

export const TOOL_QUESTIONS: { id: string; q: ToolQuery }[] = [
  {
    id: 'sc-clustering',
    q: { question: 'cluster single-cell RNA-seq data', inputFormat: 'H5AD', maxResults: 5 },
  },
  { id: 'scrna-short', q: { question: 'scRNA-seq clustering' } },
  { id: 'variant-calling', q: { question: 'call variants from whole-genome sequencing reads' } },
  { id: 'cryo-em', q: { question: 'cryo-EM particle picking', intendedUse: 'commercial' } },
  { id: 'nonsense', q: { question: 'zxqv blorf glimmering unicorn telemetry of quasar marmalade' } },
];

const runs = new Map<string, ToolsResult>();

describe('findTools on the real registry', () => {
  afterAll(() => cassette.save());

  it(
    'answers every question',
    async () => {
      for (const { id, q } of TOOL_QUESTIONS) {
        const r = await findTools(q, { http, contactEmail, now });
        runs.set(id, r);
        console.log(
          `${id}: ${r.results.length} results from ${r.stats.candidates} candidates; ` +
            `${r.lookups.map((l) => `${l.source} ${l.ok ? l.hits : 'failed'}`).join(', ')}\n` +
            r.results
              .map(
                (t) =>
                  `  ${t.rank}. [${t.match}] ${t.id} rel=${t.relevance} licence=${t.licence.verdict} paper=${t.paper.status} health=${t.health.label} install=${t.install?.line ?? '-'}`,
              )
              .join('\n'),
        );
      }
      cassette.save();
      if (!LIVE) expect(cassette.misses, 'requests with no recording — run the record workflow').toEqual([]);
    },
    30 * 60_000,
  );

  it('finds clustering tools for single-cell data with a checked paper', () => {
    const r = runs.get('sc-clustering')!;
    expect(r.status).toBe('ok');
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    expect(r.results.some((t) => t.paper.status === 'verified')).toBe(true);
  });

  it('does not rank imaging tools for a short scRNA-seq question', () => {
    const r = runs.get('scrna-short')!;
    expect(r.results.map((t) => t.id.toLowerCase())).not.toContain('spacr');
  });

  it('returns an honest empty brief for a nonsense question', () => {
    const r = runs.get('nonsense')!;
    expect(r.results).toEqual([]);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });

  it('never shows an identifier or link that no database returned', () => {
    for (const [id, r] of runs) {
      for (const t of r.results) {
        expect(t.relevance, `${id}: ${t.id}`).toBeGreaterThanOrEqual(0.5);
        expect(seen.includes(t.id.toLowerCase()), `${id}: ${t.id}`).toBe(true);
        if (t.paper.doi) expect(seen.includes(t.paper.doi.toLowerCase()), `${id}: ${t.paper.doi}`).toBe(true);
        if (t.install) expect(seen.includes(t.install.from.toLowerCase().replace(/^https?:\/\//, '')), `${id}: ${t.install.from}`).toBe(true);
        if (['retracted', 'correction', 'concern'].includes(t.paper.status)) expect(t.match).not.toBe('best');
        if (t.health.label === 'archived') expect(t.match).toBe('use_with_care');
      }
    }
  });

  it('demotes anything not cleared for commercial use when the use is commercial', () => {
    for (const t of runs.get('cryo-em')!.results) {
      if (!['ok_publication_commercial', 'ok_share_alike'].includes(t.licence.verdict)) expect(t.match).toBe('use_with_care');
    }
  });
});
