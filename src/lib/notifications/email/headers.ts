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
// - solicitation: the review-ask lane (#657, spec §7.3). Carries a PER-ASK
//   List-Unsubscribe and is fail-closed — see solicitationHeaders() below.

import { getServerConfig } from '@/lib/config/server';

export type EmailCategory = 'transactional' | 'marketing' | 'internal' | 'solicitation';

/**
 * Per-call header inputs. `unsubscribeUrl` is REQUIRED for 'solicitation' (it
 * carries that recipient's Unsubscribe token, so it can never be a shared or
 * per-sender URL) and is ignored by every other category.
 */
export interface EmailHeaderOptions {
  unsubscribeUrl?: string;
}

/**
 * Extracts a mailbox from RESEND_FROM_EMAIL, supporting both "Display <addr>"
 * and bare "addr" formats. Returns null if no valid mailbox can be extracted.
 */
export function extractMailbox(fromEmail: string | undefined): string | null {
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
 *
 * The 'solicitation' category does NOT share any of the above: it returns from
 * its own fail-closed branch before this body, because none of these fallbacks
 * are legal on that lane. See solicitationHeaders().
 */
export function getEmailHeaders(
  category: EmailCategory,
  opts: EmailHeaderOptions = {},
): Record<string, string> {
  if (category === 'solicitation') return solicitationHeaders(opts.unsubscribeUrl);
  if (category !== 'marketing') return {};

  const cfg = getServerConfig();
  const explicitUrl = cfg.LIST_UNSUBSCRIBE_URL?.trim();
  const explicitMailbox = cfg.LIST_UNSUBSCRIBE_EMAIL?.trim();
  const derived = extractMailbox(cfg.RESEND_FROM_EMAIL);
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
 * Solicitation List-Unsubscribe (spec §7.3). Fail-closed on every path:
 *   - no per-ask URL          -> throw (never the global LIST_UNSUBSCRIBE_URL)
 *   - a non-HTTPS URL         -> throw (RFC 8058 §3 requires HTTPS for one-click)
 *   - no configured mailbox   -> throw (never the repworth.example.com RFC 2606 address)
 *
 * There is deliberately no fallback branch. The marketing category above may
 * degrade to a mailto-only header; this one may not, because the degraded form
 * is a compliance violation that fails silently.
 *
 * SOLICITATION_UNSUBSCRIBE_MAILTO stores a BARE address, not a `mailto:` URI —
 * the Neutral page (`src/app/(public)/u/[token]/page.tsx`) prefixes `mailto:`
 * itself in the href and renders the bare value as the link text. This header
 * prefixes it the same way, so the one advertised address stays identical
 * across both code paths.
 */
function solicitationHeaders(unsubscribeUrl: string | undefined): Record<string, string> {
  const raw = unsubscribeUrl?.trim();
  if (!raw) {
    throw new Error(
      "[email/headers] the 'solicitation' category requires a per-ask unsubscribeUrl — refusing to ship a List-Unsubscribe header that cannot work",
    );
  }

  let httpsUrl: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') throw new Error('non-https');
    httpsUrl = u.toString();
  } catch {
    // Not a swallow — a parse failure and a non-HTTPS scheme are the same
    // compliance defect, rethrown as one specific error.
    throw new Error(
      "[email/headers] the 'solicitation' unsubscribeUrl must be an HTTPS URL (RFC 8058 §3 one-click)",
    );
  }

  const mailbox = getServerConfig().SOLICITATION_UNSUBSCRIBE_MAILTO?.trim();
  if (!mailbox) {
    throw new Error(
      "[email/headers] SOLICITATION_UNSUBSCRIBE_MAILTO is required for the 'solicitation' category — the mailto: member of List-Unsubscribe has no fallback",
    );
  }

  return {
    'List-Unsubscribe': `<${httpsUrl}>, <mailto:${mailbox}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Returns Resend tags for a given category. Lets the Resend dashboard
 * filter/aggregate deliveries by category.
 */
export function getEmailTags(category: EmailCategory): Array<{ name: string; value: string }> {
  return [{ name: 'category', value: category }];
}
