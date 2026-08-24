// src/lib/notifications/email/templates/solicitation-veto-notice.ts
//
// Solicitation Veto notice email (#631 Task 5, Auto-approval lane) —
// transactional. Sent when a batch of review requests is auto-approved and
// scheduled: "N review requests were auto-approved; they will send once your
// veto window closes; stop them from the Requests page." The notice is about
// a BATCH, not a response or a review — no reviewer/star/review-text fields,
// unlike the Reply lane's pending-post-notice.ts. ONE CTA, tokenless
// (decision 10): `${appUrl}/dashboard/requests`. Delivery rows use template
// 'solicitation_veto_notice' (owner-directed for bounce classification —
// worker/ingress/resend.ts, decision 16).

import { randomUUID } from 'node:crypto';
import { isMockMode } from '@/lib/shared/mock-mode';
import { escapeHtml } from '@/lib/shared/html';
import { sendEmail } from '../send-email';
import { getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX, buildEmailShell, escapeHrefUrl } from './shared';
import { sanitizeLocationLabelForPrefix } from '@/lib/notifications/channels/template-prefix';

// Single owner for the notice title copy — used by BOTH the subject line and
// the body <h1> so they can't drift.
const SOLICITATION_VETO_NOTICE_TITLE = 'Review requests will send automatically';

export interface SolicitationVetoNoticeEmailParams {
  to: string;
  from: string;
  locationLabel: string;
  businessName: string;
  /** Live rendered Outreach count on the batch, read at send time. */
  requestCount: number;
  /** `${APP_URL}/dashboard/requests` — tokenless CTA (decision 10). */
  requestsUrl: string;
  idempotencyKey?: string;
}

export function solicitationVetoNoticeSubject(
  params: Pick<SolicitationVetoNoticeEmailParams, 'locationLabel' | 'requestCount'>,
): string {
  const safeLabel = sanitizeLocationLabelForPrefix(params.locationLabel);
  const plural = params.requestCount === 1 ? '' : 's';
  return `[${safeLabel}] ${params.requestCount} review request${plural} will send automatically`;
}

export function buildSolicitationVetoNoticeEmailHtml(
  params: Omit<SolicitationVetoNoticeEmailParams, 'to' | 'from' | 'idempotencyKey'>,
): string {
  const safeLabel = escapeHtml(sanitizeLocationLabelForPrefix(params.locationLabel));
  const safeBusinessName = escapeHtml(params.businessName);
  const plural = params.requestCount === 1 ? 'review request' : 'review requests';

  return buildEmailShell(`        <tr><td style="padding:32px 24px 0;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#111;">[${safeLabel}] ${SOLICITATION_VETO_NOTICE_TITLE}</h1>
          <p style="margin:0 0 12px;font-size:14px;color:#374151;line-height:1.6;">${params.requestCount} ${plural} for <strong>${safeBusinessName}</strong> were automatically approved.</p>
          <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">They will send once your veto window closes.</p>
        </td></tr>
        <tr><td style="padding:24px;" align="center">
          <a href="${escapeHrefUrl(params.requestsUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 24px;border-radius:6px;font-size:16px;font-weight:600;text-decoration:none;">Stop these requests</a>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">No action needed if this looks right.</p>
        </td></tr>`);
}

export async function sendSolicitationVetoNoticeEmail(
  params: SolicitationVetoNoticeEmailParams,
): Promise<{ messageId: string }> {
  const subject = solicitationVetoNoticeSubject(params);

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Solicitation veto notice email to=${params.to} subject="${subject}" messageId=${mockId}\n  → ${params.requestsUrl}`);
    return { messageId: mockId };
  }

  const html = buildSolicitationVetoNoticeEmailHtml(params);

  // Transactional alert: no List-Unsubscribe header (operational, not marketing).
  const category: EmailCategory = 'transactional';
  const { data, error } = await sendEmail(
    {
      from: params.from,
      to: params.to,
      subject,
      html,
      tags: getEmailTags(category),
    },
    { idempotencyKey: params.idempotencyKey },
  );

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
