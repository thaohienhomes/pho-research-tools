import { describe, expect, it } from 'vitest';
import { journalMatches, pagesMatch, parsePages, stripStatusPrefix, titleSimilarity } from '../text';

describe('titleSimilarity', () => {
  it('is 1 for the same title modulo case and punctuation', () => {
    expect(titleSimilarity('Deep Learning.', 'deep learning')).toBe(1);
  });
  it('accepts a cited title without its subtitle', () => {
    expect(
      titleSimilarity(
        'The PRISMA 2020 statement',
        'The PRISMA 2020 statement: an updated guideline for reporting systematic reviews',
      ),
    ).toBeGreaterThan(0.88);
  });
  it('scores unrelated titles low', () => {
    expect(titleSimilarity('Deep learning', 'Prospect theory: an analysis of decision under risk')).toBeLessThan(0.4);
  });
});

describe('stripStatusPrefix', () => {
  it('drops a RETRACTED: prefix', () => {
    expect(stripStatusPrefix('RETRACTED: Ileal-lymphoid-nodular hyperplasia')).toBe('Ileal-lymphoid-nodular hyperplasia');
  });
});

describe('journalMatches', () => {
  it('matches an abbreviation to the full name', () => {
    expect(journalMatches('N Engl J Med', 'The New England Journal of Medicine')).toBe(true);
    expect(journalMatches('Brief Bioinform', 'Briefings in Bioinformatics')).toBe(true);
  });
  it('does not match a different journal of the same family', () => {
    expect(journalMatches('Nature', 'Nature Medicine')).toBe(false);
    expect(journalMatches('Bioinformatics', 'Briefings in Bioinformatics')).toBe(false);
  });
});

describe('pages', () => {
  it('expands abbreviated page ranges', () => {
    expect(parsePages('436-44')).toEqual({ start: '436', end: '444' });
  });
  it('compares start and end pages', () => {
    expect(pagesMatch('436-44', '436-444')).toBe(true);
    expect(pagesMatch('437-444', '436-444')).toBe(false);
    expect(pagesMatch('e124', 'e124')).toBe(true);
  });
});
