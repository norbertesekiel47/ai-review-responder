import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { setDeviceCookie, setCsrfCookie, verifyDeviceCookie } from '@/lib/approval/cookies';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  const ip = request.headers.get('x-forwarded-for') ?? request.ip ?? 'unknown';
  const rateCheck = await checkRateLimit(`approve:get:${ip}`, 10, 60);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }

  const rawToken = params.token;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const [link] = await sql<{
    id: string;
    response_id: string;
    business_id: string;
    expires_at: Date;
    consumed_at: Date | null;
    revoked_at: Date | null;
  }[]>`
    SELECT id, response_id, business_id, expires_at, consumed_at, revoked_at
    FROM approval_links WHERE token_hash = ${tokenHash}
  `;

  if (!link) {
    return NextResponse.json(
      { error: 'Invalid approval link' },
      { status: 404, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }
  if (link.consumed_at) {
    return NextResponse.json(
      { error: 'This link has already been used' },
      { status: 410, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }
  if (link.revoked_at) {
    return NextResponse.json(
      { error: 'This link has been revoked' },
      { status: 410, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }
  if (new Date(link.expires_at) <= new Date()) {
    return NextResponse.json(
      { error: 'This link has expired' },
      { status: 410, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }

  const [data] = await sql<{
    response_text: string;
    version: number;
    status: string;
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    review_date: string;
    business_name: string;
  }[]>`
    SELECT resp.response_text, resp.version, resp.status,
           r.reviewer_name, r.star_rating, r.review_text, r.review_date,
           b.name AS business_name
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    JOIN businesses b ON resp.business_id = b.id
    WHERE resp.id = ${link.response_id}
  `;

  if (!data) {
    return NextResponse.json(
      { error: 'Response data not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }

  const response = NextResponse.json({
    review: {
      reviewerName: data.reviewer_name,
      starRating: data.star_rating,
      reviewText: data.review_text,
      reviewDate: data.review_date,
    },
    response: {
      responseText: data.response_text,
      version: data.version,
      status: data.status,
    },
    businessName: data.business_name,
    expiresAt: link.expires_at,
  }, { status: 200, headers: { 'Cache-Control': 'no-store, private' } });

  // Only set a new device cookie if one doesn't already exist or is invalid.
  // Re-creating on every GET would overwrite the browser cookie after session
  // binding, making the same device fail future device checks.
  if (!verifyDeviceCookie(request)) {
    setDeviceCookie(response);
  }
  // CSRF token is always refreshed — it's a short-lived nonce
  setCsrfCookie(response);

  return response;
}
