import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { approve } from '@/lib/approval/service';

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  return runTokenApprovalAction(
    request,
    params.token,
    'approve',
    { success: true, message: "Response approved! We'll post it to Google shortly." },
    ({ tx, link, deviceCookieHash, audit, correlationId }) => (
      approve(tx, link, deviceCookieHash, audit, correlationId)
    ),
  );
}
