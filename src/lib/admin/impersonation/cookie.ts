import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getServerConfig } from '@/lib/config/server';

const COOKIE_NAME = 'rw_impersonation';

const MIN_SECRET_LENGTH = 32;

function getSecret(): string {
  const value = getServerConfig().IMPERSONATION_COOKIE_SECRET;
  if (!value) throw new Error('IMPERSONATION_COOKIE_SECRET not configured');
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `IMPERSONATION_COOKIE_SECRET too short (min ${MIN_SECRET_LENGTH} chars)`,
    );
  }
  return value;
}

export function assertImpersonationCookieConfigured(): void {
  getSecret();
}

export function signImpersonationSession(sessionId: string): string {
  const sig = createHmac('sha256', getSecret()).update(sessionId).digest('hex');
  return `${sessionId}.${sig}`;
}

export function verifyImpersonationSession(value: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [sessionId, sig] = parts;
  if (!sessionId || !sig) return null;
  const expected = createHmac('sha256', getSecret()).update(sessionId).digest('hex');
  if (expected.length !== sig.length) return null;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig)) ? sessionId : null;
}

/**
 * Is this request carrying an impersonation session? The ONE definition
 * (architecture pass 2026-09-12, H1-B) — there were two byte-identical private
 * copies, in `api/operator/turns/route.ts` and `api/settings/auto-approval/
 * route.ts`, and Run B's apply and decline routes would have made four.
 *
 * PRESENCE, not validity: the routes that call this REFUSE on presence, so an
 * unverifiable cookie must refuse too. Verifying here would mean a forged
 * cookie fails `verifyImpersonationSession`, reads as "not impersonating", and
 * the write goes through — the opposite of the intent. `verifyImpersonationSession`
 * above stays the gate for anything that ACTS on the session.
 *
 * `import type { NextRequest }`: only the shape is needed, so no runtime
 * `next/server` import enters a module the worker can reach.
 */
export function hasImpersonationCookie(request: NextRequest): boolean {
  return Boolean(request.cookies.get(COOKIE_NAME)?.value);
}

export { COOKIE_NAME as IMPERSONATION_COOKIE_NAME };
