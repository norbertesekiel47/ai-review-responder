import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql, jsonb } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { asLocationId } from '@/lib/shared/ids';
import type { LocationId } from '@/lib/shared/ids';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

const KeywordsSchema = z.object({
  // trim() BEFORE min(1) so whitespace-only strings become "" and fail validation
  keywords: z.array(z.string().trim().min(1, 'Keyword cannot be empty').max(255)).max(5, 'Maximum 5 keywords'),
});

async function updateKeywords(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawBusinessId } = await params;
  const businessId: LocationId = asLocationId(rawBusinessId);

  try {
    await requireRole(request, 'admin');
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
      SET tracked_keywords = ${jsonb(parsed.keywords)},
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

export const PUT = withSameOrigin()(updateKeywords);
