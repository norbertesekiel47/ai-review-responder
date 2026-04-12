import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: businessId } = await params;

  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let responseId: string;
  try {
    const body = await request.json();
    responseId = body.responseId;
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 },
    );
  }

  if (!responseId || typeof responseId !== 'string') {
    return NextResponse.json(
      { error: 'responseId is required' },
      { status: 400 },
    );
  }

  try {
    const updated = await sql`
      UPDATE responses
      SET status = 'posted', posted_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status = 'awaiting_manual_post'
    `;

    if (updated.count === 0) {
      return NextResponse.json(
        { error: 'Response not found or not awaiting manual post' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api/mark-posted] Failed to update response:', error);
    return NextResponse.json(
      { error: 'Failed to mark response as posted' },
      { status: 500 },
    );
  }
}
