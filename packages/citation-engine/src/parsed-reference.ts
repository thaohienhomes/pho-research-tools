import type { CitationAuthor } from './types';

/**
 * A reference as it was written in a user's `.bib` / `.ris` file.
 *
 * Deliberately NOT `CitationMetadata`. That type requires `doi`, `journal`,
 * `url` and `type`, because it describes a record we resolved from CrossRef and
 * therefore know. A file exported from EndNote or Zotero knows no such thing:
 * plenty of entries carry a title and nothing else. Forcing them into
 * `CitationMetadata` would mean writing `doi: ''` and `url: ''`, i.e. inventing
 * emptiness that reads downstream as fact.
 *
 * So the import path is honest in two stages: parse to `ParsedReference` (what
 * the file actually said), then resolve the entries that carry a DOI to real
 * `CitationMetadata`. Entries without a DOI survive as what they are rather than
 * being dropped or padded.
 */
export interface ParsedReference {
  /** The one field we insist on — an entry with no title is not a reference. */
  title: string;
  authors: CitationAuthor[];
  year?: number;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  /** Entry type verbatim from the source (`article`, `JOUR`, …), lowercased. */
  type?: string;
}

/**
 * What a reader made of a file.
 *
 * `skipped` exists because "we read your file and found 12 references" is a
 * different statement from "your file had 12 references". An entry with no
 * title, or one whose braces never close, is dropped — and a count of zero
 * dropped entries is the only thing that makes the first statement safe to
 * show. Returning a bare array made that distinction unrepresentable.
 */
export interface ParsedBibliography {
  references: ParsedReference[];
  /** Entries the reader saw but could not use. */
  skipped: number;
}

/**
 * Split a bibliography author string into `CitationAuthor`s.
 *
 * Shared by both parsers because both formats converge on the same two shapes:
 * `Family, Given` (BibTeX canonical, RIS canonical) and `Given Family` (what
 * people actually type). The comma is the only reliable signal, so it decides:
 * with a comma the family name is on the left, without one it is the last word.
 *
 * Exported for tests — the surname rule is where this silently goes wrong for
 * Vietnamese names, and a wrong split corrupts every citation built from it.
 */
export function parsePersonName(raw: string): CitationAuthor | null {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return null;

  const comma = name.indexOf(',');
  if (comma >= 0) {
    const family = name.slice(0, comma).trim();
    const given = name.slice(comma + 1).trim();
    if (!family) return null;
    return { given, family };
  }

  const parts = name.split(' ');
  if (parts.length === 1) return { given: '', family: parts[0]! };
  return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1]! };
}
