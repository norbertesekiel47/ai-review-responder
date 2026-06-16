import { createHash, createHmac } from 'node:crypto';
import { getSessionCookieSecret } from '@/lib/shared/session-cookie-secret';

const KEEP_MY_DATA_TOKEN_CONTEXT = 'repworth:account-offboarding-keep-my-data-token:v1';

export function hashAccountOffboardingToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

// The raw keep-my-data token is a deterministic HMAC of the offboarding id +
// delivery id under SESSION_COOKIE_SECRET — no per-token random salt. This is an
// accepted, bounded design: the trust boundary is the same server secret that
// already gates the fresh-auth cookie HMAC (destructive-auth.ts), so a secret
// compromise is already catastrophic and this does not widen it. The action it
// authorizes (keep-my-data) only CANCELS a scheduled deletion — it cannot
// exfiltrate data or grant access — so the blast radius is bounded even if a token
// were forged. The hash (never the raw token) is the only value persisted
// (invariant #5). A per-token random salt stored alongside the hash would remove
// the "secret alone mints any token" property if that ever becomes warranted.
export function createKeepMyDataRawToken(input: {
  accountOffboardingId: string;
  deliveryId: string;
}): string {
  return createHmac('sha256', getKeepMyDataTokenSecret())
    .update(`${KEEP_MY_DATA_TOKEN_CONTEXT}:${input.accountOffboardingId}:${input.deliveryId}`)
    .digest('base64url');
}

export function assertKeepMyDataTokenSecretConfigured(): void {
  getKeepMyDataTokenSecret();
}

function getKeepMyDataTokenSecret(): string {
  return getSessionCookieSecret();
}
