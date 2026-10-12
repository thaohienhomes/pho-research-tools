/**
 * DOI extraction, validation, and normalization.
 *
 * Handles formats: bare "10.xxxx/yyyy", "doi:10.xxxx/yyyy", "https://doi.org/10.xxxx/yyyy"
 */

const DOI_REGEX = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;

const DOI_PREFIX_PATTERNS = [
  /^https?:\/\/(?:dx\.)?doi\.org\//i,
  /^doi:\s*/i,
];

/**
 * Extract all DOIs from a text string.
 * Handles URLs (https://doi.org/...), prefixed (doi:...), and bare DOIs.
 */
export function extractDOIs(text: string): string[] {
  const matches = text.match(DOI_REGEX);
  if (!matches) return [];

  // Deduplicate after normalizing
  const seen = new Set<string>();
  const results: string[] = [];
  for (const m of matches) {
    const normalized = normalizeDOI(m);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  }
  return results;
}

/**
 * Check if a string is a valid DOI (starts with 10. prefix pattern).
 */
export function isValidDOI(doi: string): boolean {
  const normalized = normalizeDOI(doi);
  return /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i.test(normalized);
}

/**
 * Normalize a DOI: strip URL/prefix, lowercase.
 */
export function normalizeDOI(doi: string): string {
  let cleaned = doi.trim();
  for (const pattern of DOI_PREFIX_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  // Trailing punctuation from prose. Brackets included, matching what
  // `normalizeDoi` in @pho/research-engine's dedup already strips: a DOI pasted
  // inside parentheses — "(https://doi.org/10.1000/a)" — otherwise keeps its
  // `)` and comes back from CrossRef as not-found.
  cleaned = cleaned.replace(/[.,;)\]]+$/, '');
  return cleaned.toLowerCase();
}
