import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireDashboardReviewOwner,
  runDashboardReviewAction,
} from '@/lib/approval/http-routes';
import { editBySession } from '@/lib/approval/service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const editSchema = z.object({
  editedText: z.string().trim().min(1).max(2000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const parsed = editSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const { reviewId } = await params;
  return runDashboardReviewAction(
    request,
    reviewId,
    owner,
    'edit',
    'Response edited and approved.',
    ({ tx, responseId, businessId, audit, correlationId }) => (
      editBySession(tx, responseId, businessId, parsed.data.editedText, audit, correlationId)
    ),
  );
}
