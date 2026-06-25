// src/lib/notifications/email/templates/internal.ts
//
// Generic internal admin email — used for exception alerts, partner
// engagement alerts, and any other operator-facing message. The body is
// rendered by other templates and passed in as `bodyHtml`; this function
// handles only the Resend send + headers.
import { randomUUID } from 'node:crypto';
import { getServerConfig } from '@/lib/config/server';
import { isMockMode } from '@/lib/shared/mock-mode';
import { sendEmail } from '../send-email';
import { getEmailHeaders, getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX } from './shared';

export interface InternalEmailParams {
  to: string;
  subject: string;
  bodyHtml: string;
  /**
   * Deterministic provider idempotency key for retryable transactional sends.
   * Resend applies this key at the API layer to prevent duplicate accepted
   * emails when a worker retries after losing the local DB update.
   */
  idempotencyKey?: string;
  /**
   * Sender address. Defaults to `getServerConfig().RESEND_FROM_EMAIL`. Callers
   * that own a sender-fallback policy (e.g. the public contact/demo/lead routes,
   * which historically default to the company no-reply mailbox) pass it
   * explicitly so a missing env var doesn't silently drop delivery.
   */
  from?: string;
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
  const from = params.from ?? getServerConfig().RESEND_FROM_EMAIL;
  if (!from) throw new Error('RESEND_FROM_EMAIL not configured');

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Internal email to=${params.to} subject="${params.subject}" category=${params.category ?? 'internal'} messageId=${mockId}`);
    return { messageId: mockId };
  }

  const category: EmailCategory = params.category ?? 'internal';
  const headers = getEmailHeaders(category);

  const { data, error } = await sendEmail(
    {
      from,
      to: params.to,
      subject: params.subject,
      html: params.bodyHtml,
      tags: getEmailTags(category),
      // Only pass headers when non-empty — empty object still adds no value
      // but avoids passing an unused property to Resend's JSON body.
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    { idempotencyKey: params.idempotencyKey },
  );

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
