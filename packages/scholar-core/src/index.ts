export type * from './types';

export {
  createFetchHttp,
  createMemoryCache,
  withCache,
  cacheKey,
  userAgent,
  DEFAULT_CACHE_TTL_SECONDS,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type ScholarCache,
  type FetchHttpOptions,
} from './http';

export {
  parseReferences,
  parseTextReference,
  splitReferenceList,
  parseAuthors,
  stripIdentifiers,
  citationString,
  type ReferenceInput,
} from './parse';

export {
  verifyReference,
  verifyReferences,
  summarize,
  ACCEPT_TITLE,
  SUPPORTED_TITLE,
  AMBIGUOUS_TITLE,
  type VerifyOptions,
  type VerifyManyOptions,
  type VerificationSummary,
} from './verify';

export {
  checkRetraction,
  checkRetractions,
  classifyNotices,
  summaryNotice,
  normalizeDoi,
  titleMarksRetraction,
  type RetractionCheck,
  type CheckRetractionsOptions,
} from './retractions';

export { titleSimilarity, journalMatches, pagesMatch, normalize } from './text';

export {
  formatCitations,
  workToCsl,
  parsedRefToCsl,
  isCitationStyle,
  CITATION_STYLES,
  CITATION_OUTPUTS,
  type CitationStyle,
  type CitationOutput,
  type CitableInput,
  type CslItem,
  type EntrySource,
  type FormattedEntry,
  type FormatResult,
  type FormatOptions,
} from './format';

export {
  searchPapers,
  STUDY_TYPES,
  type KnownStudyType,
  type SearchFilters,
  type SearchOptions,
  type PaperResult,
  type SearchResult,
} from './search';

export {
  prismaFlowDiagram,
  type PrismaCounts,
  type PrismaOtherMethodsCounts,
  type PrismaOptions,
  type PrismaResult,
  type PrismaWarning,
  type PrismaWarningCode,
  type ResolvedCount,
  type NamedCount,
} from './prisma';

export {
  findEvidence,
  evidenceLevel,
  conclusionOf,
  keywordsFromClaim,
  EVIDENCE_LEVELS,
  EVIDENCE_LABELS,
  type EvidenceLevel,
  type EvidenceFilters,
  type EvidenceOptions,
  type EvidencePaper,
  type EvidenceResult,
} from './evidence';

export {
  screeningLog,
  type ScreeningRecord,
  type ScreeningIdentification,
  type ScreeningIssue,
  type ScreeningResult,
  type ScreeningDecision,
  type FullTextDecision,
} from './screening';

export {
  licenceVerdict,
  normalizeLicence,
  LICENCE_LABELS,
  OPEN_VERDICTS,
  type LicenceVerdict,
  type LicenceInfo,
} from './licence';

export {
  findDatasets,
  datasetTerms,
  relevanceOf,
  loadSnippet,
  DATASET_DOMAINS,
  INTENDED_USES,
  MAX_DATASET_RESULTS,
  MIN_RELEVANCE,
  SOURCE_NAMES,
  type DatasetDomain,
  type IntendedUse,
  type DatasetSource,
  type MatchLevel,
  type PaperStatus,
  type DatasetQuery,
  type DatasetOptions,
  type DatasetPaper,
  type DatasetResult,
  type DatasetLookup,
  type DatasetsResult,
} from './datasets';

export {
  findTools,
  toolTerms,
  installFrom,
  healthOf,
  MAX_TOOL_RESULTS,
  type ToolQuery,
  type ToolOptions,
  type ToolInstall,
  type ToolHealth,
  type ToolResult,
  type ToolsResult,
} from './tools';
