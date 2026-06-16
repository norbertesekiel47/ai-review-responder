import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { edit } from '@/lib/approval/service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { validateApproveEdit } from './validation';

type TokenRouteContext = {
  params: Promise<{ token: string }>;
};

export async function POST(
  request: NextRequest,
  { params }: TokenRouteContext,
): Promise<NextResponse> {
  const { token } = await params;

  return runTokenApprovalAction<string>(
    request,
    token,
    'edit',
    { success: true, message: "Response approved with your edits! We'll post it to Google shortly." },
    ({ tx, link, deviceCookieHash, audit, correlationId, prepared }) => (
      edit(tx, link, prepared, deviceCookieHash, audit, correlationId)
    ),
    {
      prepare: async () => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: NO_STORE_HEADERS });
        }

        const result = validateApproveEdit(body);
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400, headers: NO_STORE_HEADERS });
        }

        return result.editedText;
      },
    },
  );
}
