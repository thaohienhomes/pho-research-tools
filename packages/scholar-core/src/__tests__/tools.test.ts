import { describe, expect, it } from 'vitest';
import { findTools, healthOf, installFrom, queryWords, toolRelevance, toolTerms } from '../tools';
import type { HttpClient, HttpResponse } from '../http';
import { biotoolsQuery, mapBiotools } from '../sources/biotools';
import { githubRepoOf } from '../sources/github';

const DOI = '10.1186/s13059-017-1382-0';

const record = (over: Record<string, unknown> = {}) => ({
  biotoolsID: 'scanpy',
  name: 'Scanpy',
  description: 'Scalable single-cell RNA-seq clustering and visualisation in Python.',
  homepage: 'https://scanpy.readthedocs.io',
  license: 'BSD-3-Clause',
  cost: 'Free of charge',
  language: ['Python'],
  toolType: ['Library'],
  topic: [{ term: 'Transcriptomics' }],
  function: [
    {
      operation: [{ term: 'Clustering' }],
      input: [{ data: { term: 'Count matrix' }, format: [{ term: 'H5AD' }] }],
      output: [{ data: { term: 'Matrix' }, format: [{ term: 'TSV' }] }],
    },
  ],
  link: [{ url: 'https://github.com/scverse/scanpy', type: ['Repository'] }],
  download: [{ url: 'https://pypi.org/project/scanpy/', type: 'Software package' }],
  publication: [{ doi: DOI, pmid: null, type: ['Primary'] }],
  credit: [{ name: 'A Person', email: 'a@example.org' }],
  ...over,
});

function fakeHttp(list: unknown[], extra: Record<string, HttpResponse> = {}): HttpClient & { urls: string[] } {
  const urls: string[] = [];
  const http = (async (req) => {
    urls.push(req.url);
    if (req.url.startsWith('https://bio.tools/api/t/')) return { status: 200, body: { count: list.length, list } };
    for (const [k, v] of Object.entries(extra)) if (req.url.includes(k)) return v;
    if (req.url.includes('api.crossref.org/works/')) {
      return {
        status: 200,
        body: {
          status: 'ok',
          'message-type': 'work',
          message: {
            DOI: DOI,
            title: ['SCANPY: large-scale single-cell gene expression data analysis'],
            author: [{ family: 'Wolf', given: 'F. Alexander' }],
            'container-title': ['Genome Biology'],
            issued: { 'date-parts': [[2018]] },
            type: 'journal-article',
          },
        },
      };
    }
    return { status: 404, body: null };
  }) as HttpClient & { urls: string[] };
  http.urls = urls;
  return http;
}

const github = (pushed: string, extra: Record<string, unknown> = {}): Record<string, HttpResponse> => ({
  'api.github.com/repos/scverse/scanpy': {
    status: 200,
    body: { archived: false, pushed_at: pushed, license: { spdx_id: 'BSD-3-Clause' }, ...extra },
  },
});

describe('bio.tools records', () => {
  it('keeps the facts the pipeline reads and drops the rest', () => {
    const t = mapBiotools(record())!;
    expect(t.id).toBe('scanpy');
    expect(t.url).toBe('https://bio.tools/scanpy');
    expect(t.operations).toEqual(['Clustering']);
    expect(t.inputFormats).toEqual(['H5AD']);
    expect(t.publications).toEqual([{ doi: DOI, types: ['Primary'] }]);
    expect(JSON.stringify(t)).not.toContain('example.org');
  });

  it('rejects ids and DOIs that are not shaped like ids and DOIs', () => {
    expect(mapBiotools(record({ biotoolsID: 'a/../b' }))).toBeNull();
    expect(mapBiotools(record({ name: '  ' }))).toBeNull();
    const t = mapBiotools(record({ publication: [{ doi: 'not a doi' }, { pmid: '12ab' }, { pmid: '31501' }] }))!;
    expect(t.publications).toEqual([{ pmid: '31501', types: [] }]);
  });

  it('ignores URLs that are not http(s)', () => {
    const t = mapBiotools(record({ homepage: 'javascript:alert(1)', link: [{ url: 'ftp://x.org/y' }], download: [] }))!;
    expect(t.homepage).toBeUndefined();
    expect(t.urls).toEqual([]);
  });

  it('builds a query from safe words only', () => {
    expect(biotoolsQuery(['Single-cell', 'RNA&seq', 'x', '../etc'])).toBe('single-cell rnaseq etc');
  });
});

