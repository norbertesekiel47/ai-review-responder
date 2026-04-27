// src/lib/notifications/email/templates/owner-connection-lost.ts
//
// Owner connection-lost — sent when Zernio reports that the business's
// Google Business connection has gone offline. New replies will queue
// until the owner reconnects.
import { escapeHtml } from '@/lib/shared/html';

export interface OwnerConnectionLostEmailParams {
  businessName: string;
  queuedCount: number;
  dashboardConnectUrl: string;
}

export function buildOwnerConnectionLostEmailHtml(
  params: OwnerConnectionLostEmailParams,
): string {
  const { businessName, queuedCount, dashboardConnectUrl } = params;
  const queuedNote = queuedCount > 0
    ? `<p>You currently have ${queuedCount} approved ${queuedCount === 1 ? 'reply' : 'replies'} waiting to publish.</p>`
    : '';
  return `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="color:#111">Google Business connection paused for ${escapeHtml(businessName)}</h2>
  <p>We noticed your Google Business connection is no longer active. New replies will queue until you reconnect.</p>
  ${queuedNote}
  <p style="margin-top:32px">
    <a href="${escapeHtml(dashboardConnectUrl)}" style="background:#2563eb;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Reconnect Google Business</a>
  </p>
</body></html>`;
}
