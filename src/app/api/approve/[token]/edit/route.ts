import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { edit } from '@/lib/approval/service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { sanitizePublicResponseText } from '@/lib/shared/sanitize';

const MAX_EDIT_LENGTH = 2000;

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  return runTokenApprovalAction<string>(
    request,
    params.token,
    'edit',
    { success: true, message: "Response approved with your edits! We'll post it to Google shortly." },
    ({ tx, link, deviceCookieHash, audit, correlationId, prepared }) => (
      edit(tx, link, prepared, deviceCookieHash, audit, correlationId)
    ),
    {
      prepare: async () => {
        let editedText: string;
        try {
          const body = await request.json();
          editedText = body.editedText;
        } catch {
          return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: NO_STORE_HEADERS });
        }

        if (!editedText || typeof editedText !== 'string') {
          return NextResponse.json({ error: 'editedText is required' }, { status: 400, headers: NO_STORE_HEADERS });
        }

        if (editedText.length > MAX_EDIT_LENGTH) {
          return NextResponse.json({ error: `editedText exceeds ${MAX_EDIT_LENGTH} characters` }, { status: 400, headers: NO_STORE_HEADERS });
        }

        const sanitizedText = sanitizePublicResponseText(editedText);
        if (sanitizedText.length === 0) {
          return NextResponse.json({ error: 'editedText is required' }, { status: 400, headers: NO_STORE_HEADERS });
        }

        return sanitizedText;
      },
    },
  );
}
