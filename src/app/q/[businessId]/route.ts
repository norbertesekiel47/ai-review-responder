// src/app/q/[businessId]/route.ts
//
// Public QR redirect (docs/context/review-qr.md "QR redirect"): resolves a Review QR scan
// server-side and 302s to the location's Google write-review deep link.
// Hardened like src/app/r/google/[responseId]/route.ts, but stronger on the
// destination: the URL is CONSTRUCTED from an isPlaceId-validated place id,
// never read from a stored URL, so no allowlist is needed and no open
// redirect is possible. Every refusal renders the scanner-facing unavailable
// page (200, no-store) with one reason-coded log line — never an error leak.
//
// UI-only per invariant #1: one short DB read + redirect, with the
// best-effort analytics insert deferred via `after()`: the 302 returns
// FIRST, and the guarded insert runs post-response, so a stalled insert can
// no longer delay a scanner (adversarial R1 A1 — the old code awaited the
// insert on the critical path). The try/catch stays INSIDE the after
// callback: a failed insert is reported, never thrown (the
// best-effort-after-primary-side-effect gotcha).

import { randomUUID } from 'node:crypto';
import { after, NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import { resolveQrRedirect } from '@/lib/locations/review-qr';
import { createWorkerLogger } from '@/lib/shared/logger';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

// Local on purpose, the /r/google precedent — importing owner-route's
// UUID_RE would drag the owner-auth module chain into a public route.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const logger = createWorkerLogger('q/[businessId]');

function unavailablePage(): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review link unavailable</title>
</head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#111;">
  <div style="max-width:520px;margin:80px auto;padding:32px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <h1 style="font-size:20px;margin:0 0 8px;">Review link unavailable</h1>
    <p style="font-size:15px;color:#555;line-height:1.5;margin:0;">
      This review link isn&#39;t active right now. You can still leave a review
      by searching for the business on Google.
    </p>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> },
): Promise<NextResponse> {
  const { businessId } = await params;
  if (!UUID_RE.test(businessId)) {
    logger.log('qr_redirect_unavailable', { reason: 'bad_id' });
    return unavailablePage();
  }

  const resolution = await resolveQrRedirect(sql, businessId);
  if (resolution.kind === 'unavailable') {
    logger.log('qr_redirect_unavailable', { reason: resolution.reason, businessId });
    return unavailablePage();
  }

  after(async () => {
    try {
      await enqueueAnalyticsEvent(sql, {
        eventName: 'qr_scan_redirected',
        eventKey: makeAnalyticsEventKey('qr_scan_redirected', [businessId, randomUUID()]),
        distinctId: resolution.accountId,
        accountId: resolution.accountId,
        businessId,
        // Duplicated INTO properties on purpose: AnalyticsDispatchPoller
        // forwards only the properties JSON (plus $insert_id) to PostHog —
        // the DB columns never reach it (codex R1 M3/M4).
        properties: { account_id: resolution.accountId, business_id: businessId },
      });
    } catch (err) {
      reportCaughtError('q/[businessId] GET analytics', err, { businessId });
    }
  });

  return new NextResponse(null, {
    status: 302,
    headers: { Location: resolution.url, 'Cache-Control': 'no-store' },
  });
}
