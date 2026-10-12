import { describe, it, expect } from 'vitest';
import { extractDOIs, normalizeDOI, isValidDOI } from '../doi-parser';

describe('normalizeDOI', () => {
  it('strips the wrappers people paste', () => {
    expect(normalizeDOI('https://doi.org/10.1111/BJU.16231')).toBe('10.1111/bju.16231');
    expect(normalizeDOI('http://dx.doi.org/10.1111/bju.16231')).toBe('10.1111/bju.16231');
    expect(normalizeDOI('doi: 10.1111/bju.16231')).toBe('10.1111/bju.16231');
  });

  it('strips trailing prose punctuation, brackets included', () => {
    // THE BUG THIS PREVENTS: a DOI pasted inside parentheses —
    // "(https://doi.org/10.1000/abc)" — kept its `)`, because the DOI character
    // class legitimately allows parentheses. CrossRef then answered 404 and the
    // user was told their DOI does not exist. Same rule as `normalizeDoi` in
    // @pho/research-engine's dedup, which already had it right.
    expect(normalizeDOI('10.1000/abc)')).toBe('10.1000/abc');
    expect(normalizeDOI('10.1000/abc]')).toBe('10.1000/abc');
    expect(normalizeDOI('10.1000/abc.')).toBe('10.1000/abc');
    expect(normalizeDOI('10.1000/abc,')).toBe('10.1000/abc');
  });
});

describe('extractDOIs', () => {
  it('pulls a DOI out of parenthesised prose without the bracket', () => {
    expect(extractDOIs('See the trial (https://doi.org/10.1000/abc) for detail.')).toEqual([
      '10.1000/abc',
    ]);
  });

  it('de-duplicates across spellings', () => {
    expect(extractDOIs('10.1000/ABC and https://doi.org/10.1000/abc')).toEqual(['10.1000/abc']);
  });

  it('returns [] when there is no DOI', () => {
    expect(extractDOIs('no identifier here')).toEqual([]);
  });
});

describe('isValidDOI', () => {
  it('accepts a real DOI and rejects a truncated prefix', () => {
    expect(isValidDOI('10.1097/WCO.0000000000001145')).toBe(true);
    // Real DOI prefixes carry 4 to 9 digits; `10.1/a` is not one.
    expect(isValidDOI('10.1/a')).toBe(false);
  });
});
