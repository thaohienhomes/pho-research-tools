/**
 * The only door to the network.
 *
 * Every source module receives an `HttpClient` instead of calling `fetch`, for
 * three reasons:
 *   1. Tests replay recorded responses through the same code path production
 *      runs, so the CI quality bar measures the real pipeline, not a mock of it.
 *   2. The MCP server and the web tools add a persistent cache (`rt_cache`)
 *      by wrapping the client, without this package knowing about a database.
 *   3. Rate limiting and politeness live in one place.
 */

export interface HttpRequest {
  url: string;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON, or `null` when the body was not JSON. */
  body: unknown;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export interface FetchHttpOptions {
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Sent as `mailto:` in the User-Agent (Crossref/Unpaywall polite pool). */
  contactEmail?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function userAgent(contactEmail?: string): string {
  return contactEmail
    ? `pho-scholar/0.1 (+https://pho.chat; mailto:${contactEmail})`
    : 'pho-scholar/0.1 (+https://pho.chat)';
}

/**
 * `fetch`-backed client. Network errors and timeouts are returned as status 0
 * rather than thrown: callers treat 0 as "this source could not be asked",
 * which is a different fact from "this source has nothing".
 *
 * One retry on 429, honouring `Retry-After` up to 3s. Not more: retrying into a
 * rate limiter is the mistake the main app already made and corrected once.
 */
export function createFetchHttp(opts: FetchHttpOptions = {}): HttpClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const ua = userAgent(opts.contactEmail);

  async function once(req: HttpRequest): Promise<HttpResponse & { retryAfterMs?: number }> {
    try {
      const res = await doFetch(req.url, {
        headers: { accept: 'application/json', 'user-agent': ua, ...req.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const ra = Number(res.headers.get('retry-after'));
      return {
        status: res.status,
        body,
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
      };
    } catch {
      return { status: 0, body: null };
    }
  }

  return async (req) => {
    const first = await once(req);
    if (first.status !== 429) return { status: first.status, body: first.body };
    await new Promise((r) => setTimeout(r, Math.min(first.retryAfterMs ?? 1_000, 3_000)));
    const second = await once(req);
    return { status: second.status, body: second.body };
  };
}

export interface ScholarCache {
  get(key: string): Promise<HttpResponse | undefined>;
  set(key: string, value: HttpResponse, ttlSeconds: number): Promise<void>;
}

/** Thirty days, per the brief: bibliographic records barely move. */
export const DEFAULT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Wrap a client with a cache. Only definitive answers are stored: 200 and 404.
 * A 429, a 5xx or a timeout is a statement about the network at that moment,
 * and caching it would keep serving "could not check" for a month.
 *
 * Retraction notices live inside the same Crossref work record as the
 * metadata, and a paper can be retracted tomorrow. `ttlFor` lets the server
 * give `/works/{doi}` a short TTL while search results keep the long one.
 */
export function withCache(
  inner: HttpClient,
  cache: ScholarCache,
  ttlFor: (url: string) => number = () => DEFAULT_CACHE_TTL_SECONDS,
): HttpClient {
  return async (req) => {
    const key = cacheKey(req.url);
    try {
      const hit = await cache.get(key);
      if (hit) return hit;
    } catch {
      // A broken cache must never break verification.
    }
    const res = await inner(req);
    if (res.status === 200 || res.status === 404) {
      try {
        await cache.set(key, res, ttlFor(req.url));
      } catch {
        /* fail-open */
      }
    }
    return res;
  };
}

/**
 * Credentials and contact params are stripped from the key so that two
 * deployments with different keys share entries, and so a key never lands in
 * a cache table.
 */
export function cacheKey(url: string): string {
  try {
    const u = new URL(url);
    for (const p of ['mailto', 'api_key', 'email', 'tool']) u.searchParams.delete(p);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url;
  }
}

/** In-process cache for tests and single-process use. */
export function createMemoryCache(): ScholarCache {
  const store = new Map<string, { value: HttpResponse; expires: number }>();
  return {
    async get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expires < Date.now()) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    async set(key, value, ttlSeconds) {
      store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
    },
  };
}
