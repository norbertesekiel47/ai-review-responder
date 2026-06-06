import { escapeHtml } from '@/lib/shared/html';

export interface AccountOffboardingEmailParams {
  emailType?: 'cancel_only_confirmation' | 'cancel_only_reactivation_confirmation';
  accessEndsAt: Date | string | null;
}

export function buildAccountOffboardingEmailHtml(
  params: AccountOffboardingEmailParams,
): string {
  if (params.emailType === 'cancel_only_reactivation_confirmation') {
    return buildCancelOnlyReactivationConfirmationEmailHtml();
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
