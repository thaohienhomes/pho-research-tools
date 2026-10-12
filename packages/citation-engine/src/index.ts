export type {
  CitationMetadata,
  CitationAuthor,
  CitationStyle,
  NumericCitationStyle,
} from './types';

export {
  extractDOIs,
  isValidDOI,
  normalizeDOI,
} from './doi-parser';

export {
  resolveDOI,
  searchByTitle,
  DOINotFoundError,
  CrossRefNetworkError,
} from './crossref';

export {
  formatAPA,
  formatVancouver,
  formatAMA,
  formatHarvard,
  formatBibTeX,
} from './formatter';

export type {
  ReferenceOrdering,
  OrderableReference,
  ReferenceListResult,
} from './reference-list';
export {
  buildReferenceList,
  remapCitationMarkers,
  isVietnameseSource,
  vietnameseSortKey,
  latinSortKey,
} from './reference-list';

export type { ParsedReference, ParsedBibliography } from './parsed-reference';
export { parsePersonName } from './parsed-reference';

export { parseBibTeX } from './bibtex-parser';
export { parseRIS } from './ris-parser';
