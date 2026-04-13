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
    console.log(`${LOG_PREFIX} [MOCK] Approval email to=${params.to} subject="New review for ${params.businessName} — response ready" messageId=${mockId}\n  → ${params.approvalUrl}`);
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

// ── Weekly summary email template ─────────────────────────────────────

export interface WeeklySummaryEmailParams {
  businessName: string;
  weekStartDate: string; // 'YYYY-MM-DD'
  weekEndDate: string;   // 'YYYY-MM-DD'
  totalReviews: number;
  totalResponded: number;
  notableReviews: Array<{
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
  }>;
}

function formatWeekDate(iso: string): string {
  try {
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return iso;
  }
}

export function buildWeeklySummaryEmailHtml(params: WeeklySummaryEmailParams): string {
  const { businessName, weekStartDate, weekEndDate, totalReviews, totalResponded, notableReviews } = params;
  const safeName = escapeHtml(businessName);
  const responseRate = totalReviews > 0 ? Math.round((totalResponded / totalReviews) * 100) : 0;
  const weekRange = `${formatWeekDate(weekStartDate)} – ${formatWeekDate(weekEndDate)}`;

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

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 0;">
          <h2 style="margin:0 0 4px;font-size:18px;color:#111;">Weekly Review Summary — ${safeName}</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">${weekRange}</p>
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
        ${notableHtml}
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by RepWorth — automated review responses for your business.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
