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
