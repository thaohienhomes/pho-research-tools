/**
 * findDatasets — open datasets (and optionally models) for a research
 * question, with a licence verdict, the source paper checked, a citation and
 * a line of code to load each one.
 *
 * Like `findEvidence`, this module makes no model call and writes no prose
 * that a database did not support:
 *   - candidates come from DataCite (Zenodo, Figshare, Dryad…), NCBI GEO,
 *     CZ CELLxGENE Discover (single-cell), the CZ CryoET Data Portal and the
 *     Hugging Face Hub, with Hugging Science's curated index as a boost;
 *   - relevance is the share of the question's keywords found in the record;
 *   - the licence verdict is a fixed table (`./licence`);
 *   - a "source paper" is only ever an identifier the repository's metadata
 *     lists (DataCite related identifiers, GEO PubMed ids, the CELLxGENE
 *     collection DOI, CryoET `datasetPublications`, Hugging Face `arxiv:`
 *     tags), then looked up in Crossref / PubMed / DataCite for
 *     existence and retraction or correction notices;
 *   - takeaways are sentences assembled from those facts.
 * Explaining why a dataset fits the question in natural language is left to
 * the assistant that called the tool, which has the question and the facts.
 */

import { formatCitations, type CitationStyle, type CslItem } from './format';
import type { HttpClient } from './http';
import { licenceVerdict, LICENCE_LABELS, OPEN_VERDICTS, type LicenceVerdict } from './licence';
import { classifyNotices } from './retractions';
import { CELLXGENE_LICENCE, cellxgeneCollections, type CellxgeneCollection } from './sources/cellxgene';
import { crossrefGetWork } from './sources/crossref';
import { CRYOET_LICENCE, cryoetSearchDatasets, type CryoetDataset } from './sources/cryoet';
import { dataciteGetDoi, dataciteSearchDatasets, type DataCiteName, type DataCiteRecord } from './sources/datacite';
import { geoSearchSeries, type GeoSeries } from './sources/geo';
import {
  HF_DOI_PREFIX,
  hfGet,
  hfSearch,
  huggingScienceIndex,
  type CuratedEntry,
  type HfKind,
  type HfRepo,
} from './sources/huggingface';
import { pubmedSummaries } from './sources/pubmed';
import { keywordsFromClaim } from './evidence';
import { normalize } from './text';
import type { Work } from './types';

export const DATASET_DOMAINS = [
  'genomics',
  'biology',
  'medicine',
  'chemistry',
  'physics',
  'earth_science',
  'materials',
  'engineering',
  'other',
] as const;
export type DatasetDomain = (typeof DATASET_DOMAINS)[number];

export const INTENDED_USES = ['thesis', 'publication', 'commercial', 'teaching'] as const;
export type IntendedUse = (typeof INTENDED_USES)[number];

export type DatasetSource = 'datacite' | 'geo' | 'cellxgene' | 'cryoet' | 'huggingface';
export type MatchLevel = 'best' | 'good' | 'use_with_care';
export type PaperStatus =
  | 'verified'
  | 'correction'
  | 'concern'
  | 'retracted'
  | 'not_found'
  | 'unchecked'
  | 'none_linked';

export interface DatasetQuery {
  question: string;
  /** English search keywords. Defaults to the question's content words. */
  keywords?: string;
  domain?: DatasetDomain;
  intendedUse?: IntendedUse;
  includeModels?: boolean;
  /** 1–5, default 3. */
  maxResults?: number;
  citationStyle?: CitationStyle;
}

export interface DatasetOptions {
  http: HttpClient;
  contactEmail?: string;
  pubmedApiKey?: string;
  hfToken?: string;
}

export interface DatasetPaper {
  doi?: string;
  pmid?: string;
  arxiv?: string;
  status: PaperStatus;
  /** One sentence on what was checked and what was found. */
  note: string;
  title?: string;
  year?: number;
  journal?: string;
  /** Formatted in the requested style, only when a database record backs it. */
  citation?: string;
}

export interface DatasetResult {
  rank: number;
  kind: 'dataset' | 'model';
  source: DatasetSource;
  /**
   * `owner/name` on Hugging Face, the DOI on DataCite, `GSE…` on GEO, the
   * collection id on CELLxGENE, `CZCDP-…` on the CryoET Data Portal.
   */
  id: string;
  url: string;
  title: string;
  description?: string;
  match: MatchLevel;
  /** Facts behind the match: the keywords found, size, organism, linked paper. */
  why: string;
  matchedTerms: string[];
  /** Share of the keywords found, 0–1. */
  relevance: number;
  licence: { spdx?: string; verdict: LicenceVerdict; label: string; notes: string[] };
  access: 'open' | 'gated' | 'unknown';
  formats: string[];
  /** As the repository states it: "1K<n<10K", "2.1 GB", "198 samples". */
  size?: string;
  nSamples?: number;
  organism?: string;
  year?: number;
  /** The repository's own DOI for the data (Zenodo, Figshare, Hugging Face). */
  datasetDoi?: string;
  paper: DatasetPaper;
  /** The dataset itself, formatted in the requested style. */
  citation: string;
  loadSnippet: string;
  curated: boolean;
}

export interface DatasetLookup {
  source: DatasetSource | 'hugging-science';
  ok: boolean;
  hits: number;
}

export interface DatasetsResult {
  question: string;
  /** The keywords that were searched. */
  terms: string[];
  status: 'ok' | 'unavailable';
  intendedUse: IntendedUse;
  results: DatasetResult[];
  stats: { sourcesScanned: number; results: number; papersVerified: number; warnings: number };
  takeaways: string[];
  warnings: string[];
  lookups: DatasetLookup[];
  /** Search suggestions when nothing relevant was found. */
  suggestions: string[];
}

