// src/lib/notifications/email/templates/shared.ts
//
// Helpers shared across multiple email template families.
//
// `LOG_PREFIX` is the canonical [email] prefix used by every send-path log
// line. `renderStars` and `truncate` are pure formatting helpers used by
// approval, manual-post, weekly, monthly, owner-nudge, and onboarding
// templates. Keeping them centralized prevents drift between templates
// (for example, two slightly different star characters or truncation
// suffixes appearing in different emails).

export const LOG_PREFIX = '[email]';

export function renderStars(rating: number): string {
  // Clamp to [0, 5] integer range — '★'.repeat() throws RangeError on
  // negative counts. A malformed star_rating from the DB must not crash
  // every email send for that business.
  const clamped = Math.max(0, Math.min(5, Math.floor(Number.isFinite(rating) ? rating : 0)));
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
