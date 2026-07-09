// src/lib/notifications/email/templates/pending-post-notice.ts
//
// Pending-post notice email (WS4 veto window) — transactional. Sent when a
// reply is auto-approved and scheduled: "will post automatically at ~HH:MM —
// review or cancel", with ONE approve-page CTA (a standard tokenized approval
// link). Delivery rows use template 'pending_post_notice' (owner-directed for
// bounce classification — worker/ingress/resend.ts, Task 7).

import { randomUUID } from 'node:crypto';
import { isMockMode } from '@/lib/shared/mock-mode';
import { escapeHtml } from '@/lib/shared/html';
import { sendEmail } from '../send-email';
import { getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX, renderStars, truncate, escapeHrefUrl, buildEmailShell } from './shared';
import { sanitizeLocationLabelForPrefix } from '@/lib/notifications/channels/template-prefix';
import { formatScheduledPostTime } from '@/lib/notifications/channels/scheduled-post-time';

const REVIEW_TEXT_PREVIEW_CHARS = 400;
const DRAFT_TEXT_PREVIEW_CHARS = 400;

// Single owner for the notice title copy — used by BOTH the subject line and
// the body <h1> so they can't drift.
const NOTICE_TITLE = '⏳ Reply will post automatically';

export interface PendingPostNoticeEmailParams {
  to: string;
  from: string;
  locationLabel: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  /** The auto-approved draft reply text. */
  responsePreview: string;
  /** responses.auto_post_scheduled_at — the veto deadline the copy phrases. */
  scheduledPostAt: Date;
  /** Tokenized approve-page link — the single "Review or cancel" CTA. */
  approveUrl: string;
  idempotencyKey?: string;
  /**
   * Send-time clock for the relative phrasing; injectable for tests. The send
   * function threads ONE value to subject and body so they can't straddle a
   * minute boundary and disagree.
   */
  now?: Date;
}

export function pendingPostNoticeSubject(
  params: Pick<PendingPostNoticeEmailParams, 'locationLabel' | 'scheduledPostAt' | 'now'>,
): string {
  const safeLabel = sanitizeLocationLabelForPrefix(params.locationLabel);
  const { absoluteUtc } = formatScheduledPostTime(params.scheduledPostAt, params.now ?? new Date());
  return `[${safeLabel}] ${NOTICE_TITLE} at ${absoluteUtc}`;
}

export function buildPendingPostNoticeEmailHtml(
  params: Omit<PendingPostNoticeEmailParams, 'to' | 'from' | 'idempotencyKey'>,
): string {
  const safeLabel = escapeHtml(sanitizeLocationLabelForPrefix(params.locationLabel));
  const safeReviewer = escapeHtml(params.reviewerName);
  const stars = renderStars(params.starRating);
  const reviewPreview = params.reviewText
    ? escapeHtml(truncate(params.reviewText, REVIEW_TEXT_PREVIEW_CHARS))
    : '(no review text)';
  const draftPreview = escapeHtml(truncate(params.responsePreview, DRAFT_TEXT_PREVIEW_CHARS));
  const { absoluteUtc, relative } = formatScheduledPostTime(params.scheduledPostAt, params.now ?? new Date());

  return buildEmailShell(`        <tr><td style="padding:32px 24px 0;">
          <h1 style="margin:0 0 4px;font-size:20px;color:#111;">[${safeLabel}] ${NOTICE_TITLE}</h1>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">Your auto-approved reply to <strong>${safeReviewer}</strong>&#39;s ${params.starRating}★ review will post automatically at <strong>${absoluteUtc}</strong> (${relative}) unless you review or cancel it.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:24px;letter-spacing:2px;">${stars}</p>
              <p style="margin:0 0 8px;font-size:14px;color:#374151;">Review from <strong>${safeReviewer}</strong>:</p>
              <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;white-space:pre-wrap;">${reviewPreview}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 0;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Draft reply</p>
          <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;font-style:italic;">&ldquo;${draftPreview}&rdquo;</p>
        </td></tr>
        <tr><td style="padding:24px;" align="center">
          <a href="${escapeHrefUrl(params.approveUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;text-decoration:none;">Review or cancel</a>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">No action needed if the reply looks good — it will post automatically at ${absoluteUtc}.</p>
        </td></tr>`);
}

export async function sendPendingPostNoticeEmail(
  params: PendingPostNoticeEmailParams,
): Promise<{ messageId: string }> {
  const now = params.now ?? new Date();
  const subject = pendingPostNoticeSubject({ ...params, now });

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Pending-post notice email to=${params.to} subject="${subject}" messageId=${mockId}\n  → /approve/[redacted]`);
    return { messageId: mockId };
  }

  const html = buildPendingPostNoticeEmailHtml({ ...params, now });

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
