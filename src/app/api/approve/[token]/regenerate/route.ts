import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { regenerate } from '@/lib/approval/service';

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
    'regenerate',
    { success: true, message: 'Generating a new response - check your email in a few minutes.' },
    ({ tx, link, deviceCookieHash, audit, correlationId }) => (
      regenerate(tx, link, deviceCookieHash, audit, correlationId)
    ),
  );
}
