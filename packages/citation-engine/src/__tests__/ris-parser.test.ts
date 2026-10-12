import { describe, it, expect } from 'vitest';
import { parseRIS } from '../ris-parser';

/** The references alone — most cases do not care about the skipped count. */
const refs = (src: string) => parseRIS(src).references;

/** Shaped like a PubMed "Send to → Citation manager" download. */
const PUBMED = [
  'TY  - JOUR',
  'AU  - Fraser, Stuart',
  'AU  - Pabst, Lisa',
  'TI  - Stroke in the young',
  'JO  - Current Opinion in Neurology',
  'PY  - 2023',
  'VL  - 36',
  'IS  - 2',
  'SP  - 131',
  'EP  - 139',
  'DO  - 10.1097/WCO.0000000000001145',
  'AB  - The purpose of this review is to review recent findings',
  'ER  - ',
].join('\n');

describe('parseRIS', () => {
  it('reads a PubMed-style record with every field the importer uses', () => {
    const [ref] = refs(PUBMED);

    expect(ref).toBeDefined();
    expect(ref!.title).toBe('Stroke in the young');
    expect(ref!.journal).toBe('Current Opinion in Neurology');
    expect(ref!.year).toBe(2023);
    expect(ref!.volume).toBe('36');
    expect(ref!.issue).toBe('2');
    expect(ref!.doi).toBe('10.1097/WCO.0000000000001145');
    expect(ref!.type).toBe('jour');
    expect(ref!.authors).toEqual([
      { given: 'Stuart', family: 'Fraser' },
      { given: 'Lisa', family: 'Pabst' },
    ]);
  });

  it('rejoins SP and EP into one page range', () => {
    expect(refs(PUBMED)[0]!.pages).toBe('131-139');
  });

  it('keeps a lone SP when there is no EP', () => {
    expect(refs('TY  - JOUR\nTI  - T\nSP  - e0123456\nER  -')[0]!.pages).toBe('e0123456');
  });

  it('joins continuation lines so a wrapped abstract is not truncated', () => {
    // This is the failure that matters most: the abstract is the whole reason
    // the import path is useful for a paywalled paper, and exporters wrap it.
    const src = [
      'TY  - JOUR',
      'TI  - T',
      'AB  - Children with congenital or acquired cardiac disease are at',
      'increased risk for both ischemic and hemorrhagic stroke. This review',
      'covers epidemiology and outcomes.',
      'ER  -',
    ].join('\n');

    expect(refs(src)[0]!.abstract).toBe(
      'Children with congenital or acquired cardiac disease are at increased risk ' +
        'for both ischemic and hemorrhagic stroke. This review covers epidemiology and outcomes.',
    );
  });

  it('reads several records from one file', () => {
    const src = `${PUBMED}\n\nTY  - JOUR\nTI  - Second paper\nPY  - 2024\nER  -\n`;
    expect(refs(src).map((r) => r.title)).toEqual(['Stroke in the young', 'Second paper']);
  });

  it('handles CRLF line endings', () => {
    expect(refs(PUBMED.replace(/\n/g, '\r\n'))[0]!.title).toBe('Stroke in the young');
  });

  it('accepts the one-space separator some exporters emit', () => {
    expect(refs('TY - JOUR\nTI - Loose\nER -')[0]!.title).toBe('Loose');
  });

  it('does not read medical prose in a wrapped abstract as a tag', () => {
    // THE BUG THIS PREVENTS. The tag pattern used to allow zero spaces before
    // the hyphen, so a continuation line beginning `ER-positive` hit the `ER`
    // branch and TERMINATED the record — throwing away the DOI and URL that came
    // after it. `T2-weighted` was worse: it landed in the journal aliases and put
    // "weighted images were obtained" on the card as the journal name, which is a
    // fabricated venue rather than a mere truncation.
    const src = [
      'TY  - JOUR',
      'TI  - Endocrine therapy in breast cancer',
      'AB  - We reviewed 400 patients treated between 2015 and 2020.',
      'ER-positive tumours were the majority of the cohort.',
      'T2-weighted images were obtained in all cases.',
      'IL-6 was elevated in 30% of them.',
      'DO  - 10.1000/real',
      'UR  - https://example.org/a',
      'ER  - ',
    ].join('\n');

    const [ref] = refs(src);

    expect(ref!.doi).toBe('10.1000/real');
    expect(ref!.url).toBe('https://example.org/a');
    expect(ref!.journal).toBeUndefined();
    expect(ref!.abstract).toContain('ER-positive tumours');
    expect(ref!.abstract).toContain('IL-6 was elevated');
  });

  it('ignores a two-letter token that is not a real RIS tag', () => {
    const src = 'TY  - JOUR\nTI  - T\nAB  - Line one.\nZZ  - not a tag, prose.\nER  -';
    expect(refs(src)[0]!.abstract).toBe('Line one. ZZ  - not a tag, prose.');
  });

  it('keeps editors (A2-A4) out of the author list', () => {
    // A2/A3/A4 are secondary contributors. Folding them into `authors` puts an
    // editor's name in the citation as if they wrote the paper.
    const src = 'TY  - JOUR\nTI  - T\nAU  - Fraser, Stuart\nA2  - Editor, Jane\nER  -';
    expect(refs(src)[0]!.authors).toEqual([{ given: 'Stuart', family: 'Fraser' }]);
  });

  it('counts an untitled record as skipped', () => {
    const parsed = parseRIS('TY  - JOUR\nAU  - Nguyen, Hien\nER  -');
    expect(parsed.references).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });

  it('strips a doi.org wrapper from DO so the value is a bare DOI', () => {
    const src = 'TY  - JOUR\nTI  - T\nDO  - https://doi.org/10.1111/bju.16231\nER  -';
    expect(refs(src)[0]!.doi).toBe('10.1111/bju.16231');
  });

  it('falls back through the journal tag aliases', () => {
    expect(refs('TY  - JOUR\nTI  - T\nT2  - Journal of Endourology\nER  -')[0]!.journal).toBe(
      'Journal of Endourology',
    );
  });

  it('takes the year out of a full date', () => {
    expect(refs('TY  - JOUR\nTI  - T\nY1  - 2024/08/01\nER  -')[0]!.year).toBe(2024);
  });

  it('emits a trailing record whose ER is missing', () => {
    // Truncated downloads are common; the records before the cut are still good.
    const src = 'TY  - JOUR\nTI  - First\nER  -\nTY  - JOUR\nTI  - Truncated\nPY  - 2020';
    expect(refs(src).map((r) => r.title)).toEqual(['First', 'Truncated']);
  });

  it('does not merge two records when the first forgets its ER', () => {
    const src = 'TY  - JOUR\nTI  - First\nTY  - JOUR\nTI  - Second\nER  -';
    expect(refs(src).map((r) => r.title)).toEqual(['First', 'Second']);
  });

  it('drops an untitled record rather than inventing a placeholder', () => {
    expect(refs('TY  - JOUR\nAU  - Nguyen, Hien\nPY  - 2020\nER  -')).toEqual([]);
  });

  it('composes Vietnamese diacritics to NFC', () => {
    const composed = 'Đột quỵ ở người trẻ';
    const src = `TY  - JOUR\nTI  - ${composed.normalize('NFD')}\nER  -`;
    expect(refs(src)[0]!.title).toBe(composed);
  });

  it('returns [] for input that is not RIS at all', () => {
    expect(refs('')).toEqual([]);
    expect(refs('just some prose about stroke')).toEqual([]);
  });
});
