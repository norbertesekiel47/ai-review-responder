import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { regenerate } from '@/lib/approval/service';

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  return runTokenApprovalAction(
    request,
    params.token,
    'regenerate',
    { success: true, message: 'Generating a new response - check your email in a few minutes.' },
    ({ tx, link, deviceCookieHash, audit, correlationId }) => (
      regenerate(tx, link, deviceCookieHash, audit, correlationId)
    ),
  );
}
