import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { lockValidLink, approve } from '@/lib/approval/service';
import type { AuditContext } from '@/lib/approval/service';
import { getDeviceCookieHash, validateCsrf, verifyDeviceCookie } from '@/lib/approval/cookies';
import { handleApprovalError } from '@/lib/approval/http-errors';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  const rawToken = params.token;

  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const rateCheck = await checkRateLimit(`approve:post:${tokenHash}`, 3, 60);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'Cache-Control': 'no-store, private' } });
  }

  if (!validateCsrf(request)) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403, headers: { 'Cache-Control': 'no-store, private' } });
  }
  if (!verifyDeviceCookie(request)) {
    return NextResponse.json({ error: 'Invalid device cookie' }, { status: 403, headers: { 'Cache-Control': 'no-store, private' } });
  }

  const deviceCookieHash = getDeviceCookieHash(request);
  if (!deviceCookieHash) {
    return NextResponse.json({ error: 'Device cookie missing' }, { status: 400, headers: { 'Cache-Control': 'no-store, private' } });
  }

  const ip = request.headers.get('x-forwarded-for') ?? request.ip ?? null;

  try {
    await sql.begin(async (tx) => {
      const link = await lockValidLink(tx, rawToken);
      const audit: AuditContext = { tokenHash: link.token_hash, deviceCookieHash, ipAddress: ip };
      await approve(tx, link, deviceCookieHash, audit);
    });

    return NextResponse.json(
      { success: true, message: "Response approved! We'll post it to Google shortly." },
      { status: 200, headers: { 'Cache-Control': 'no-store, private' } },
    );
  } catch (err) {
    return handleApprovalError(err, 'approve');
  }
}
