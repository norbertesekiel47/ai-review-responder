import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const RankingSchema = z.object({
  keyword: z.string().min(1).max(255).trim(),
  rankPosition: z.number().int().min(1).max(100).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
});

export async function POST(
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

  let parsed: z.infer<typeof RankingSchema>;
  try {
    const body = await request.json();
    const result = RankingSchema.safeParse(body);
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

  const snapshotDate = parsed.date ?? new Date().toISOString().slice(0, 10);
  const id = uuidv7();

  try {
    const rows = await sql`
      INSERT INTO ranking_snapshots (id, business_id, keyword, rank_position, snapshot_date, source)
      VALUES (${id}, ${businessId}, ${parsed.keyword}, ${parsed.rankPosition}, ${snapshotDate}::date, 'manual')
      ON CONFLICT (business_id, keyword, snapshot_date)
      DO UPDATE SET rank_position = EXCLUDED.rank_position, source = 'manual'
      RETURNING id
    `;

    return NextResponse.json(
      { success: true, id: rows[0].id },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('[api/ranking] Failed to upsert ranking snapshot:', error);
    return NextResponse.json(
      { error: 'Failed to save ranking snapshot' },
      { status: 500 },
    );
  }
}
