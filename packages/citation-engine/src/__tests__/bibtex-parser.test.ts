import { describe, it, expect } from 'vitest';
import { parseBibTeX } from '../bibtex-parser';

/** The references alone — most cases do not care about the skipped count. */
const refs = (src: string) => parseBibTeX(src).references;
import { formatBibTeX } from '../formatter';
import type { CitationMetadata } from '../types';

/**
 * The fixtures are shaped like real exports, not like the spec. Zotero quotes
 * with braces and wraps acronyms; EndNote quotes with `"`; PubMed emits `--`
 * page ranges. Each of those broke an earlier draft of the parser.
 */
const ZOTERO = `
@article{fraser2023stroke,
  author = {Fraser, Stuart and Pabst, Lisa and Smith, Fiona},
  title = {Stroke in the young: {A} review of {DNA} evidence},
  journal = {Current Opinion in Neurology},
  year = {2023},
  volume = {36},
  number = {2},
  pages = {131--139},
  doi = {10.1097/WCO.0000000000001145},
  url = {https://doi.org/10.1097/WCO.0000000000001145}
}
`;

describe('parseBibTeX', () => {
  it('reads a Zotero-style entry with every field the importer uses', () => {
    const [ref] = refs(ZOTERO);

    expect(ref).toBeDefined();
    expect(ref!.title).toBe('Stroke in the young: A review of DNA evidence');
    expect(ref!.journal).toBe('Current Opinion in Neurology');
    expect(ref!.year).toBe(2023);
    expect(ref!.volume).toBe('36');
    expect(ref!.issue).toBe('2');
    expect(ref!.doi).toBe('10.1097/WCO.0000000000001145');
    expect(ref!.type).toBe('article');
  });

  it('rejoins the BibTeX en-dash page range into a plain one', () => {
    // `131--139` renders as an en dash in LaTeX but must not reach a UI as two
    // hyphens, and must not be mistaken for a negative number downstream.
    expect(refs(ZOTERO)[0]!.pages).toBe('131-139');
  });

  it('splits authors on the top-level `and` and keeps family/given apart', () => {
    expect(refs(ZOTERO)[0]!.authors).toEqual([
      { given: 'Stuart', family: 'Fraser' },
      { given: 'Lisa', family: 'Pabst' },
      { given: 'Fiona', family: 'Smith' },
    ]);
  });

  it('does not split on an `and` inside a braced name', () => {
    const src = `@book{x, title={T}, author={{Rand and Sons Institute} and Tran, Minh}}`;
    expect(refs(src)[0]!.authors).toEqual([
      { given: '', family: 'Rand and Sons Institute' },
      { given: 'Minh', family: 'Tran' },
    ]);
  });

  it('reads `Given Family` authors, which is what people actually type', () => {
    const src = `@article{x, title={T}, author={Hien Thao Nguyen and Minh Tran}}`;
    expect(refs(src)[0]!.authors).toEqual([
      { given: 'Hien Thao', family: 'Nguyen' },
      { given: 'Minh', family: 'Tran' },
    ]);
  });

  it('drops the `others` marker instead of citing a person called Others', () => {
    const src = `@article{x, title={T}, author={Nguyen, Hien and others}}`;
    expect(refs(src)[0]!.authors).toEqual([{ given: 'Hien', family: 'Nguyen' }]);
  });

  it('accepts quote-delimited values (EndNote style)', () => {
    const src = `@article{x, title = "Ho Chi Minh City cohort", year = "2021"}`;
    const [ref] = refs(src);
    expect(ref!.title).toBe('Ho Chi Minh City cohort');
    expect(ref!.year).toBe(2021);
  });

  it('accepts bare unquoted values', () => {
    const src = `@article{x, title = {T}, year = 1998, volume = 12}`;
    const [ref] = refs(src);
    expect(ref!.year).toBe(1998);
    expect(ref!.volume).toBe('12');
  });

  it('keeps escaped specials and drops only decorative braces', () => {
    const src = `@article{x, title={Cost \\& benefit of {MRI} in 50\\% of cases}}`;
    expect(refs(src)[0]!.title).toBe('Cost & benefit of MRI in 50% of cases');
  });

  it('preserves a brace that was escaped to be literal', () => {
    const src = `@article{x, title={The set \\{a\\} matters}}`;
    expect(refs(src)[0]!.title).toBe('The set {a} matters');
  });

  it('composes Vietnamese diacritics to NFC', () => {
    // Some reference managers hand back decomposed marks. Everything downstream
    // (dedupe by title, DOI matching, the term overlay) assumes composed form,
    // so the parser is where the two forms have to converge. Written as escapes
    // because a literal combining mark is invisible in a diff.
    const composed = '\u0110\u1ed9t qu\u1ef5 \u1edf ng\u01b0\u1eddi tr\u1ebb';
    const decomposed = composed.normalize('NFD');
    const title = refs(`@article{x, title={${decomposed}}}`)[0]!.title;

    expect(decomposed).not.toBe(composed);
    expect(title).toBe(composed);
  });

  it('skips @comment/@string/@preamble blocks', () => {
    const src = `
@string{cn = {Current Opinion in Neurology}}
@comment{ignore me}
@article{x, title={Real}}
`;
    const parsed = refs(src);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.title).toBe('Real');
  });

  it('drops an untitled entry rather than inventing a placeholder', () => {
    const src = `@article{x, author={Nguyen, Hien}, year={2020}}`;
    expect(refs(src)).toEqual([]);
  });

  it('a malformed entry costs one entry, not the rest of the file', () => {
    // THE BUG THIS PREVENTS: `matchBrace` counts braces across the whole
    // remaining file, so one stray `{` in an abstract made it run to EOF and the
    // scanner gave up on the document. A 200-entry export with one typo imported
    // as ZERO references, and the UI then said "no references found" — which
    // reads as "your file was empty". Total silent loss from one character.
    const src = `
@article{one, title = {First good entry}, abstract = {We used the {Cochrane tool.}, year = {2020}}

@article{two, title = {Second good entry}, year = {2021}}
@article{three, title = {Third good entry}, year = {2022}}
`;
    const parsed = parseBibTeX(src);

    expect(parsed.references.map((r) => r.title)).toContain('Second good entry');
    expect(parsed.references.map((r) => r.title)).toContain('Third good entry');
    // And the loss is counted rather than absorbed.
    expect(parsed.skipped).toBeGreaterThan(0);
  });

  it('recovers when the very first entry is the malformed one', () => {
    const src = '@article{a, title = {Broken {\n@article{b, title = {Fine}}';
    expect(parseBibTeX(src).references.map((r) => r.title)).toEqual(['Fine']);
  });

  it('counts an untitled entry as skipped instead of losing it silently', () => {
    const parsed = parseBibTeX('@article{x, author={Nguyen, Hien}, year={2020}}');
    expect(parsed.references).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });

  it('reports zero skipped for a clean file', () => {
    expect(parseBibTeX(ZOTERO).skipped).toBe(0);
  });

  it('returns [] for input that is not BibTeX at all', () => {
    expect(refs('')).toEqual([]);
    expect(refs('https://doi.org/10.1000/xyz')).toEqual([]);
  });

  it('strips a doi.org wrapper so both readers hand back the same shape', () => {
    // Plenty of exports write `doi = {https://doi.org/10.x}`. Leaving the URL in
    // the field made a resolved record fail to match its own lookup result and
    // silently demote to unverified.
    const src = `@article{x, title={T}, doi={https://doi.org/10.1111/bju.16231}}`;
    expect(refs(src)[0]!.doi).toBe('10.1111/bju.16231');
  });

  it('maps @inproceedings booktitle into the journal slot', () => {
    const src = `@inproceedings{x, title={T}, booktitle={ICML 2026}}`;
    const [ref] = refs(src);
    expect(ref!.journal).toBe('ICML 2026');
    expect(ref!.type).toBe('inproceedings');
  });

  it('round-trips what formatBibTeX writes', () => {
    // The importer and the exporter are two halves of one promise: a user who
    // exports from Phở must be able to import it back without losing fields.
    const meta: CitationMetadata = {
      doi: '10.1111/bju.16231',
      title: 'Indocyanine green fluorescence-guided dissection',
      authors: [
        { given: 'Peng', family: 'Yuan' },
        { given: 'Yu', family: 'Xie' },
      ],
      journal: 'BJU International',
      year: 2023,
      volume: '133',
      issue: '4',
      pages: '442-450',
      url: 'https://doi.org/10.1111/bju.16231',
      type: 'journal-article',
      publisher: 'Wiley',
    };

    const [back] = refs(formatBibTeX(meta));

    expect(back!.title).toBe(meta.title);
    expect(back!.authors).toEqual(meta.authors);
    expect(back!.journal).toBe(meta.journal);
    expect(back!.year).toBe(meta.year);
    expect(back!.volume).toBe(meta.volume);
    expect(back!.issue).toBe(meta.issue);
    expect(back!.pages).toBe(meta.pages);
    expect(back!.publisher).toBe(meta.publisher);
    expect(back!.doi).toBe(meta.doi);
  });
});
