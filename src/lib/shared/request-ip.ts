import type { NextRequest } from 'next/server';

/**
 * Build a rate-limit key prefixed by the request IP. Uses the leftmost
 * `x-forwarded-for` entry (set by Vercel / Next.js's edge), falling back
 * to `'unknown'` when the header is absent. Prefer this over inline parsing
 * so every callsite produces a consistent key shape.
 */
export function getIpKey(req: NextRequest, prefix: string): string {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return `${prefix}:ip:${ip}`;
}
