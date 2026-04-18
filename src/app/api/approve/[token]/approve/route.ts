import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { lockValidLink, approve } from '@/lib/approval/service';
import type { AuditContext } from '@/lib/approval/service';
import { recoverCorrelationId } from '@/lib/approval/correlation';
import { getDeviceCookieHash, validateCsrf, verifyDeviceCookie } from '@/lib/approval/cookies';
import { handleApprovalError } from '@/lib/approval/http-errors';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  const rawToken = params.token;

  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const rateCheck = await checkRateLimit(`approve:post:${tokenHash}`, 3, 60);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: NO_STORE_HEADERS });
  }

  if (!validateCsrf(request)) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403, headers: NO_STORE_HEADERS });
  }
  if (!verifyDeviceCookie(request)) {
    return NextResponse.json({ error: 'Invalid device cookie' }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const deviceCookieHash = getDeviceCookieHash(request);
  if (!deviceCookieHash) {
    return NextResponse.json({ error: 'Device cookie missing' }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const ip = request.headers.get('x-forwarded-for') ?? request.ip ?? null;

  try {
    await sql.begin(async (tx) => {
      const link = await lockValidLink(tx, rawToken);
      const audit: AuditContext = { tokenHash: link.token_hash, deviceCookieHash, ipAddress: ip };
      const [response] = await tx<{ review_id: string }[]>`
        SELECT review_id FROM responses WHERE id = ${link.response_id}
      `;
      const correlationId = response
        ? await recoverCorrelationId(tx, { reviewId: response.review_id, responseId: link.response_id })
        : link.response_id;
      await approve(tx, link, deviceCookieHash, audit, correlationId);
    });

    return NextResponse.json(
      { success: true, message: "Response approved! We'll post it to Google shortly." },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    return handleApprovalError(err, 'approve');
  }
}
