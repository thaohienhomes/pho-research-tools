/**
 * Is a DOI registered at all, with any agency (Crossref, DataCite, mEDRA…)?
 *
 * Crossref answering 404 only means "not a Crossref DOI": Zenodo, arXiv and
 * many repositories register with DataCite. The DOI handle API answers for
 * every agency, so a DOI unknown here does not exist — which, cited next to a
 * title, is the strongest single sign of a fabricated reference.
 * https://www.doi.org/the-identifier/resources/factsheets/doi-resolution-documentation
 */

import type { HttpClient } from '../http';

export type DoiRegistration = 'registered' | 'unregistered' | 'unknown';

export async function doiRegistration(http: HttpClient, doi: string): Promise<DoiRegistration> {
  const res = await http({ url: `https://doi.org/api/handles/${encodeURIComponent(doi)}` });
  const code = (res.body as { responseCode?: number } | null)?.responseCode;
  // responseCode 1 = handle found, 100 = handle not found (served with HTTP 404).
  if (res.status === 200 && code === 1) return 'registered';
  if (res.status === 404 && code === 100) return 'unregistered';
  return 'unknown';
}
