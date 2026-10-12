/**
 * Who is calling: an anonymous subject for quotas and a coarse client name for
 * analytics. Neither stores an IP address or anything that identifies a person;
 * the subject is a salted hash.
 */

import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

export interface Caller {
  /**
   * sha256(salt | quotaKey(ip)), hex, 32 chars. Stable for one address (one
   * IPv6 /64) per salt.
   * The client name is deliberately NOT part of it: the User-Agent is chosen by
   * the caller, so including it would let anyone multiply their allowance by
   * rotating it. The trade-off is that one network (a university NAT) shares
   * one allowance across all its clients.
   */
  subject: string;
  /** `claude`, `chatgpt`, `cursor`… or `unknown`. */
  client: string;
  /** `user` once a Phở account token was verified; the subject is then per account, not per network. */
  auth: 'anon' | 'user';
}

const CLIENT_PATTERNS: [RegExp, string][] = [
  [/claude-code|claude code/i, 'claude-code'],
  [/claude|anthropic/i, 'claude'],
  [/openai|chatgpt/i, 'chatgpt'],
  [/cursor/i, 'cursor'],
  [/perplexity/i, 'perplexity'],
  [/grok|xai/i, 'grok'],
  [/openclaw/i, 'openclaw'],
  [/vscode|copilot/i, 'vscode'],
  [/mcp-inspector|inspector/i, 'mcp-inspector'],
];

export function detectClient(userAgent: string | undefined): string {
  if (!userAgent) return 'unknown';
  for (const [re, name] of CLIENT_PATTERNS) if (re.test(userAgent)) return name;
  return 'unknown';
}

export function clientIp(headers: Headers, trustProxy: boolean, socketIp?: string): string {
  if (trustProxy) {
    // The RIGHTMOST entry is the one our proxy appended. Anything to its left
    // was sent by the client and can be forged to dodge the quota.
    const forwarded = headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded) return forwarded;
    const real = headers.get('x-real-ip')?.trim();
    if (real) return real;
  }
  return socketIp ?? 'unknown';
}

/**
 * The unit a quota is charged to. IPv4 is the address itself. IPv6 is the /64
 * prefix: an ISP hands one customer a whole /64 (often more), so per-address
 * counting would let anyone rotate addresses for a fresh allowance. IPv4-mapped
 * IPv6 (`::ffff:1.2.3.4`) is the IPv4 address.
 */
export function quotaKey(ip: string): string {
  const raw = ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (isIPv4(raw)) return raw;
  if (!isIPv6(raw)) return raw.toLowerCase();
  const groups = expandIPv6(raw);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** Eight 16-bit groups of a valid IPv6 address, handling `::` and a trailing dotted IPv4. */
function expandIPv6(ip: string): number[] {
  let s = ip.toLowerCase();
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number);
    s = s.slice(0, -dotted[1]!.length) + `${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

export function identifyCaller(headers: Headers, opts: { salt: string; trustProxy: boolean; socketIp?: string }): Caller {
  const ip = clientIp(headers, opts.trustProxy, opts.socketIp);
  const ua = headers.get('user-agent') ?? '';
  // The free web tools (apps/tools) call this server from the browser, where the
  // User-Agent cannot be set; they name themselves with this header instead.
  const client = headers.get('x-pho-client') === 'tools-web' ? 'pho-tools-web' : detectClient(ua);
  const subject = createHash('sha256').update(`${opts.salt}|${quotaKey(ip)}`).digest('hex').slice(0, 32);
  return { subject, client, auth: 'anon' };
}

/** A signed-in caller: one allowance per Phở account, wherever it connects from. */
export function signedInCaller(anon: Caller, userId: string, salt: string): Caller {
  const subject = createHash('sha256').update(`${salt}|user|${userId}`).digest('hex').slice(0, 32);
  return { subject, client: anon.client, auth: 'user' };
}
