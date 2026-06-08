import { escapeHtml } from '@/lib/shared/html';
import { escapeHrefUrl } from './shared';

export interface AccountOffboardingEmailParams {
  emailType?:
    | 'cancel_only_confirmation'
    | 'cancel_only_access_end'
    | 'cancel_only_reactivation_confirmation'
    | 'delete_data_confirmation'
    | 'delete_data_purge_reminder'
    | 'keep_my_data_confirmation'
    | 'purge_receipt';
  accessEndsAt: Date | string | null;
  purgeAfter?: Date | string | null;
  purgedAt?: Date | string | null;
  keepMyDataUrl?: string;
}

export function buildAccountOffboardingEmailHtml(
  params: AccountOffboardingEmailParams,
): string {
  if (params.emailType === 'cancel_only_access_end') {
    return buildCancelOnlyAccessEndEmailHtml({ accessEndsAt: params.accessEndsAt });
  }
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
  if (params.emailType === 'delete_data_purge_reminder') {
    return buildDeleteDataPurgeReminderEmailHtml({ purgeAfter: params.purgeAfter ?? null });
  }
  if (params.emailType === 'keep_my_data_confirmation') {
    return buildKeepMyDataConfirmationEmailHtml();
  }
  if (params.emailType === 'purge_receipt') {
    return buildPurgeReceiptEmailHtml({
      purgedAt: params.purgedAt ?? null,
    });
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

function buildDeleteDataPurgeReminderEmailHtml(params: {
  purgeAfter: Date | string | null;
}): string {
  const purgeAfterLabel = formatPurgeAfter(params.purgeAfter);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 8px;">
          <h2 style="margin:0 0 12px;font-size:18px;color:#111;">Reminder: your RepWorth data will be deleted soon</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">Your RepWorth account data is scheduled for permanent deletion on <strong>${escapeHtml(purgeAfterLabel)}</strong>. After that date the deletion cannot be undone.</p>
          <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">If you did not intend to delete your data, sign in to RepWorth to keep it, or use the secure link from your original deletion email, before the deletion date. If you have questions, contact RepWorth support.</p>
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

function buildPurgeReceiptEmailHtml(params: {
  purgedAt: Date | string | null;
}): string {
  const purgedAtLabel = formatPurgedAt(params.purgedAt);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 8px;">
          <h2 style="margin:0 0 12px;font-size:18px;color:#111;">Your RepWorth data has been deleted</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">RepWorth completed the account deletion process on <strong>${escapeHtml(purgedAtLabel)}</strong>.</p>
          <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">If you have questions about this deletion, contact RepWorth support.</p>
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

function buildCancelOnlyAccessEndEmailHtml(params: {
  accessEndsAt: Date | string | null;
}): string {
  const accessEndedLabel = formatAccessEndsAt(params.accessEndsAt);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="padding:32px 24px 8px;">
          <h2 style="margin:0 0 12px;font-size:18px;color:#111;">Your RepWorth subscription has ended</h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.5;">Your scheduled cancellation is now complete and your access ended on <strong>${escapeHtml(accessEndedLabel)}</strong>.</p>
          <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">To use RepWorth again, you can resubscribe and reconnect your Google locations at any time. Your historical data is retained subject to the usual retention rules.</p>
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

const OFFBOARDING_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatPurgeAfter(value: Date | string | null): string {
  if (!value) return '30 days from your deletion request';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '30 days from your deletion request';
  return OFFBOARDING_DATE_FORMAT.format(date);
}

function formatPurgedAt(value: Date | string | null): string {
  if (!value) return 'the scheduled deletion date';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'the scheduled deletion date';
  return OFFBOARDING_DATE_FORMAT.format(date);
}

function formatAccessEndsAt(value: Date | string | null): string {
  if (!value) return 'the end of your current billing period';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'the end of your current billing period';
  return OFFBOARDING_DATE_FORMAT.format(date);
}
