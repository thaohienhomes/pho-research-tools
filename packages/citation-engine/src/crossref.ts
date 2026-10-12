/**
 * CrossRef API client — resolves DOIs and searches papers.
 *
 * Uses the polite pool (mailto header) for better rate limits (50 req/s).
 * API docs: https://api.crossref.org/
 */

import type { CitationMetadata } from './types';
import { normalizeDOI } from './doi-parser';

const BASE_URL = 'https://api.crossref.org';
const USER_AGENT = 'PhoChat/2.0 (mailto:hi@pho.chat)';
const TIMEOUT_MS = 10_000;

// -- CrossRef raw types (internal) --

interface CrossRefAuthor {
  given?: string;
  family?: string;
  name?: string;
  ORCID?: string;
}

interface CrossRefWork {
  DOI: string;
  title: string[];
  author?: CrossRefAuthor[];
  'container-title'?: string[];
  published?: { 'date-parts': number[][] };
  volume?: string;
  issue?: string;
  page?: string;
  type?: string;
  publisher?: string;
  abstract?: string;
  URL?: string;
  'is-referenced-by-count'?: number;
  license?: { URL: string }[];
}

// -- Internal helpers --

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string, maxRetries = 2): Promise<Response> {
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchWithTimeout(url);
    if (res.status !== 429) return res;

    lastRes = res;
    const waitMs = Math.min(1000 * 2 ** attempt, 4000);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  return lastRes!;
}

function extractYear(work: CrossRefWork): number {
  const parts = work.published?.['date-parts']?.[0];
  return parts?.[0] ?? 0;
}

function mapWork(work: CrossRefWork): CitationMetadata {
  return {
    doi: work.DOI,
    title: work.title?.[0] ?? 'Untitled',
    authors: (work.author ?? []).map((a) => ({
      given: a.given ?? '',
      family: a.family ?? a.name ?? '',
      orcid: a.ORCID,
    })),
    journal: work['container-title']?.[0] ?? '',
    year: extractYear(work),
    volume: work.volume,
    issue: work.issue,
    pages: work.page,
    url: work.URL ?? `https://doi.org/${work.DOI}`,
    type: work.type ?? 'unknown',
    publisher: work.publisher,
    abstract: work.abstract,
    citationCount: work['is-referenced-by-count'],
    license: work.license?.[0]?.URL,
  };
}

// -- Public API --

export class DOINotFoundError extends Error {
  constructor(doi: string) {
    super(`DOI not found: ${doi}`);
    this.name = 'DOINotFoundError';
  }
}

export class CrossRefNetworkError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'CrossRefNetworkError';
  }
}

/**
 * Resolve a DOI to its full citation metadata.
 *
 * @throws {DOINotFoundError} if the DOI does not exist
 * @throws {CrossRefNetworkError} on network or API errors
 */
export async function resolveDOI(doi: string): Promise<CitationMetadata> {
  const normalized = normalizeDOI(doi);
  const url = `${BASE_URL}/works/${encodeURIComponent(normalized)}?mailto=hi@pho.chat`;

  let res: Response;
  try {
    res = await fetchWithRetry(url);
  } catch (err) {
    throw new CrossRefNetworkError(
      `Network error resolving DOI ${normalized}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === 404) {
    throw new DOINotFoundError(normalized);
  }

  if (!res.ok) {
    throw new CrossRefNetworkError(
      `CrossRef API error: HTTP ${res.status}`,
      res.status,
    );
  }

  const data = await res.json();
  return mapWork(data.message as CrossRefWork);
}

/**
 * Search CrossRef for works matching a title/query string.
 */
export async function searchByTitle(
  title: string,
  limit = 5,
): Promise<CitationMetadata[]> {
  const url = `${BASE_URL}/works?query=${encodeURIComponent(title)}&rows=${limit}&mailto=hi@pho.chat`;

  let res: Response;
  try {
    res = await fetchWithRetry(url);
  } catch (err) {
    throw new CrossRefNetworkError(
      `Network error searching CrossRef: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new CrossRefNetworkError(
      `CrossRef search error: HTTP ${res.status}`,
      res.status,
    );
  }

  const data = await res.json();
  const items = (data.message?.items ?? []) as CrossRefWork[];
  return items.map(mapWork);
}
