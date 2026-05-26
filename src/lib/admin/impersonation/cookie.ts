import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'rw_impersonation';

function getSecret(): string {
  const value = process.env.IMPERSONATION_COOKIE_SECRET;
  if (!value) throw new Error('IMPERSONATION_COOKIE_SECRET not configured');
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

export { COOKIE_NAME as IMPERSONATION_COOKIE_NAME };
