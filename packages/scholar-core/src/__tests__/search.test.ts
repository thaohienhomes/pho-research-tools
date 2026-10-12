import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../http';
import { searchPapers } from '../search';

function oaWork(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `https://openalex.org/W${i}`,
    doi: `https://doi.org/10.1000/oa${i}`,
    title: `OpenAlex paper ${i}`,
    publication_year: 2020,
    authorships: [{ author: { display_name: 'An Nguyen' } }],
    primary_location: { source: { display_name: 'Journal A' } },
    biblio: {},
    type: 'article',
    open_access: { is_oa: i % 2 === 0, oa_url: i % 2 === 0 ? `https://oa.example/${i}` : null },
    cited_by_count: 10 * i,
    ...over,
  };
}

function pmDoc(uid: string, over: Record<string, unknown> = {}) {
  return {
    uid,
    title: `PubMed paper ${uid}.`,
    authors: [{ name: 'Tran B', authtype: 'Author' }],
    fulljournalname: 'Journal B',
    pubdate: '2021 Mar',
    articleids: [{ idtype: 'pubmed', value: uid }],
    pubtype: ['Journal Article'],
    ...over,
  };
}

function fakeHttp(oa: unknown[], pm: Record<string, unknown>[], seen: string[] = []): HttpClient {
  return async ({ url }) => {
    seen.push(url);
    if (url.startsWith('https://api.openalex.org/')) return { status: 200, body: { results: oa } };
    if (url.includes('esearch.fcgi')) return { status: 200, body: { esearchresult: { idlist: pm.map((d) => d.uid) } } };
    if (url.includes('esummary.fcgi')) {
      return { status: 200, body: { result: Object.fromEntries(pm.map((d) => [d.uid as string, d])) } };
    }
    return { status: 404, body: null };
  };
}