describe('install lines', () => {
  it('comes only from a link the registry lists', () => {
    expect(installFrom(['https://pypi.org/project/scanpy/'])?.line).toBe('pip install scanpy');
    expect(installFrom(['https://anaconda.org/bioconda/samtools'])?.line).toBe('conda install -c bioconda samtools');
    expect(installFrom(['https://bioconda.github.io/recipes/bwa/README.html'])?.line).toBe(
      'conda install -c bioconda bwa',
    );
    expect(installFrom(['https://bioconductor.org/packages/release/bioc/html/DESeq2.html'])?.line).toBe(
      'BiocManager::install("DESeq2")',
    );
    expect(installFrom(['https://cran.r-project.org/web/packages/Seurat/index.html'])?.line).toBe(
      'install.packages("Seurat")',
    );
    expect(installFrom(['https://github.com/scverse/scanpy'])?.line).toBe(
      'git clone https://github.com/scverse/scanpy.git',
    );
    expect(installFrom(['https://example.org/tool'])).toBeUndefined();
  });

  it('prefers a package manager over a clone, and refuses odd package names', () => {
    expect(installFrom(['https://github.com/a/b', 'https://pypi.org/project/b/'])?.kind).toBe('pip');
    expect(installFrom(['https://pypi.org/project/x;rm -rf/'])).toBeUndefined();
    expect(githubRepoOf('https://github.com/a/b/issues')).toEqual({ owner: 'a', name: 'b' });
    expect(githubRepoOf('https://gitlab.com/a/b')).toBeUndefined();
  });
});

describe('maintenance label', () => {
  const now = new Date('2026-10-08T00:00:00Z');
  const repo = (pushedAt: string, archived = false) => ({ owner: 'a', name: 'b', url: 'u', archived, pushedAt });
  it('reads the label from the last push', () => {
    expect(healthOf(repo('2026-08-01T00:00:00Z'), now).label).toBe('active');
    expect(healthOf(repo('2025-01-01T00:00:00Z'), now).label).toBe('idle');
    expect(healthOf(repo('2022-01-01T00:00:00Z'), now).label).toBe('stale');
    expect(healthOf(repo('2026-08-01T00:00:00Z', true), now).label).toBe('archived');
  });
  it('says unknown rather than guessing', () => {
    expect(healthOf(undefined, now).label).toBe('unknown');
    expect(healthOf(null, now).label).toBe('unknown');
    expect(healthOf({ owner: 'a', name: 'b', url: 'u', archived: false }, now).label).toBe('unknown');
  });
});

