import { describe, expect, it } from 'vitest';
import { datasetTerms, findDatasets, loadSnippet, relevanceOf } from '../datasets';
import { cacheKey, type HttpClient, type HttpResponse } from '../http';
import { mapCollection } from '../sources/cellxgene';
import { cryoetPattern, cryoetSearchDatasets } from '../sources/cryoet';
import { licenceVerdict, normalizeLicence } from '../licence';
import { parseCuratedIndex } from '../sources/huggingface';

/** Answers by URL substring; anything unmatched is an empty but successful answer. */
function fakeHttp(routes: [string, HttpResponse][]): HttpClient & { urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const http = (async (req) => {
    urls.push(req.url);
    if (req.body) bodies.push(req.body);
    const hit = routes.find(([k]) => req.url.includes(k));
    if (hit) return hit[1];
    if (req.url.includes('huggingface.co/api/')) return { status: 200, body: [] };
    if (req.url.includes('api.datacite.org/dois?')) return { status: 200, body: { data: [] } };
    if (req.url.includes('esearch.fcgi')) return { status: 200, body: { esearchresult: { idlist: [] } } };
    if (req.url.includes('huggingscience.co')) return { status: 200, body: '# Hugging Science\n' };
    if (req.url.includes('api.cellxgene.cziscience.com')) return { status: 200, body: [] };
    if (req.url.includes('graphql.cryoetdataportal')) {
      return { status: 200, body: { data: { byTitle: [], byDescription: [], byOrganism: [] } } };
    }
    return { status: 404, body: null };
  }) as HttpClient & { urls: string[]; bodies: string[] };
  http.urls = urls;
  http.bodies = bodies;
  return http;
}

const dc = (attrs: Record<string, unknown>) => ({ attributes: attrs });

const crossrefWork = (doi: string, extra: Record<string, unknown> = {}): HttpResponse => ({
  status: 200,
  body: {
    status: 'ok',
    'message-type': 'work',
    message: {
      DOI: doi,
      title: ['Gene expression of triple negative breast cancer subtypes'],
      author: [{ family: 'Burstein', given: 'Matthew D.' }],
      'container-title': ['Clinical Cancer Research'],
      issued: { 'date-parts': [[2015]] },
      type: 'journal-article',
      ...extra,
    },
  },
});

describe('licence verdicts', () => {
  it('maps the table from the spec', () => {
    expect(licenceVerdict('cc-by-4.0').verdict).toBe('ok_publication_commercial');
    expect(licenceVerdict('CC0-1.0').verdict).toBe('ok_publication_commercial');
    expect(licenceVerdict('https://creativecommons.org/licenses/by/4.0/legalcode').spdx).toBe('cc-by-4.0');
    expect(licenceVerdict('Creative Commons Attribution 4.0 International').spdx).toBe('cc-by-4.0');
    expect(licenceVerdict('cc-by-sa-4.0').verdict).toBe('ok_share_alike');
    expect(licenceVerdict('odbl').verdict).toBe('ok_share_alike');
    expect(licenceVerdict('cc-by-nc-4.0').verdict).toBe('non_commercial');
    expect(licenceVerdict('cc-by-nc-nd-4.0').verdict).toBe('non_commercial');
    expect(licenceVerdict('cc-by-nd-4.0').verdict).toBe('no_derivatives');
    expect(licenceVerdict('license:pddl').verdict).toBe('ok_publication_commercial');
    for (const unclear of ['other', 'unknown', 'openrail', '', undefined]) {
      expect(licenceVerdict(unclear).verdict).toBe('unclear');
    }
    expect(normalizeLicence('https://creativecommons.org/publicdomain/zero/1.0/')).toBe('cc0-1.0');
  });

  it('classifies the software licences bio.tools and GitHub report', () => {
    for (const open of ['Artistic-2.0', 'ISC', 'Zlib', 'BSL-1.0', '0BSD']) {
      expect(licenceVerdict(open).verdict).toBe('ok_publication_commercial');
    }
    for (const copyleft of ['MPL-2.0', 'EPL-2.0', 'EUPL-1.2', 'CECILL-2.1', 'LGPL-3.0']) {
      expect(licenceVerdict(copyleft).verdict).toBe('ok_share_alike');
    }
    expect(licenceVerdict('Artistic-1.0').verdict).toBe('unclear');
    expect(licenceVerdict(undefined).label).not.toMatch(/dataset/);
  });
});

