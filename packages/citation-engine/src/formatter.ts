/**
 * Citation formatters — APA 7th, Vancouver (ICMJE), AMA 11th, Harvard, BibTeX.
 *
 * AMA matters specifically for this product: it is the house style of most US
 * medical journals (JAMA and family), and it was the one style a medical
 * research tool could not offer.
 */

import type { CitationMetadata, CitationAuthor } from './types';

// -- Author formatting helpers --

function initialsWithDots(given: string): string {
  return given
    .split(/[\s-]+/)
    .map((n) => `${n[0]?.toUpperCase() ?? ''}.`)
    .join(' ');
}

function initialsNoDots(given: string): string {
  return given
    .split(/[\s-]+/)
    .map((n) => n[0]?.toUpperCase() ?? '')
    .join('');
}

function yearOrNd(year: number): string {
  return year > 0 ? String(year) : 'n.d.';
}

// -- APA 7th --

function formatAuthorsAPA(authors: CitationAuthor[]): string {
  if (authors.length === 0) return '';

  const fmt = authors.map((a) => {
    const initials = a.given ? initialsWithDots(a.given) : '';
    return initials ? `${a.family}, ${initials}` : a.family;
  });

  if (fmt.length === 1) return fmt[0]!;
  if (fmt.length === 2) return `${fmt[0]} & ${fmt[1]}`;
  if (fmt.length <= 20) {
    return `${fmt.slice(0, -1).join(', ')}, & ${fmt[fmt.length - 1]}`;
  }
  return `${fmt.slice(0, 19).join(', ')}, ... ${fmt[fmt.length - 1]}`;
}

/**
 * APA 7th Edition format.
 * @example "Nguyen, H. T., & Tran, V. M. (2024). Title. *Journal*, 12(3), 45-67. https://doi.org/10.xxx"
 */
export function formatAPA(meta: CitationMetadata): string {
  const authors = formatAuthorsAPA(meta.authors);
  const year = yearOrNd(meta.year);
  let citation = '';

  if (authors) citation += `${authors} `;
  citation += `(${year}). ${meta.title}.`;

  if (meta.journal) {
    citation += ` *${meta.journal}*`;
    if (meta.volume) citation += `, ${meta.volume}`;
    if (meta.issue) citation += `(${meta.issue})`;
    if (meta.pages) citation += `, ${meta.pages}`;
    citation += '.';
  }

  // A record without a DOI used to render the literal string
  // "https://doi.org/undefined" into the reference list. Fall back to the URL,
  // and print nothing at all when there is neither.
  if (meta.doi) citation += ` https://doi.org/${meta.doi}`;
  else if (meta.url) citation += ` ${meta.url}`;
  return citation.trim();
}

// -- Vancouver --

function formatAuthorsVancouver(authors: CitationAuthor[]): string {
  if (authors.length === 0) return '';

  const fmt = authors.map((a) => {
    const initials = a.given ? initialsNoDots(a.given) : '';
    return initials ? `${a.family} ${initials}` : a.family;
  });

  if (fmt.length <= 6) return fmt.join(', ');
  return `${fmt.slice(0, 6).join(', ')}, et al.`;
}

/**
 * Vancouver (ICMJE) format.
 * @example "Nguyen HT, Tran VM. Title. Journal. 2024;12(3):45-67."
 */
export function formatVancouver(meta: CitationMetadata): string {
  const authors = formatAuthorsVancouver(meta.authors);
  const year = yearOrNd(meta.year);
  let citation = '';

  if (authors) citation += `${authors}. `;
  citation += `${meta.title}. `;

  if (meta.journal) {
    citation += `${meta.journal}. ${year}`;
    if (meta.volume) citation += `;${meta.volume}`;
    if (meta.issue) citation += `(${meta.issue})`;
    if (meta.pages) citation += `:${meta.pages}`;
    citation += '.';
  } else {
    citation += `${year}.`;
  }

  // ICMJE asks for the DOI when one exists; the previous implementation
  // dropped it, so a Vancouver list exported from here was not submittable
  // without hand-editing every entry.
  if (meta.doi) citation += ` doi:${meta.doi}`;
  else if (meta.url) citation += ` ${meta.url}`;

  return citation.trim();
}

// -- AMA 11th --

