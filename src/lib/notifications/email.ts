import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import { isMockMode } from '@/lib/shared/mock-mode';

const LOG_PREFIX = '[email]';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

export interface ApprovalEmailParams {
  to: string;
  from: string;
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string;
  responsePreview: string;
  approvalUrl: string;
}

function renderStars(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

import { escapeHtml } from '@/lib/shared/html';

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
  const { businessName, reviewerName, starRating, reviewText, reviewDate, responsePreview, approvalUrl } = params;
  const stars = renderStars(starRating);
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
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">New review for ${safeName}</h2>
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

export async function sendApprovalEmail(
  params: ApprovalEmailParams,
): Promise<{ messageId: string }> {
  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Approval email to=${params.to} subject="New review for ${params.businessName} — response ready" messageId=${mockId}\n  → /approve/[redacted]`);
    return { messageId: mockId };
  }

  const resend = getResend();
  const html = buildApprovalEmailHtml(params);

  const { data, error } = await resend.emails.send({
    from: params.from,
    to: params.to,
    subject: `New review for ${params.businessName} — response ready`,
    html,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}

// ── Manual-post email template ──────────────────────────────────────────

export interface ManualPostEmailParams {
  businessName: string;
  reviewerName: string;
  starRating: number;
  approvedText: string;
  googleMapsUrl: string | null;
}

export function buildManualPostEmailHtml(params: ManualPostEmailParams): string {
  const safeBusinessName = escapeHtml(params.businessName);
  const safeReviewerName = escapeHtml(params.reviewerName);
  const safeApprovedText = escapeHtml(params.approvedText);
  const stars = renderStars(params.starRating);

  const mapsLinkHtml = params.googleMapsUrl
    ? `<p style="margin:16px 0 0;"><a href="${escapeHtml(params.googleMapsUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">Open on Google Maps</a></p>`
    : `<p style="margin:16px 0 0;font-size:13px;color:#9ca3af;">No Google Place ID on file — locate the business manually on Google Maps.</p>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Manual post needed: ${safeBusinessName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">An owner-approved response is ready to be posted on Google Maps.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f9fafb;border-radius:6px;padding:16px;border:1px solid #e5e7eb;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:14px;color:#374151;font-weight:600;">${safeReviewerName} ${stars}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 0;">
          <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Instructions</p>
          <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.5;">Copy the response below and paste it as an owner reply on Google Maps.</p>
        </td></tr>
        <tr><td style="padding:0 24px;">
          <table role="presentation" width="100%" style="background:#f0fdf4;border-radius:6px;padding:16px;border:1px solid #bbf7d0;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:12px;color:#166534;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Approved response (copy this)</p>
              <p style="margin:0;font-size:14px;color:#14532d;line-height:1.6;white-space:pre-wrap;">${safeApprovedText}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 24px;">
          ${mapsLinkHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Internal admin emails (manual post instructions, exception alerts) ──

export interface InternalEmailParams {
  to: string;
  subject: string;
  bodyHtml: string;
}

export async function sendInternalEmail(
  params: InternalEmailParams,
): Promise<{ messageId: string }> {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) throw new Error('RESEND_FROM_EMAIL not configured');

  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Internal email to=${params.to} subject="${params.subject}" messageId=${mockId}`);
    return { messageId: mockId };
  }

  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.bodyHtml,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }

  return { messageId: data!.id };
}

// ── Weekly Value Report email template ──────────────────────────────────

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
}

export function buildWeeklyValueReportHtml(params: WeeklyValueReportParams): string {
  const {
    businessName, weekStartDate, weekEndDate,
    totalReviews, totalResponded, notableReviews,
    intelligenceBrief, baselineResponseRate, fourWeekAvgReviews,
    ranking, dashboardUrl,
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

  // Dashboard link (conditional)
  const dashboardHtml = dashboardUrl
    ? `
    <tr><td style="padding:16px 24px 0;" align="center">
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
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Monthly Impact email template ───────────────────────────────────────

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

// ── Owner Nudge email template ────────────────────────────────────────

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

// ── Partner Engagement Alert email template ───────────────────────────

export interface PartnerEngagementAlertParams {
  businessName: string;
  daysSinceApproval: number | null;
  /** Fallback: days_since_approval ?? oldest_pending_age_days. Used for display. */
  activityAgeDays: number | null;
  pendingCount: number;
  approvalRate: number | null;
  ownerEmail: string;
  ownerPhone: string | null;
}

export function buildPartnerEngagementAlertHtml(params: PartnerEngagementAlertParams): string {
  const safeName = escapeHtml(params.businessName);
  const safeEmail = escapeHtml(params.ownerEmail);
  const safePhone = params.ownerPhone ? escapeHtml(params.ownerPhone) : null;

  const daysText = params.activityAgeDays !== null
    ? `${params.activityAgeDays} day${params.activityAgeDays !== 1 ? 's' : ''}`
    : 'unknown';

  const approvalRateText = params.approvalRate !== null
    ? `<p style="margin:0 0 8px;font-size:14px;color:#374151;">Approval rate: <strong>${params.approvalRate}%</strong></p>`
    : '';

  const phoneText = safePhone
    ? `<p style="margin:0 0 8px;font-size:14px;color:#374151;">Phone: ${safePhone}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 16px;font-size:18px;color:#111;">Customer ${safeName} hasn&#39;t engaged in ${daysText}</h2>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">${params.daysSinceApproval !== null ? 'Days since last approval' : 'Oldest pending review age'}: <strong>${daysText}</strong></p>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Pending reviews: <strong>${params.pendingCount}</strong></p>
    ${approvalRateText}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
    <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Owner contact</p>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Email: ${safeEmail}</p>
    ${phoneText}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
    <p style="margin:0;font-size:14px;color:#6b7280;font-style:italic;">Suggested action: Consider sending a check-in message.</p>
  </div>
</body>
</html>`;
}

// ── Partner Escalation Alert email template ───────────────────────────

export function buildPartnerEscalationAlertHtml(params: PartnerEngagementAlertParams): string {
  const safeName = escapeHtml(params.businessName);
  const safeEmail = escapeHtml(params.ownerEmail);
  const safePhone = params.ownerPhone ? escapeHtml(params.ownerPhone) : null;

  const daysText = params.activityAgeDays !== null
    ? `${params.activityAgeDays} day${params.activityAgeDays !== 1 ? 's' : ''}`
    : 'unknown';

  const approvalRateText = params.approvalRate !== null
    ? `<p style="margin:0 0 8px;font-size:14px;color:#374151;">Approval rate: <strong>${params.approvalRate}%</strong></p>`
    : '';

  const phoneText = safePhone
    ? `<p style="margin:0 0 8px;font-size:14px;color:#374151;">Phone: ${safePhone}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="border-left:4px solid #dc2626;padding-left:16px;margin-bottom:16px;">
      <h2 style="margin:0 0 4px;font-size:18px;color:#dc2626;">Customer ${safeName} may be at risk</h2>
      <p style="margin:0;font-size:14px;color:#374151;">No engagement in 2+ weeks</p>
    </div>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">${params.daysSinceApproval !== null ? 'Days since last approval' : 'Oldest pending review age'}: <strong>${daysText}</strong></p>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Pending reviews: <strong>${params.pendingCount}</strong></p>
    ${approvalRateText}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
    <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Owner contact</p>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Email: ${safeEmail}</p>
    ${phoneText}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
    <p style="margin:0;font-size:14px;color:#991b1b;font-weight:600;font-style:italic;">Suggested action: Recommend a personal phone call or visit.</p>
  </div>
</body>
</html>`;
}

// ── Partner Low Engagement Alert email template ───────────────────────

export interface PartnerLowEngagementParams {
  businessName: string;
  approvalRate: number;
  pendingCount: number;
  ownerEmail: string;
  ownerPhone: string | null;
}

export function buildPartnerLowEngagementAlertHtml(params: PartnerLowEngagementParams): string {
  const safeName = escapeHtml(params.businessName);
  const safeEmail = escapeHtml(params.ownerEmail);
  const safePhone = params.ownerPhone ? escapeHtml(params.ownerPhone) : null;

  const phoneText = safePhone
    ? `<p style="margin:0 0 8px;font-size:14px;color:#374151;">Phone: ${safePhone}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="border-left:4px solid #d97706;padding-left:16px;margin-bottom:16px;">
      <h2 style="margin:0 0 4px;font-size:18px;color:#92400e;">Customer ${safeName} approval rate is ${params.approvalRate}%</h2>
    </div>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Approval rate: <strong>${params.approvalRate}%</strong></p>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Pending reviews: <strong>${params.pendingCount}</strong></p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
    <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Owner contact</p>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Email: ${safeEmail}</p>
    ${phoneText}
  </div>
</body>
</html>`;
}
