import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const KeywordsSchema = z.object({
  keywords: z.array(z.string().min(1).max(255).trim()).max(5, 'Maximum 5 keywords'),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: businessId } = await params;

  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed: z.infer<typeof KeywordsSchema>;
  try {
    const body = await request.json();
    const result = KeywordsSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400 },
      );
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const rows = await sql`
      UPDATE businesses
      SET tracked_keywords = ${JSON.stringify(parsed.keywords)}::jsonb,
          updated_at = NOW()
      WHERE id = ${businessId}
      RETURNING id
    `;

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('[api/keywords] Failed to update keywords:', error);
    return NextResponse.json(
      { error: 'Failed to update keywords' },
      { status: 500 },
    );
  }
}