describe('searchPapers', () => {
  it('interleaves both sources and gives every result a DOI or PMID link', async () => {
    const r = await searchPapers('sepsis', {}, { http: fakeHttp([oaWork(1), oaWork(2)], [pmDoc('111'), pmDoc('222')]) });
    expect(r.status).toBe('ok');
    expect(r.results.map((x) => x.title)).toEqual(['OpenAlex paper 1', 'PubMed paper 111', 'OpenAlex paper 2', 'PubMed paper 222']);
    for (const x of r.results) {
      expect(x.doi || x.pmid).toBeTruthy();
      expect(x.url).toMatch(/^https:\/\/(doi\.org\/10\.|pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/)/);
    }
    expect(r.results[1]!.url).toBe('https://pubmed.ncbi.nlm.nih.gov/111/');
  });

  it('folds the same paper found in both databases into one result', async () => {
    const shared = pmDoc('333', { articleids: [{ idtype: 'doi', value: '10.1000/OA1' }, { idtype: 'pmc', value: 'PMC999' }] });
    const r = await searchPapers('x y', {}, { http: fakeHttp([oaWork(1)], [shared]) });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ doi: '10.1000/oa1', pmid: '333', foundIn: ['openalex', 'pubmed'] });
    expect(r.results[0]!.links.pmc).toBe('https://pmc.ncbi.nlm.nih.gov/articles/PMC999/');
  });

  it('drops results with no identifier, notices and retracted papers, and says so', async () => {
    const r = await searchPapers(
      'x y',
      {},
      {
        http: fakeHttp(
          [oaWork(1, { doi: null }), oaWork(2, { type: 'erratum' }), oaWork(3, { is_retracted: true }), oaWork(4)],
          [],
        ),
      },
    );
    expect(r.results.map((x) => x.title)).toEqual(['OpenAlex paper 4']);
    expect(r.excluded).toMatchObject({ noIdentifier: 1, notices: 1, retracted: 1 });
    expect(r.warnings.join(' ')).toMatch(/1 retracted paper/);
    const withRetracted = await searchPapers('x y', { includeRetracted: true }, { http: fakeHttp([oaWork(3, { is_retracted: true })], []) });
    expect(withRetracted.results[0]!.retracted).toBe(true);
  });

  it('turns filters into each database’s own syntax', async () => {
    const seen: string[] = [];
    await searchPapers(
      'atrial fibrillation',
      { yearFrom: 2018, yearTo: 2024, openAccessOnly: true, studyTypes: ['RCT', 'pragmatic'], maxResults: 5 },
      { http: fakeHttp([], [], seen) },
    );
    const oa = new URL(seen.find((u) => u.includes('openalex'))!);
    expect(oa.searchParams.get('filter')).toBe('is_paratext:false,has_doi:true,publication_year:2018-2024,is_oa:true');
    expect(oa.searchParams.get('search')).toBe('atrial fibrillation pragmatic randomized controlled trial');
    expect(oa.searchParams.get('per-page')).toBe('10');
    const pm = new URL(seen.find((u) => u.includes('esearch'))!);
    expect(pm.searchParams.get('term')).toBe(
      '(atrial fibrillation) AND ("pragmatic") AND ("randomized controlled trial"[pt]) AND (2018:2024[dp]) AND free full text[sb]',
    );
  });

  it('labels how a study-type filter matched', async () => {
    const r = await searchPapers('x y', { studyTypes: ['meta-analysis'] }, { http: fakeHttp([oaWork(1)], [pmDoc('5')]) });
    expect(r.results.find((x) => x.pmid === '5')!.studyTypeMatch).toBe('publication-type');
    expect(r.results.find((x) => x.openalexId)!.studyTypeMatch).toBe('keyword');
  });

  it('respects maxResults and keeps only open-access results when asked', async () => {
    const many = Array.from({ length: 8 }, (_, i) => oaWork(i + 1));
    expect((await searchPapers('x y', { maxResults: 3 }, { http: fakeHttp(many, []) })).results).toHaveLength(3);
    const oaOnly = await searchPapers('x y', { openAccessOnly: true, sources: ['openalex'] }, { http: fakeHttp(many, []) });
    // The fake ignores the server-side filter; the client-side check still holds.
    expect(oaOnly.results.every((x) => x.openAccess.isOa && x.openAccess.url)).toBe(true);
  });

  it('reports a source that could not be reached and keeps the other', async () => {
    const http: HttpClient = async ({ url }) =>
      url.includes('openalex') ? { status: 0, body: null } : fakeHttp([], [pmDoc('7')])({ url });
    const r = await searchPapers('x y', {}, { http });
    expect(r.status).toBe('ok');
    expect(r.results).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/OpenAlex could not be searched/);
    const down = await searchPapers('x y', {}, { http: async () => ({ status: 0, body: null }) });
    expect(down.status).toBe('unavailable');
  });

  it('validates years and an empty query without calling anything', async () => {
    const seen: string[] = [];
    const r = await searchPapers('x y', { yearFrom: 2024, yearTo: 2018 }, { http: fakeHttp([], [], seen) });
    expect(r.filters).toMatchObject({ yearFrom: 2018, yearTo: 2024 });
    expect(r.warnings[0]).toMatch(/swapped/);
    const empty = await searchPapers('  ', {}, { http: fakeHttp([], [], seen) });
    expect(empty.results).toEqual([]);
    expect(seen.filter((u) => u.includes('openalex'))).toHaveLength(1);
  });
});

describe('searchPapers preprints', () => {
  it('labels preprints from either database', async () => {
    const r = await searchPapers(
      'x y',
      {},
      {
        http: fakeHttp(
          [oaWork(1, { primary_location: { source: { display_name: 'medRxiv', type: 'repository' } } }), oaWork(2)],
          [pmDoc('9', { pubtype: ['Preprint'] })],
        ),
      },
    );
    expect(r.results.map((x) => [x.title, x.preprint])).toEqual([
      ['OpenAlex paper 1', true],
      ['PubMed paper 9', true],
      ['OpenAlex paper 2', false],
    ]);
  });
});
