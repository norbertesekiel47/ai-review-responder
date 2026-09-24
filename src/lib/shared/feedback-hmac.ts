import { createHmac } from 'node:crypto';
import { getServerConfig } from '@/lib/config/server';
import { constantTimeEqual } from '@/lib/shared/signed-value';

function getSecret(): string {
  const secret = getServerConfig().CSRF_SECRET;
  if (!secret) throw new Error('CSRF_SECRET not configured');
  return secret;
}

/**
 * Sign feedback link params with HMAC-SHA256.
 * Input: business_id + rating + week_start_date concatenated with '|'.
 */
export function signFeedback(businessId: string, rating: string, weekStartDate: string): string {
  return createHmac('sha256', getSecret())
    .update(`${businessId}|${rating}|${weekStartDate}`)
    .digest('hex');
}

/**
 * Verify feedback HMAC. Uses constant-time comparison to prevent timing attacks.
 */
const HEX_64_PATTERN = /^[0-9a-f]{64}$/i;

export function verifyFeedback(businessId: string, rating: string, weekStartDate: string, sig: string): boolean {
  // Reject non-hex or wrong-length signatures before comparison. Belt-and-
  // suspenders: constantTimeEqual already handles a byte-length mismatch
  // without throwing, but this keeps a malformed sig from reaching the HMAC
  // compare at all.
  if (!HEX_64_PATTERN.test(sig)) return false;
  const expected = signFeedback(businessId, rating, weekStartDate);
  return constantTimeEqual(expected, sig, 'hex');
}

/**
 * Build a signed feedback URL for embedding in weekly emails.
 */
export function buildFeedbackUrl(
  appUrl: string,
  businessId: string,
  rating: 'great' | 'ok' | 'not_great',
  weekStartDate: string,
): string {
  const sig = signFeedback(businessId, rating, weekStartDate);
  const params = new URLSearchParams({
    business_id: businessId,
    rating,
    week: weekStartDate,
    sig,
  });
  return `${appUrl}/api/feedback?${params.toString()}`;
}
