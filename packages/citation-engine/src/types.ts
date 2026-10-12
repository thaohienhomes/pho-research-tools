export interface CitationAuthor {
  given: string;
  family: string;
  orcid?: string;
}

export interface CitationMetadata {
  doi: string;
  title: string;
  authors: CitationAuthor[];
  journal: string;
  year: number;
  volume?: string;
  issue?: string;
  pages?: string;
  url: string;
  type: string;
  publisher?: string;
  abstract?: string;
  citationCount?: number;
  isOpenAccess?: boolean;
  license?: string;
}

export type CitationStyle = 'apa' | 'vancouver' | 'ama' | 'bibtex' | 'harvard';

/**
 * Styles that number their references and cite them as `[N]` in the text.
 * Only these are safe for the manuscript export, whose drafted bodies already
 * carry `[N]` markers — an author-date style needs those markers converted,
 * not renumbered.
 */
export type NumericCitationStyle = Extract<CitationStyle, 'vancouver' | 'ama'>;
