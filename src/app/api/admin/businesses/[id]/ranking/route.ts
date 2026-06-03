import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { asLocationId } from '@/lib/shared/ids';
import type { LocationId } from '@/lib/shared/ids';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { requireAdminOr401, withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

const RankingSchema = z.object({
  keyword: z.string().trim().min(1, 'Keyword cannot be empty').max(255),
  rankPosition: z.number().int().min(1).max(100).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
});

async function createRankingSnapshot(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawBusinessId } = await params;
  const businessId: LocationId = asLocationId(rawBusinessId);

  const auth = await requireAdminOr401(request);
  if (!auth.ok) return auth.response;

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

  // Validate the date is a real calendar date (regex only checks format, not validity)
  const dateParts = snapshotDate.split('-').map(Number);
  const dateObj = new Date(Date.UTC(dateParts[0]!, dateParts[1]! - 1, dateParts[2]!));
  if (
    dateObj.getUTCFullYear() !== dateParts[0]! ||
    dateObj.getUTCMonth() !== dateParts[1]! - 1 ||
    dateObj.getUTCDate() !== dateParts[2]!
  ) {
    return NextResponse.json(
      { error: 'Invalid date' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

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
      { success: true, id: rows[0]?.id },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    // FK violation (23503) — unknown business_id → 404
    const code = (error as { code?: string }).code;
    if (code === '23503') {
      return NextResponse.json(
        { error: 'Business not found' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    console.error('[api/ranking] Failed to upsert ranking snapshot:', error);
    return NextResponse.json(
      { error: 'Failed to save ranking snapshot' },
      { status: 500 },
    );
  }
}

export const POST = withSameOrigin()(createRankingSnapshot);
