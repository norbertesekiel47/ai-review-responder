// src/lib/notifications/email/templates/escalation-notice.ts
//
// Guardian escalation notice email (WS3) — transactional. Sent when triage
// says the owner must be alerted (suggested_action escalate /
// respond_and_escalate). Fallback-sourced escalations (triage_source
// fallback_high_v1) use "couldn't assess" copy and claim NO severity.
// Delivery rows use template 'escalation_notice' (owner-directed for bounce
// classification — worker/ingress/resend.ts).

import { randomUUID } from 'node:crypto';
import { isMockMode } from '@/lib/shared/mock-mode';
import { escapeHtml } from '@/lib/shared/html';
import { sendEmail } from '../send-email';
import { getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX, renderStars, truncate, escapeHrefUrl, buildEmailShell } from './shared';
import { sanitizeLocationLabelForPrefix } from '@/lib/notifications/channels/template-prefix';
import { TRIAGE_ISSUE_LABELS, TRIAGE_SEVERITY_LABELS, type TriageIssue, type TriageSeverity } from '@/lib/reviews/triage-schema';

const REVIEW_TEXT_PREVIEW_CHARS = 400;

// Single owner for the notice title copy — used by BOTH the subject line and
// the body <h1> so they can't drift.
const URGENT_NOTICE_TITLE = '🚨 A review needs your attention';
const FALLBACK_NOTICE_TITLE = '⚠️ A review needs a look';

export interface EscalationNoticeEmailParams {
  to: string;
  from: string;
  locationLabel: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  severity: TriageSeverity;
  issues: TriageIssue[];
  isFallback: boolean;
  dashboardUrl: string;
  idempotencyKey?: string;
}

export function escalationNoticeSubject(
  params: Pick<EscalationNoticeEmailParams, 'locationLabel' | 'isFallback'>,
): string {
  const safeLabel = sanitizeLocationLabelForPrefix(params.locationLabel);
  return params.isFallback
    ? `[${safeLabel}] ${FALLBACK_NOTICE_TITLE}`
    : `[${safeLabel}] ${URGENT_NOTICE_TITLE}`;
}

export function buildEscalationNoticeEmailHtml(
  params: Omit<EscalationNoticeEmailParams, 'to' | 'from' | 'idempotencyKey'>,
): string {
  const safeLabel = escapeHtml(sanitizeLocationLabelForPrefix(params.locationLabel));
  const safeReviewer = escapeHtml(params.reviewerName);
  const stars = params.starRating !== null
    ? `<p style="margin:0 0 4px;font-size:24px;letter-spacing:2px;">${renderStars(params.starRating)}</p>`
    : '<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">No star rating</p>';
  const preview = params.reviewText
    ? escapeHtml(truncate(params.reviewText, REVIEW_TEXT_PREVIEW_CHARS))
    : '(no review text)';

  const assessment = params.isFallback
    ? `<p style="margin:0 0 20px;font-size:14px;color:#666;">We couldn&#39;t assess this review automatically — please take a look.</p>`
    : `<p style="margin:0 0 20px;font-size:14px;color:#666;"><strong>${TRIAGE_SEVERITY_LABELS[params.severity]}.</strong>${
        params.issues.length > 0
          ? ` Flagged for: ${escapeHtml(params.issues.map((i) => TRIAGE_ISSUE_LABELS[i]).join(', '))}.`
          : ''
      } A reply draft follows the usual approval flow — this alert is about the underlying issue.</p>`;

  return buildEmailShell(`        <tr><td style="padding:32px 24px 0;">
          <h1 style="margin:0 0 4px;font-size:20px;color:#111;">[${safeLabel}] ${params.isFallback ? FALLBACK_NOTICE_TITLE : URGENT_NOTICE_TITLE}</h1>
          ${assessment}
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              ${stars}
              <p style="margin:0 0 8px;font-size:14px;color:#374151;">Review from <strong>${safeReviewer}</strong>:</p>
              <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;white-space:pre-wrap;">${preview}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px;" align="center">
          <a href="${escapeHrefUrl(params.dashboardUrl)}" style="display:inline-block;background:#dc2626;color:#ffffff;padding:12px 28px;border-radius:6px;font-size:15px;font-weight:600;text-decoration:none;">Open dashboard</a>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Acknowledge or resolve this escalation from your reviews dashboard.</p>
        </td></tr>`);
}

export async function sendEscalationNoticeEmail(
  params: EscalationNoticeEmailParams,
): Promise<{ messageId: string }> {
  const subject = escalationNoticeSubject(params);

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Escalation notice email to=${params.to} subject="${subject}" messageId=${mockId}`);
    return { messageId: mockId };
  }

  const html = buildEscalationNoticeEmailHtml(params);

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
