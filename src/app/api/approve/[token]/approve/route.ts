import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { approve } from '@/lib/approval/service';

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
    'approve',
    { success: true, message: 'Approved — posting to Google has started.' },
    ({ tx, link, deviceCookieHash, audit, correlationId }) => (
      approve(tx, link, deviceCookieHash, audit, correlationId)
    ),
  );
}
