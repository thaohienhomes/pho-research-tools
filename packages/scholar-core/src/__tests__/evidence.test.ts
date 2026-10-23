import { describe, expect, it } from 'vitest';
import { conclusionOf, evidenceLevel, findEvidence, keywordsFromClaim } from '../evidence';
import type { HttpClient, HttpRequest } from '../http';
import { cleanAbstract } from '../sources/europepmc';
import { abstractFromInvertedIndex } from '../sources/openalex';

describe('evidenceLevel', () => {
  it('reads PubMed publication types before the title', () => {
    expect(evidenceLevel(['Journal Article', 'Meta-Analysis', 'Review'], 'Coffee and diabetes')).toEqual({
      level: 'meta-analysis',
      from: 'publication-type',
    });
    expect(evidenceLevel(['Practice Guideline'], 'x').level).toBe('guideline');
    expect(evidenceLevel(['Randomized Controlled Trial', 'Journal Article'], 'x').level).toBe('rct');
    expect(evidenceLevel(['Clinical Trial, Phase III'], 'x').level).toBe('clinical-trial');
    expect(evidenceLevel(['Case Reports'], 'x').level).toBe('case-report');
  });

  it('falls back to title words, and never calls a review a meta-analysis from its abstract', () => {
    expect(evidenceLevel([], 'Coffee consumption and risk of type 2 diabetes: a systematic review').level).toBe(
      'systematic-review',
    );
    expect(evidenceLevel([], 'A dose-response meta-analysis of coffee').level).toBe('meta-analysis');
    expect(evidenceLevel([], 'Coffee and diabetes in a prospective cohort of nurses')).toEqual({
      level: 'observational',
      from: 'title',
    });
    expect(evidenceLevel(['Journal Article', 'Review'], 'Coffee: an update').level).toBe('review');
    expect(evidenceLevel(['Journal Article'], 'Coffee and glucose').level).toBe('other');
  });
});

describe('evidenceLevel: protocols', () => {
  it('ranks a protocol or analysis plan below results, even when PubMed tags it as an RCT', () => {
    expect(evidenceLevel(['Clinical Trial Protocol', 'Journal Article'], 'x').level).toBe('protocol');
    expect(
      evidenceLevel(
        ['Randomized Controlled Trial', 'Journal Article'],
        'Pneumococcal vaccine schedules (PVS) study: a cluster-randomised, non-inferiority trial of an alternative versus standard schedule for pneumococcal conjugate vaccination-statistical analysis plan',
      ),
    ).toEqual({ level: 'protocol', from: 'title' });
    expect(
      evidenceLevel(
        [],
        'Evaluation of the effect of reduced-dose pneumococcal conjugate vaccine schedules on vaccine serotype carriage in children and their caretakers in a naïve population in Vietnam: Protocol for a cluster randomized non-inferiority trial',
      ).level,
    ).toBe('protocol');
    expect(
      evidenceLevel([], 'Simplified 0+1 and 1+1 pneumococcal vaccine schedules in Ho Chi Minh City, Vietnam: protocol for a randomised controlled trial').level,
    ).toBe('protocol');
  });

  it('does not mistake a trial result that mentions a protocol for one', () => {
    expect(evidenceLevel(['Randomized Controlled Trial'], 'Per-protocol and intention-to-treat effects of drug X').level).toBe('rct');
    expect(evidenceLevel([], 'A randomised trial of an enhanced recovery protocol after colectomy').level).toBe('rct');
  });
});

describe('conclusionOf', () => {
  it('takes the text after the last conclusion heading', () => {
    const a =
      'BACKGROUND: Coffee is widely drunk. RESULTS: Nine cohorts were pooled (RR 0.65). CONCLUSIONS: This systematic review supports the hypothesis that habitual coffee consumption is associated with a substantially lower risk of type 2 diabetes.';
    expect(conclusionOf(a)).toEqual({
      text: 'This systematic review supports the hypothesis that habitual coffee consumption is associated with a substantially lower risk of type 2 diabetes.',
      from: 'section',
    });
  });

  it('stops at the next heading and handles JAMA-style labels', () => {
    const a =
      'IMPORTANCE: x. CONCLUSIONS AND RELEVANCE: Coffee was not associated with risk in this trial. TRIAL REGISTRATION: NCT0001.';
    expect(conclusionOf(a)?.text).toBe('Coffee was not associated with risk in this trial.');
  });

  it('uses the last two sentences of an unstructured abstract', () => {
    const r = conclusionOf('We studied coffee. Risk fell by 30%. Further trials are needed.');
    expect(r).toEqual({ text: 'Risk fell by 30%. Further trials are needed.', from: 'last-sentences' });
  });
});

