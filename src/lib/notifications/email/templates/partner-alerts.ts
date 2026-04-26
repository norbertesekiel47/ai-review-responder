// src/lib/notifications/email/templates/partner-alerts.ts
//
// Partner-facing alert builders. Sent to sales partners (not owners)
// when a customer needs attention — engagement gaps, escalations, low
// approval rates, satisfaction-pulse signals.
//
// All four templates share the "owner contact + suggested action"
// layout pattern, so they live in one file and tend to evolve together.
import { escapeHtml } from '@/lib/shared/html';

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

// ── Partner Satisfaction Alert email template ─────────────────────────

export interface PartnerSatisfactionAlertParams {
  businessName: string;
  rating: 'great' | 'ok' | 'not_great';
  comment: string | null;
  weekStartDate: string;
  ownerEmail: string;
  ownerPhone: string | null;
}

export function buildPartnerSatisfactionAlertHtml(params: PartnerSatisfactionAlertParams): string {
  const safeName = escapeHtml(params.businessName);
  const safeEmail = escapeHtml(params.ownerEmail);
  const safePhone = params.ownerPhone ? escapeHtml(params.ownerPhone) : null;
  const safeComment = params.comment ? escapeHtml(params.comment) : null;

  const accentColor = params.rating === 'not_great' ? '#dc2626' : '#d97706';
  const headerColor = params.rating === 'not_great' ? '#dc2626' : '#92400e';
  const ratingLabel = params.rating === 'not_great' ? 'Not great' : params.rating === 'ok' ? 'OK' : 'Great';

  const phoneText = safePhone
    ? `<p style="margin:0 0 8px;font-size:14px;color:#374151;">Phone: ${safePhone}</p>`
    : '';

  const commentSection = safeComment
    ? `<div style="margin:16px 0;padding:12px;background-color:#fef2f2;border-radius:6px;">
        <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Owner comment</p>
        <p style="margin:0;font-size:14px;color:#374151;font-style:italic;">&ldquo;${safeComment}&rdquo;</p>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="border-left:4px solid ${accentColor};padding-left:16px;margin-bottom:16px;">
      <h2 style="margin:0 0 4px;font-size:18px;color:${headerColor};">Satisfaction pulse: ${safeName} rated &ldquo;${ratingLabel}&rdquo;</h2>
      <p style="margin:0;font-size:14px;color:#374151;">Week of ${escapeHtml(params.weekStartDate)}</p>
    </div>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Rating: <strong style="color:${accentColor};">${ratingLabel}</strong></p>
    ${commentSection}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
    <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Owner contact</p>
    <p style="margin:0 0 8px;font-size:14px;color:#374151;">Email: ${safeEmail}</p>
    ${phoneText}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
    <p style="margin:0;font-size:14px;color:${headerColor};font-weight:600;font-style:italic;">Suggested action: Reach out to the owner to understand their concern.</p>
  </div>
</body>
</html>`;
}
