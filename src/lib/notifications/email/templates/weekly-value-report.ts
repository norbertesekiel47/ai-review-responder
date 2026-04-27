// src/lib/notifications/email/templates/weekly-value-report.ts
//
// Weekly Value Report — recurring marketing email sent every Monday
// summarizing the past week's review activity.
import { escapeHtml } from '@/lib/shared/html';
import { renderStars, truncate, escapeHrefUrl } from './shared';

function formatWeekDate(iso: string): string {
  try {
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return iso;
  }
}

export interface WeeklyValueReportParams {
  businessName: string;
  weekStartDate: string;
  weekEndDate: string;
  totalReviews: number;
  totalResponded: number;
  notableReviews: Array<{
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
  }>;
  intelligenceBrief: string | null;
  baselineResponseRate: number | null;
  fourWeekAvgReviews: number;
  ranking: { keyword: string; currentRank: number; initialRank: number } | null;
  dashboardUrl: string | null;
  /** HMAC-signed feedback URLs for satisfaction pulse. null if CSRF_SECRET not configured. */
  feedbackUrls: {
    great: string;
    ok: string;
    notGreat: string;
  } | null;
}

export function buildWeeklyValueReportHtml(params: WeeklyValueReportParams): string {
  const {
    businessName, weekStartDate, weekEndDate,
    totalReviews, totalResponded, notableReviews,
    intelligenceBrief, baselineResponseRate, fourWeekAvgReviews,
    ranking, dashboardUrl, feedbackUrls,
  } = params;

  const safeName = escapeHtml(businessName);
  const responseRate = totalReviews > 0 ? Math.round((totalResponded / totalReviews) * 100) : 0;
  const weekRange = `${formatWeekDate(weekStartDate)} – ${formatWeekDate(weekEndDate)}`;
  const timeSavedMinutes = totalResponded * 7;

  // Value-delivered header
  const valueHeader = `This week RepWorth handled ${totalResponded} review${totalResponded !== 1 ? 's' : ''} for you, saving you approximately ${timeSavedMinutes} minutes`;

  // Response rate lift
  const baselineHtml = baselineResponseRate !== null
    ? ` <span style="font-size:13px;color:#6b7280;">(was ${baselineResponseRate}% before RepWorth)</span>`
    : '';

  // Review velocity
  const velocityHtml = `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">New reviews this week: <strong>${totalReviews}</strong> | 4-week average: <strong>${fourWeekAvgReviews}</strong></p>
    </td></tr>`;

  // Ranking (conditional)
  const rankingHtml = ranking
    ? `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">Your ranking for &lsquo;${escapeHtml(ranking.keyword)}&rsquo;: <strong>#${ranking.currentRank}</strong> (was #${ranking.initialRank} when you joined)</p>
    </td></tr>`
    : '';

  // Intelligence brief (conditional)
  const briefHtml = intelligenceBrief
    ? `
    <tr><td style="padding:16px 24px 0;">
      <div style="background:#f0f9ff;border-radius:6px;padding:12px;border-left:3px solid #3b82f6;">
        <p style="margin:0 0 4px;font-size:12px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">AI Intelligence Brief</p>
        <p style="margin:0;font-size:14px;color:#1e3a5f;line-height:1.5;">${escapeHtml(intelligenceBrief)}</p>
      </div>
    </td></tr>`
    : '';

  // Notable reviews
  let notableHtml = '';
  if (notableReviews.length > 0) {
    const items = notableReviews.map((r) => {
      const stars = renderStars(r.starRating);
      const text = r.reviewText ? escapeHtml(truncate(r.reviewText, 150)) : 'Rating only';
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;"><span style="font-size:16px;">${stars}</span> <strong>${escapeHtml(r.reviewerName)}</strong><br><span style="color:#4b5563;font-size:14px;">${text}</span></td></tr>`;
    }).join('');
    notableHtml = `
      <tr><td style="padding:16px 24px 0;">
        <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Reviews needing attention</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
      </td></tr>`;
  }

  // Dashboard link (conditional). Use the shared escapeHrefUrl helper for
  // both & and " escaping (a query-string `?token=abc&type=invite` would
  // otherwise render as `?token=abc&type=invite` and risk being mis-parsed
  // as an HTML entity reference by strict parsers).
  const dashboardHtml = dashboardUrl
    ? `
    <tr><td style="padding:16px 24px 0;" align="center">
      <a href="${escapeHrefUrl(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">See your full dashboard &rarr;</a>
    </td></tr>`
    : '';

  // Satisfaction pulse (conditional) — escape URLs for href attributes
  const pulseSection = feedbackUrls
    ? `
        <tr><td style="padding:20px 24px 0;">
          <p style="margin:0 0 12px;font-size:14px;color:#374151;text-align:center;">How was your experience this week?</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" width="33%" style="padding:0 4px;">
                <a href="${escapeHrefUrl(feedbackUrls.great)}" style="display:block;padding:10px 4px;background:#d1fae5;color:#065f46;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;text-align:center;">Great</a>
              </td>
              <td align="center" width="33%" style="padding:0 4px;">
                <a href="${escapeHrefUrl(feedbackUrls.ok)}" style="display:block;padding:10px 4px;background:#fef3c7;color:#92400e;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;text-align:center;">OK</a>
              </td>
              <td align="center" width="33%" style="padding:0 4px;">
                <a href="${escapeHrefUrl(feedbackUrls.notGreat)}" style="display:block;padding:10px 4px;background:#fee2e2;color:#991b1b;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;text-align:center;">Not great</a>
              </td>
            </tr>
          </table>
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
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Weekly Value Report — ${safeName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">${weekRange}</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">${valueHeader}</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            <tr>
              <td style="padding:16px;background:#f9fafb;border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:#111;">${totalReviews}</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Reviews</p>
              </td>
              <td style="width:8px;"></td>
              <td style="padding:16px;background:#f9fafb;border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:#111;">${totalResponded}</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Responded</p>
              </td>
              <td style="width:8px;"></td>
              <td style="padding:16px;background:${responseRate >= 90 ? '#f0fdf4' : '#fef3c7'};border-radius:6px;text-align:center;width:33%;">
                <p style="margin:0;font-size:24px;font-weight:700;color:${responseRate >= 90 ? '#166534' : '#92400e'};">${responseRate}%</p>
                <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">Rate</p>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:8px 24px 0;">
          <p style="margin:0;font-size:14px;color:#374151;">${responseRate}%${baselineHtml}</p>
        </td></tr>
        ${velocityHtml}
        ${rankingHtml}
        ${briefHtml}
        ${notableHtml}
        ${dashboardHtml}
        ${pulseSection}
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
