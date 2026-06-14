// src/lib/notifications/email/templates/auto-post-notice.ts
//
// Auto-approved post FYI email — transactional. Sent AFTER an auto-policy
// response is posted to Google (Workstream B). NO approval affordance: the
// post already happened. The optional "View on Google" CTA routes through the
// hardened /r/google/<responseId> redirect; it is omitted when the business
// has no known Google Maps URL (the free-form channel knows the destination is
// unknown, so it shows no button rather than a button that lands on the
// redirect's "unavailable" page).
//
// The delivery row recorded by the FYI dispatcher uses template
// 'auto_post_notice' — which the Resend ingress allowlists as owner-directed,
// so a hard bounce flags businesses.owner_email_bounced.

import { randomUUID } from 'node:crypto';
import { isMockMode } from '@/lib/shared/mock-mode';
import { escapeHtml } from '@/lib/shared/html';
import { getResend } from '../client';
import { getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX, renderStars, escapeHrefUrl, buildEmailShell } from './shared';
import { sanitizeLocationLabelForPrefix } from '@/lib/notifications/channels/template-prefix';

export interface AutoPostNoticeEmailParams {
  to: string;
  from: string;
  /** Resolved location label: display_label ?? businesses.name. Always non-null. */
  locationLabel: string;
  businessName: string;
  reviewerName: string;
  starRating: number;
  /** null when the business has no known Google Maps URL — CTA omitted. */
  googleMapsUrl: string | null;
  /** Stable redirect CTA target: `${APP_URL}/r/google/${responseId}`. */
  viewUrl: string;
}

function buildAutoPostNoticeEmailHtml(params: AutoPostNoticeEmailParams): string {
  const safeLabel = escapeHtml(sanitizeLocationLabelForPrefix(params.locationLabel));
  const stars = renderStars(params.starRating);
  const safeReviewer = escapeHtml(params.reviewerName);
  const cta = params.googleMapsUrl !== null
    ? `<tr><td style="padding:24px;" align="center">
          <a href="${escapeHrefUrl(params.viewUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;padding:12px 28px;border-radius:6px;font-size:15px;font-weight:600;text-decoration:none;">View on Google</a>
        </td></tr>`
    : '';

  return buildEmailShell(`        <tr><td style="padding:32px 24px 0;">
          <h1 style="margin:0 0 4px;font-size:20px;color:#111;">[${safeLabel}] ✅ Auto-approved reply posted</h1>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">Your auto-approval policy approved and posted a reply to a new review — no action needed.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:24px;letter-spacing:2px;">${stars}</p>
              <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;">Your reply to <strong>${safeReviewer}</strong>'s review is now live on Google.</p>
            </td></tr>
          </table>
        </td></tr>
        ${cta}
        <tr><td style="padding:16px 24px 24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">You're receiving this because auto-approval is enabled for this location.</p>
        </td></tr>`);
}

export { buildAutoPostNoticeEmailHtml };

export async function sendAutoPostNoticeEmail(
  params: AutoPostNoticeEmailParams,
): Promise<{ messageId: string }> {
  const safeLabel = sanitizeLocationLabelForPrefix(params.locationLabel);
  const subject = `[${safeLabel}] ✅ Auto-approved reply posted to Google`;

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Auto-post notice email to=${params.to} subject="${subject}" messageId=${mockId}`);
    return { messageId: mockId };
  }

  const resend = getResend();
  const html = buildAutoPostNoticeEmailHtml(params);

  // Transactional FYI: no List-Unsubscribe header (operational, not marketing).
  const category: EmailCategory = 'transactional';
  const { data, error } = await resend.emails.send({
    from: params.from,
    to: params.to,
    subject,
    html,
    tags: getEmailTags(category),
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
