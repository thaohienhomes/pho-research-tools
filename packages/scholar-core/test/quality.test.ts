/**
 * Quality bar for `verifyCitations` (brief §3), measured on the real pipeline
 * with recorded responses:
 *   - fabricated references detected            ≥ 95%
 *   - real, correct references not flagged      ≥ 97%
 *   - retracted references detected             100%
 *
 * "Flagged" means the result tells the user the reference is bad or unknown:
 * likely_fabricated, not_found, ambiguous or retracted. A correct reference
 * reported as `verified_with_corrections` is not a false alarm about its
 * existence, but it is noise, so its rate is printed separately.
 *
 * The confusion matrix is printed on every run so CI logs show it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFetchHttp } from '../src/http';
import type { VerificationResult, VerificationStatus } from '../src/types';
import { verifyReferences } from '../src/verify';
import { openCassette } from './support/cassette';

interface Fixture {
  id: string;
  category: 'correct' | 'injected' | 'fabricated' | 'retracted';
  style: string;
  input: string;
  expect: { status: VerificationStatus[]; mismatch?: string; injected?: string };
  note?: string;
}

const FIXTURES = join(__dirname, 'fixtures');
const data = JSON.parse(readFileSync(join(FIXTURES, 'references.json'), 'utf8')) as
  | Fixture[]
  | { references: Fixture[] };
const fixtures: Fixture[] = Array.isArray(data) ? data : data.references;

const LIVE = process.env.SCHOLAR_LIVE === '1';
const contactEmail = process.env.SCHOLAR_CONTACT_EMAIL || undefined;
const cassette = openCassette(join(FIXTURES, 'cassettes'), { contactEmail });
const http = LIVE ? createFetchHttp({ contactEmail, timeoutMs: 20_000 }) : cassette.http;

const STATUSES: VerificationStatus[] = [
  'verified',
  'verified_with_corrections',
  'retracted',
  'ambiguous',
  'not_found',
  'likely_fabricated',
];
const FLAGGED = new Set<VerificationStatus>(['likely_fabricated', 'not_found', 'ambiguous', 'retracted']);

const results = new Map<string, VerificationResult>();

describe('verifyCitations quality bar', () => {
  afterAll(() => cassette.save());

  it(
    'runs every fixture',
    async () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(60);
      // Sequential so recordings are deterministic and polite to the APIs.
      for (const f of fixtures) {
        const [r] = await verifyReferences(f.input, { http, contactEmail, concurrency: 1 });
        expect(r, `${f.id} parsed to no reference`).toBeDefined();
        results.set(f.id, r!);
      }
      cassette.save();
      printReport();
      if (!LIVE) expect(cassette.misses, 'requests with no recording — run the record workflow').toEqual([]);
    },
    30 * 60_000,
  );

  it('detects ≥95% of fabricated references', () => {
    const fab = fixtures.filter((f) => f.category === 'fabricated');
    const hit = fab.filter((f) => results.get(f.id)?.status === 'likely_fabricated');
    expect(hit.length / fab.length).toBeGreaterThanOrEqual(0.95);
  });

  it('does not flag ≥97% of real, correct references', () => {
    const ok = fixtures.filter((f) => f.category === 'correct');
    const clean = ok.filter((f) => !FLAGGED.has(results.get(f.id)!.status));
    expect(clean.length / ok.length).toBeGreaterThanOrEqual(0.97);
  });

  it('detects 100% of retracted references', () => {
    for (const f of fixtures.filter((x) => x.category === 'retracted')) {
      expect(results.get(f.id)?.status, f.id).toBe('retracted');
    }
  });

  it('reports the injected error on the right field', () => {
    for (const f of fixtures.filter((x) => x.category === 'injected')) {
      const r = results.get(f.id)!;
      expect(r.status, `${f.id}: ${r.summary}`).toBe('verified_with_corrections');
      if (f.expect.mismatch) {
        expect(r.mismatches.map((m) => m.field), f.id).toContain(f.expect.mismatch);
      }
    }
  });

  it('never invents metadata: every match carries a source identifier', () => {
    for (const r of results.values()) {
      if (r.match) expect(r.match.doi || r.match.pmid || r.match.openalexId, String(r.index)).toBeTruthy();
    }
  });
});

function printReport() {
  const cats = ['correct', 'injected', 'fabricated', 'retracted'] as const;
  const rows = cats.map((c) => {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<VerificationStatus, number>;
    for (const f of fixtures.filter((x) => x.category === c)) counts[results.get(f.id)!.status]++;
    return { category: c, ...counts };
  });
  const lines = [
    '',
    'Confusion matrix (rows = fixture category, columns = returned status)',
    ['category'.padEnd(11), ...STATUSES.map((s) => s.slice(0, 14).padStart(15))].join(''),
    ...rows.map((r) =>
      [r.category.padEnd(11), ...STATUSES.map((s) => String(r[s]).padStart(15))].join(''),
    ),
  ];
  const ok = fixtures.filter((f) => f.category === 'correct');
  const corrected = ok.filter((f) => results.get(f.id)!.status === 'verified_with_corrections').length;
  lines.push(`correct refs reported with corrections (noise, not a failure): ${corrected}/${ok.length}`);
  const wrong = fixtures.filter((f) => !f.expect.status.includes(results.get(f.id)!.status));
  if (wrong.length) {
    lines.push('', 'Fixtures not matching their expected status:');
    for (const f of wrong) {
      const r = results.get(f.id)!;
      lines.push(`  ${f.id} expected ${f.expect.status.join('|')} got ${r.status} (title ${r.titleScore.toFixed(2)}): ${r.summary}`);
    }
  }
  console.log(lines.join('\n'));
}
