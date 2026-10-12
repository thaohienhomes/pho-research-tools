import { describe, expect, it } from 'vitest';
import { classifyNotices, normalizeDoi, parseUpdatedBy } from '../retractions';

describe('normalizeDoi', () => {
  it('strips resolvers and prefixes and lowercases', () => {
    expect(normalizeDoi('https://doi.org/10.1016/S0140-6736(97)11096-0')).toBe('10.1016/s0140-6736(97)11096-0');
    expect(normalizeDoi('doi: 10.1038/nature14539.')).toBe('10.1038/nature14539');
    expect(normalizeDoi('not a doi')).toBeNull();
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
