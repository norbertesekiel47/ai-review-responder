// src/app/r/google/[responseId]/route.ts
//
// Stable "View on Google" redirect for the auto-approved post FYI (Workstream
// B6). The WhatsApp Content template URL button needs a FIXED prefix + dynamic
// suffix, and an arbitrary businesses.google_maps_url cannot be a template
// button target — so every channel's CTA points here, and this route resolves
// the destination server-side.
//
// This is a NEW PUBLIC redirect surface, so it is hardened (Codex R2 #5) even
// though we store the URL ourselves — never open-redirect off blindly-trusted
// stored data:
//   - require the response↔business relationship AND status='posted'
//   - validate the stored URL against an https Google Maps host/path allowlist
//   - render an "unavailable" PAGE (not a redirect) on null/invalid/unknown
//   - Cache-Control: no-store on every response
//
// UI-only per invariant #1: a short user-blocking DB read + redirect, no LLM /
// external / long-running work.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Allow ONLY https Google Maps destinations. Defense-in-depth against a
 * poisoned stored URL ever turning this into an open redirect.
 */
function isAllowedGoogleMapsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === 'maps.app.goo.gl') return true;          // Google Maps app short links
  if (host === 'maps.google.com') return true;          // maps subdomain (any path)
  if (host === 'google.com' || host === 'www.google.com') return path.startsWith('/maps');
  if (host === 'goo.gl') return path.startsWith('/maps');
  return false;
}

function unavailablePage(): NextResponse {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  const dashboardHref = `${appUrl}/dashboard`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link unavailable · RepWorth</title>
</head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#111;">
  <div style="max-width:520px;margin:80px auto;padding:32px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <h1 style="font-size:20px;margin:0 0 8px;">Link unavailable</h1>
    <p style="font-size:15px;color:#555;line-height:1.5;margin:0 0 24px;">
      We couldn't open this review on Google right now. Your reply was still posted —
      you can view your reviews from your RepWorth dashboard.
    </p>
    <a href="${dashboardHref}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none;">Go to dashboard</a>
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
  { params }: { params: Promise<{ responseId: string }> },
): Promise<NextResponse> {
  const { responseId } = await params;
  if (!UUID_RE.test(responseId)) {
    return unavailablePage();
  }

  // Require the response↔business relationship AND a confirmed post. A
  // not-yet/never-posted response (or a bad id) yields the unavailable page,
  // never a redirect.
  const [row] = await sql<{ google_maps_url: string | null }[]>`
    SELECT b.google_maps_url
    FROM responses resp
    JOIN businesses b ON b.id = resp.business_id
    WHERE resp.id = ${responseId}
      AND resp.status = 'posted'
    LIMIT 1
  `;

  if (!row || row.google_maps_url === null || !isAllowedGoogleMapsUrl(row.google_maps_url)) {
    return unavailablePage();
  }

  return new NextResponse(null, {
    status: 302,
    headers: { Location: row.google_maps_url, 'Cache-Control': 'no-store' },
  });
}
