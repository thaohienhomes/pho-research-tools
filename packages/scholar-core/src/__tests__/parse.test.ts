import { describe, expect, it } from 'vitest';
import { parseReferences, splitReferenceList, stripIdentifiers } from '../parse';

describe('splitReferenceList', () => {
  it('splits a numbered list and joins wrapped lines', () => {
    const list = '1. Smith J. A title. Nature. 2020;1:1-2.\n2. Doe A. Another title\ncontinued. Science. 2019;2:3.';
    const parts = splitReferenceList(list);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain('continued');
  });
  it('falls back to one reference per line', () => {
    expect(splitReferenceList('10.1038/nature14539\n10.1136/bmj.n71')).toHaveLength(2);
  });
});

describe('parseReferences', () => {
  it('reads a Vancouver reference', () => {
    const [r] = parseReferences(
      'LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521(7553):436-444. doi:10.1038/nature14539',
    );
    expect(r).toMatchObject({ title: 'Deep learning', year: 2015, doi: '10.1038/nature14539', volume: '521' });
    expect(r!.authors[0]).toMatchObject({ family: 'LeCun' });
  });

  it('reads an APA reference', () => {
    const [r] = parseReferences(
      'Kahneman, D., & Tversky, A. (1979). Prospect theory: An analysis of decision under risk. Econometrica, 47(2), 263–291.',
    );
    expect(r).toMatchObject({ year: 1979, title: 'Prospect theory: An analysis of decision under risk' });
    expect(r!.authors.map((a) => a.family)).toEqual(['Kahneman', 'Tversky']);
  });

  it('reads an MLA reference with the inverted first author', () => {
    const [r] = parseReferences(
      'Watson, James D., and Francis H. C. Crick. "Molecular Structure of Nucleic Acids." Nature, vol. 171, no. 4356, 1953, pp. 737-738.',
    );
    expect(r!.title).toBe('Molecular Structure of Nucleic Acids');
    expect(r!.authors[0]).toMatchObject({ family: 'Watson' });
    expect(r!.year).toBe(1953);
  });

  it('reads BibTeX and RIS', () => {
    const [b] = parseReferences('@article{x, title={Deep learning}, author={LeCun, Yann and Bengio, Yoshua}, year={2015}, doi={10.1038/nature14539}}');
    expect(b).toMatchObject({ format: 'bibtex', title: 'Deep learning', year: 2015, doi: '10.1038/nature14539' });
    const [r] = parseReferences('TY  - JOUR\nTI  - Deep learning\nAU  - LeCun, Yann\nPY  - 2015\nDO  - 10.1038/nature14539\nER  -');
    expect(r).toMatchObject({ format: 'ris', title: 'Deep learning', year: 2015 });
  });

  it('reads a bare DOI list', () => {
    const refs = parseReferences('https://doi.org/10.1038/NATURE14539\ndoi:10.1136/bmj.n71');
    expect(refs.map((r) => r.doi)).toEqual(['10.1038/nature14539', '10.1136/bmj.n71']);
  });

  it('never invents a field', () => {
    const [r] = parseReferences('Some words that are not a reference at all');
    expect(r!.doi).toBeUndefined();
    expect(r!.year).toBeUndefined();
  });
});

describe('stripIdentifiers', () => {
  it('removes DOIs, URLs and PMIDs', () => {
    expect(stripIdentifiers('Title. 2020. doi:10.1234/x PMID: 123456 https://example.org/a')).toBe('Title. 2020.');
  });
});

describe('hostile input', () => {
  it('parses a long run of name-like text in linear time', () => {
    const evil = `${'Aa-'.repeat(5000)}!, ${'A. '.repeat(3000)}x`;
    const t = performance.now();
    parseReferences(evil);
    parseReferences(`${'Ab Cd '.repeat(20_000)}`);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