export const MAX_DATASET_RESULTS = 5;
const DEFAULT_RESULTS = 3;
/** A candidate must contain at least this share of the keywords. */
export const MIN_RELEVANCE = 0.5;
const MAX_TERMS = 8;
const DESCRIPTION_CHARS = 400;
const CURATED_LOOKUPS = 3;
const HF_QUERY_TERMS = 3;
/** CELLxGENE returns every collection; only this many of the best enter the ranking. */
const CELLXGENE_CANDIDATES = 12;

/** Words that describe the request, not the data. */
const REQUEST_WORDS = new Set(
  (
    'data dataset datasets database databases open public publicly available use using used cite citable cited ' +
    'thesis master masters phd dissertation writing write writing research researching question find finding ' +
    'any some good best free download downloadable my our we want need looking look please help project paper ' +
    'papers work working source sources model models also like'
  ).split(' '),
);

/** Too common to search Hugging Face repository names with. */
const GENERIC_WORDS = new Set(
  'gene genes expression analysis study studies cell cells human humans disease diseases patient patients clinical level levels type effect effects'.split(
    ' ',
  ),
);

const BIO_DOMAINS: readonly (DatasetDomain | undefined)[] = ['genomics', 'biology', 'medicine', undefined];

export function datasetTerms(question: string, keywords?: string): string[] {
  const words = keywordsFromClaim(keywords?.trim() ? keywords : question)
    .split(' ')
    .filter((w) => w && !REQUEST_WORDS.has(w));
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** A term matches a word starting with it, allowing plural and -ing/-ion endings. */
export function termRegex(term: string): RegExp {
  const stem = term.length >= 8 ? term.slice(0, -2) : term.length >= 6 ? term.slice(0, -1) : term;
  return new RegExp(`(^|\\s)${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

/** Share of terms found, title hits counting fully and body hits 0.8. */
export function relevanceOf(terms: string[], title: string, body: string): { score: number; matched: string[] } {
  if (terms.length === 0) return { score: 0, matched: [] };
  const t = ` ${normalize(title)} `;
  const b = ` ${normalize(body)} `;
  let sum = 0;
  const matched: string[] = [];
  for (const term of terms) {
    const re = termRegex(term);
    if (re.test(t)) {
      sum += 1;
      matched.push(term);
    } else if (re.test(b)) {
      sum += 0.8;
      matched.push(term);
    }
  }
  return { score: Math.round((sum / terms.length) * 100) / 100, matched };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface PaperRef {
  doi?: string;
  pmid?: string;
  arxiv?: string;
}

interface Name {
  family?: string;
  given?: string;
  literal?: string;
}

interface Candidate {
  kind: 'dataset' | 'model';
  source: DatasetSource;
  id: string;
  url: string;
  title: string;
  description?: string;
  creators: Name[];
  publisher: string;
  year?: number;
  datasetDoi?: string;
  version?: string;
  licenceRaw?: string;
  access: 'open' | 'gated' | 'unknown';
  formats: string[];
  size?: string;
  nSamples?: number;
  organism?: string;
  papers: PaperRef[];
  popularity: number;
  curated: boolean;
  /** Text searched for keywords, besides the title. */
  body: string;
  /** Duplicate key (a concept DOI shared by versions). */
  groupKey: string;
  hf?: HfRepo;
  geo?: GeoSeries;
  cellxgene?: CellxgeneCollection;
}

function shorten(s: string | undefined, max = DESCRIPTION_CHARS): string | undefined {
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s;
}

/** Files named after their role in a paper, not after their content. */
const GENERIC_TITLE =
  /^(supplementa(ry|l)( (material|materials|data|figures?|tables?|information|file))?|additional files?( \d+)?|(figure|fig\.?|table|data|movie|video) s?\d+[a-z]?|data sheet( \d+)?|raw data|dataset( \d+)?|source data( \d+)?)\.?$/i;

function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Bigger studies are more useful to reuse; worth at most a popularity bonus. */
function sampleBonus(n: number | undefined): number {
  return n ? Math.min(0.05, Math.log10(n + 1) / 60) : 0;
}

function fromDataCite(r: DataCiteRecord): Candidate {
  const sizes = r.sizes.join('; ');
  return {
    kind: 'dataset',
    source: 'datacite',
    id: r.doi,
    url: `https://doi.org/${r.doi}`,
    title: r.title,
    ...(r.description ? { description: r.description } : {}),
    creators: r.creators as DataCiteName[],
    publisher: r.publisher ?? 'DataCite',
    ...(r.year ? { year: r.year } : {}),
    datasetDoi: r.doi,
    ...(r.version ? { version: r.version } : {}),
    ...(r.rights ? { licenceRaw: r.rights } : {}),
    access: r.restricted ? 'gated' : 'open',
    formats: r.formats,
    ...(sizes ? { size: sizes } : {}),
    papers: r.papers.map((p) => (p.doi ? { doi: p.doi } : { pmid: p.pmid })),
    popularity: 0,
    curated: false,
    body: [r.description, r.subjects.join(' '), r.formats.join(' ')].filter(Boolean).join(' '),
    groupKey: `doi:${r.versionOf ?? r.doi.replace(/\.v\d+$/, '')}`,
  };
}

function fromGeo(g: GeoSeries): Candidate {
  return {
    kind: 'dataset',
    source: 'geo',
    id: g.accession,
    url: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${g.accession}`,
    title: g.title,
    ...(g.summary ? { description: g.summary } : {}),
    creators: [],
    publisher: 'NCBI Gene Expression Omnibus',
    ...(g.year ? { year: g.year } : {}),
    access: 'open',
    formats: g.suppFiles,
    ...(g.nSamples ? { size: `${g.nSamples} samples`, nSamples: g.nSamples } : {}),
    ...(g.organism ? { organism: g.organism } : {}),
    papers: g.pmids.slice(0, 1).map((pmid) => ({ pmid })),
    popularity: 0,
    curated: false,
    body: [g.summary, g.studyType, g.organism].filter(Boolean).join(' '),
    groupKey: `geo:${g.accession}`,
    geo: g,
  };
}

function fromCellxgene(x: CellxgeneCollection): Candidate {
  const n = x.datasetIds.length;
  const size = [n ? `${n} dataset${n === 1 ? '' : 's'}` : undefined, x.cellCount ? `${x.cellCount.toLocaleString('en-US')} cells` : undefined]
    .filter(Boolean)
    .join(', ');
  return {
    kind: 'dataset',
    source: 'cellxgene',
    id: x.id,
    url: x.url,
    title: x.name,
    ...(x.description ? { description: x.description } : {}),
    creators: x.authors,
    publisher: 'CZ CELLxGENE Discover',
    ...(x.year ? { year: x.year } : {}),
    licenceRaw: CELLXGENE_LICENCE,
    access: 'open',
    formats: ['H5AD'],
    ...(size ? { size } : {}),
    ...(x.organisms.length ? { organism: x.organisms.join(', ') } : {}),
    papers: x.doi ? [{ doi: x.doi }] : [],
    popularity: 0,
    curated: false,
    body: [x.description, x.tissues.join(' '), x.diseases.join(' '), x.assays.join(' '), x.organisms.join(' '), x.consortia.join(' '), 'single cell']
      .filter(Boolean)
      .join(' '),
    groupKey: `cellxgene:${x.id}`,
    cellxgene: x,
  };
}

function fromCryoet(d: CryoetDataset): Candidate {
  return {
    kind: 'dataset',
    source: 'cryoet',
    id: d.accession,
    url: d.url,
    title: d.title,
    ...(d.description ? { description: d.description } : {}),
    creators: [],
    publisher: 'CZ CryoET Data Portal',
    ...(d.year ? { year: d.year } : {}),
    licenceRaw: CRYOET_LICENCE,
    access: 'open',
    formats: [],
    ...(d.fileSizeBytes ? { size: humanBytes(d.fileSizeBytes) } : {}),
    ...(d.organism ? { organism: d.organism } : {}),
    papers: d.paperDois.slice(0, 1).map((doi) => ({ doi })),
    popularity: 0,
    curated: false,
    body: [d.description, d.organism, d.tissue, d.cell, d.cellComponent, d.sampleType, d.relatedEntries.join(' '), 'cryo-electron tomography cryo-et']
      .filter(Boolean)
      .join(' '),
    groupKey: `cryoet:${d.id}`,
  };
}

function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fromHf(h: HfRepo, curated: CuratedEntry | undefined): Candidate {
  const hfDoi = h.dois.find((d) => d.startsWith(HF_DOI_PREFIX));
  const paperDoi = h.dois.find((d) => !d.startsWith(HF_DOI_PREFIX));
  const papers: PaperRef[] = [...(paperDoi ? [{ doi: paperDoi }] : []), ...h.arxiv.map((arxiv) => ({ arxiv }))];
  const year = h.updated ? Number(h.updated.slice(0, 4)) : undefined;
  const description = h.description ?? curated?.description;
  return {
    kind: h.kind,
    source: 'huggingface',
    id: h.id,
    url: h.url,
    title: h.title,
    ...(description ? { description } : {}),
    creators: [{ literal: h.author }],
    publisher: 'Hugging Face',
    ...(year && Number.isFinite(year) ? { year } : {}),
    ...(hfDoi ? { datasetDoi: hfDoi } : {}),
    ...(h.licence ? { licenceRaw: h.licence } : {}),
    access: h.gated ? 'gated' : 'open',
    formats: h.formats,
    ...(h.sizeCategory ? { size: h.sizeCategory } : {}),
    papers,
    popularity: Math.min(0.05, Math.log10(h.downloads + h.likes * 10 + 1) / 120),
    curated: !!curated,
    body: [
      description,
      h.tags.filter((t) => !t.includes(':')).join(' '),
      h.modalities.join(' '),
      curated?.topics.join(' '),
      h.pipelineTag,
    ]
      .filter(Boolean)
      .join(' '),
    groupKey: `hf:${h.kind}:${h.id.toLowerCase()}`,
    hf: h,
  };
}

// ---------------------------------------------------------------------------
// Licence notes: what the repository's licence field cannot tell you
// ---------------------------------------------------------------------------

const CREDENTIALED = [
  { re: /\bmimic(-| )?(iii|iv|cxr|ed)?\b/, name: 'MIMIC (PhysioNet credentialed access)' },
  { re: /\bphysionet\b/, name: 'PhysioNet' },
  { re: /\buk ?biobank\b/, name: 'UK Biobank' },
  { re: /\bdbgap\b/, name: 'dbGaP' },
  { re: /\beuropean genome-phenome archive\b/, name: 'the European Genome-phenome Archive' },
];

const UPSTREAM = [
  {
    re: /\btcga\b|\bcancer genome atlas\b|\bgdc\b/,
    note: 'Built from TCGA data: the NCI Genomic Data Commons terms of use also apply.',
  },
  {
    re: /\bgse\d{3,}\b|\bgene expression omnibus\b/,
    note: 'Built from NCBI GEO series: cite the original GEO study as well.',
  },
  { re: /\bcptac\b/, note: 'Built from CPTAC data: the CPTAC data use terms also apply.' },
];

function licenceFor(c: Candidate, intendedUse: IntendedUse) {
  const notes: string[] = [];
  let info = licenceVerdict(c.licenceRaw);
  if (c.source === 'geo') {
    info = { verdict: 'repository_terms', label: LICENCE_LABELS.repository_terms };
    notes.push(
      'NCBI places no restrictions on GEO data, but the original submitters may hold rights; cite the study that produced it.',
    );
  }
  if (c.source === 'cellxgene') {
    notes.push('CELLxGENE Discover publishes its data under CC BY 4.0: cite the original study and CZ CELLxGENE Discover.');
  }
  if (c.source === 'cryoet') {
    notes.push('The CryoET Data Portal releases its data under CC0; cite the dataset and its publications anyway.');
  }
  if (c.source !== 'geo') {
    const text = ` ${normalize(`${c.title} ${c.description ?? ''}`)} `;
    const cred = CREDENTIALED.find((x) => x.re.test(text));
    if (cred) {
      info = { ...(info.spdx ? { spdx: info.spdx } : {}), verdict: 'unclear', label: LICENCE_LABELS.unclear };
      notes.push(
        `Mentions ${cred.name}, which requires credentialed access to the original data; a copy here does not give you that access.`,
      );
    }
    for (const u of UPSTREAM) if (u.re.test(text)) notes.push(u.note);
    if (c.source === 'huggingface' && c.licenceRaw && notes.length > 0) {
      notes.push('The licence shown is the one the uploader declared on Hugging Face.');
    }
  }
  if (c.access === 'gated') {
    notes.push(
      c.source === 'huggingface'
        ? 'Requires an access request on Hugging Face.'
        : 'Access is restricted: request it from the repository.',
    );
  }
  if (intendedUse === 'commercial' && !OPEN_VERDICTS.includes(info.verdict)) {
    notes.push('Not cleared for commercial use by its licence.');
  }
  return { ...info, notes };
}

// ---------------------------------------------------------------------------
// Source papers
// ---------------------------------------------------------------------------

export async function checkPaper(
  ref: PaperRef | undefined,
  opts: DatasetOptions,
  style: CitationStyle,
): Promise<DatasetPaper> {
  if (!ref) {
    return { status: 'none_linked', note: 'The repository lists no paper for this data. Cite the dataset itself.' };
  }
  if (ref.doi) return paperFromDoi(ref.doi, opts, style, {});
  if (ref.pmid) {
    const r = await pubmedSummaries(opts.http, [ref.pmid], {
      apiKey: opts.pubmedApiKey,
      contactEmail: opts.contactEmail,
    });
    if (!r.ok) {
      return { pmid: ref.pmid, status: 'unchecked', note: `PubMed could not be reached to check PMID ${ref.pmid}.` };
    }
    const work = r.value[0];
    if (!work)
      return {
        pmid: ref.pmid,
        status: 'not_found',
        note: `PMID ${ref.pmid} is listed but PubMed has no record of it.`,
      };
    if (work.doi) return paperFromDoi(work.doi, opts, style, { pmid: ref.pmid, fallback: work });
    return fromWork(
      work,
      { pmid: ref.pmid },
      'Found in PubMed (no DOI, so Crossref notices could not be checked).',
      style,
    );
  }
  const arxiv = ref.arxiv!;
  const r = await dataciteGetDoi(opts.http, `10.48550/arxiv.${arxiv}`);
  if (!r.ok) {
    return r.reason === 'not_found'
      ? { arxiv, status: 'not_found', note: `arXiv:${arxiv} is tagged but has no registered arXiv DOI.` }
      : { arxiv, status: 'unchecked', note: `DataCite could not be reached to check arXiv:${arxiv}.` };
  }
  const rec = r.value;
  const csl: CslItem = {
    id: 'paper',
    type: 'article',
    title: rec.title,
    ...(rec.creators.length ? { author: rec.creators.map(cslName) } : {}),
    ...(rec.year ? { issued: { 'date-parts': [[rec.year]] } } : {}),
    publisher: 'arXiv',
    DOI: rec.doi,
  } as CslItem;
  return {
    arxiv,
    doi: rec.doi,
    status: 'verified',
    note: 'arXiv preprint found (not peer reviewed; arXiv withdrawals are not tracked here).',
    title: rec.title,
    ...(rec.year ? { year: rec.year } : {}),
    journal: 'arXiv',
    citation: cite(csl, style),
  };
}

async function paperFromDoi(
  doi: string,
  opts: DatasetOptions,
  style: CitationStyle,
  extra: { pmid?: string; fallback?: Work },
): Promise<DatasetPaper> {
  const ids = { doi, ...(extra.pmid ? { pmid: extra.pmid } : {}) };
  const r = await crossrefGetWork(opts.http, doi, opts.contactEmail);
  if (r.ok) {
    const status = classifyNotices(r.value.notices, r.value.title);
    const paperStatus: PaperStatus =
      status === 'retracted'
        ? 'retracted'
        : status === 'concern'
          ? 'concern'
          : status === 'corrected'
            ? 'correction'
            : 'verified';
    const note =
      paperStatus === 'retracted'
        ? 'This paper has been RETRACTED. Do not rely on it; check whether the data were affected.'
        : paperStatus === 'concern'
          ? 'An expression of concern has been published for this paper.'
          : paperStatus === 'correction'
            ? 'A correction has been published for this paper; read it before citing.'
            : 'Found in Crossref; no retraction or correction notice.';
    return fromWork(r.value, ids, note, style, paperStatus);
  }
  if (extra.fallback) {
    return fromWork(
      extra.fallback,
      ids,
      'Found in PubMed; Crossref could not confirm retraction status.',
      style,
      'unchecked',
    );
  }
  if (r.reason === 'not_found') {
    // Some publishers register with DataCite or mEDRA rather than Crossref.
    const dc = await dataciteGetDoi(opts.http, doi);
    if (dc.ok) {
      return {
        ...ids,
        status: 'unchecked',
        note: 'Registered DOI (not in Crossref), so retraction notices could not be checked.',
        title: dc.value.title,
        ...(dc.value.year ? { year: dc.value.year } : {}),
      };
    }
    return { ...ids, status: 'not_found', note: 'The DOI listed for this paper is not in Crossref or DataCite.' };
  }
  return { ...ids, status: 'unchecked', note: 'Crossref could not be reached to check this paper.' };
}

function fromWork(
  w: Work,
  ids: { doi?: string; pmid?: string },
  note: string,
  style: CitationStyle,
  status: PaperStatus = 'verified',
): DatasetPaper {
  let citation: string | undefined;
  try {
    citation = formatCitations([w], style).entries[0]?.bibliography || undefined;
  } catch {
    citation = undefined;
  }
  return {
    ...(ids.doi || w.doi ? { doi: ids.doi ?? w.doi } : {}),
    ...(ids.pmid || w.pmid ? { pmid: ids.pmid ?? w.pmid } : {}),
    status,
    note,
    title: w.title,
    ...(w.years[0] ? { year: w.years[0] } : {}),
    ...(w.journals[0] ? { journal: w.journals[0] } : {}),
    ...(citation && status !== 'retracted' ? { citation } : {}),
  };
}

// ---------------------------------------------------------------------------
// Citation and loading
// ---------------------------------------------------------------------------

function cslName(n: Name): { family: string; given?: string } | { literal: string } {
  if (n.family) return { family: n.family, ...(n.given ? { given: n.given } : {}) };
  return { literal: n.literal ?? 'Unknown' };
}

function cite(item: CslItem, style: CitationStyle): string {
  try {
    return formatCitations([item], style).entries[0]?.bibliography ?? '';
  } catch {
    return '';
  }
}

function datasetCitation(c: Candidate, style: CitationStyle): string {
  const item = {
    id: 'data',
    type: 'dataset',
    title: c.source === 'huggingface' ? c.id : c.title,
    ...(c.creators.length ? { author: c.creators.slice(0, 20).map(cslName) } : {}),
    ...(c.year ? { issued: { 'date-parts': [[c.year]] } } : {}),
    publisher: c.publisher,
    ...(c.version ? { version: c.version } : {}),
    ...(c.source === 'geo' || c.source === 'cryoet' ? { number: c.id } : {}),
    ...(c.datasetDoi ? { DOI: c.datasetDoi } : { URL: c.url }),
  } as CslItem;
  return cite(item, style);
}

function pyStr(s: string): string {
  return JSON.stringify(s);
}

export function loadSnippet(
  c: Pick<Candidate, 'kind' | 'source' | 'id' | 'formats' | 'datasetDoi' | 'access'> & {
    url?: string;
    hf?: HfRepo;
    cellxgene?: Pick<CellxgeneCollection, 'datasetIds' | 'organisms'>;
  },
): string {
  if (c.source === 'huggingface') {
    const login = c.access === 'gated' ? '# Request access on the dataset page, then run `hf auth login` once.\n' : '';
    if (c.kind === 'model') {
      if (c.hf?.libraries.includes('transformers')) {
        return `${login}from transformers import AutoModel\nmodel = AutoModel.from_pretrained(${pyStr(c.id)})`;
      }
      return `${login}from huggingface_hub import snapshot_download\npath = snapshot_download(${pyStr(c.id)})`;
    }
    const loadable =
      c.hf?.libraries.includes('datasets') ||
      c.formats.some((f) => /parquet|csv|json|arrow|text|imagefolder|audiofolder|webdataset/i.test(f));
    if (loadable) return `${login}from datasets import load_dataset\nds = load_dataset(${pyStr(c.id)})`;
    return `${login}from huggingface_hub import snapshot_download\npath = snapshot_download(${pyStr(c.id)}, repo_type="dataset")`;
  }
  if (c.source === 'cellxgene') {
    const ids = c.cellxgene?.datasetIds ?? [];
    const organism = c.cellxgene?.organisms.find((o) => o === 'Homo sapiens' || o === 'Mus musculus');
    if (!organism || ids.length === 0) {
      return `# Download the H5AD files from ${c.url ?? "the collection page"}\nimport anndata; adata = anndata.read_h5ad("<file>.h5ad")`;
    }
    const shown = ids.slice(0, 3);
    const more = ids.length > shown.length ? `  # ${ids.length - shown.length} more dataset(s) on the collection page` : '';
    return (
      `import cellxgene_census  # pip install cellxgene-census\n` +
      `with cellxgene_census.open_soma() as census:\n` +
      `    adata = cellxgene_census.get_anndata(\n` +
      `        census, organism=${pyStr(organism)},\n` +
      `        obs_value_filter="dataset_id in [${shown.map((i) => `'${i}'`).join(', ')}]",${more}\n` +
      `    )\n` +
      `# Datasets not yet in the Census: download the H5AD from ${c.url ?? "the collection page"}`
    );
  }
  if (c.source === 'cryoet') {
    const id = Number(c.id.replace(/^CZCDP-/, ''));
    return (
      `from cryoet_data_portal import Client, Dataset  # pip install cryoet-data-portal\n` +
      `ds = Dataset.get_by_id(Client(), ${id})\n` +
      `ds.download_everything()  # tomograms and annotations; check the size first`
    );
  }
  if (c.source === 'geo') {
    return `import GEOparse  # pip install GEOparse\ngse = GEOparse.get_GEO(geo=${pyStr(c.id)})`;
  }
  const reader = readerFor(c.formats);
  const doi = c.datasetDoi ?? c.id;
  const get = /^10\.5281\/zenodo\./.test(doi)
    ? `# pip install zenodo-get\n!zenodo_get ${doi}`
    : `# Download the files from https://doi.org/${doi}`;
  return reader ? `${get}\n${reader}` : get;
}

