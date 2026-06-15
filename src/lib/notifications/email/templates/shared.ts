// src/lib/notifications/email/templates/shared.ts
//
// Helpers shared across multiple email template families.
//
// `LOG_PREFIX` is the canonical [email] prefix used by every send-path log
// line. `renderStars` and `truncate` are pure formatting helpers used by
// approval, weekly, monthly, owner-nudge, and onboarding templates.
// Keeping them centralized prevents drift between templates
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

/**
 * Escape a URL for safe interpolation into an HTML href attribute.
 * Escapes BOTH `&` (must come first) and `"` so query strings like
 * `?token=abc&type=invite` don't render as `?token=abc&type=invite`
 * which a strict HTML parser would interpret as an entity reference.
 *
 * Use this for every `<a href="${url}">` in template strings.
 */
export function escapeHrefUrl(url: string): string {
  return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Wrap a card's inner `<tr>` rows in the shared RepWorth transactional-email
 * shell (doctype + responsive 600px white card on a grey backdrop). Defined
 * ONCE here so the chrome can't drift between templates; each template supplies
 * only its card content rows (indented to sit inside the card `<table>`).
 */
export function buildEmailShell(cardRowsHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
${cardRowsHtml}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
