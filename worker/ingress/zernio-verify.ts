// worker/ingress/zernio-verify.ts
//
// HMAC-SHA256 signature verification for Zernio webhooks.
//
// Mirrors the safer pattern from src/lib/shared/feedback-hmac.ts:22-30 —
// Node's crypto.timingSafeEqual THROWS when buffer lengths differ, so we
// must reject malformed signatures BEFORE comparison.
//
// Per spec §5.3: HEX_64 regex is case-insensitive (/^[0-9a-f]{64}$/i).

import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * Verify a Zernio webhook signature.
 *
 * @param rawBody       Exact raw request body (must match what was signed; do not re-stringify parsed JSON).
 * @param signatureHex  Hex-encoded HMAC-SHA256 from `x-zernio-signature` header.
 * @param secret        Shared signing secret (`ZERNIO_WEBHOOK_SECRET`).
 * @returns true iff the signature is well-formed AND matches the recomputed HMAC.
 */
export function verifyZernioSignature(
  rawBody: string,
  signatureHex: string,
  secret: string,
): boolean {
  if (typeof signatureHex !== 'string' || !HEX_64.test(signatureHex)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  // Defensive: HEX_64.test guarantees length 64, but expected.length is also
  // always 64 for sha256 hex. Belt-and-suspenders before timingSafeEqual.
  if (expected.length !== signatureHex.length) return false;

  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signatureHex.toLowerCase(), 'hex'),
  );
}
