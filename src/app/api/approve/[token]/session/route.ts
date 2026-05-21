import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { establishApprovalSession } from '@/lib/approval/service';

type TokenRouteContext = {
  params: Promise<{ token: string }>;
};

export async function POST(
  request: NextRequest,
  { params }: TokenRouteContext,
): Promise<NextResponse> {
  const { token } = await params;

  return runTokenApprovalAction(
    request,
    token,
    'session',
    { success: true },
    ({ tx, link, deviceCookieHash, audit }) => (
      establishApprovalSession(tx, link.id, deviceCookieHash, audit)
    ),
    { requireVerifiedDeviceCookie: false, recoverResponseCorrelation: false },
  );
}
