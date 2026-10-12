/**
 * Stateless links to a rendered PRISMA diagram.
 *
 * The counts travel in the URL (deflate + base64url), so the image endpoint
 * stores nothing and the link keeps working for as long as the server does.
 * The diagram is re-drawn from the counts on every request, which takes a few
 * milliseconds.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { PrismaCounts, PrismaOptions } from '@pho/scholar-core';

export interface PrismaPayload {
  counts: PrismaCounts;
  options?: Pick<PrismaOptions, 'otherMethods' | 'footnotes'>;
}

/** Longest encoded payload accepted; keeps URLs under common proxy limits. */
export const MAX_ENCODED_CHARS = 6000;

export function encodePrismaPayload(p: PrismaPayload): string {
  return deflateRawSync(Buffer.from(JSON.stringify(p))).toString('base64url');
}

export function decodePrismaPayload(encoded: string): PrismaPayload | null {
  if (!encoded || encoded.length > MAX_ENCODED_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    // maxOutputLength guards against a decompression bomb.
    const json = inflateRawSync(Buffer.from(encoded, 'base64url'), { maxOutputLength: 64 * 1024 }).toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('counts' in parsed)) return null;
    return parsed as PrismaPayload;
  } catch {
    return null;
  }
}

export function prismaLinks(base: string, p: PrismaPayload): { png: string; svg: string } | null {
  const d = encodePrismaPayload(p);
  if (d.length > MAX_ENCODED_CHARS) return null;
  return { png: `${base}/prisma/${d}.png`, svg: `${base}/prisma/${d}.svg` };
}