describe('keywords and relevance', () => {
  it('drops words about the request, keeps the topic', () => {
    expect(
      datasetTerms("I'm writing my master's thesis on gene expression in triple-negative breast cancer. Is there open data I can use and cite?"),
    ).toEqual(['gene', 'expression', 'triple', 'negative', 'breast', 'cancer']);
    expect(datasetTerms('anything', 'TNBC RNA-seq')).toEqual(['tnbc', 'rna', 'seq']);
  });

  it('matches plurals and word starts, weighting the title', () => {
    const r = relevanceOf(['breast', 'cancer', 'expression'], 'Breast cancers', 'expression profiling by array');
    expect(r.matched).toEqual(['breast', 'cancer', 'expression']);
    expect(r.score).toBeCloseTo((1 + 1 + 0.8) / 3, 2);
    expect(relevanceOf(['breast'], 'breakdown of costs', '').score).toBe(0);
  });
});

describe('Hugging Science index', () => {
  it('reads dataset and model lines with their topics', () => {
    const text = [
      '## Datasets',
      '- [arcinstitute/opengenome2](https://huggingface.co/datasets/arcinstitute/opengenome2): Genomic sequences. [Biology, Genomics]',
      '- [arcinstitute/opengenome2](https://huggingface.co/datasets/arcinstitute/opengenome2): duplicate',
      '## Models',
      '- [arcinstitute/evo2_7b](https://huggingface.co/arcinstitute/evo2_7b): DNA language model [Genomics]',
      '- [Blog](https://huggingscience.co/blog/x): not a repo',
    ].join('\n');
    expect(parseCuratedIndex(text)).toEqual([
      { kind: 'dataset', id: 'arcinstitute/opengenome2', description: 'Genomic sequences.', topics: ['Biology', 'Genomics'] },
      { kind: 'model', id: 'arcinstitute/evo2_7b', description: 'DNA language model', topics: ['Genomics'] },
    ]);
  });
});

describe('load snippets', () => {
  it('uses the right loader for each source', () => {
    expect(loadSnippet({ kind: 'dataset', source: 'geo', id: 'GSE76275', formats: [], access: 'open' })).toContain(
      'GEOparse.get_GEO(geo="GSE76275")',
    );
    expect(
      loadSnippet({ kind: 'dataset', source: 'huggingface', id: 'org/data', formats: ['parquet'], access: 'gated' }),
    ).toMatch(/hf auth login[\s\S]*load_dataset\("org\/data"\)/);
    expect(
      loadSnippet({ kind: 'dataset', source: 'datacite', id: '10.5281/zenodo.1', datasetDoi: '10.5281/zenodo.1', formats: ['h5ad'], access: 'open' }),
    ).toMatch(/zenodo_get 10\.5281\/zenodo\.1\n.*read_h5ad/);
  });
});

const TNBC = 'gene expression in triple-negative breast cancer';