function readerFor(formats: string[]): string | undefined {
  const f = formats.join(' ').toLowerCase();
  if (/h5ad|anndata/.test(f)) return 'import anndata; adata = anndata.read_h5ad("<file>.h5ad")';
  if (/netcdf|\bnc\b|x-netcdf/.test(f)) return 'import xarray as xr; ds = xr.open_dataset("<file>.nc")';
  if (/zarr/.test(f)) return 'import xarray as xr; ds = xr.open_zarr("<folder>.zarr")';
  if (/parquet/.test(f)) return 'import pandas as pd; df = pd.read_parquet("<file>.parquet")';
  if (/fasta|\bfa\b/.test(f)) return 'from Bio import SeqIO; records = list(SeqIO.parse("<file>.fasta", "fasta"))';
  if (/mmcif|\bcif\b|\bpdb\b/.test(f)) return 'import gemmi; st = gemmi.read_structure("<file>.cif")';
  if (/csv|comma-separated/.test(f)) return 'import pandas as pd; df = pd.read_csv("<file>.csv")';
  if (/tsv|tab-separated|text\/plain/.test(f)) return 'import pandas as pd; df = pd.read_csv("<file>.tsv", sep="\\t")';
  if (/xlsx|excel|spreadsheet/.test(f)) return 'import pandas as pd; df = pd.read_excel("<file>.xlsx")';
  return undefined;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function findDatasets(input: DatasetQuery, opts: DatasetOptions): Promise<DatasetsResult> {
  const question = input.question.trim();
  const intendedUse = input.intendedUse ?? 'publication';
  const style = input.citationStyle ?? 'apa';
  const maxResults = Math.min(MAX_DATASET_RESULTS, Math.max(1, input.maxResults ?? DEFAULT_RESULTS));
  const terms = datasetTerms(question, input.keywords);
  const base = { question, terms, intendedUse };
  if (terms.length === 0) {
    return {
      ...base,
      status: 'unavailable',
      results: [],
      stats: { sourcesScanned: 0, results: 0, papersVerified: 0, warnings: 0 },
      takeaways: [],
      warnings: ['The question has no searchable words.'],
      lookups: [],
      suggestions: ['Pass `keywords` with English words for the topic, e.g. "triple negative breast cancer RNA-seq".'],
    };
  }

  const query = terms.join(' ');
  const hfTerms = [...terms]
    .filter((t) => !GENERIC_WORDS.has(t) && t.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, HF_QUERY_TERMS);
  const useGeo = BIO_DOMAINS.includes(input.domain);
  const kinds: HfKind[] = input.includeModels ? ['dataset', 'model'] : ['dataset'];

  const [dc, geo, cxg, cryo, hfRuns, index] = await Promise.all([
    dataciteSearchDatasets(opts.http, query).then(async (r) =>
      // DataCite matches every word; with no hit, retry on the first half of the keywords.
      r.ok && r.value.length === 0 && terms.length > 3
        ? dataciteSearchDatasets(opts.http, terms.slice(0, Math.ceil(terms.length / 2)).join(' '))
        : r,
    ),
    useGeo
      ? geoSearchSeries(opts.http, query, { apiKey: opts.pubmedApiKey, contactEmail: opts.contactEmail })
      : Promise.resolve(undefined),
    useGeo ? cellxgeneCollections(opts.http) : Promise.resolve(undefined),
    useGeo ? cryoetSearchDatasets(opts.http, terms) : Promise.resolve(undefined),
    Promise.all(kinds.flatMap((k) => hfTerms.map((t) => hfSearch(opts.http, k, t, { token: opts.hfToken })))),
    huggingScienceIndex(opts.http),
  ]);

  const lookups: DatasetLookup[] = [
    { source: 'datacite', ok: dc.ok, hits: dc.ok ? dc.value.length : 0 },
    ...(geo ? [{ source: 'geo' as const, ok: geo.ok, hits: geo.ok ? geo.value.length : 0 }] : []),
    ...(cxg ? [{ source: 'cellxgene' as const, ok: cxg.ok, hits: cxg.ok ? cxgTop(cxg.value, terms).length : 0 }] : []),
    ...(cryo ? [{ source: 'cryoet' as const, ok: cryo.ok, hits: cryo.ok ? cryo.value.length : 0 }] : []),
    {
      source: 'huggingface',
      ok: hfRuns.length === 0 || hfRuns.some((r) => r.ok),
      hits: hfRuns.reduce((n, r) => n + (r.ok ? r.value.length : 0), 0),
    },
    { source: 'hugging-science', ok: index.ok, hits: index.ok ? index.value.length : 0 },
  ];

  const curatedById = new Map<string, CuratedEntry>();
  if (index.ok)
    for (const e of index.value) if (kinds.includes(e.kind)) curatedById.set(`${e.kind}:${e.id.toLowerCase()}`, e);

  // Curated entries that match the question but did not come up in the Hub search.
  const hfSeen = new Set<string>();
  const hfRepos: HfRepo[] = [];
  for (const r of hfRuns)
    if (r.ok)
      for (const h of r.value)
        if (!hfSeen.has(`${h.kind}:${h.id.toLowerCase()}`)) {
          hfSeen.add(`${h.kind}:${h.id.toLowerCase()}`);
          hfRepos.push(h);
        }
  const curatedHits = [...curatedById.values()]
    .map((e) => ({ e, rel: relevanceOf(terms, e.id.replace(/[/_-]/g, ' '), `${e.description} ${e.topics.join(' ')}`) }))
    .filter((x) => x.rel.score >= MIN_RELEVANCE && !hfSeen.has(`${x.e.kind}:${x.e.id.toLowerCase()}`))
    .sort((a, b) => b.rel.score - a.rel.score)
    .slice(0, CURATED_LOOKUPS);
  const curatedRepos = await Promise.all(
    curatedHits.map((x) => hfGet(opts.http, x.e.kind, x.e.id, { token: opts.hfToken })),
  );
  for (const r of curatedRepos) if (r.ok) hfRepos.push(r.value);

  const candidates: Candidate[] = [
    ...(dc.ok ? dc.value.map(fromDataCite) : []),
    ...(geo?.ok ? geo.value.map(fromGeo) : []),
    ...(cxg?.ok ? cxgTop(cxg.value, terms).map(fromCellxgene) : []),
    ...(cryo?.ok ? cryo.value.map(fromCryoet) : []),
    ...hfRepos.map((h) => fromHf(h, curatedById.get(`${h.kind}:${h.id.toLowerCase()}`))),
  ];

  const anySource = lookups.some((l) => l.ok && l.source !== 'hugging-science');
  const warnings: string[] = [];
  for (const l of lookups) {
    if (!l.ok)
      warnings.push(`${SOURCE_LABELS[l.source]} could not be reached, so its datasets are missing from this brief.`);
  }

  // Score, drop weak matches, keep one record per dataset.
  const scored = candidates
    .map((c) => {
      const rel = relevanceOf(
        terms,
        `${c.title} ${c.source === 'huggingface' ? c.id.replace(/[/_-]/g, ' ') : ''}`,
        c.body,
      );
      const licence = licenceVerdict(c.licenceRaw);
      const score =
        rel.score * 0.75 +
        (c.papers.length ? 0.1 : 0) +
        (c.source === 'geo' || licence.verdict !== 'unclear' ? 0.05 : 0) +
        (c.source === 'cellxgene' ? 0.03 : 0) +
        c.popularity +
        sampleBonus(c.nSamples) +
        (c.curated ? 0.1 : 0);
      return { c, rel, score };
    })
    .filter((x) => x.rel.score >= MIN_RELEVANCE && !GENERIC_TITLE.test(x.c.title.trim()))
    .sort((a, b) => b.score - a.score || b.rel.score - a.rel.score);
  // One record per dataset: versions share a concept DOI, and a series split by
  // year or sub-experiment shares its title once the numbers are taken out.
  const seen = new Set<string>();
  const top = scored
    .filter((x) => {
      const keys = [x.c.groupKey, `title:${titleKey(x.c.title)}`];
      if (keys.some((k) => seen.has(k))) return false;
      for (const k of keys) seen.add(k);
      return true;
    })
    .slice(0, maxResults);

  // Papers one at a time: Crossref's public pool allows one request in flight.
  const results: DatasetResult[] = [];
  for (const [i, { c, rel }] of top.entries()) {
    const paper = await checkPaper(c.papers[0], opts, style);
    const licence = licenceFor(c, intendedUse);
    results.push({
      rank: i + 1,
      kind: c.kind,
      source: c.source,
      id: c.id,
      url: c.url,
      title: c.title,
      ...(c.description ? { description: shorten(c.description) } : {}),
      match: matchLevel(rel.score, paper.status, licence.verdict, intendedUse, licence.notes),
      why: whyLine(c, rel.matched, paper),
      matchedTerms: rel.matched,
      relevance: rel.score,
      licence,
      access: c.access,
      formats: c.formats.slice(0, 6),
      ...(c.size ? { size: c.size } : {}),
      ...(c.nSamples ? { nSamples: c.nSamples } : {}),
      ...(c.organism ? { organism: c.organism } : {}),
      ...(c.year ? { year: c.year } : {}),
      ...(c.datasetDoi ? { datasetDoi: c.datasetDoi } : {}),
      paper,
      citation: datasetCitation(c, style),
      loadSnippet: loadSnippet(c),
      curated: c.curated,
    });
  }

  // Best matches first; the order within a level is the score order.
  const ORDER: Record<MatchLevel, number> = { best: 0, good: 1, use_with_care: 2 };
  results.sort((a, b) => ORDER[a.match] - ORDER[b.match] || a.rank - b.rank);
  results.forEach((r, i) => (r.rank = i + 1));

  for (const r of results) {
    if (r.paper.status === 'retracted') warnings.push(`The paper behind ${r.id} has been retracted.`);
    else if (r.paper.status === 'correction') warnings.push(`The paper behind ${r.id} has a published correction.`);
    else if (r.paper.status === 'concern') warnings.push(`The paper behind ${r.id} has an expression of concern.`);
    else if (r.paper.status === 'not_found') warnings.push(`The paper listed for ${r.id} could not be found.`);
  }

  const papersVerified = results.filter((r) => r.paper.status === 'verified' || r.paper.status === 'correction').length;
  return {
    ...base,
    status: anySource ? 'ok' : 'unavailable',
    results,
    stats: { sourcesScanned: candidates.length, results: results.length, papersVerified, warnings: warnings.length },
    takeaways: takeaways(results, intendedUse),
    warnings,
    lookups,
    suggestions: results.length ? [] : suggestionsFor(terms),
  };
}

/**
 * The collections worth ranking: CELLxGENE answers with all of them, so only
 * those that reach the relevance bar, best first, become candidates.
 */
function cxgTop(all: CellxgeneCollection[], terms: string[]): CellxgeneCollection[] {
  return all
    .map((x) => ({
      x,
      rel: relevanceOf(terms, x.name, `${x.description ?? ''} ${x.tissues.join(' ')} ${x.diseases.join(' ')} ${x.assays.join(' ')} single cell`),
    }))
    .filter((r) => r.rel.score >= MIN_RELEVANCE)
    .sort((a, b) => b.rel.score - a.rel.score)
    .slice(0, CELLXGENE_CANDIDATES)
    .map((r) => r.x);
}

const SOURCE_LABELS: Record<DatasetLookup['source'], string> = {
  datacite: 'DataCite (Zenodo, Figshare, Dryad)',
  geo: 'NCBI GEO',
  cellxgene: 'CZ CELLxGENE Discover',
  cryoet: 'The CZ CryoET Data Portal',
  huggingface: 'Hugging Face',
  'hugging-science': 'The Hugging Science index',
};

export const SOURCE_NAMES: Record<DatasetSource, string> = {
  datacite: 'DataCite',
  geo: 'NCBI GEO',
  cellxgene: 'CZ CELLxGENE Discover',
  cryoet: 'CZ CryoET Data Portal',
  huggingface: 'Hugging Face',
};

function matchLevel(
  relevance: number,
  paper: PaperStatus,
  verdict: LicenceVerdict,
  intendedUse: IntendedUse,
  notes: string[],
): MatchLevel {
  if (paper === 'retracted' || paper === 'not_found') return 'use_with_care';
  if (intendedUse === 'commercial' && !OPEN_VERDICTS.includes(verdict)) return 'use_with_care';
  if (verdict === 'unclear' && notes.some((n) => /credentialed/.test(n))) return 'use_with_care';
  if (relevance >= 0.8 && paper === 'verified' && verdict !== 'unclear') return 'best';
  if (relevance >= 0.6) return 'good';
  return 'use_with_care';
}

function whyLine(c: Candidate, matched: string[], paper: DatasetPaper): string {
  const parts = [`Matches ${matched.map((m) => `"${m}"`).join(', ')}`];
  if (c.nSamples) parts.push(`${c.nSamples} samples`);
  else if (c.size) parts.push(`size ${c.size}`);
  if (c.organism) parts.push(c.organism);
  if (paper.status === 'verified' && paper.year)
    parts.push(`linked paper ${paper.journal ? `in ${paper.journal}, ` : ''}${paper.year}`);
  if (c.curated) parts.push('listed in the Hugging Science index');
  return `${parts.join(' · ')}.`;
}

/** Lower-cases a sentence's first letter, but not an acronym's ("OK", "CC BY"). */
function lowerFirst(s: string): string {
  return /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function takeaways(results: DatasetResult[], intendedUse: IntendedUse): string[] {
  if (results.length === 0) return [];
  const out: string[] = [];
  const first = results.find((r) => r.match === 'best') ?? results.find((r) => r.match === 'good');
  if (first) {
    const facts = [
      first.paper.status === 'verified' ? 'its source paper checks out' : undefined,
      first.licence.verdict === 'unclear'
        ? undefined
        : lowerFirst(first.licence.label),
    ].filter(Boolean);
    // CELLxGENE ids are bare UUIDs, which tell a reader nothing; its titles are short.
    const name = first.source === 'cellxgene' ? `"${first.title}"` : first.id;
    out.push(`Start with ${name}${facts.length ? `: ${facts.join('; ')}` : ''}.`);
  }
  const restricted = results.filter((r) =>
    intendedUse === 'commercial' ? !OPEN_VERDICTS.includes(r.licence.verdict) : r.licence.verdict === 'unclear',
  );
  if (restricted.length) {
    out.push(
      intendedUse === 'commercial'
        ? `${restricted.length} of ${results.length} are not cleared for commercial use; check their licences before building on them.`
        : `${restricted.length} of ${results.length} have no clear licence; confirm the terms with the repository before you publish with them.`,
    );
  }
  const noPaper = results.filter((r) => r.paper.status === 'none_linked');
  if (noPaper.length) {
    out.push(
      `${noPaper.length} of ${results.length} list no source paper, so describe how the data were collected from the repository page and cite the dataset itself.`,
    );
  }
  const gated = results.filter((r) => r.access === 'gated');
  if (gated.length && out.length < 3) out.push(`${gated.length} need an access request before you can download them.`);
  return out.slice(0, 3);
}

function suggestionsFor(terms: string[]): string[] {
  return [
    'Use fewer, broader English keywords (the main disease, organism or measurement).',
    terms.length > 4
      ? `Try just "${terms.slice(0, 3).join(' ')}".`
      : 'Add the measurement type, e.g. "RNA-seq", "proteomics", "imaging".',
    'Controlled-access data (dbGaP, EGA, UK Biobank) is not searched here; apply through those portals.',
  ];
}
