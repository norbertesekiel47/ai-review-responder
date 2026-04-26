import { renderStars, truncate } from './email/templates/shared';
import { escapeHtml } from '@/lib/shared/html';

export { getResend } from './email/client';
export * from './email/templates/shared';

export type { EmailCategory } from './email/headers';
export { getEmailHeaders, getEmailTags } from './email/headers';

export * from './email/templates/approval';
export * from './email/templates/manual-post';
export * from './email/templates/internal';

export * from './email/templates/weekly-value-report';

export * from './email/templates/monthly-impact';

export * from './email/templates/owner-nudge';

export * from './email/templates/partner-alerts';

// ── Onboarding Drip: Day 1 (Welcome) ─────────────────────────────────

export interface OnboardingDay1Params {
  businessName: string;
  ownerName: string;
  dashboardUrl: string | null;
}

export function buildOnboardingDay1Html(params: OnboardingDay1Params): string {
  const safeName = escapeHtml(params.businessName);
  const safeOwner = escapeHtml(params.ownerName);

  const dashboardHtml = params.dashboardUrl
    ? `
        <tr><td style="padding:16px 24px 0;" align="center">
          <a href="${params.dashboardUrl.replace(/"/g, '&quot;')}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">See your dashboard &rarr;</a>
        </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 16px;font-size:18px;color:#111827;">Welcome to RepWorth, ${safeOwner}!</h2>
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">We are now monitoring reviews for ${safeName}.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">How it works:</p>
          <ol style="margin:0 0 16px;padding-left:20px;font-size:14px;color:#374151;line-height:1.8;">
            <li>A new review comes in — we draft a personalized response</li>
            <li>You review and approve (or edit) the draft</li>
            <li>Your approved response is queued for posting to Google</li>
          </ol>
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">Each approval takes about 30 seconds.</p>
          <p style="margin:0 0 0;font-size:14px;color:#374151;line-height:1.5;">You will also receive a weekly value report every Monday.</p>
        </td></tr>
        ${dashboardHtml}
        <tr><td style="padding:24px;">
          <p style="margin:0 0 0;font-size:14px;color:#374151;line-height:1.5;">If you have questions, just reply to this email.</p>
          <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Onboarding Drip: Day 7 (First Week Recap) ────────────────────────

export interface OnboardingDay7Params {
  businessName: string;
  ownerName: string;
  reviewsHandled: number;
  timeSavedMinutes: number;
  responseRate: number; // 0-100
  highlightReview: {
    reviewerName: string;
    starRating: number;
    reviewText: string;
    responseText: string;
  } | null;
  hasEdits: boolean;
  pendingReviews: Array<{
    reviewerName: string;
    starRating: number | null;
    approvalUrl: string;
  }>;
}

export function buildOnboardingDay7Html(params: OnboardingDay7Params): string {
  const safeName = escapeHtml(params.businessName);
  const safeOwner = escapeHtml(params.ownerName);
  const { reviewsHandled, timeSavedMinutes, responseRate, highlightReview, hasEdits, pendingReviews } = params;

  // Stats section
  const statsHtml = reviewsHandled > 0 || pendingReviews.length > 0
    ? `
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 8px;font-size:14px;color:#374151;line-height:1.5;">This week we handled <strong>${reviewsHandled}</strong> review${reviewsHandled !== 1 ? 's' : ''}, saving you approximately <strong>${timeSavedMinutes} minutes</strong>.</p>
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">Response rate: <strong>${responseRate}%</strong></p>
        </td></tr>`
    : `
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">No reviews came in this week — we are watching and will notify you when one does.</p>
        </td></tr>`;

  // Highlight review
  let highlightHtml = '';
  if (highlightReview) {
    const stars = renderStars(highlightReview.starRating);
    highlightHtml = `
        <tr><td style="padding:0 24px 12px;">
          <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Example from this week</p>
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:16px;">${stars}</p>
              <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">${escapeHtml(highlightReview.reviewerName)}</p>
              <p style="margin:0 0 12px;font-size:14px;color:#4b5563;line-height:1.5;">${escapeHtml(highlightReview.reviewText)}</p>
              <p style="margin:0;font-size:13px;color:#166534;line-height:1.5;font-style:italic;border-top:1px solid #e5e7eb;padding-top:8px;">&ldquo;${escapeHtml(highlightReview.responseText)}&rdquo;</p>
            </td></tr>
          </table>
        </td></tr>`;
  }

  // Edits acknowledgment
  const editsHtml = hasEdits
    ? `
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">Thanks for the edits — we are learning your voice and will get closer each time.</p>
        </td></tr>`
    : '';

  // Pending reviews
  let pendingHtml = '';
  if (pendingReviews.length > 0) {
    const rows = pendingReviews.map((review) => {
      const stars = review.starRating != null ? renderStars(review.starRating) : '';
      const safeReviewer = escapeHtml(review.reviewerName);
      const safeUrl = review.approvalUrl.replace(/"/g, '&quot;');
      return `
              <tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
                <p style="margin:0 0 4px;font-size:16px;letter-spacing:2px;">${stars}</p>
                <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">${safeReviewer}</p>
                <a href="${safeUrl}" style="display:inline-block;padding:10px 20px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review &amp; Approve</a>
              </td></tr>`;
    }).join('');

    pendingHtml = `
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">You have ${pendingReviews.length} review${pendingReviews.length !== 1 ? 's' : ''} ready for approval:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${rows}
          </table>
        </td></tr>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111827;">Your first week with RepWorth</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">Hi ${safeOwner}, here is how ${safeName} did this week.</p>
        </td></tr>
        ${statsHtml}
        ${highlightHtml}
        ${editsHtml}
        ${pendingHtml}
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Onboarding Drip: Day 30 (First Month Impact) ──────────────────────

export interface OnboardingDay30Params {
  businessName: string;
  ownerName: string;
  totalReviews: number;
  responseRateBefore: number | null; // null if no baseline
  responseRateNow: number;
  timeSavedMinutes: number;
  rankingChange: { keyword: string; from: number; to: number } | null;
  salesPartnerName: string | null;
}

export function buildOnboardingDay30Html(params: OnboardingDay30Params): string {
  const safeName = escapeHtml(params.businessName);
  const safeOwner = escapeHtml(params.ownerName);
  const { totalReviews, responseRateBefore, responseRateNow, timeSavedMinutes, rankingChange, salesPartnerName } = params;

  const baselineHtml = responseRateBefore !== null
    ? ` <span style="font-size:13px;color:#6b7280;">(was ${responseRateBefore}% before RepWorth)</span>`
    : '';

  const rankingHtml = rankingChange
    ? `
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">Your ranking for &lsquo;${escapeHtml(rankingChange.keyword)}&rsquo;: <strong>#${rankingChange.to}</strong> (was #${rankingChange.from} when you joined)</p>
        </td></tr>`
    : '';

  const safeSalesPartner = salesPartnerName ? escapeHtml(salesPartnerName) : null;
  const signoff = safeSalesPartner
    ? `Questions? Reply to this email — ${safeSalesPartner} is here to help.`
    : 'Questions? Reply to this email.';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111827;">Your first month with RepWorth — here is what changed</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">Hi ${safeOwner}, here is the impact for ${safeName}.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">In your first month, we handled <strong>${totalReviews}</strong> review${totalReviews !== 1 ? 's' : ''}, saving you approximately <strong>${timeSavedMinutes} minutes</strong>.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">Your response rate: <strong>${responseRateNow}%</strong>${baselineHtml}</p>
        </td></tr>
        ${rankingHtml}
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">This is just the beginning — your review responses will keep getting better as we learn your voice.</p>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">${signoff}</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

