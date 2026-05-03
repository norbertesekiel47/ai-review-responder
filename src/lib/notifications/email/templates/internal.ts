// src/lib/notifications/email/templates/internal.ts
//
// Generic internal admin email — used for exception alerts, partner
// engagement alerts, and any other operator-facing message. The body is
// rendered by other templates and passed in as `bodyHtml`; this function
// handles only the Resend send + headers.
import { randomUUID } from 'node:crypto';
import { isMockMode } from '@/lib/shared/mock-mode';
import { getResend } from '../client';
import { getEmailHeaders, getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX } from './shared';

export interface InternalEmailParams {
  to: string;
  subject: string;
  bodyHtml: string;
  /**
   * Email category for headers + Resend tags. Defaults to 'internal'
   * (admin-facing, no List-Unsubscribe). Use 'marketing' for owner-
   * directed recurring emails (weekly reports, drips, nudges).
   */
  category?: EmailCategory;
}

export async function sendInternalEmail(
  params: InternalEmailParams,
): Promise<{ messageId: string }> {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) throw new Error('RESEND_FROM_EMAIL not configured');

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Internal email to=${params.to} subject="${params.subject}" category=${params.category ?? 'internal'} messageId=${mockId}`);
    return { messageId: mockId };
  }

  const category: EmailCategory = params.category ?? 'internal';
  const headers = getEmailHeaders(category);

  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.bodyHtml,
    tags: getEmailTags(category),
    // Only pass headers when non-empty — empty object still adds no value
    // but avoids passing an unused property to Resend's JSON body.
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