describe('findDatasets', () => {
  it('returns a verified paper, licence verdict, citation and snippet (DataCite)', async () => {
    const http = fakeHttp([
      [
        'api.datacite.org/dois?',
        {
          status: 200,
          body: {
            data: [
              dc({
                doi: '10.5281/ZENODO.111',
                titles: [{ title: 'Triple negative breast cancer gene expression matrix' }],
                creators: [{ name: 'Burstein, Matthew', nameType: 'Personal' }],
                publisher: 'Zenodo',
                publicationYear: 2016,
                rightsList: [{ rightsIdentifier: 'cc-by-4.0' }, { rightsUri: 'info:eu-repo/semantics/openAccess' }],
                relatedIdentifiers: [{ relatedIdentifier: '10.1158/1078-0432.ccr-14-0432', relatedIdentifierType: 'DOI', relationType: 'IsSupplementTo' }],
                formats: ['text/csv'],
                sizes: ['198 samples'],
              }),
              // A version of the same record: must not appear twice.
              dc({
                doi: '10.5281/zenodo.112',
                titles: [{ title: 'Triple negative breast cancer gene expression matrix' }],
                publisher: 'Zenodo',
                relatedIdentifiers: [{ relatedIdentifier: '10.5281/zenodo.111', relatedIdentifierType: 'DOI', relationType: 'IsVersionOf' }],
              }),
            ],
          },
        },
      ],
      ['works/10.1158', crossrefWork('10.1158/1078-0432.ccr-14-0432')],
    ]);
    const r = await findDatasets({ question: TNBC }, { http });
    expect(r.status).toBe('ok');
    expect(r.results).toHaveLength(1);
    const d = r.results[0]!;
    expect(d).toMatchObject({
      source: 'datacite',
      id: '10.5281/zenodo.111',
      match: 'best',
      access: 'open',
      licence: { spdx: 'cc-by-4.0', verdict: 'ok_publication_commercial' },
      paper: { doi: '10.1158/1078-0432.ccr-14-0432', status: 'verified', journal: 'Clinical Cancer Research', year: 2015 },
    });
    expect(d.citation).toContain('Burstein');
    expect(d.citation).toContain('https://doi.org/10.5281/zenodo.111');
    expect(d.paper.citation).toContain('Clinical Cancer Research');
    expect(d.loadSnippet).toContain('zenodo_get 10.5281/zenodo.111');
    expect(r.takeaways[0]).toMatch(/^Start with 10\.5281\/zenodo\.111/);
    expect(r.stats).toMatchObject({ results: 1, papersVerified: 1 });
  });

  it('labels non-commercial licences and demotes them for commercial use', async () => {
    const routes: [string, HttpResponse][] = [
      [
        'api.datacite.org/dois?',
        {
          status: 200,
          body: {
            data: [
              dc({
                doi: '10.6084/m9.figshare.9',
                titles: [{ title: 'Triple negative breast cancer gene expression' }],
                publisher: 'figshare',
                rightsList: [{ rightsIdentifier: 'cc-by-nc-4.0' }],
                relatedIdentifiers: [{ relatedIdentifier: '10.1/abc', relatedIdentifierType: 'DOI', relationType: 'IsSupplementTo' }],
              }),
            ],
          },
        },
      ],
      ['works/10.1%2Fabc', crossrefWork('10.1/abc')],
    ];
    const thesis = await findDatasets({ question: TNBC, intendedUse: 'thesis' }, { http: fakeHttp(routes) });
    expect(thesis.results[0]!.licence.label).toMatch(/^Non-commercial only/);
    expect(thesis.results[0]!.match).toBe('best');
    const commercial = await findDatasets({ question: TNBC, intendedUse: 'commercial' }, { http: fakeHttp(routes) });
    expect(commercial.results[0]!.match).toBe('use_with_care');
    expect(commercial.results[0]!.licence.notes).toContain('Not cleared for commercial use by its licence.');
    expect(commercial.takeaways.join(' ')).toMatch(/not cleared for commercial use/);
  });

  it('says "Licence unclear" when the card names none, and flags upstream terms', async () => {
    const http = fakeHttp([
      [
        'huggingface.co/api/datasets?search=negative',
        {
          status: 200,
          body: [
            {
              id: 'someone/tcga-brca-triple-negative',
              author: 'someone',
              tags: ['format:csv', 'size_categories:1K<n<10K'],
              description: 'TCGA breast cancer gene expression, triple negative subset.',
              downloads: 100,
            },
          ],
        },
      ],
    ]);
    const r = await findDatasets({ question: TNBC }, { http });
    const d = r.results.find((x) => x.id === 'someone/tcga-brca-triple-negative')!;
    expect(d.licence.verdict).toBe('unclear');
    expect(d.licence.label).toMatch(/^Licence unclear/);
    expect(d.licence.notes.join(' ')).toMatch(/TCGA data/);
    expect(d.paper.status).toBe('none_linked');
    expect(d.match).not.toBe('best');
  });

  it('never shows a retracted or corrected paper as verified', async () => {
    const http = fakeHttp([
      [
        'api.datacite.org/dois?',
        {
          status: 200,
          body: {
            data: [
              dc({
                doi: '10.5061/dryad.1',
                titles: [{ title: 'Triple negative breast cancer gene expression' }],
                publisher: 'Dryad',
                rightsList: [{ rightsIdentifier: 'cc0-1.0' }],
                relatedIdentifiers: [{ relatedIdentifier: '10.2/retracted', relatedIdentifierType: 'DOI', relationType: 'IsSupplementTo' }],
              }),
              dc({
                doi: '10.5061/dryad.2',
                titles: [{ title: 'Breast cancer triple negative gene expression set' }],
                publisher: 'Dryad',
                rightsList: [{ rightsIdentifier: 'cc0-1.0' }],
                relatedIdentifiers: [{ relatedIdentifier: '10.2/corrected', relatedIdentifierType: 'DOI', relationType: 'IsSupplementTo' }],
              }),
            ],
          },
        },
      ],
      ['works/10.2%2Fretracted', crossrefWork('10.2/retracted', { 'updated-by': [{ type: 'retraction', label: 'Retraction', DOI: '10.2/notice' }] })],
      ['works/10.2%2Fcorrected', crossrefWork('10.2/corrected', { 'updated-by': [{ type: 'correction', label: 'Correction', DOI: '10.2/erratum' }] })],
    ]);
    const r = await findDatasets({ question: TNBC }, { http });
    const retracted = r.results.find((x) => x.id === '10.5061/dryad.1')!;
    const corrected = r.results.find((x) => x.id === '10.5061/dryad.2')!;
    expect(retracted.paper.status).toBe('retracted');
    expect(retracted.paper.citation).toBeUndefined();
    expect(retracted.match).toBe('use_with_care');
    expect(corrected.paper.status).toBe('correction');
    expect(corrected.match).not.toBe('best');
    expect(r.warnings.join(' ')).toMatch(/10\.5061\/dryad\.1 has been retracted/);
    expect(r.warnings.join(' ')).toMatch(/10\.5061\/dryad\.2 has a published correction/);
  });

  it('returns an honest empty brief when nothing fits', async () => {
    const http = fakeHttp([
      [
        'api.datacite.org/dois?',
        {
          status: 200,
          body: { data: [dc({ doi: '10.9/x', titles: [{ title: 'Zebrafish fin regeneration images' }], publisher: 'Zenodo' })] },
        },
      ],
    ]);
    const r = await findDatasets({ question: 'quantum chromodynamics lattice gluon propagator' }, { http });
    expect(r.status).toBe('ok');
    expect(r.results).toEqual([]);
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.stats.sourcesScanned).toBe(1);
  });

  it('links GEO series to their PubMed paper and uses GEO terms', async () => {
    const http = fakeHttp([
      ['esearch.fcgi?db=gds', { status: 200, body: { esearchresult: { idlist: ['200076275'] } } }],
      [
        'esummary.fcgi?db=gds',
        {
          status: 200,
          body: {
            result: {
              '200076275': {
                accession: 'GSE76275',
                title: 'Triple negative breast cancer gene expression subtypes',
                summary: 'Expression profiling of 198 TNBC tumours.',
                taxon: 'Homo sapiens',
                gdstype: 'Expression profiling by array',
                pdat: '2016/01/26',
                n_samples: 265,
                pubmedids: ['25208879'],
              },
            },
          },
        },
      ],
      [
        'esummary.fcgi?db=pubmed',
        {
          status: 200,
          body: {
            result: {
              '25208879': {
                uid: '25208879',
                title: 'Comprehensive genomic analysis identifies novel subtypes of triple-negative breast cancer.',
                authors: [{ name: 'Burstein MD', authtype: 'Author' }],
                fulljournalname: 'Clinical cancer research',
                pubdate: '2015 Apr 1',
                articleids: [{ idtype: 'doi', value: '10.1158/1078-0432.CCR-14-0432' }],
              },
            },
          },
        },
      ],
      ['works/10.1158', crossrefWork('10.1158/1078-0432.ccr-14-0432')],
    ]);
    const r = await findDatasets({ question: TNBC, domain: 'genomics' }, { http });
    const d = r.results[0]!;
    expect(d).toMatchObject({
      source: 'geo',
      id: 'GSE76275',
      nSamples: 265,
      organism: 'Homo sapiens',
      licence: { verdict: 'repository_terms' },
      paper: { pmid: '25208879', doi: '10.1158/1078-0432.ccr-14-0432', status: 'verified' },
    });
    expect(d.why).toMatch(/265 samples · Homo sapiens · linked paper/);
  });

  it('skips GEO outside the life sciences and reports unreachable sources', async () => {
    const http = fakeHttp([['api.datacite.org', { status: 503, body: null }]]);
    const r = await findDatasets({ question: 'perovskite solar cell efficiency', domain: 'materials' }, { http });
    expect(http.urls.some((u) => u.includes('db=gds'))).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/DataCite .* could not be reached/);
  });
});

