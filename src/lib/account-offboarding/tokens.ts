import { createHash, createHmac } from 'node:crypto';

const KEEP_MY_DATA_TOKEN_CONTEXT = 'repworth:account-offboarding-keep-my-data-token:v1';

export function hashAccountOffboardingToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

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
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (!secret) throw new Error('SESSION_COOKIE_SECRET not configured');
  return secret;
}
