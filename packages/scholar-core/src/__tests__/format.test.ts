import { describe, expect, it } from 'vitest';
import { CITATION_STYLES, formatCitations } from '../format';
import { CSL_STYLES } from '../csl-styles.generated';
import { parseReferences } from '../parse';
import type { VerificationResult, Work } from '../types';

const lecun: Work = {
  source: 'crossref',
  title: 'Deep learning',
  authors: [
    { family: 'LeCun', given: 'Yann' },
    { family: 'Bengio', given: 'Yoshua' },
    { family: 'Hinton', given: 'Geoffrey' },
  ],
  years: [2015],
  journals: ['Nature'],
  volume: '521',
  issue: '7553',
  pages: '436-444',
  doi: '10.1038/nature14539',
  type: 'journal-article',
  notices: [],
};

const pubmedWork: Work = {
  source: 'pubmed',
  title: 'Respiratory syncytial virus infection',
  authors: [{ family: 'Drysdale', given: 'SB' }, { family: 'Pollard', given: 'AJ' }],
  years: [2020],
  journals: ['The New England journal of medicine', 'N Engl J Med'],
  volume: '383',
  pages: '1-10',
  pmid: '12345678',
  notices: [],
};

function result(over: Partial<VerificationResult> & Pick<VerificationResult, 'status'>): VerificationResult {
  const [input] = parseReferences(
    'LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2016;521(7553):436-444.',
  );
  return {
    index: 0,
    input: input!,
    confidence: 0.9,
    summary: '',
    mismatches: [],
    links: {},
    titleScore: 1,
    lookups: [],
    ...over,
  };
}

describe('formatCitations', () => {
  it('embeds all seven official styles', () => {
    expect(CITATION_STYLES.sort()).toEqual(['ama', 'apa', 'chicago', 'harvard', 'ieee', 'mla', 'vancouver']);
    for (const s of Object.values(CSL_STYLES)) {
      expect(s.xml).toContain('<style');
      expect(s.xml).not.toContain('independent-parent');
    }
  });

  it.each([
    ['apa', 'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539', '(LeCun et al., 2015)'],
    ['mla', 'LeCun, Yann, et al. “Deep Learning.” Nature, vol. 521, no. 7553, 2015, pp. 436–44, https://doi.org/10.1038/nature14539.', '(LeCun et al.)'],
    ['chicago', 'LeCun, Yann, Yoshua Bengio, and Geoffrey Hinton. 2015. “Deep Learning.” Nature 521 (7553): 436–44. https://doi.org/10.1038/nature14539.', '(LeCun et al. 2015)'],
    ['harvard', 'LeCun, Y., Bengio, Y. and Hinton, G. (2015) “Deep learning,” Nature, 521(7553), pp. 436–444. Available at: https://doi.org/10.1038/nature14539.', '(LeCun, Bengio and Hinton, 2015)'],
    ['vancouver', '1. LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521(7553):436–44. doi:10.1038/nature14539', '(1)'],
    ['ieee', '[1] Y. LeCun, Y. Bengio, and G. Hinton, “Deep learning,” Nature, vol. 521, no. 7553, pp. 436–444, 2015, doi: 10.1038/nature14539.', '[1]'],
    ['ama', '1. LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521(7553):436-444. doi:10.1038/nature14539', '1'],
  ] as const)('%s matches the official style', (style, bib, cite) => {
    const r = formatCitations([lecun], style);
    expect(r.entries[0]!.bibliography).toBe(bib);
    expect(r.entries[0]!.inText).toBe(cite);
    expect(r.content).toBe(bib);
    expect(r.entries[0]!.verified).toBe(true);
  });

  it('numbers numeric styles by input order and sorts author-date styles alphabetically', () => {
    const v = formatCitations([pubmedWork, lecun], 'vancouver');
    expect(v.entries.map((e) => e.inText)).toEqual(['(1)', '(2)']);
    expect(v.content.split('\n')[0]).toMatch(/^1\. Drysdale/);
    const apa = formatCitations([pubmedWork, lecun], 'apa');
    expect(apa.content.split('\n')[0]).toMatch(/^Drysdale/);
    expect(apa.entries[1]!.inText).toBe('(LeCun et al., 2015)');
  });

  it('expands PubMed initials and uses the journal abbreviation where the style wants it', () => {
    expect(formatCitations([pubmedWork], 'apa').content).toMatch(/^Drysdale, S\. B\., & Pollard, A\. J\./);
    expect(formatCitations([pubmedWork], 'vancouver').content).toContain('N Engl J Med.');
  });

  it('formats a verified result from the matched record, keeping the cited year when the record allows it', () => {
    const corrected = formatCitations(
      [result({ status: 'verified_with_corrections', match: lecun, mismatches: [{ field: 'year', cited: '2016', found: '2015' }] })],
      'apa',
    );
    expect(corrected.entries[0]!.bibliography).toContain('(2015)');
    expect(corrected.entries[0]!.source).toBe('record');
    expect(corrected.warnings[0]).toContain('corrected: year');

    const twoYears = { ...lecun, years: [2015, 2016] };
    expect(formatCitations([result({ status: 'verified', match: twoYears })], 'apa').content).toContain('(2016)');
  });

  it('never formats an unverified reference from a guessed record', () => {
    const r = formatCitations([result({ status: 'likely_fabricated', match: lecun })], 'apa');
    expect(r.entries[0]!.source).toBe('as-cited');
    expect(r.entries[0]!.verified).toBe(false);
    expect(r.entries[0]!.bibliography).toContain('(2016)');
    expect(r.warnings[0]).toMatch(/Not verified \(likely fabricated\)/);
  });

  it('flags retracted papers', () => {
    const retracted = formatCitations([result({ status: 'retracted', match: lecun })], 'apa');
    expect(retracted.entries[0]!.retracted).toBe(true);
    expect(retracted.warnings[0]).toMatch(/retracted/);
  });

  it('exports BibTeX, RIS and CSL-JSON', () => {
    const bib = formatCitations([lecun], 'apa', 'bibtex').content;
    expect(bib).toMatch(/^@article\{LeCun2015/);
    expect(bib).toContain('doi = {10.1038/nature14539}');
    const ris = formatCitations([lecun], 'apa', 'ris').content;
    expect(ris).toMatch(/^TY {2}- JOUR/);
    expect(ris).toContain('DO  - 10.1038/nature14539');
    const json = JSON.parse(formatCitations([lecun], 'apa', 'csl-json').content);
    expect(json[0]).toMatchObject({ type: 'article-journal', DOI: '10.1038/nature14539' });
  });

  it('renders HTML with superscript in-text citations for AMA', () => {
    const r = formatCitations([lecun], 'ama', 'html');
    expect(r.content).toContain('<div class="csl-bib-body">');
    expect(r.entries[0]!.inText).toBe('<sup>1</sup>');
  });

  it('round-trips a pasted BibTeX entry as cited, marked unverified', () => {
    const refs = parseReferences('@article{x, title={A study}, author={Nguyen, An}, year={2021}, journal={J Test}}');
    const r = formatCitations(refs, 'apa');
    expect(r.content).toBe('Nguyen, A. (2021). A study. J Test.');
    expect(r.entries[0]!.verified).toBe(false);
  });

  it('handles an empty list and rejects unknown styles', () => {
    expect(formatCitations([], 'apa').content).toBe('');
    expect(() => formatCitations([lecun], 'turabian' as never)).toThrow(/Unknown citation style/);
  });
});
