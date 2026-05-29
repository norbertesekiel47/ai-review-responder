// Single owner of the "where do public contact/demo/lead notification emails go?"
// rule. Replaces the personal-Gmail fallback that used to be duplicated across the
// contact, demo-request, and lead-intake routes.

import * as Sentry from '@sentry/nextjs';
import { extractMailbox } from './email/headers';

export type ContactNotifySource = 'env' | 'from-email' | 'default';

// Company sending-domain default. Matches the routes' RESEND_FROM_EMAIL `from`
// fallback so the notify recipient stays on an owned domain — never a personal
// inbox. Operators should set CONTACT_NOTIFY_TO in production.
const DEFAULT_NOTIFY_TO = 'noreply@repworth.com';

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