const LUNG_COLLECTION = {
  collection_id: '6f6d381a-7701-4781-935c-db10d30de293',
  collection_url: 'https://cellxgene.cziscience.com/collections/6f6d381a-7701-4781-935c-db10d30de293',
  name: 'The integrated Human Lung Cell Atlas',
  description: 'A single-cell RNA-seq atlas of the human lung across 107 individuals.',
  doi: '10.1038/s41591-023-02327-2',
  consortia: ['CZI Single-Cell Biology'],
  published_at: '2023-05-02T00:00:00+00:00',
  publisher_metadata: { authors: [{ family: 'Sikkema', given: 'Lisa' }], journal: 'Nature Medicine', is_preprint: false },
  datasets: [
    {
      dataset_id: '066943a2-fdac-4b29-b348-40cede398e4e',
      cell_count: 584944,
      organism: [{ label: 'Homo sapiens' }],
      tissue: [{ label: 'lung' }],
      disease: [{ label: 'normal' }],
      assay: [{ label: "10x 3' v3" }],
    },
  ],
};

describe('CELLxGENE Discover', () => {
  it('ranks collections locally and returns a Census snippet, CC BY verdict and the curated paper', async () => {
    const unrelated = { ...LUNG_COLLECTION, collection_id: '11111111-1111-1111-1111-111111111111', name: 'Mouse retina', description: 'Retinal ganglion cells', datasets: [] };
    const http = fakeHttp([
      ['api.cellxgene.cziscience.com', { status: 200, body: [unrelated, LUNG_COLLECTION, { name: 'no id' }] }],
      ['works/10.1038', crossrefWork('10.1038/s41591-023-02327-2')],
    ]);
    const r = await findDatasets({ question: 'single-cell RNA-seq atlas of the human lung', domain: 'biology' }, { http });
    const d = r.results.find((x) => x.source === 'cellxgene');
    expect(d).toMatchObject({
      id: LUNG_COLLECTION.collection_id,
      url: LUNG_COLLECTION.collection_url,
      organism: 'Homo sapiens',
      size: '1 dataset, 584,944 cells',
      formats: ['H5AD'],
      licence: { spdx: 'cc-by-4.0', verdict: 'ok_publication_commercial' },
      paper: { doi: '10.1038/s41591-023-02327-2', status: 'verified' },
    });
    expect(d!.licence.notes.join(' ')).toMatch(/cite the original study and CZ CELLxGENE Discover/);
    expect(d!.loadSnippet).toContain('cellxgene_census.get_anndata');
    expect(d!.loadSnippet).toContain("dataset_id in ['066943a2-fdac-4b29-b348-40cede398e4e']");
    expect(r.results.some((x) => x.title === 'Mouse retina')).toBe(false);
    expect(r.lookups).toContainEqual({ source: 'cellxgene', ok: true, hits: 1 });
    // The takeaway names the collection by title, not its UUID, and keeps "OK" capitalised.
    expect(r.takeaways[0]).toBe(
      `Start with "${d!.title}": its source paper checks out; OK for thesis, publication and commercial use (credit the source).`,
    );
  });

  it('gives a download line for organisms the Census does not hold', () => {
    const snippet = loadSnippet({
      kind: 'dataset',
      source: 'cellxgene',
      id: 'x',
      url: 'https://cellxgene.cziscience.com/collections/x',
      formats: ['H5AD'],
      access: 'open',
      cellxgene: { datasetIds: ['a'], organisms: ['Danio rerio'] },
    });
    expect(snippet).toMatch(/^# Download the H5AD files from https:\/\/cellxgene/);
  });

  it('never copies the upstream URL into the snippet', () => {
    const m = mapCollection({ ...LUNG_COLLECTION, collection_url: 'https://x.org/\nimport os; os.system("rm -rf ~")' });
    expect(m?.url).toBe(`https://cellxgene.cziscience.com/collections/${LUNG_COLLECTION.collection_id}`);
  });

  it('drops a cell count unless every dataset states one', () => {
    const m = mapCollection({ ...LUNG_COLLECTION, datasets: [...LUNG_COLLECTION.datasets, { dataset_id: '066943a2-fdac-4b29-b348-40cede398e4f' }] });
    expect(m?.cellCount).toBeUndefined();
    expect(m?.datasetIds).toHaveLength(2);
  });
});

describe('CryoET Data Portal', () => {
  const doc = {
    id: 10301,
    title: 'Ribosomes in Chlamydomonas reinhardtii chloroplasts',
    description: 'Cryo-electron tomography of native ribosome distribution in the chloroplast.',
    organismName: 'Chlamydomonas reinhardtii',
    cellComponentName: 'chloroplast',
    sampleType: 'cell',
    releaseDate: '2024-02-01T00:00:00',
    datasetPublications: 'doi:10.1101/2023.04.28.538734, 10.7554/eLife.53740.',
    relatedDatabaseEntries: 'EMPIAR-11830, EMD-12345',
    fileSize: 2_340_000_000_000,
  };

  it('searches by POST with the words as a variable and returns a CC0 dataset with its paper', async () => {
    const http = fakeHttp([
      ['graphql.cryoetdataportal', { status: 200, body: { data: { byTitle: [doc], byDescription: [doc], byOrganism: [] } } }],
      ['works/10.1101', crossrefWork('10.1101/2023.04.28.538734')],
    ]);
    const r = await findDatasets({ question: 'chloroplast ribosome tomography', domain: 'biology' }, { http });
    const d = r.results.find((x) => x.source === 'cryoet');
    expect(d).toMatchObject({
      id: 'CZCDP-10301',
      url: 'https://cryoetdataportal.czscience.com/datasets/10301',
      size: '2.3 TB',
      licence: { spdx: 'cc0-1.0', verdict: 'ok_publication_commercial' },
      paper: { doi: '10.1101/2023.04.28.538734', status: 'verified' },
    });
    expect(r.results.filter((x) => x.source === 'cryoet')).toHaveLength(1);
    expect(d!.loadSnippet).toContain('Dataset.get_by_id(Client(), 10301)');
    const body = JSON.parse(http.bodies[0]!) as { query: string; variables: { p: string } };
    expect(body.variables.p).toBe('(chloroplast|tomography|ribosome)');
    expect(body.query).not.toContain('chloroplast');
  });

  it('keeps only letters, digits and hyphens in the pattern', () => {
    expect(cryoetPattern(['a"}) { x', 'Ribosome', 'cryo-et', '..'])).toBe('(ribosome|cryo-et)');
    expect(cryoetPattern(['ab', '!!'])).toBeUndefined();
  });

  it('treats a GraphQL error as an unreachable source', async () => {
    const http = fakeHttp([['graphql.cryoetdataportal', { status: 200, body: { errors: [{ message: 'bad' }], data: null } }]]);
    const r = await cryoetSearchDatasets(http, ['ribosome']);
    expect(r).toEqual({ ok: false, reason: 'error' });
  });

  it('is not asked outside the life sciences', async () => {
    const http = fakeHttp([]);
    await findDatasets({ question: 'perovskite solar cell efficiency', domain: 'materials' }, { http });
    expect(http.urls.some((u) => u.includes('cryoet') || u.includes('cellxgene'))).toBe(false);
  });
});

describe('cache keys', () => {
  it('separate POST bodies to one URL', () => {
    const u = 'https://graphql.cryoetdataportal.czscience.com/graphql';
    expect(cacheKey(u, '{"a":1}')).not.toBe(cacheKey(u, '{"a":2}'));
    expect(cacheKey(u)).toBe(u);
  });
});

describe('Hugging Face ids from third-party text', () => {
  it('never lets a dot segment into the API path', async () => {
    const http = fakeHttp([]);
    const { hfGet } = await import('../sources/huggingface');
    for (const id of ['../..', 'org/..', './x', 'a/b/c', 'org/.hidden']) {
      expect((await hfGet(http, 'dataset', id)).ok, id).toBe(false);
    }
    expect(http.urls).toEqual([]);
  });
});
