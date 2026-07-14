import { randomUUID } from 'node:crypto';
import { isMockMode } from '@/lib/shared/mock-mode';
import { escapeHtml } from '@/lib/shared/html';
import { sendEmail } from '../send-email';
import { getEmailTags, type EmailCategory } from '../headers';
import { buildEmailShell, escapeHrefUrl, LOG_PREFIX } from './shared';

export interface AutonomySuspendedNoticeEmailParams {
  to: string;
  from: string;
  accountName: string;
  reason: string;
  settingsUrl: string;
  supportUrl: string;
  idempotencyKey?: string;
}

export function autonomySuspendedNoticeSubject(accountName: string): string {
  return `[${accountName}] Auto-posting paused`;
}

export function buildAutonomySuspendedNoticeEmailHtml(
  params: Omit<AutonomySuspendedNoticeEmailParams, 'to' | 'from' | 'idempotencyKey'>,
): string {
  const accountName = escapeHtml(params.accountName);
  const reason = escapeHtml(params.reason);
  return buildEmailShell(`        <tr><td style="padding:32px 24px 0;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#111;">Auto-posting paused for ${accountName}</h1>
          <p style="margin:0 0 12px;font-size:14px;color:#374151;line-height:1.6;">Auto-posting was paused after a safety review. This pause applies to your entire account.</p>
          <p style="margin:0 0 12px;font-size:14px;color:#374151;line-height:1.6;">Drafts will continue to be created, but you will need to review and approve them manually.</p>
          <p style="margin:0;font-size:14px;color:#374151;"><strong>Reason:</strong> ${reason}</p>
        </td></tr>
        <tr><td style="padding:24px;" align="center">
          <a href="${escapeHrefUrl(params.settingsUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 24px;border-radius:6px;font-size:16px;font-weight:600;text-decoration:none;">Review auto-approval settings</a>
        </td></tr>
        <tr><td style="padding:0 24px 24px;">
          <p style="margin:0;font-size:13px;color:#6b7280;text-align:center;">Questions? <a href="${escapeHrefUrl(params.supportUrl)}" style="color:#2563eb;">Contact RepWorth support</a>.</p>
        </td></tr>`);
}

export async function sendAutonomySuspendedNoticeEmail(
  params: AutonomySuspendedNoticeEmailParams,
): Promise<{ messageId: string }> {
  const subject = autonomySuspendedNoticeSubject(params.accountName);
  if (isMockMode()) {
    const mockId = `mock-${randomUUID()}`;
    console.log(`${LOG_PREFIX} [MOCK] Autonomy-suspended notice email to=${params.to} subject="${subject}" messageId=${mockId}`);
    return { messageId: mockId };
  }
  const html = buildAutonomySuspendedNoticeEmailHtml(params);
  const category: EmailCategory = 'transactional';
  const { data, error } = await sendEmail({
    from: params.from,
    to: params.to,
    subject,
    html,
    tags: getEmailTags(category),
  }, { idempotencyKey: params.idempotencyKey });
  if (error) throw new Error(`Resend API error: ${error.message}`);
  return { messageId: data!.id };
}
