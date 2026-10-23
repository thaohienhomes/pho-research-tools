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

  // Nature-style conference papers (FAHR-Face, Lancet Digit Health 2026): the
  // whole string used to become the title, so the DOI record's real title
  // never matched and 11 real papers came back as "likely fabricated".
  it('reads a Nature-style conference reference', () => {
    const [r] = parseReferences(
      'Rothe, R., Timofte, R. & Van Gool, L. DEX: Deep EXpectation of apparent age from a single image. in 2015 IEEE International Conference on Computer Vision Workshop (ICCVW) (IEEE, 2015). doi:10.1109/iccvw.2015.41.',
    );
    expect(r).toMatchObject({
      title: 'DEX: Deep EXpectation of apparent age from a single image',
      journal: '2015 IEEE International Conference on Computer Vision Workshop (ICCVW)',
      year: 2015,
      doi: '10.1109/iccvw.2015.41',
    });
    expect(r!.authors[0]).toMatchObject({ family: 'Rothe' });
  });

  it('ends a Nature-style author list at the last initial after "&"', () => {
    const [r] = parseReferences(
      'Han, H., Otto, C. & Jain, A. K. Age estimation from face images: Human vs. machine performance. in 2013 International Conference on Biometrics (ICB) (IEEE, 2013).',
    );
    expect(r!.title).toBe('Age estimation from face images: Human vs. machine performance');
  });

  it('keeps a question mark that ends the title before the venue', () => {
    const [r] = parseReferences(
      'Rathgeb, C., Dogan, D. & Busch, C. Plastic Surgery: An Obstacle for Deep Face Recognition? in 2020 IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops (CVPRW) (IEEE, 2020).',
    );
    expect(r!.title).toBe('Plastic Surgery: An Obstacle for Deep Face Recognition?');
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

  it('reads a JSON array of strings as one reference per element', () => {
    const refs = parseReferences(
      JSON.stringify(['10.1038/nature14539', '', 'LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521:436-44.']),
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ index: 0, doi: '10.1038/nature14539' });
    expect(refs[1]).toMatchObject({ index: 1, year: 2015 });
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
