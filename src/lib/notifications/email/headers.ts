// src/lib/notifications/email/headers.ts
//
// Email categorization (deliverability + compliance) — header + tag helpers.
//
// Resend tags + List-Unsubscribe headers are per-category.
// - transactional: one-to-one user-initiated (approval emails). No unsubscribe —
//   these are necessary for service operation, not marketing.
// - marketing: recurring owner reports + nudges (weekly/monthly/drips/owner_nudge).
//   Gmail/Outlook bulk-sender rules require List-Unsubscribe one-click for these.
// - internal: admin/sales-partner alerts (exceptions,
//   partner engagement alerts). Not customer-facing, no unsubscribe needed.

export type EmailCategory = 'transactional' | 'marketing' | 'internal';

/**
 * Extracts a mailbox from RESEND_FROM_EMAIL, supporting both "Display <addr>"
 * and bare "addr" formats. Returns null if no valid mailbox can be extracted.
 */
function extractMailbox(fromEmail: string | undefined): string | null {
  if (!fromEmail) return null;
  const angleMatch = fromEmail.match(/<([^>]+)>/);
  if (angleMatch && angleMatch[1] && angleMatch[1].includes('@')) return angleMatch[1].trim();
  const trimmed = fromEmail.trim();
  if (trimmed.includes('@') && !trimmed.includes('<')) return trimmed;
  return null;
}

/**
 * Returns additional email headers for a given category.
 * Only 'marketing' emails get List-Unsubscribe headers — required by
 * Gmail/Outlook bulk-sender compliance rules.
 *
 * RFC 8058 one-click compliance:
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` ONLY works when the
 * `List-Unsubscribe` header contains an HTTPS URL — mail clients POST to
 * that URL to execute the unsubscribe without a user round-trip. A
 * mailto-only header falls back to composing an email (not one-click),
 * and including `List-Unsubscribe-Post` alongside it is misleading (and
 * ignored by compliant clients per RFC 8058 §3).
 *
 * Env-var contract:
 *   LIST_UNSUBSCRIBE_URL   — https://... one-click endpoint (optional)
 *   LIST_UNSUBSCRIBE_EMAIL — mailto fallback recipient (optional)
 * If an HTTPS URL is configured, we send both forms plus the Post header.
 * Otherwise we send ONLY the mailto form — still valid per the pre-RFC-8058
 * standard, which Gmail/Outlook accept as a fallback for low-volume senders.
 */
export function getEmailHeaders(category: EmailCategory): Record<string, string> {
  if (category !== 'marketing') return {};

  const explicitUrl = process.env.LIST_UNSUBSCRIBE_URL?.trim();
  const explicitMailbox = process.env.LIST_UNSUBSCRIBE_EMAIL?.trim();
  const derived = extractMailbox(process.env.RESEND_FROM_EMAIL);
  // Fallback mailbox uses the reserved example.com domain (per RFC 2606) —
  // it's intentionally non-functional. Anyone reaching this branch has a
  // production misconfiguration: a marketing email is being sent without
  // either LIST_UNSUBSCRIBE_EMAIL or a derivable RESEND_FROM_EMAIL.
  // Log a warning so the misconfiguration surfaces in production logs
  // rather than silently shipping headers no mail provider will honor.
  let mailbox = explicitMailbox || derived;
  if (!mailbox) {
    console.warn(
      '[email/headers] No LIST_UNSUBSCRIBE_EMAIL or parseable RESEND_FROM_EMAIL set — falling back to non-functional example.com mailbox. Marketing emails will fail mailbox-provider compliance checks.',
    );
    mailbox = 'unsubscribe@repworth.example.com';
  }

  // RFC 8058 §3 requires HTTPS for one-click. An http: URL would leak the
  // unsubscribe token in transit and most mail providers will refuse to honor
  // the One-Click Post header — so we only trust an HTTPS scheme here. Any
  // other scheme (http:, javascript:, data:, mailto:, etc., or a parse
  // failure) falls through to the mailto-only fallback below.
  let httpsUrl: string | null = null;
  if (explicitUrl) {
    try {
      const u = new URL(explicitUrl);
      if (u.protocol === 'https:') {
        httpsUrl = u.toString();
      }
    } catch {
      httpsUrl = null;
    }
  }

  if (httpsUrl) {
    return {
      'List-Unsubscribe': `<${httpsUrl}>, <mailto:${mailbox}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }

  // Mailto-only fallback: no Post header (it wouldn't function anyway).
  return {
    'List-Unsubscribe': `<mailto:${mailbox}>`,
  };
}

/**
 * Returns Resend tags for a given category. Lets the Resend dashboard
 * filter/aggregate deliveries by category.
 */
export function getEmailTags(category: EmailCategory): Array<{ name: string; value: string }> {
  return [{ name: 'category', value: category }];
}
