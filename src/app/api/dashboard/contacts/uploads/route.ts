// POST /api/dashboard/contacts/uploads — contacts/visits CSV upload (#541).
// Route orchestrates only: flag gate, owner auth, multipart parse, ownership
// check; all persistence logic lives in src/lib/solicitation/uploads.ts.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import {
  errorResponse,
  jsonResponse,
  requireWritableOwner,
  withSameOrigin,
} from '@/lib/auth/route-helpers';
import { isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { MAX_UPLOAD_BYTES } from '@/lib/solicitation/contacts-csv';
import { createContactsCsvUpload } from '@/lib/solicitation/uploads';

export const dynamic = 'force-dynamic';

async function uploadContactsCsv(request: NextRequest): Promise<NextResponse> {
  // Flag gate FIRST (invariant #13): when watch-mode is off this surface does
  // not exist — 404 before auth so the response shape leaks nothing.
  if (!solicitationWatchEnabled()) return errorResponse('Not found', 404);

  // Mutation posture: requireWritableOwner = owner auth + writable-subscription
  // gate (the write-flavored sibling of the kpis route's read gate).
  const owner = await requireWritableOwner(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const businessId = formData.get('businessId')?.toString() ?? '';
    const attestationAccepted = formData.get('attestationAccepted')?.toString() === 'true';

    if (!file || !(file instanceof Blob)) {
      return errorResponse('missing_file', 400);
    }
    if (!isValidUuid(businessId)) {
      return errorResponse('invalid_business_id', 400);
    }
    // Size precheck BEFORE buffering the file into a string (precedent:
    // admin locations csv-import). The module re-checks the decoded bytes.
    if (file.size > MAX_UPLOAD_BYTES) {
      return errorResponse('file_too_large', 413);
    }

    // Business-ownership gate: contact_csv_uploads denormalizes BOTH
    // account_id and business_id, so this SELECT is the app-enforced
    // integrity check (invariant #8) that the pairing written below is real.
    const businessRows = await sql<{ id: string }[]>`
      SELECT id FROM businesses
      WHERE id = ${businessId} AND account_id = ${accountId}
    `;
    if (businessRows.length === 0) {
      return errorResponse('Business not found', 404);
    }

    const csvText = await file.text();
    const filename = file instanceof File && file.name.length > 0
      ? file.name
      : 'upload.csv';

    const result = await createContactsCsvUpload(sql, {
      accountId,
      businessId,
      attestedByUserId: user.id,
      attestationAccepted,
      filename,
      csvText,
    });

    if (!result.ok) {
      return errorResponse(result.error, result.error === 'file_too_large' ? 413 : 400);
    }
    return jsonResponse({ uploadId: result.uploadId }, 201);
  } catch (error) {
    reportCaughtError('api/dashboard/contacts/uploads', error, { accountId });
    return errorResponse('Failed to upload contacts CSV', 500);
  }
}

export const POST = withSameOrigin()(uploadContactsCsv);
