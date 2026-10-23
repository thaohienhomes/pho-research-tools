import { describe, expect, it } from 'vitest';
import { classifyNotices, normalizeDoi, parseUpdatedBy, summaryNotice } from '../retractions';
import type { RetractionNotice } from '../types';

const correction: RetractionNotice = { type: 'correction', label: 'Correction', date: '2004-03-06', source: 'publisher', noticeDoi: '10.1016/s0140-6736(04)15715-2' };
const concern: RetractionNotice = { type: 'expression_of_concern', label: 'Expression of Concern', date: '2009-01-01', source: 'publisher' };
const retraction: RetractionNotice = { type: 'retraction', label: 'Retraction', date: '2010-02-06', source: 'retraction-watch', noticeDoi: '10.1016/s0140-6736(10)60175-4' };

describe('summaryNotice', () => {
  it('names the retraction when a correction comes first', () => {
    expect(summaryNotice([correction, retraction])).toBe(retraction);
  });
  it('names the retraction when an expression of concern comes first', () => {
    expect(summaryNotice([concern, retraction])).toBe(retraction);
  });
  it('names the correction when it is the only notice', () => {
    expect(summaryNotice([correction])).toBe(correction);
  });
  it('prefers an expression of concern over a correction', () => {
    expect(summaryNotice([correction, concern])).toBe(concern);
  });
  it('picks the newest of several retractions', () => {
    const later: RetractionNotice = { ...retraction, date: '2011-05-01', label: 'Partial retraction', type: 'partial_retraction' };
    expect(summaryNotice([retraction, later, correction])).toBe(later);
    expect(summaryNotice([later, retraction])).toBe(later);
  });
  it('treats an undated retraction as oldest but still above any correction', () => {
    const undated: RetractionNotice = { type: 'retraction', label: 'Retraction', source: 'pubmed' };
    expect(summaryNotice([correction, undated])).toBe(undated);
    expect(summaryNotice([undated, retraction])).toBe(retraction);
  });
  it('returns undefined for no notices and leaves the list untouched', () => {
    expect(summaryNotice([])).toBeUndefined();
    const list = [correction, concern, retraction];
    summaryNotice(list);
    expect(list).toEqual([correction, concern, retraction]);
  });
});

describe('normalizeDoi', () => {
  it('strips resolvers and prefixes and lowercases', () => {
    expect(normalizeDoi('https://doi.org/10.1016/S0140-6736(97)11096-0')).toBe('10.1016/s0140-6736(97)11096-0');
    expect(normalizeDoi('doi: 10.1038/nature14539.')).toBe('10.1038/nature14539');
    expect(normalizeDoi('not a doi')).toBeNull();
  });
});

describe('parseUpdatedBy: self-referencing updates', () => {
  it('ignores a "new version" that points at the paper itself, keeps an in-place retraction', () => {
    const self = '10.1371/journal.pmed.1004016';
    expect(
      parseUpdatedBy({
        DOI: self,
        'updated-by': [{ type: 'new_version', label: 'New version', DOI: self.toUpperCase(), source: 'publisher' }],
      }),
    ).toEqual([]);
    expect(
      classifyNotices(
        parseUpdatedBy({ DOI: self, 'updated-by': [{ type: 'retraction', label: 'Retraction', DOI: self, source: 'publisher' }] }),
      ),
    ).toBe('retracted');
    expect(
      parseUpdatedBy({ DOI: self, 'updated-by': [{ type: 'new_version', label: 'New version', DOI: '10.1/other', source: 'publisher' }] }),
    ).toHaveLength(1);
  });
});

describe('parseUpdatedBy / classifyNotices', () => {
  it('reads a retraction notice from updated-by', () => {
    const notices = parseUpdatedBy({
      'updated-by': [
        { DOI: '10.1016/s0140-6736(10)60175-4', type: 'retraction', label: 'Retraction', source: 'retraction-watch', updated: { 'date-parts': [[2010, 2, 6]] } },
      ],
    });
    expect(notices).toEqual([
      { type: 'retraction', label: 'Retraction', date: '2010-02-06', source: 'retraction-watch', noticeDoi: '10.1016/s0140-6736(10)60175-4' },
    ]);
    expect(classifyNotices(notices)).toBe('retracted');
  });
  it('ignores update-to (that is the notice pointing elsewhere)', () => {
    expect(parseUpdatedBy({ 'update-to': [{ type: 'retraction' }] })).toEqual([]);
  });
  it('treats a RETRACTED title as a retraction', () => {
    expect(classifyNotices([], 'RETRACTED: Something')).toBe('retracted');
  });
  it('distinguishes corrections from retractions', () => {
    expect(classifyNotices([{ type: 'correction', label: 'Erratum', source: 'publisher' }])).toBe('corrected');
    expect(classifyNotices([])).toBe('no_notice');
  });
});
