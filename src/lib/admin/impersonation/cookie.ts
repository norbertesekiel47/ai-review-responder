import type { NextRequest } from 'next/server';
import { getServerConfig } from '@/lib/config/server';
import { signValue, verifySignedValue, type SignedValueOptions } from '@/lib/shared/signed-value';

// The stored digest is hex (`.digest('hex')`), but it is compared as literal
// UTF-8 TEXT rather than decoded hex bytes — a deliberate deviation from the
// hex-decode compare every other HMAC-signed cookie in this codebase uses.
// `signed-value.ts` preserves it rather than normalizing it: switching to a
// hex-decode compare would not change acceptance for THIS alphabet (a hex
// digest is pure ASCII, so utf8 bytes and would-be hex-decoded bytes still
// agree/disagree the same way), but there is no reason to touch a working
// wire format for #1370, which is a consolidation, not a behavior change.
const IMPERSONATION_SIGNED_VALUE_OPTIONS: SignedValueOptions = { compareEncoding: 'utf8' };

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
  return signValue(sessionId, getSecret(), IMPERSONATION_SIGNED_VALUE_OPTIONS);
}

export function verifyImpersonationSession(value: string): string | null {
  return verifySignedValue(value, getSecret(), IMPERSONATION_SIGNED_VALUE_OPTIONS);
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
