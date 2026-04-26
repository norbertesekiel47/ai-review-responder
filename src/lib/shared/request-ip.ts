import type { NextRequest } from 'next/server';

/**
 * Build a rate-limit key prefixed by the request IP. Uses the leftmost
 * `x-forwarded-for` entry (set by Vercel / Next.js's edge), falling back
 * to `'unknown'` when the header is absent OR effectively empty. Prefer
 * this over inline parsing so every callsite produces a consistent key
 * shape.
 *
 * The `??` operator only catches null/undefined, not empty strings. The
 * pre-fix version returned `${prefix}:ip:` (empty IP) when the header
 * was '', '   ', or ', 1.2.3.4' (leading comma), collapsing every
 * anonymous request into a single bucket and enabling trivial rate-limit
 * dodging — an attacker could spoof `X-Forwarded-For: ` with an empty
 * value to join the global "no-IP" bucket and share its quota with every
 * other malformed request.
 *
 * Now: trim, check truthiness, fall back to `'unknown'`. The key shape
 * `${prefix}:ip:${ip}` is guaranteed to receive a non-empty `ip`.
 */
export function getIpKey(req: NextRequest, prefix: string): string {
  const raw = req.headers.get('x-forwarded-for');
  const first = raw?.split(',')[0]?.trim();
  const ip = first && first.length > 0 ? first : 'unknown';
  return `${prefix}:ip:${ip}`;
}
