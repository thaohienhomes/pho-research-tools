/**
 * Recorded HTTP responses ("cassettes") for the quality test.
 *
 * The quality bar has to measure the real pipeline: parse → Crossref → PubMed
 * → OpenAlex → decision. Calling the live APIs on every CI run would make the
 * gate flaky (rate limits, index updates) and slow, so responses are recorded
 * once and replayed through the same `HttpClient` seam production uses.
 *
 * Modes (env `SCHOLAR_RECORD`):
 *   unset     replay only. A request with no recording returns status 0 and is
 *             listed in `misses`, which the test asserts is empty.
 *   missing   replay, fetch + save anything not yet recorded, and drop
 *             recordings no request used (the full suite runs in this mode).
 * `SCHOLAR_LIVE=1` bypasses cassettes entirely (manual drift check).
 *
 * One JSON file per host, keyed by `cacheKey(url)` so contact emails and API
 * keys never end up in the repository.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheKey, createFetchHttp, type HttpClient, type HttpResponse } from '../../src/http';

/** Keys the pipeline never reads. Dropping them keeps cassettes reviewable. */
const DROP_KEYS = new Set([
  'reference',
  'abstract',
  'license',
  'link',
  'assertion',
  'funder',
  'content-domain',
  'institution',
  'resource',
  'subject',
  'references-count',
  'is-referenced-by-count',
  'indexed',
  'deposited',
  'score',
  'affiliation',
  'ORCID',
  'authenticated-orcid',
  'clinical-trial-number',
  'review',
  'archive',
]);

export function sanitize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (!DROP_KEYS.has(k)) out[k] = sanitize(val);
    return out;
  }
  return v;
}

/** Minimum gap between live requests per host while recording. */
const GAP_MS: Record<string, number> = {
  'eutils.ncbi.nlm.nih.gov': 400,
  // Crossref's public pool answered 429 at ~10 req/s (measured while recording).
  'api.crossref.org': 350,
  'api.openalex.org': 150,
  'doi.org': 100,
};

export interface Cassette {
  http: HttpClient;
  misses: string[];
  /** Write any newly recorded responses to disk. */
  save(): void;
}

export function openCassette(dir: string, opts: { contactEmail?: string } = {}): Cassette {
  const record = process.env.SCHOLAR_RECORD === 'missing';
  const live = createFetchHttp({ contactEmail: opts.contactEmail, timeoutMs: 20_000 });
  const files = new Map<string, Record<string, HttpResponse>>();
  const dirty = new Set<string>();
  const lastCall = new Map<string, number>();
  const misses: string[] = [];
  const used = new Map<string, Set<string>>();

  function tape(host: string): Record<string, HttpResponse> {
    let t = files.get(host);
    if (!t) {
      const p = join(dir, `${host}.json`);
      t = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, HttpResponse>) : {};
      files.set(host, t);
    }
    return t;
  }

  async function throttle(host: string) {
    const gap = GAP_MS[host] ?? 200;
    const wait = (lastCall.get(host) ?? 0) + gap - Date.now();
    lastCall.set(host, Date.now() + Math.max(0, wait));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  const http: HttpClient = async (req) => {
    const host = new URL(req.url).host;
    const key = cacheKey(req.url);
    const t = tape(host);
    if (!used.has(host)) used.set(host, new Set());
    used.get(host)!.add(key);
    const hit = t[key];
    if (hit) return hit;
    if (!record) {
      misses.push(key);
      return { status: 0, body: null };
    }
    await throttle(host);
    const res = await live(req);
    // Only stable answers are recorded; a 429/5xx/timeout must be retried later.
    if (res.status === 200 || res.status === 404) {
      t[key] = { status: res.status, body: sanitize(res.body) };
      dirty.add(host);
    } else {
      misses.push(`${res.status} ${key}`);
    }
    return res;
  };

  return {
    http,
    misses,
    save() {
      // While recording, drop responses no request asked for: a request the
      // code stopped making must not keep its stale answer in the repository.
      if (record) {
        for (const [host, t] of files) {
          const keep = used.get(host) ?? new Set<string>();
          for (const k of Object.keys(t)) {
            if (!keep.has(k)) {
              delete t[k];
              dirty.add(host);
            }
          }
        }
      }
      if (dirty.size === 0) return;
      mkdirSync(dir, { recursive: true });
      for (const host of dirty) {
        const t = files.get(host)!;
        const sorted = Object.fromEntries(Object.keys(t).sort().map((k) => [k, t[k]]));
        writeFileSync(join(dir, `${host}.json`), `${JSON.stringify(sorted, null, 1)}\n`);
      }
      dirty.clear();
    },
  };
}
