/**
 * Hugging Face Hub datasets and models, plus the Hugging Science curated index.
 *
 * The Hub's search matches repository names, not descriptions, so one query
 * per distinctive keyword is sent and relevance is judged afterwards from the
 * description and tags. Licence, gating, size, format and linked papers all
 * come from the repository's own tags (`license:cc-by-4.0`, `arxiv:2405.07460`,
 * `size_categories:1K<n<10K`, `format:parquet`).
 *
 * Hugging Science (huggingscience.co) publishes its catalogue of science
 * datasets and models as Markdown at /llms-full.txt. It is read as a list of
 * curated ids that get a ranking boost; it is never the only source.
 * https://huggingface.co/docs/hub/api — `HF_TOKEN` raises the rate limit.
 */

import type { HttpClient } from '../http';
import type { LookupOutcome } from './crossref';

export const HF_BASE = 'https://huggingface.co';
export const HUGGING_SCIENCE_INDEX = 'https://huggingscience.co/llms-full.txt';

export type HfKind = 'dataset' | 'model';

interface HfRepoJson {
  id?: string;
  author?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
  gated?: boolean | string;
  private?: boolean;
  disabled?: boolean;
  description?: string;
  lastModified?: string;
  createdAt?: string;
  pipeline_tag?: string;
  library_name?: string;
  cardData?: { license?: string | string[]; pretty_name?: string; [k: string]: unknown };
}

export interface HfRepo {
  kind: HfKind;
  id: string;
  author: string;
  title: string;
  description?: string;
  /** `license:` tag or card value, verbatim. */
  licence?: string;
  gated: boolean;
  tags: string[];
  arxiv: string[];
  /** DOIs in tags. Hugging Face mints `10.57967/hf/…` DOIs for repositories themselves. */
  dois: string[];
  /** `size_categories:1K<n<10K` → "1K<n<10K". */
  sizeCategory?: string;
  formats: string[];
  modalities: string[];
  libraries: string[];
  pipelineTag?: string;
  downloads: number;
  likes: number;
  updated?: string;
  url: string;
}

/** Hugging Face's own repository DOIs, as opposed to a paper's. */
export const HF_DOI_PREFIX = '10.57967/hf/';

function tagValues(tags: string[], prefix: string): string[] {
  return tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
}

function cleanDescription(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s*…?\s*See the full description on the dataset page:.*$/i, '')
    .replace(/[#*`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mapHfRepo(j: HfRepoJson, kind: HfKind): HfRepo | null {
  if (!j.id || j.private || j.disabled) return null;
  const tags = (j.tags ?? []).filter((t) => typeof t === 'string');
  const cardLicence = Array.isArray(j.cardData?.license) ? j.cardData?.license[0] : j.cardData?.license;
  const licence = tagValues(tags, 'license:')[0] ?? (typeof cardLicence === 'string' ? cardLicence : undefined);
  const pretty = typeof j.cardData?.pretty_name === 'string' ? j.cardData.pretty_name : undefined;
  const description = j.description ? cleanDescription(j.description) : undefined;
  return {
    kind,
    id: j.id,
    author: j.author ?? j.id.split('/')[0] ?? j.id,
    title: pretty || j.id.split('/').pop() || j.id,
    ...(description ? { description } : {}),
    ...(licence ? { licence } : {}),
    gated: j.gated === true || j.gated === 'auto' || j.gated === 'manual',
    tags,
    arxiv: tagValues(tags, 'arxiv:').filter((a) => /^\d{4}\.\d{4,5}$|^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/.test(a)),
    dois: tagValues(tags, 'doi:').map((d) => d.toLowerCase()),
    ...(tagValues(tags, 'size_categories:')[0] ? { sizeCategory: tagValues(tags, 'size_categories:')[0] } : {}),
    formats: tagValues(tags, 'format:'),
    modalities: tagValues(tags, 'modality:'),
    libraries: [...tagValues(tags, 'library:'), ...(j.library_name ? [j.library_name] : [])],
    ...(j.pipeline_tag ? { pipelineTag: j.pipeline_tag } : {}),
    downloads: Number(j.downloads) || 0,
    likes: Number(j.likes) || 0,
    ...(j.lastModified ? { updated: j.lastModified } : {}),
    url: `${HF_BASE}/${kind === 'dataset' ? 'datasets/' : ''}${j.id}`,
  };
}

function authHeaders(token?: string): Record<string, string> | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

/** Repositories whose name contains `term`, most downloaded first. */
export async function hfSearch(
  http: HttpClient,
  kind: HfKind,
  term: string,
  opts: { limit?: number; token?: string } = {},
): Promise<LookupOutcome<HfRepo[]>> {
  const q = new URLSearchParams({
    search: term,
    full: 'true',
    limit: String(opts.limit ?? 20),
    sort: 'downloads',
    direction: '-1',
  });
  const res = await http({ url: `${HF_BASE}/api/${kind}s?${q.toString()}`, headers: authHeaders(opts.token) });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200 || !Array.isArray(res.body)) return { ok: false, reason: 'error' };
  return {
    ok: true,
    value: (res.body as HfRepoJson[]).map((j) => mapHfRepo(j, kind)).filter((r): r is HfRepo => !!r),
  };
}

