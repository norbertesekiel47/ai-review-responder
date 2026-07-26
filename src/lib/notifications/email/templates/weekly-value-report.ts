// src/lib/notifications/email/templates/weekly-value-report.ts
//
// Recurring Insights agent report sent every Monday with the past week's
// review activity.
import { escapeHtml } from '@/lib/shared/html';
import type { CompetitorDelta, NamedRivalLine } from '@/lib/competitors/named-rival';
import { renderStars, truncate, escapeHrefUrl } from './shared';

// Re-exported so the `src/lib/notifications/email` barrel keeps serving the
// type to existing consumers; `named-rival.ts` owns the declaration.
export type { CompetitorDelta };

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
  competitorDelta: CompetitorDelta;
  dashboardUrl: string | null;
  /** HMAC-signed feedback URLs for satisfaction pulse. null if CSRF_SECRET not configured. */
  feedbackUrls: {
    great: string;
    ok: string;
    notGreat: string;
  } | null;
}

function renderRankingHtml(ranking: WeeklyValueReportParams['ranking']): string {
  return ranking
    ? `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">Your ranking for &lsquo;${escapeHtml(ranking.keyword)}&rsquo;: <strong>#${ranking.currentRank}</strong> (was #${ranking.initialRank} when you joined)</p>
    </td></tr>`
    : '';
}

function renderRivalLineHtml(line: NamedRivalLine): string {
  let velocityCopy = '';
  if (line.reviewVelocity !== null) {
    if (line.reviewVelocity > 0) {
      const reviewLabel = line.reviewVelocity === 1 ? 'review' : 'reviews';
      velocityCopy = ` gained ${line.reviewVelocity} ${reviewLabel} since our last check;`;
    } else if (line.reviewVelocity < 0) {
      const lost = Math.abs(line.reviewVelocity);
      const reviewLabel = lost === 1 ? 'review' : 'reviews';
      velocityCopy = ` lost ${lost} ${reviewLabel} since our last check;`;
    } else {
      velocityCopy = ' had no new reviews since our last check;';
    }
  }

  // The Auto-default rival is always disclosed as algorithmic; an owner's own
  // pick is never presented as auto-selected (CONTEXT.md, Auto-default rival).
  const prefix = line.source === 'auto_default' ? 'Auto-selected rival: ' : '';

  return `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">${prefix}${escapeHtml(line.rivalName)}${velocityCopy} gap now ${line.gap}</p>
    </td></tr>`;
}

function renderCompetitorDeltaHtml(competitorDelta: CompetitorDelta): string {
  if (!competitorDelta) return '';

  if (competitorDelta.kind === 'teaser') {
    return `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">RepWorth is watching &lsquo;${escapeHtml(competitorDelta.keyword)}&rsquo; and will report Competitor Delta after our next check.</p>
    </td></tr>`;
  }

  if (competitorDelta.kind === 'dropout') {
    const note = `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">${escapeHtml(competitorDelta.droppedName)} dropped out of your local pack.</p>
    </td></tr>`;
    return competitorDelta.fallback ? note + renderRivalLineHtml(competitorDelta.fallback) : note;
  }

  return renderRivalLineHtml(competitorDelta.line);
}

function renderBriefHtml(intelligenceBrief: string | null): string {
  return intelligenceBrief
    ? `
    <tr><td style="padding:16px 24px 0;">
      <div style="background:#f0f9ff;border-radius:6px;padding:12px;border-left:3px solid #3b82f6;">
        <p style="margin:0 0 4px;font-size:12px;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">AI Intelligence Brief</p>
        <p style="margin:0;font-size:14px;color:#1e3a5f;line-height:1.5;">${escapeHtml(intelligenceBrief)}</p>
      </div>
    </td></tr>`
    : '';
}

function renderNotableReviewsHtml(
  notableReviews: WeeklyValueReportParams['notableReviews'],
): string {
  if (notableReviews.length === 0) return '';
  const items = notableReviews.map((review) => {
    const stars = renderStars(review.starRating);
    const text = review.reviewText
      ? escapeHtml(truncate(review.reviewText, 150))
      : 'Rating only';
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;"><span style="font-size:16px;">${stars}</span> <strong>${escapeHtml(review.reviewerName)}</strong><br><span style="color:#4b5563;font-size:14px;">${text}</span></td></tr>`;
  }).join('');
  return `
      <tr><td style="padding:16px 24px 0;">
        <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Reviews needing attention</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
      </td></tr>`;
}

function renderDashboardHtml(dashboardUrl: string | null): string {
  return dashboardUrl
    ? `
    <tr><td style="padding:16px 24px 0;" align="center">
      <a href="${escapeHrefUrl(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">See your full dashboard &rarr;</a>
    </td></tr>`
    : '';
}

function renderPulseSection(
  feedbackUrls: WeeklyValueReportParams['feedbackUrls'],
): string {
  return feedbackUrls
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
}

interface WeeklyReportShellParts {
  safeName: string;
  weekRange: string;
  valueHeader: string;
  totalReviews: number;
  totalResponded: number;
  responseRate: number;
  baselineHtml: string;
  velocityHtml: string;
  rankingHtml: string;
  competitorDeltaHtml: string;
  briefHtml: string;
  notableHtml: string;
  dashboardHtml: string;
  pulseSection: string;
}

function renderWeeklyReportShell(parts: WeeklyReportShellParts): string {
  const {
    safeName, weekRange, valueHeader, totalReviews, totalResponded, responseRate,
    baselineHtml, velocityHtml, rankingHtml, competitorDeltaHtml, briefHtml,
    notableHtml, dashboardHtml, pulseSection,
  } = parts;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Your Insights agent's weekly report — ${safeName}</h2>
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
        ${competitorDeltaHtml}
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

export function buildWeeklyValueReportHtml(params: WeeklyValueReportParams): string {
  const {
    businessName, weekStartDate, weekEndDate,
    totalReviews, totalResponded, notableReviews,
    intelligenceBrief, baselineResponseRate, fourWeekAvgReviews,
    ranking, competitorDelta, dashboardUrl, feedbackUrls,
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

  return renderWeeklyReportShell({
    safeName,
    weekRange,
    valueHeader,
    totalReviews,
    totalResponded,
    responseRate,
    baselineHtml,
    velocityHtml,
    rankingHtml: renderRankingHtml(ranking),
    competitorDeltaHtml: renderCompetitorDeltaHtml(competitorDelta),
    briefHtml: renderBriefHtml(intelligenceBrief),
    notableHtml: renderNotableReviewsHtml(notableReviews),
    dashboardHtml: renderDashboardHtml(dashboardUrl),
    pulseSection: renderPulseSection(feedbackUrls),
  });
}