describe('findTools', () => {
  const now = new Date('2026-10-08T00:00:00Z');
  const opts = (http: HttpClient) => ({ http, now });

  it('drops the word "tool" from the search', () => {
    expect(toolTerms('a tool to cluster single-cell data')).toEqual(expect.not.arrayContaining(['tool']));
  });

  it('returns a tool with a checked paper, licence, health and install line', async () => {
    const http = fakeHttp([record()], github('2026-09-01T00:00:00Z'));
    const r = await findTools({ question: 'cluster single-cell RNA-seq', inputFormat: 'h5ad' }, opts(http));
    expect(r.status).toBe('ok');
    const t = r.results[0]!;
    expect(t.name).toBe('Scanpy');
    expect(t.match).toBe('best');
    expect(t.paper.status).toBe('verified');
    expect(t.paper.doi).toBe(DOI);
    expect(t.licence.verdict).toBe('ok_publication_commercial');
    expect(t.health.label).toBe('active');
    expect(t.install?.line).toBe('pip install scanpy');
    expect(t.readsRequestedFormat).toBe(true);
    expect(r.takeaways[0]).toBe(
      'Start with Scanpy: its paper checks out; code pushed in the last year; OK for thesis, publication and commercial use (credit the source).',
    );
  });

  it('filters commercial, proprietary and thin records', async () => {
    const http = fakeHttp([
      record({ biotoolsID: 'paid', name: 'Paid clustering', cost: 'Commercial' }),
      record({ biotoolsID: 'prop', name: 'Prop clustering', license: 'Proprietary' }),
      record({ biotoolsID: 'thin', name: 'Thin clustering', publication: [], link: [], download: [] }),
    ]);
    const r = await findTools({ question: 'clustering single-cell' }, opts(http));
    expect(r.results).toEqual([]);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });

  it('keeps a tool with code but no paper, and says so', async () => {
    const http = fakeHttp([record({ publication: [] })], github('2026-09-01T00:00:00Z'));
    const r = await findTools({ question: 'cluster single-cell RNA-seq' }, opts(http));
    expect(r.results[0]!.paper.status).toBe('none_linked');
    expect(r.results[0]!.match).toBe('use_with_care');
    expect(r.takeaways.join(' ')).toContain('list no paper');
  });

  it('demotes an archived tool', async () => {
    const archived = fakeHttp([record()], github('2026-09-01T00:00:00Z', { archived: true }));
    const a = await findTools({ question: 'cluster single-cell RNA-seq' }, opts(archived));
    expect(a.results[0]!.health.label).toBe('archived');
    expect(a.results[0]!.match).toBe('use_with_care');
  });

  it('does not rank a preprint-only tool as best', async () => {
    const http = fakeHttp(
      [record({ publication: [{ doi: DOI, type: ['Preprint'] }] })],
      github('2026-09-01T00:00:00Z'),
    );
    const r = await findTools({ question: 'cluster single-cell RNA-seq' }, opts(http));
    expect(r.results[0]!.paperIsPreprint).toBe(true);
    expect(r.results[0]!.match).toBe('good');
  });

  it('warns when no tool reads the named format', async () => {
    const http = fakeHttp([record()], github('2026-09-01T00:00:00Z'));
    const r = await findTools({ question: 'cluster single-cell RNA-seq', inputFormat: 'loom' }, opts(http));
    expect(r.warnings.join(' ')).toContain('loom');
    expect(r.results[0]!.readsRequestedFormat).toBe(false);
  });

  it('reports unavailable, not empty, when bio.tools cannot be reached', async () => {
    const http: HttpClient = async () => ({ status: 503, body: null });
    const r = await findTools({ question: 'cluster single-cell RNA-seq' }, { http, now });
    expect(r.status).toBe('unavailable');
    expect(r.lookups[0]).toMatchObject({ source: 'biotools', ok: false });
  });

  it('labels maintenance unknown when GitHub is rate-limited', async () => {
    const http = fakeHttp([record()], { 'api.github.com': { status: 403, body: null } });
    const r = await findTools({ question: 'cluster single-cell RNA-seq' }, opts(http));
    expect(r.results[0]!.health.label).toBe('unknown');
    expect(r.warnings.join(' ')).toContain('GitHub');
  });
});

describe('toolRelevance', () => {
  const words = (q: string) => queryWords(q, toolTerms(q));
  // spaCR's real registry text: single-cell images, sequencing reads, gRNAs, clustering.
  const imaging =
    'spaCR links pooled CRISPR-Cas9 perturbations to single-cell spatial phenotypes in microscopy images. It maps sequencing reads to wells and gRNAs. Clustering';

  it('needs a hyphenated word as one phrase, so "sequencing" and "gRNA" are not RNA-seq', () => {
    const r = toolRelevance(words('scRNA-seq clustering'), 'spaCR', imaging);
    expect(r.matched).toEqual(['clustering']);
    expect(r.score).toBeLessThan(0.5);
  });

  it('reads scRNA-seq as "single-cell RNA sequencing"', () => {
    const r = toolRelevance(words('scRNA-seq clustering'), 'X', 'Clusters cells from single-cell RNA sequencing data.');
    expect(r.matched).toEqual(['clustering', 'scrna-seq']);
  });

  it('ranks a single-cell RNA-seq tool above an imaging tool for the same question', () => {
    const w = words('cluster single-cell RNA-seq data');
    const rnaseq = toolRelevance(w, 'X', 'Clustering of single cell RNA-seq experiments.');
    expect(rnaseq.score).toBeGreaterThan(toolRelevance(w, 'spaCR', imaging).score);
  });
});
