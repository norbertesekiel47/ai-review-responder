import { createHmac, timingSafeEqual } from 'node:crypto';

function getSecret(): string {
  const secret = process.env.CSRF_SECRET;
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
export function verifyFeedback(businessId: string, rating: string, weekStartDate: string, sig: string): boolean {
  const expected = signFeedback(businessId, rating, weekStartDate);
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
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
