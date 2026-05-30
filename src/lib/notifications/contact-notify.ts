// Single owner of the "where do public contact/demo/lead notification emails go?"
// rule. Replaces the personal-Gmail fallback that used to be duplicated across the
// contact, demo-request, and lead-intake routes.

import * as Sentry from '@sentry/nextjs';
import { isMockMode } from '@/lib/shared/mock-mode';
import { extractMailbox } from './email/headers';
import { sendInternalEmail } from './email/templates/internal';

export type ContactNotifySource = 'env' | 'from-email' | 'default';

// The company no-reply mailbox — the single default for BOTH the notify
// recipient (when CONTACT_NOTIFY_TO is unset) and the email `from` (when
// RESEND_FROM_EMAIL is unset). Keeps the recipient on an owned domain — never a
// personal inbox — and preserves the routes' pre-#167 `from` fallback so a
// missing sender env never silently drops a lead. Operators should still set
// CONTACT_NOTIFY_TO in production.
const COMPANY_NOREPLY = 'noreply@repworth.net';
const DEFAULT_NOTIFY_TO = COMPANY_NOREPLY;

/**
 * Resolves the recipient for public contact/demo/lead notification emails.
 *
 * Order:
 *   1. CONTACT_NOTIFY_TO (explicit, trimmed, non-empty)
 *   2. mailbox parsed from RESEND_FROM_EMAIL (company sending domain)
 *   3. DEFAULT_NOTIFY_TO
 *
 * Emits one console.warn — in production only — when falling back
 * (source !== 'env'), so a missing CONTACT_NOTIFY_TO surfaces in production logs
 * instead of silently mailing an unintended address. Gated to production (like the
 * worker boot-time checks) because locally CONTACT_NOTIFY_TO is normally unset and
 * a per-request warning would just spam dev/test logs.
 */
export function resolveContactNotifyTo(): { to: string; source: ContactNotifySource } {
  const explicit = process.env.CONTACT_NOTIFY_TO?.trim();
  if (explicit) return { to: explicit, source: 'env' };

  const derived = extractMailbox(process.env.RESEND_FROM_EMAIL);
  const to = derived ?? DEFAULT_NOTIFY_TO;
  const source: ContactNotifySource = derived ? 'from-email' : 'default';

  if (process.env.NODE_ENV === 'production') {
    Sentry.captureMessage('contact_notify_to_unset', {
      level: 'error',
      tags: { subsystem: 'contact-notify' },
      extra: { resolvedTo: to, source },
    });
    console.warn(
      `[contact-notify] CONTACT_NOTIFY_TO is unset — falling back to ${
        source === 'from-email' ? 'the RESEND_FROM_EMAIL mailbox' : 'the default noreply mailbox'
      } (${to}). Set CONTACT_NOTIFY_TO so leads route to a monitored inbox.`,
    );
  }
  return { to, source };
}

// Escapes the HTML metacharacters so user-supplied submission fields render
// literally in the notification email body.
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// True when the notification email should be sent. Mirrors the routes' pre-#167
// best-effort guard: send when a real API key is present or in mock mode; when
// neither (email genuinely off, e.g. local dev) skip and let the caller return
// success. RESEND_FROM_EMAIL is intentionally NOT required here — the `from`
// falls back to COMPANY_NOREPLY in notifyContactSubmission, so a missing sender
// env preserves delivery instead of silently dropping the lead.
function emailConfigured(): boolean {
  return isMockMode() || Boolean(process.env.RESEND_API_KEY);
}

/**
 * Sends a public contact/demo/lead notification through the shared
 * sendInternalEmail path (mock-mode aware, lazy client, category headers).
 * Best-effort: returns { sent: false } only when email is genuinely off
 * (no API key and not mock mode); otherwise sends and returns { sent: true }.
 * The `from` falls back to COMPANY_NOREPLY when RESEND_FROM_EMAIL is unset, so a
 * missing sender env preserves delivery (pre-#167 behavior) instead of dropping
 * the lead. Propagates a real send error so the caller can surface a 500.
 */
export async function notifyContactSubmission(params: {
  subject: string;
  lines: string[];
}): Promise<{ sent: boolean }> {
  if (!emailConfigured()) return { sent: false };
  const { to } = resolveContactNotifyTo();
  const from = process.env.RESEND_FROM_EMAIL?.trim() || COMPANY_NOREPLY;
  const bodyHtml = params.lines.map(escapeHtml).join('<br>\n');
  await sendInternalEmail({ to, from, subject: params.subject, bodyHtml, category: 'internal' });
  return { sent: true };
}
