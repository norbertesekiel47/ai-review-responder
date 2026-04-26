// src/lib/notifications/email/templates/monthly-impact.ts
//
// Monthly Impact email — recurring marketing email summarizing the
// month's response activity, ranking trend, and best review.
import { escapeHtml } from '@/lib/shared/html';
import { renderStars } from './shared';

export interface MonthlyImpactEmailParams {
  businessName: string;
  monthLabel: string; // e.g. 'March 2026'
  totalReviews: number;
  totalResponded: number;
  responseRate: number;
  baselineResponseRate: number | null;
  timeSavedMinutes: number;
  intelligenceBrief: string | null;
  ranking: { keyword: string; currentRank: number; initialRank: number } | null;
  bestReview: {
    reviewerName: string;
    starRating: number;
    reviewText: string;
    responseText: string | null;
  } | null;
  dashboardUrl: string | null;
}

export function buildMonthlyImpactEmailHtml(params: MonthlyImpactEmailParams): string {
  const {
    businessName, monthLabel,
    totalReviews, totalResponded, responseRate,
    baselineResponseRate, timeSavedMinutes,
    intelligenceBrief, ranking, bestReview, dashboardUrl,
  } = params;

  const safeName = escapeHtml(businessName);
  const safeMonth = escapeHtml(monthLabel);
  const timeSavedHours = (timeSavedMinutes / 60).toFixed(1);

  // Intelligence brief (conditional)
  const briefHtml = intelligenceBrief
    ? `
        <tr><td style="padding:0 24px 16px;">
          <div style="background:#f0f9ff;border-radius:6px;padding:12px;border-left:3px solid #3b82f6;">
            <p style="margin:0 0 4px;font-size:12px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Monthly Intelligence Brief</p>
            <p style="margin:0;font-size:14px;color:#1e3a5f;line-height:1.5;">${escapeHtml(intelligenceBrief)}</p>
          </div>
        </td></tr>`
    : '';

  // Value delivered
  const valueHtml = `
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">In ${safeMonth}, we handled ${totalResponded} review${totalResponded !== 1 ? 's' : ''}, saving you approximately ${timeSavedHours} hours</p>
        </td></tr>`;

  // Response rate with baseline
  const baselineHtml = baselineResponseRate !== null
    ? ` <span style="font-size:13px;color:#6b7280;">(was ${baselineResponseRate}% before RepWorth)</span>`
    : '';
  const rateHtml = `
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 12px;font-size:14px;color:#374151;">Response rate: <strong>${responseRate}%</strong>${baselineHtml}</p>
        </td></tr>`;

  // Ranking (conditional)
  const rankingHtml = ranking
    ? `
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 12px;font-size:14px;color:#374151;">Your ranking for &lsquo;${escapeHtml(ranking.keyword)}&rsquo;: <strong>#${ranking.currentRank}</strong> (was #${ranking.initialRank} when you joined)</p>
        </td></tr>`
    : '';

  // Best review (conditional)
  let bestReviewHtml = '';
  if (bestReview) {
    const stars = renderStars(bestReview.starRating);
    const safeReviewText = escapeHtml(bestReview.reviewText);
    const safeReviewer = escapeHtml(bestReview.reviewerName);
    const responseHtml = bestReview.responseText
      ? `<p style="margin:12px 0 0;font-size:13px;color:#166534;line-height:1.5;font-style:italic;border-top:1px solid #e5e7eb;padding-top:8px;">&ldquo;${escapeHtml(bestReview.responseText)}&rdquo;</p>`
      : '';

    bestReviewHtml = `
        <tr><td style="padding:0 24px 12px;">
          <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Best Review of the Month</p>
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:16px;">${stars}</p>
              <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">${safeReviewer}</p>
              <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.5;">${safeReviewText}</p>
              ${responseHtml}
            </td></tr>
          </table>
        </td></tr>`;
  }

  // Dashboard link (conditional)
  const dashboardHtml = dashboardUrl
    ? `
        <tr><td style="padding:12px 24px 0;" align="center">
          <a href="${dashboardUrl.replace(/"/g, '&quot;')}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">See your full dashboard &rarr;</a>
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
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Monthly Impact Report — ${safeName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">${safeMonth}</p>
        </td></tr>
        ${briefHtml}
        ${valueHtml}
        ${rateHtml}
        ${rankingHtml}
        ${bestReviewHtml}
        ${dashboardHtml}
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
