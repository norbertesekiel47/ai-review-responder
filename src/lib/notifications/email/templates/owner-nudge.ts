// src/lib/notifications/email/templates/owner-nudge.ts
//
// Owner nudge — re-engagement email listing pending reviews waiting
// for owner approval. Marketing category.
import { escapeHtml } from '@/lib/shared/html';
import { renderStars, truncate } from './shared';

export interface OwnerNudgeEmailParams {
  businessName: string;
  /** Total pending reviews (may be more than pendingReviews.length if capped). */
  totalPending?: number;
  pendingReviews: Array<{
    reviewerName: string;
    starRating: number | null;
    reviewText: string | null;
    approvalUrl: string;
  }>;
}

export function buildOwnerNudgeEmailHtml(params: OwnerNudgeEmailParams): string {
  const { businessName, pendingReviews } = params;
  const safeName = escapeHtml(businessName);
  const totalPending = params.totalPending ?? pendingReviews.length;
  const showing = pendingReviews.length;

  const reviewRows = pendingReviews.map((review) => {
    const stars = review.starRating != null ? renderStars(review.starRating) : '';
    const safeReviewer = escapeHtml(review.reviewerName);
    const reviewBody = review.reviewText
      ? escapeHtml(truncate(review.reviewText, 50))
      : 'Rating only';
    const safeUrl = review.approvalUrl.replace(/"/g, '&quot;');

    return `
            <tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
              <p style="margin:0 0 4px;font-size:16px;letter-spacing:2px;">${stars}</p>
              <p style="margin:0 0 4px;font-size:14px;color:#374151;font-weight:600;">${safeReviewer}</p>
              <p style="margin:0 0 8px;font-size:14px;color:#4b5563;">${reviewBody}</p>
              <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">Review &amp; Approve &rarr;</a>
            </td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">You have ${totalPending} review${totalPending !== 1 ? 's' : ''} waiting for your approval</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">Hi! These responses for ${safeName} are ready whenever you have a moment.${totalPending > showing ? ` Showing the ${showing} oldest.` : ''}</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${reviewRows}
          </table>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
