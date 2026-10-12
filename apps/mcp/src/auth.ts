/**
 * Optional sign-in with a Phở account (Clerk as the OAuth authorization server).
 *
 * The MCP endpoint never requires a token: anonymous use keeps working. A token
 * only raises the allowance. Clients sign in by connecting to `/mcp/login`,
 * which answers 401 with RFC 9728 protected-resource metadata, so an MCP client
 * (Claude, ChatGPT, Cursor…) runs the OAuth flow against Clerk and comes back
 * with a bearer token.
 *
 * Tokens are checked against Clerk's `/oauth/userinfo` endpoint. That needs no
 * secret on this server and works for both opaque and JWT access tokens.
 */

import { createHash } from 'node:crypto';

export interface VerifiedUser {
  /** Clerk user id (`user_…`). */
  userId: string;
}

export type TokenCheck =
  | { kind: 'valid'; user: VerifiedUser }
  /** The authorization server rejected the token: expired, revoked or forged. */
  | { kind: 'invalid' }
  /** Clerk could not be asked. Not the caller's fault. */
  | { kind: 'unavailable' };

export type TokenVerifier = (token: string) => Promise<TokenCheck>;

export const SCOPES_SUPPORTED = ['profile', 'email'];

/** Successful lookups are reused for this long, so one chat does not ask Clerk on every call. */
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 5000;

export function createClerkVerifier(issuer: string, fetchImpl: typeof fetch = fetch): TokenVerifier {
  const cache = new Map<string, { user: VerifiedUser; until: number }>();
  return async (token) => {
    // Key by hash: the cache must not hold usable tokens.
    const key = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.until > now) return { kind: 'valid', user: hit.user };

    let res: Response;
    try {
      res = await fetchImpl(`${issuer}/oauth/userinfo`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return { kind: 'unavailable' };
    }
    if (res.status === 401 || res.status === 403) return { kind: 'invalid' };
    if (!res.ok) return { kind: 'unavailable' };
    const body = (await res.json().catch(() => null)) as { user_id?: unknown; sub?: unknown } | null;
    const userId = typeof body?.user_id === 'string' ? body.user_id : typeof body?.sub === 'string' ? body.sub : undefined;
    if (!userId) return { kind: 'invalid' };

    if (cache.size >= CACHE_MAX) {
      for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
      if (cache.size >= CACHE_MAX) cache.clear();
    }
    cache.set(key, { user: { userId }, until: now + CACHE_MS });
    return { kind: 'valid', user: { userId } };
  };
}

/** `Authorization: Bearer <token>`, or undefined. */
export function bearerToken(headers: Headers): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(headers.get('authorization') ?? '');
  return m?.[1];
}

/** RFC 9728 §3.1: metadata for resource `${base}${path}` lives at `/.well-known/oauth-protected-resource${path}`. */
export function resourceMetadataUrl(base: string, path: string): string {
  return `${base}/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadata(base: string, path: string, issuer: string) {
  return {
    resource: `${base}${path}`,
    authorization_servers: [issuer],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'Phở Research Tools',
    resource_documentation: 'https://pho.chat/tools/mcp/',
  };
}

/** RFC 6750 §3 challenge pointing the client at the metadata (MCP authorization spec). */
export function wwwAuthenticate(base: string, path: string, error?: 'invalid_token'): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(base, path)}"`, `scope="${SCOPES_SUPPORTED.join(' ')}"`];
  if (error) parts.unshift(`error="${error}"`);
  return `Bearer ${parts.join(', ')}`;
}