describe('source helpers', () => {
  it('turns Europe PMC headings into labels a reader can find', () => {
    expect(cleanAbstract('<h4>Background</h4>Coffee.<h4>Conclusions</h4>It <i>lowers</i> risk &amp; more.')).toBe(
      'BACKGROUND: Coffee. CONCLUSIONS: It lowers risk & more.',
    );
  });

  it('rebuilds an OpenAlex abstract from its inverted index', () => {
    expect(abstractFromInvertedIndex({ Coffee: [0], lowers: [1], risk: [2, 4], and: [3] })).toBe(
      'Coffee lowers risk and risk',
    );
    expect(abstractFromInvertedIndex(null)).toBeUndefined();
  });

  it('keeps the content words of a claim', () => {
    expect(keywordsFromClaim('Does drinking coffee reduce the risk of type 2 diabetes?')).toBe(
      'drinking coffee reduce risk type diabetes',
    );
  });
});

// ── findEvidence through a fake network ──────────────────────────────

const epmc = (
  pmid: string,
  title: string,
  pubType: string[],
  abstractText?: string,
  extra: Record<string, unknown> = {},
) => ({
  pmid,
  title,
  authorString: 'Ding M, Bhupathiraju SN.',
  journalInfo: { yearOfPublication: 2014, journal: { title: 'Diabetes care' } },
  pubTypeList: { pubType },
  ...(abstractText ? { abstractText } : {}),
  isOpenAccess: 'N',
  ...extra,
});

function fakeNetwork(opts: { epmcDown?: boolean } = {}) {
  const calls: string[] = [];
  const http: HttpClient = async (req: HttpRequest) => {
    const url = new URL(req.url);
    calls.push(url.host + url.pathname);
    if (url.pathname.endsWith('/esearch.fcgi')) {
      const term = url.searchParams.get('term') ?? '';
      const ids = term.includes('"meta-analysis"[pt]') ? ['1', '9'] : ['2', '3', '4', '1', '5'];
      return { status: 200, body: { esearchresult: { idlist: ids } } };
    }
    if (url.pathname.endsWith('/esummary.fcgi')) {
      return {
        status: 200,
        body: {
          result: {
            1: {
              uid: '1',
              title: 'Coffee and diabetes: a meta-analysis.',
              pubdate: '2014',
              pubtype: ['Journal Article'],
            },
            2: { uid: '2', title: 'Coffee in a prospective cohort.', pubdate: '2010', pubtype: ['Journal Article'] },
          },
        },
      };
    }
    if (url.host === 'www.ebi.ac.uk') {
      if (opts.epmcDown) return { status: 503, body: null };
      return {
        status: 200,
        body: {
          hitCount: 6,
          resultList: {
            result: [
              epmc(
                '1',
                'Caffeinated and decaffeinated coffee and risk of type 2 diabetes',
                ['Meta-Analysis', 'Journal Article'],
                '<h4>Results</h4>RR 0.92.<h4>Conclusions</h4>Coffee consumption is inversely associated with type 2 diabetes.',
              ),
              epmc(
                '2',
                'Coffee drinking in a prospective cohort',
                ['Journal Article'],
                'We followed nurses. Coffee lowered risk.',
              ),
              epmc('3', 'RETRACTED: Coffee cures diabetes', ['Retracted Publication', 'Journal Article'], 'x.'),
              epmc('4', 'Erratum to coffee paper', ['Published Erratum'], 'x.'),
              epmc(
                '5',
                'Caffeine and insulin sensitivity: a randomised crossover trial',
                ['Randomized Controlled Trial'],
                'CONCLUSION: Acute caffeine reduced insulin sensitivity.',
              ),
              epmc('9', 'Coffee and health: guideline', ['Practice Guideline'], undefined),
            ],
          },
        },
      };
    }
    if (url.host === 'api.openalex.org') {
      return {
        status: 200,
        body: {
          results: [
            // Same paper as PMID 2: must merge, not repeat.
            {
              id: 'https://openalex.org/W1',
              doi: null,
              title: 'Coffee drinking in a prospective cohort',
              publication_year: 2010,
              ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/2' },
              type: 'article',
              open_access: { is_oa: false },
            },
            // Not in PubMed: kept from OpenAlex with its own abstract.
            {
              id: 'https://openalex.org/W2',
              doi: 'https://doi.org/10.1000/xyz',
              title: 'Coffee and metabolic health in Vietnamese adults',
              publication_year: 2021,
              type: 'preprint',
              open_access: { is_oa: true },
              abstract_inverted_index: { Coffee: [0], helped: [1] },
            },
            // An open peer-review report is not a paper and must not be listed.
            {
              id: 'https://openalex.org/W4',
              doi: 'https://doi.org/10.21956/x.1.r1',
              title: 'Peer Review Report For: Coffee and diabetes [version 1; peer review: 2 approved]',
              publication_year: 2023,
              type: 'peer-review',
            },
            {
              id: 'https://openalex.org/W3',
              doi: 'https://doi.org/10.1000/ret',
              title: 'Withdrawn coffee study',
              is_retracted: true,
              type: 'article',
            },
          ],
        },
      };
    }
    return { status: 404, body: null };
  };
  return { http, calls };
}

