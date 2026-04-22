//
// Pure formatter for approval SMS bodies. GSM-7 single-segment invariant
// (≤160 chars, ASCII-only after transliteration). See docs/superpowers/
// specs/2026-04-21-phase1-sms-design.md §7 for rationale and tier layout.

import transliterate from '@sindresorhus/transliterate';

export class SmsBodyTooLongError extends Error {
  constructor(public readonly length: number) {
    super(`sms_body_too_long:${length}`);
    this.name = 'SmsBodyTooLongError';
  }
}

export interface FormatApprovalSmsParams {
  reviewerName: string;
  starRating: number;
  approvalUrl: string;
}

const GSM7_REGEX = /^[\x00-\x7F\n]+$/;
const FALLBACK_NAME = 'a reviewer';

function formatReviewerName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return FALLBACK_NAME;
  const ascii = transliterate(trimmed).replace(/[^\x00-\x7F]/g, '').trim();
  if (ascii.length === 0) return FALLBACK_NAME;
  const parts = ascii.split(' ').filter((p) => p.length > 0);
  if (parts.length === 0) return FALLBACK_NAME;
  const first = parts[0]!;
  const lastInitial = parts.length > 1 ? `${(parts[parts.length - 1]!).charAt(0)}.` : '';
  const formatted = lastInitial ? `${first} ${lastInitial}` : first;
  if (formatted.length === 0) return FALLBACK_NAME;
  // Cap overly long names; trailing ".." signals truncation to the owner.
  if (formatted.length > 29) return formatted.slice(0, 25) + '..';
  return formatted;
}

/**
 * Returns a GSM-7 single-segment SMS body for an approval notification.
 *
 * Tier 1 (preferred): "New N-star review from <Name>. Draft ready: <url>\nReply STOP to unsubscribe."
 * Tier 2 (fallback when tier 1 > 160): "New N-star review. Draft ready: <url>\nReply STOP to unsubscribe."
 * Throws SmsBodyTooLongError when tier 2 also exceeds 160 (deployment misconfig: URL too long).
 */
export function formatApprovalSms(p: FormatApprovalSmsParams): string {
  const formattedName = formatReviewerName(p.reviewerName);
  const tier1 = `New ${p.starRating}-star review from ${formattedName}. Draft ready: ${p.approvalUrl}\nReply STOP to unsubscribe.`;
  if (tier1.length <= 160) {
    if (!GSM7_REGEX.test(tier1)) throw new SmsBodyTooLongError(tier1.length);
    return tier1;
  }
  const tier2 = `New ${p.starRating}-star review. Draft ready: ${p.approvalUrl}\nReply STOP to unsubscribe.`;
  if (tier2.length <= 160) {
    if (!GSM7_REGEX.test(tier2)) throw new SmsBodyTooLongError(tier2.length);
    return tier2;
  }
  throw new SmsBodyTooLongError(tier2.length);
}
