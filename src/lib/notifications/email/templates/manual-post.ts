// src/lib/notifications/email/templates/manual-post.ts
//
// Manual-post instructions email — sent to a sales partner after an
// owner approves a response in SerpAPI mode (no GBP API connection).
import { escapeHtml } from '@/lib/shared/html';
import { renderStars } from './shared';

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