/**
 * AMA lists up to 6 authors in full; with MORE than 6 it prints the first
 * three followed by "et al." (Vancouver/ICMJE keeps six — the cutoffs differ,
 * which is exactly the kind of detail a reviewer notices.)
 */
function formatAuthorsAMA(authors: CitationAuthor[]): string {
  if (authors.length === 0) return '';

  const fmt = authors.map((a) => {
    const initials = a.given ? initialsNoDots(a.given) : '';
    return initials ? `${a.family} ${initials}` : a.family;
  });

  if (fmt.length <= 6) return fmt.join(', ');
  return `${fmt.slice(0, 3).join(', ')}, et al`;
}

/**
 * AMA 11th Edition format.
 * @example "Nguyen HT, Tran VM. Title of the article. JAMA. 2024;12(3):45-67. doi:10.1001/x"
 */
export function formatAMA(meta: CitationMetadata): string {
  const authors = formatAuthorsAMA(meta.authors);
  const year = yearOrNd(meta.year);
  let citation = '';

  if (authors) citation += `${authors}. `;
  citation += `${meta.title}. `;

  if (meta.journal) {
    citation += `${meta.journal}. ${year}`;
    if (meta.volume) citation += `;${meta.volume}`;
    if (meta.issue) citation += `(${meta.issue})`;
    if (meta.pages) citation += `:${meta.pages}`;
    citation += '.';
  } else {
    citation += `${year}.`;
  }

  if (meta.doi) citation += ` doi:${meta.doi}`;
  else if (meta.url) citation += ` ${meta.url}`;

  return citation.trim();
}

// -- Harvard --

function formatAuthorsHarvard(authors: CitationAuthor[]): string {
  if (authors.length === 0) return '';

  const fmt = authors.map((a) => {
    const initials = a.given ? initialsWithDots(a.given) : '';
    return initials ? `${a.family}, ${initials}` : a.family;
  });

  if (fmt.length === 1) return fmt[0]!;
  if (fmt.length === 2) return `${fmt[0]} and ${fmt[1]}`;
  return `${fmt.slice(0, -1).join(', ')} and ${fmt[fmt.length - 1]}`;
}

/**
 * Harvard format.
 * @example "Nguyen, H. T. and Tran, V. M. (2024) 'Title', *Journal*, 12(3), pp. 45-67."
 */
export function formatHarvard(meta: CitationMetadata): string {
  const authors = formatAuthorsHarvard(meta.authors);
  const year = yearOrNd(meta.year);
  let citation = '';

  if (authors) citation += `${authors} `;
  citation += `(${year}) '${meta.title}'`;

  if (meta.journal) {
    citation += `, *${meta.journal}*`;
    if (meta.volume) citation += `, ${meta.volume}`;
    if (meta.issue) citation += `(${meta.issue})`;
    if (meta.pages) citation += `, pp. ${meta.pages}`;
  }

  citation += '.';
  return citation.trim();
}

// -- BibTeX --

function sanitizeBibKey(str: string): string {
  return str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * BibTeX format.
 * @example "@article{nguyen2024title, author={Nguyen, H. T. and Tran, V. M.}, ...}"
 */
export function formatBibTeX(meta: CitationMetadata): string {
  const firstAuthor = meta.authors[0]?.family ?? 'unknown';
  const titleWord = meta.title.split(/\s+/)[0] ?? 'untitled';
  const year = meta.year > 0 ? String(meta.year) : 'nd';
  const key = sanitizeBibKey(`${firstAuthor}${year}${titleWord}`);

  const authorStr = meta.authors
    .map((a) => (a.given ? `${a.family}, ${a.given}` : a.family))
    .join(' and ');

  const fields: string[] = [
    `  author = {${authorStr}}`,
    `  title = {${meta.title}}`,
  ];

  if (meta.journal) fields.push(`  journal = {${meta.journal}}`);
  if (meta.year > 0) fields.push(`  year = {${year}}`);
  if (meta.volume) fields.push(`  volume = {${meta.volume}}`);
  if (meta.issue) fields.push(`  number = {${meta.issue}}`);
  if (meta.pages) fields.push(`  pages = {${meta.pages}}`);
  if (meta.publisher) fields.push(`  publisher = {${meta.publisher}}`);
  fields.push(`  doi = {${meta.doi}}`);

  return `@article{${key},\n${fields.join(',\n')}\n}`;
}
