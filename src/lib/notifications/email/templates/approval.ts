// src/lib/notifications/email/templates/approval.ts
//
// Owner approval email — transactional. No List-Unsubscribe header
// because these are required for service operation, not marketing.
//
// VAL-NOTIF-012: Subject includes [locationLabel] prefix.
// VAL-NOTIF-013: Body H1 includes locationLabel.
// VAL-NOTIF-014: locationLabel is resolved at the data layer via
//   getDisplayLabel({ display_label, name }) — display_label ?? name fallback.

import { randomUUID } from 'node:crypto';
import { isMockMode } from '@/lib/shared/mock-mode';
import { escapeHtml } from '@/lib/shared/html';
import { getResend } from '../client';
import { getEmailTags, type EmailCategory } from '../headers';
import { LOG_PREFIX, renderStars, truncate } from './shared';

export interface ApprovalEmailParams {
  to: string;
  from: string;
  /** Resolved location label: display_label ?? businesses.name. Always non-null. */
  locationLabel: string;
  /** Raw business name from the businesses table. Used in body text. */
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string;
  responsePreview: string;
  approvalUrl: string;
}

function formatDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

function buildApprovalEmailHtml(params: ApprovalEmailParams): string {
  const { locationLabel, businessName, reviewerName, starRating, reviewText, reviewDate, responsePreview, approvalUrl } = params;
  const stars = renderStars(starRating);
  const safeLocationLabel = escapeHtml(locationLabel);
  const safeName = escapeHtml(businessName);
  const safeReviewer = escapeHtml(reviewerName);
  const safeDate = escapeHtml(formatDate(reviewDate));
  const reviewBody = reviewText
    ? escapeHtml(truncate(reviewText, 200))
    : 'Rating only — no written review';
  const preview = escapeHtml(truncate(responsePreview, 100));
  // approvalUrl is constructed from NEXT_PUBLIC_APP_URL + a UUID — safe, but encode for href attribute
  const safeUrl = approvalUrl.replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h1 style="margin:0 0 4px;font-size:20px;color:#111;">[${safeLocationLabel}] New ${starRating}★ review needs approval</h1>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">A draft response is ready for your approval.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:24px;letter-spacing:2px;">${stars}</p>
              <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">${safeReviewer} &middot; ${safeDate}</p>
              <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.5;">${reviewBody}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 0;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Draft response</p>
          <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;font-style:italic;">&ldquo;${preview}&rdquo;</p>
        </td></tr>
        <tr><td style="padding:24px;" align="center">
          <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;text-decoration:none;">Review &amp; Approve</a>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This link expires in 48 hours.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export { buildApprovalEmailHtml };

export async function sendApprovalEmail(
  params: ApprovalEmailParams,
): Promise<{ messageId: string }> {
  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Approval email to=${params.to} subject="[${params.locationLabel}] New ${params.starRating}★ review needs approval" messageId=${mockId}\n  → /approve/[redacted]`);
    return { messageId: mockId };
  }

  const resend = getResend();
  const html = buildApprovalEmailHtml(params);

  // Approval emails are transactional: no List-Unsubscribe header. They are
  // necessary for service operation, not marketing, so bulk-sender rules
  // don't require (and shouldn't include) an unsubscribe link.
  const category: EmailCategory = 'transactional';
  // VAL-NOTIF-012: Subject includes [locationLabel] prefix with star rating.
  const { data, error } = await resend.emails.send({
    from: params.from,
    to: params.to,
    subject: `[${params.locationLabel}] New ${params.starRating}★ review needs approval`,
    html,
    tags: getEmailTags(category),
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}
