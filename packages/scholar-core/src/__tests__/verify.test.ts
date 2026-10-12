import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpResponse } from '../http';
import { verifyReferences } from '../verify';

/** A Crossref /works/{doi} envelope for the LeCun 2015 record. */
function lecun(extra: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    'message-type': 'work',
    message: {
      DOI: '10.1038/nature14539',
      title: ['Deep learning'],
      author: [
        { family: 'LeCun', given: 'Yann' },
        { family: 'Bengio', given: 'Yoshua' },
        { family: 'Hinton', given: 'Geoffrey' },
      ],
      'container-title': ['Nature'],
      issued: { 'date-parts': [[2015, 5, 27]] },
      'published-print': { 'date-parts': [[2015, 5, 28]] },
      volume: '521',
      issue: '7553',
      page: '436-444',
      type: 'journal-article',
      ...extra,
    },
  };
}

/** Routes by URL prefix; anything unrouted answers an empty result, never a network error. */
function fakeHttp(routes: [RegExp, HttpResponse][]): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async ({ url }) => {
    calls.push(url);
    for (const [re, res] of routes) if (re.test(decodeURIComponent(url))) return res;
    if (url.includes('api.crossref.org/works?')) return { status: 200, body: { message: { items: [] } } };
    if (url.includes('esearch.fcgi')) return { status: 200, body: { esearchresult: { idlist: [] } } };
    if (url.includes('api.openalex.org')) return { status: 200, body: { results: [] } };
    return { status: 404, body: null };
  }) as HttpClient & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('verifyReferences', () => {
  it('verifies a correct reference by its DOI without searching', async () => {
    const http = fakeHttp([[/works\/10\.1038\/nature14539/, { status: 200, body: lecun() }]]);
    const [r] = await verifyReferences(
      'LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521(7553):436-444. doi:10.1038/nature14539',
      { http },
    );
    expect(r!.status).toBe('verified');
    expect(r!.mismatches).toEqual([]);
    expect(r!.match?.doi).toBe('10.1038/nature14539');
    expect(http.calls.some((u) => u.includes('works?'))).toBe(false);
  });

  it('reports a wrong year as a correction, with the value it found', async () => {
    const http = fakeHttp([[/works\/10\.1038\/nature14539/, { status: 200, body: lecun() }]]);
    const [r] = await verifyReferences(
      'LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2012;521(7553):436-444. doi:10.1038/nature14539',
      { http },
    );
    expect(r!.status).toBe('verified_with_corrections');
    expect(r!.mismatches).toContainEqual(expect.objectContaining({ field: 'year', cited: '2012' }));
  });

  it('flags a retraction from updated-by', async () => {
    const body = lecun({
      'updated-by': [{ DOI: '10.1/notice', type: 'retraction', label: 'Retraction', source: 'retraction-watch' }],
    });
    const http = fakeHttp([[/works\/10\.1038\/nature14539/, { status: 200, body }]]);
    const [r] = await verifyReferences('doi:10.1038/nature14539', { http });
    expect(r!.status).toBe('retracted');
    expect(r!.retraction?.notices[0]?.noticeDoi).toBe('10.1/notice');
  });

  it('dates the retraction by its retraction notice, not an earlier correction', async () => {
    const body = lecun({
      'updated-by': [
        { DOI: '10.1/corr', type: 'correction', label: 'Correction', source: 'retraction-watch', updated: { 'date-parts': [[2004, 3, 6]] } },
        { DOI: '10.1/retr', type: 'retraction', label: 'Retraction', source: 'retraction-watch', updated: { 'date-parts': [[2010, 2, 6]] } },
      ],
    });
    const http = fakeHttp([[/works\/10\.1038\/nature14539/, { status: 200, body }]]);
    const [r] = await verifyReferences('doi:10.1038/nature14539', { http });
    expect(r!.status).toBe('retracted');
    expect(r!.summary).toContain('(2010-02-06)');
    expect(r!.summary).not.toContain('2004');
  });

  it('calls an unregistered DOI next to an unfindable title likely fabricated', async () => {
    const http = fakeHttp([
      [/doi\.org\/api\/handles\//, { status: 404, body: { responseCode: 100 } }],
    ]);
    const [r] = await verifyReferences(
      'Nguyen T, Whitfield R. Efficacy of alternate-day fasting on HbA1c in adults with type 2 diabetes: a randomized trial. Diabetes Care. 2021;44(7):1532-1540. doi:10.2337/dc99-9999',
      { http },
    );
    expect(r!.status).toBe('likely_fabricated');
    expect(r!.match).toBeUndefined();
  });

  it('says "not checked" rather than "fake" when every source is down', async () => {
    const down: HttpClient = async () => ({ status: 0, body: null });
    const [r] = await verifyReferences(
      'Nguyen T, Whitfield R. Efficacy of alternate-day fasting on HbA1c in adults with type 2 diabetes: a randomized trial. Diabetes Care. 2021;44(7):1532-1540.',
      { http: down },
    );
    expect(r!.status).toBe('not_found');
    expect(r!.notFoundReason).toBe('lookup_failed');
  });
});