describe('findEvidence', () => {
  it('ranks by level of evidence, hydrates abstracts and drops retractions and notices', async () => {
    const { http } = fakeNetwork();
    const r = await findEvidence('Does drinking coffee reduce diabetes risk?', {}, { http });
    expect(r.status).toBe('ok');
    expect(r.query).toBe('drinking coffee reduce diabetes risk');
    expect(r.papers.map((p) => p.pmid ?? p.doi)).toEqual(['9', '1', '5', '2', '10.1000/xyz']);
    expect(r.papers.map((p) => p.level)).toEqual(['guideline', 'meta-analysis', 'rct', 'observational', 'other']);
    expect(r.papers[1]!.conclusion).toBe('Coffee consumption is inversely associated with type 2 diabetes.');
    expect(r.papers[1]!.conclusionFrom).toBe('section');
    expect(r.papers[3]!.foundIn).toEqual(['pubmed', 'openalex']);
    expect(r.papers[4]).toMatchObject({ preprint: true, foundIn: ['openalex'], abstract: 'Coffee helped' });
    expect(r.excluded).toEqual({ retracted: 2, notices: 1, preprints: 0 });
    expect(r.withoutAbstract).toBe(1);
    expect(r.byLevel).toEqual({ guideline: 1, 'meta-analysis': 1, rct: 1, observational: 1, other: 1 });
  });

  it('can leave preprints out and caps the number of papers', async () => {
    const { http } = fakeNetwork();
    const r = await findEvidence('coffee diabetes', { includePreprints: false, maxResults: 2 }, { http });
    expect(r.papers).toHaveLength(2);
    expect(r.excluded.preprints).toBe(1);
  });

  it('still lists real PubMed papers when Europe PMC is down', async () => {
    const { http } = fakeNetwork({ epmcDown: true });
    const r = await findEvidence('coffee diabetes', {}, { http });
    expect(r.status).toBe('ok');
    expect(r.papers.find((p) => p.pmid === '1')).toMatchObject({ level: 'meta-analysis', levelFrom: 'title' });
    expect(r.papers.find((p) => p.pmid === '1')?.conclusion).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/Europe PMC/);
  });

  it('refuses a claim with nothing to search for', async () => {
    const { http, calls } = fakeNetwork();
    const r = await findEvidence('is it?', {}, { http });
    expect(r.status).toBe('unavailable');
    expect(calls).toEqual([]);
  });
});
