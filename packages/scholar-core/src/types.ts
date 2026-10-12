/**
 * Shared types for scholar-core.
 *
 * Two shapes carry the whole package and they are deliberately distinct:
 * `ParsedRef` is what the user's text SAID, `Work` is what a bibliographic
 * database HOLDS. Verification is the comparison of the two; collapsing them
 * into one type is how a tool ends up "correcting" a reference into a paper it
 * never cited.
 */

export interface Author {
  family: string;
  given?: string;
}

export type RefFormat = 'bibtex' | 'ris' | 'csl-json' | 'doi' | 'text';

/** One reference as the user wrote it. Every field except `raw` is optional. */
export interface ParsedRef {
  /** Position in the input, 0-based. Stable across verify/format so rows line up. */
  index: number;
  /** The reference exactly as it appeared (one entry, not the whole list). */
  raw: string;
  format: RefFormat;
  title?: string;
  authors: Author[];
  year?: number;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  pmid?: string;
  url?: string;
  /** Entry type when the format states one (`article`, `JOUR`, `book`…). */
  type?: string;
}

/** A retraction / correction / concern notice attached to a work. */
export interface RetractionNotice {
  /** Crossref update type verbatim (`retraction`, `expression_of_concern`…). */
  type: string;
  label: string;
  date?: string;
  /** Where the flag came from: `retraction-watch`, `publisher`, `crossref-title`, `pubmed`, `openalex`. */
  source: string;
  /** DOI of the notice itself, so a reader can go and look. */
  noticeDoi?: string;
}

export type WorkSource = 'crossref' | 'pubmed' | 'openalex';

/** A record as a bibliographic database holds it. */
export interface Work {
  source: WorkSource;
  title: string;
  authors: Author[];
  /** Every year this work can legitimately be cited with (print, online, issued). */
  years: number[];
  /** Full container titles and abbreviations, all of which are acceptable. */
  journals: string[];
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  pmid?: string;
  /** PubMed Central id (`PMC1234567`): a free full text exists. */
  pmcid?: string;
  openalexId?: string;
  type?: string;
  notices: RetractionNotice[];
  /**
   * The record is itself a notice (a retraction/correction document), not a
   * paper. Crossref expresses this as a non-empty `update-to`. Such records
   * share most of their title with the paper they retract and must never be
   * mistaken for it.
   */
  isNotice?: boolean;
}

export type VerificationStatus =
  | 'verified'
  | 'verified_with_corrections'
  | 'likely_fabricated'
  | 'not_found'
  | 'retracted'
  | 'ambiguous';

export type MismatchField =
  | 'title'
  | 'authors'
  | 'year'
  | 'journal'
  | 'volume'
  | 'issue'
  | 'pages'
  | 'doi';

export interface FieldMismatch {
  field: MismatchField;
  /** What the reference says. */
  cited: string;
  /** What the matched record says. */
  found: string;
}

export interface SourceLinks {
  doi?: string;
  pubmed?: string;
  openalex?: string;
}

export type RetractionStatus =
  | 'retracted'
  | 'concern'
  | 'corrected'
  | 'other_notice'
  | 'no_notice'
  | 'not_in_crossref'
  | 'invalid_doi'
  | 'rate_limited'
  | 'lookup_failed';

/** Why a reference ended up `not_found`, so the UI can say something useful. */
export type NotFoundReason = 'insufficient_data' | 'lookup_failed' | 'not_indexed';

export interface LookupLog {
  source: WorkSource | 'doi.org';
  /** `ok` = the source answered (even with zero hits). */
  ok: boolean;
  hits: number;
}

export interface VerificationResult {
  index: number;
  input: ParsedRef;
  status: VerificationStatus;
  /** 0–1: how sure we are of `status` (not of the paper being good). */
  confidence: number;
  /** One plain-English sentence explaining the status. */
  summary: string;
  match?: Work;
  mismatches: FieldMismatch[];
  links: SourceLinks;
  retraction?: { status: RetractionStatus; notices: RetractionNotice[] };
  notFoundReason?: NotFoundReason;
  /** Title similarity of the best candidate, 0–1 (diagnostics + CI report). */
  titleScore: number;
  lookups: LookupLog[];
}