/** One repository by id. */
export async function hfGet(
  http: HttpClient,
  kind: HfKind,
  id: string,
  opts: { token?: string } = {},
): Promise<LookupOutcome<HfRepo>> {
  // Ids come from third-party text (the curated index), so a "." or ".." segment
  // must never reach the URL and climb out of /api/{kind}s/.
  const segs = id.split('/');
  if (segs.length !== 2 || !segs.every((s) => /^[\w-][\w.-]*$/.test(s) && !/^\.+$/.test(s))) {
    return { ok: false, reason: 'not_found' };
  }
  const res = await http({
    url: `${HF_BASE}/api/${kind}s/${segs.map(encodeURIComponent).join('/')}`,
    headers: authHeaders(opts.token),
  });
  if (res.status === 404 || res.status === 401) return { ok: false, reason: 'not_found' };
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const repo = mapHfRepo(res.body as HfRepoJson, kind);
  return repo ? { ok: true, value: repo } : { ok: false, reason: 'not_found' };
}

export interface CuratedEntry {
  kind: HfKind;
  id: string;
  description: string;
  topics: string[];
}

/**
 * `- [owner/name](https://huggingface.co/datasets/owner/name): Description. [Biology, Genomics]`
 * Only Hugging Face links are kept: those are the ids the Hub API can describe.
 */
export function parseCuratedIndex(text: string): CuratedEntry[] {
  const out: CuratedEntry[] = [];
  const seen = new Set<string>();
  const re = /^\s*[-*]\s*\[[^\]]*\]\(https:\/\/huggingface\.co\/(datasets\/)?([\w.-]+\/[\w.-]+)\/?\)\s*:?\s*(.*)$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const kind: HfKind = m[1] ? 'dataset' : 'model';
    const id = m[2]!;
    const key = `${kind}:${id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rest = m[3] ?? '';
    const topicMatch = /\[([^\]]+)\]\s*$/.exec(rest);
    out.push({
      kind,
      id,
      description: (topicMatch ? rest.slice(0, topicMatch.index) : rest).trim(),
      topics: topicMatch
        ? topicMatch[1]!
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    });
  }
  return out;
}

export async function huggingScienceIndex(http: HttpClient): Promise<LookupOutcome<CuratedEntry[]>> {
  const res = await http({ url: HUGGING_SCIENCE_INDEX, expect: 'text' });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status !== 200 || typeof res.body !== 'string') return { ok: false, reason: 'error' };
  return { ok: true, value: parseCuratedIndex(res.body) };
}
