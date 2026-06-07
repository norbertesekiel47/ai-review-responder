import { escapeHtml } from '@/lib/shared/html';
import { escapeHrefUrl } from './shared';

export interface AccountOffboardingEmailParams {
  emailType?:
    | 'cancel_only_confirmation'
    | 'cancel_only_reactivation_confirmation'
    | 'delete_data_confirmation'
    | 'keep_my_data_confirmation';
  accessEndsAt: Date | string | null;
  purgeAfter?: Date | string | null;
  keepMyDataUrl?: string;
}

export function buildAccountOffboardingEmailHtml(
  params: AccountOffboardingEmailParams,
): string {
  if (params.emailType === 'cancel_only_reactivation_confirmation') {
    return buildCancelOnlyReactivationConfirmationEmailHtml();
  }
  if (params.emailType === 'delete_data_confirmation') {
    if (!params.keepMyDataUrl) {
      throw new Error('keepMyDataUrl is required for delete_data_confirmation');
    }
    return buildDeleteDataConfirmationEmailHtml({
      keepMyDataUrl: params.keepMyDataUrl,
      purgeAfter: params.purgeAfter ?? null,
    });
  }
  if (params.emailType === 'keep_my_data_confirmation') {
    return buildKeepMyDataConfirmationEmailHtml();
  }

  const accessEndsLabel = formatAccessEndsAt(params.accessEndsAt);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 8px;">
          <h2 style="margin:0 0 12px;font-size:18px;color:#111;">Your RepWorth cancellation is scheduled</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">Your subscription is set to cancel at the end of the current billing period.</p>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">Your RepWorth access remains available until <strong>${escapeHtml(accessEndsLabel)}</strong>.</p>
          <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">No further action is needed.</p>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">RepWorth</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildDeleteDataConfirmationEmailHtml(params: {
  keepMyDataUrl: string;
  purgeAfter: Date | string | null;
}): string {
  const purgeAfterLabel = formatPurgeAfter(params.purgeAfter);
  const keepMyDataUrl = escapeHrefUrl(params.keepMyDataUrl);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 8px;">
          <h2 style="margin:0 0 12px;font-size:18px;color:#111;">Your RepWorth data deletion is scheduled</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">RepWorth has stopped review processing for this account and started the billing and Google teardown steps.</p>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">Your account data is scheduled for deletion on <strong>${escapeHtml(purgeAfterLabel)}</strong>. Some records may be retained when legally or operationally required.</p>
          <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.5;">If you want RepWorth to keep your historical data instead, use this secure link before deletion starts.</p>
          <p style="margin:0 0 20px;">
            <a href="${keepMyDataUrl}" style="display:inline-block;background:#111827;color:#ffffff;padding:12px 18px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">Keep my data</a>
          </p>
          <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">Keeping data does not restore product access. To use RepWorth again, you will need to resubscribe and reconnect your Google locations.</p>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">RepWorth</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildKeepMyDataConfirmationEmailHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 8px;">
          <h2 style="margin:0 0 12px;font-size:18px;color:#111;">Your RepWorth data will be kept</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">Your deletion request has been cancelled. RepWorth will keep your historical account data subject to the usual retention rules.</p>
          <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">Keeping data does not restore product access. To use RepWorth again, you will need to resubscribe and reconnect your Google locations.</p>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">RepWorth</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildCancelOnlyReactivationConfirmationEmailHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 8px;">
          <h2 style="margin:0 0 12px;font-size:18px;color:#111;">Your RepWorth subscription is active again</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">Your scheduled cancellation has been reversed.</p>
          <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">Your account access and subscription continue as before.</p>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">RepWorth</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function formatPurgeAfter(value: Date | string | null): string {
  if (!value) return '30 days from your deletion request';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '30 days from your deletion request';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatAccessEndsAt(value: Date | string | null): string {
  if (!value) return 'the end of your current billing period';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'the end of your current billing period';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
