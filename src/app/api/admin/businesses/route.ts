import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { extractPlaceId } from '@/lib/reviews/url-parser';
import type { SyncReviewsPayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/admin/businesses — paginated business list
// ---------------------------------------------------------------------------

interface BusinessListRow {
  id: string;
  name: string;
  category: string | null;
  subscription_status: string;
  last_sync_at: Date | null;
  pending_count: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10) || 20,
      100,
    );
    const offset = Math.max(
      parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0,
      0,
    );

    const [businessRows, countRows] = await Promise.all([
      sql<BusinessListRow[]>`
        SELECT
          b.id,
          b.name,
          b.category,
          b.subscription_status,
          b.last_sync_at,
          COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_count
        FROM businesses b
        LEFT JOIN responses resp
          ON resp.business_id = b.id AND resp.status != 'superseded'
        GROUP BY b.id
        ORDER BY b.name ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM businesses`,
    ]);

    return NextResponse.json({
      businesses: businessRows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category ?? null,
        subscriptionStatus: row.subscription_status,
        lastSyncAt: row.last_sync_at ? row.last_sync_at.toISOString() : null,
        pendingCount: row.pending_count,
      })),
      total: countRows[0]?.total ?? 0,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[api/admin/businesses GET] Failed to fetch businesses:', error);
    return NextResponse.json(
      { error: 'Failed to fetch businesses' },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/businesses — onboard a new business
// ---------------------------------------------------------------------------

const OnboardSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.string().max(100).optional(),
  googleMapsUrl: z.string().min(1),
  ownerName: z.string().min(1).max(255),
  ownerEmail: z.string().email().max(255),
  ownerPhone: z.string().max(20).optional(),
  notificationPreference: z.enum(['email', 'sms', 'both']).default('email'),
  tone: z.string().max(100).default('professional and friendly'),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: z.enum(['founding', 'standard']).default('standard'),
});

function splitLines(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();

  const parsed = OnboardSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const data = parsed.data;

  const placeId = extractPlaceId(data.googleMapsUrl);
  if (!placeId) {
    return NextResponse.json(
      { error: 'Could not extract Google Place ID from URL' },
      { status: 400 },
    );
  }

  const businessId = uuidv7();
  const userId = uuidv7();
  const outboxId = uuidv7();

  const staffNames = splitLines(data.staffNames);
  const highlightFacts = splitLines(data.highlightFacts);
  const avoidFacts = splitLines(data.avoidFacts);
  const sampleResponses = splitLines(data.sampleResponses);

  const payload: SyncReviewsPayload = {
    business_id: businessId,
    google_place_id: placeId,
  };

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO businesses (
          id,
          name,
          category,
          google_place_id,
          tone,
          products_services,
          staff_names,
          highlight_facts,
          avoid_facts,
          sample_responses,
          notification_preference,
          owner_name,
          owner_email,
          owner_phone,
          subscription_tier,
          subscription_status
        ) VALUES (
          ${businessId},
          ${data.name},
          ${data.category ?? null},
          ${placeId},
          ${data.tone},
          ${data.productsServices ?? null},
          ${staffNames},
          ${highlightFacts},
          ${avoidFacts},
          ${sampleResponses},
          ${data.notificationPreference},
          ${data.ownerName},
          ${data.ownerEmail},
          ${data.ownerPhone ?? null},
          ${data.subscriptionTier},
          'pending_payment'
        )
      `;

      await tx`
        INSERT INTO users (id, name, email, phone, role, business_id)
        VALUES (
          ${userId},
          ${data.ownerName},
          ${data.ownerEmail},
          ${data.ownerPhone ?? null},
          'owner',
          ${businessId}
        )
      `;

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${outboxId},
          'sync_reviews',
          'business',
          ${businessId},
          ${JSON.stringify(payload)}::jsonb,
          'pending'
        )
      `;
    });
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === '23505') {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 },
      );
    }
    console.error('[api/admin/businesses POST] Transaction failed:', error);
    return NextResponse.json(
      { error: 'Failed to onboard business' },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: businessId }, { status: 201 });
}
