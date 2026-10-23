/**
 * Licence verdicts for datasets and models: a fixed table, never a model call.
 *
 * The input is whatever the repository's metadata says (an SPDX id, a Hugging
 * Face `license:` tag, a Creative Commons URL). The verdict says what a
 * researcher may do with the data in plain words. When the metadata says
 * nothing usable, the verdict is `unclear`: an unknown licence is not an open
 * one.
 */

export type LicenceVerdict =
  | 'ok_publication_commercial'
  | 'ok_share_alike'
  | 'non_commercial'
  | 'no_derivatives'
  | 'repository_terms'
  | 'unclear';

export const LICENCE_LABELS: Record<LicenceVerdict, string> = {
  ok_publication_commercial: 'OK for thesis, publication and commercial use (credit the source)',
  ok_share_alike: 'OK to use; anything you derive from it must keep the same licence',
  non_commercial: 'Non-commercial only (fine for a thesis or teaching)',
  no_derivatives: 'You cannot share modified versions',
  repository_terms: 'Public repository data: free to use, cite the original study',
  unclear: 'Licence unclear: read its terms on the source page before you use it',
};

/** Verdicts that allow any use, including commercial. */
export const OPEN_VERDICTS: readonly LicenceVerdict[] = ['ok_publication_commercial', 'ok_share_alike'];

export interface LicenceInfo {
  /** Normalised identifier (`cc-by-4.0`), when one could be read. */
  spdx?: string;
  verdict: LicenceVerdict;
  label: string;
}

/** Creative Commons URL → SPDX-style id: `.../licenses/by-nc/4.0/` → `cc-by-nc-4.0`. */
function fromCcUrl(s: string): string | undefined {
  if (/creativecommons\.org\/publicdomain\/zero/.test(s)) return 'cc0-1.0';
  const m = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d(?:\.\d)?)/.exec(s);
  return m ? `cc-${m[1]}-${m[2]}` : undefined;
}

export function normalizeLicence(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().toLowerCase();
  if (!s) return undefined;
  const cc = fromCcUrl(s);
  if (cc) return cc;
  if (/opensource\.org\/licenses\/mit/.test(s)) return 'mit';
  if (/apache\.org\/licenses\/license-2\.0/.test(s)) return 'apache-2.0';
  s = s
    .replace(/^license:/, '')
    .replace(/^creative commons\s+/, 'cc ')
    .replace(/attribution/g, 'by')
    .replace(/non-?commercial/g, 'nc')
    .replace(/share-?alike/g, 'sa')
    .replace(/no-?derivatives?/g, 'nd')
    .replace(/\binternational\b|\blicen[cs]e\b|\bpublic\b/g, '')
    .replace(/[\s_/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (s === 'cc0' || s === 'cc-zero' || s === 'cc0-1-0') return 'cc0-1.0';
  return s || undefined;
}

/**
 * The table from the spec. Anything not listed (including `other`, `unknown`,
 * custom model licences such as `openrail` or `llama3`) is `unclear`.
 */
export function licenceVerdict(raw: string | undefined | null): LicenceInfo {
  const spdx = normalizeLicence(raw);
  const v = verdictFor(spdx);
  return { ...(spdx ? { spdx } : {}), verdict: v, label: LICENCE_LABELS[v] };
}

function verdictFor(id: string | undefined): LicenceVerdict {
  if (!id) return 'unclear';
  if (/^cc-by-nc/.test(id)) return 'non_commercial';
  if (/^cc-by-nd/.test(id)) return 'no_derivatives';
  if (
    /^cc-by-sa/.test(id) ||
    /^odbl/.test(id) ||
    /^(a|l)?gpl/.test(id) ||
    /^mpl-2/.test(id) ||
    /^epl-/.test(id) ||
    /^eupl-/.test(id) ||
    /^cecill/.test(id)
  ) {
    return 'ok_share_alike';
  }
  if (
    /^cc0/.test(id) ||
    /^cc-by-\d/.test(id) ||
    id === 'cc-by' ||
    id === 'mit' ||
    /^apache-2/.test(id) ||
    /^bsd/.test(id) ||
    /^odc-by/.test(id) ||
    /^pddl/.test(id) ||
    id === 'unlicense' ||
    id === '0bsd' ||
    id === 'isc' ||
    id === 'zlib' ||
    id === 'bsl-1.0' ||
    id === 'artistic-2.0' ||
    id === 'postgresql' ||
    /^python-2/.test(id)
  ) {
    return 'ok_publication_commercial';
  }
  return 'unclear';
}
