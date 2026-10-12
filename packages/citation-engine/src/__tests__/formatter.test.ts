/**
 * Formatter guards. Two of these cover real defects found on 2026-09-01:
 * APA printed the literal "https://doi.org/undefined" for a record with no
 * DOI, and Vancouver dropped the DOI entirely even though ICMJE asks for it.
 */
import { describe, it, expect } from 'vitest';

import { formatAPA, formatVancouver, formatAMA } from '../formatter';
import type { CitationMetadata } from '../types';

const meta = (over: Partial<CitationMetadata> = {}): CitationMetadata => ({
  doi: '10.1161/x',
  title: 'Metformin and cardiovascular outcomes',
  authors: [
    { given: 'Hoa Thi', family: 'Nguyen' },
    { given: 'Van Minh', family: 'Tran' },
  ],
  journal: 'Circulation',
  year: 2024,
  volume: '12',
  issue: '3',
  pages: '45-67',
  url: 'https://example.org/a',
  type: 'journal-article',
  ...over,
});

const manyAuthors = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ given: `G${i}`, family: `Fam${i}` }));

describe('formatAPA', () => {
  it('never prints "undefined" when the record has no DOI', () => {
    const out = formatAPA(meta({ doi: '' }));
    expect(out).not.toContain('undefined');
    expect(out).toContain('https://example.org/a');
  });

  it('prints nothing trailing when there is neither DOI nor url', () => {
    const out = formatAPA(meta({ doi: '', url: '' }));
    expect(out).not.toContain('undefined');
    expect(out.endsWith('.')).toBe(true);
  });
});

describe('formatVancouver', () => {
  it('includes the DOI, which ICMJE asks for', () => {
    expect(formatVancouver(meta())).toContain('doi:10.1161/x');
  });

  it('falls back to the url when there is no DOI', () => {
    const out = formatVancouver(meta({ doi: '' }));
    expect(out).toContain('https://example.org/a');
    expect(out).not.toContain('undefined');
  });

  it('keeps six authors before "et al." (ICMJE cutoff)', () => {
    expect(formatVancouver(meta({ authors: manyAuthors(7) }))).toContain('Fam5 G, et al.');
  });
});

describe('formatAMA', () => {
  it('builds Authors. Title. Journal. Year;Vol(Issue):Pages. doi:X', () => {
    expect(formatAMA(meta())).toBe(
      'Nguyen HT, Tran VM. Metformin and cardiovascular outcomes. Circulation. 2024;12(3):45-67. doi:10.1161/x',
    );
  });

  it('cuts to three authors past six — the AMA rule, not the ICMJE one', () => {
    const ama = formatAMA(meta({ authors: manyAuthors(7) }));
    expect(ama).toContain('Fam0 G, Fam1 G, Fam2 G, et al.');
    expect(ama).not.toContain('Fam3');
    // Same record under Vancouver keeps six — the cutoffs genuinely differ.
    expect(formatVancouver(meta({ authors: manyAuthors(7) }))).toContain('Fam5');
  });

  it('keeps six authors in full', () => {
    const ama = formatAMA(meta({ authors: manyAuthors(6) }));
    expect(ama).toContain('Fam5 G.');
    expect(ama).not.toContain('et al');
  });

  it('survives a record with no journal', () => {
    expect(formatAMA(meta({ journal: '' }))).toContain('2024.');
  });
});
