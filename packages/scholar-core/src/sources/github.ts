/**
 * GitHub repository facts used to say whether a tool is still maintained:
 * when the last push happened, whether the repository is archived, and the
 * licence GitHub detected. Unauthenticated requests are enough for the few
 * repositories one answer needs.
 */

import type { HttpClient } from '../http';
import type { LookupOutcome } from './crossref';

export interface GithubRepo {
  owner: string;
  name: string;
  url: string;
  archived: boolean;
  /** ISO timestamp of the last push to any branch. */
  pushedAt?: string;
  /** SPDX id GitHub detected; absent when it detected none. */
  licence?: string;
}

const PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** `owner/name` from a github.com URL, or undefined for anything else. */
export function githubRepoOf(url: string): { owner: string; name: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return undefined;
  const [owner, rawName] = u.pathname.split('/').filter(Boolean);
  const name = rawName?.replace(/\.git$/, '');
  if (!owner || !name || !PART.test(owner) || !PART.test(name)) return undefined;
  return { owner, name };
}

export async function githubRepo(
  http: HttpClient,
  ref: { owner: string; name: string },
  token?: string,
): Promise<LookupOutcome<GithubRepo | null>> {
  const res = await http({
    url: `https://api.github.com/repos/${ref.owner}/${ref.name}`,
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404 || res.status === 451) return { ok: true, value: null };
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const b = res.body as {
    archived?: boolean;
    pushed_at?: string;
    html_url?: string;
    license?: { spdx_id?: string } | null;
  } | null;
  if (!b) return { ok: false, reason: 'error' };
  const spdx = b.license?.spdx_id;
  return {
    ok: true,
    value: {
      owner: ref.owner,
      name: ref.name,
      url: `https://github.com/${ref.owner}/${ref.name}`,
      archived: b.archived === true,
      ...(typeof b.pushed_at === 'string' ? { pushedAt: b.pushed_at } : {}),
      ...(spdx && spdx !== 'NOASSERTION' ? { licence: spdx } : {}),
    },
  };
}
