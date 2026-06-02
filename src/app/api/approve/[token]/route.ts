import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { setDeviceCookie, setCsrfCookie, verifyDeviceCookie } from '@/lib/approval/cookies';
import { hashApprovalToken } from '@/lib/approval/locks';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { getIpKey } from '@/lib/shared/request-ip';

type TokenRouteContext = {
  params: Promise<{ token: string }>;
};

export async function GET(
  request: NextRequest,
  { params }: TokenRouteContext,
) {
  const rateCheck = await checkRateLimit(getIpKey(request, 'approve:get'), 10, 60);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: NO_STORE_HEADERS },
    );
  }

  const { token: rawToken } = await params;
  const tokenHash = hashApprovalToken(rawToken);

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
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  if (link.consumed_at) {
    return NextResponse.json(
      { error: 'This link has already been used' },
      { status: 410, headers: NO_STORE_HEADERS },
    );
  }
  if (link.revoked_at) {
    return NextResponse.json(
      { error: 'This link has been revoked' },
      { status: 410, headers: NO_STORE_HEADERS },
    );
  }
  if (new Date(link.expires_at) <= new Date()) {
    return NextResponse.json(
      { error: 'This link has expired' },
      { status: 410, headers: NO_STORE_HEADERS },
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
    display_label: string | null;
    account_id: string;
    is_archived: boolean;
  }[]>`
    SELECT resp.response_text, resp.version, resp.status,
           r.reviewer_name, r.star_rating, r.review_text, r.review_date,
           b.name AS business_name,
           b.display_label,
           b.account_id,
           (b.archived_at IS NOT NULL) AS is_archived
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    JOIN businesses b ON resp.business_id = b.id
    WHERE resp.id = ${link.response_id}
  `;

  if (!data) {
    return NextResponse.json(
      { error: 'Response data not found' },
      { status: 404, headers: NO_STORE_HEADERS },
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
    locationLabel: data.display_label ?? data.business_name,
    accountId: data.account_id,
    isArchived: data.is_archived,
    expiresAt: link.expires_at,
  }, { status: 200, headers: NO_STORE_HEADERS });

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
