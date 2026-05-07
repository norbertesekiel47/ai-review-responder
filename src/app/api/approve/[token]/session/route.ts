import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { establishApprovalSession } from '@/lib/approval/service';

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  return runTokenApprovalAction(
    request,
    params.token,
    'session',
    { success: true },
    ({ tx, link, deviceCookieHash, audit }) => (
      establishApprovalSession(tx, link.id, deviceCookieHash, audit)
    ),
    { requireVerifiedDeviceCookie: false, recoverResponseCorrelation: false },
  );
}
