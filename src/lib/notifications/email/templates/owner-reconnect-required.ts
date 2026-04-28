// src/lib/notifications/email/templates/owner-reconnect-required.ts
//
// Owner reconnect-required — sent when an approval lands but the
// business's Zernio (Google Business) connection isn't currently linked.
// Prompts the owner to reconnect so the queued reply can be published.
import { escapeHtml } from '@/lib/shared/html';

export interface OwnerReconnectRequiredEmailParams {
  businessName: string;
  reviewerName: string;
  dashboardConnectUrl: string;
}

export function buildOwnerReconnectRequiredEmailHtml(
  params: OwnerReconnectRequiredEmailParams,
): string {
  const { businessName, reviewerName, dashboardConnectUrl } = params;
  return `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="color:#111">Your reply to ${escapeHtml(reviewerName)} is ready to publish</h2>
  <p>You approved a response for ${escapeHtml(businessName)}, but your Google Business connection isn't currently linked.</p>
  <p>Reconnect to publish this reply (and any others queued behind it).</p>
  <p style="margin-top:32px">
    <a href="${escapeHtml(dashboardConnectUrl)}" style="background:#2563eb;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Reconnect Google Business</a>
  </p>
</body></html>`;
}
