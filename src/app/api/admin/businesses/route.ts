import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { OnboardBusinessSchema } from '@/lib/shared/schemas';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isPlaceId, extractPlaceId } from '@/lib/reviews/url-parser';
import type { SyncReviewsPayload, ValidatePlaceIdPayload } from '@/lib/shared/worker-types';

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
      Math.max(parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10) || 20, 1),
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

function splitCommaOrNewline(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitParagraphs(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildPaymentLinkUrl(tier: string, businessId: string, ownerEmail: string): string | null {
  const links: Record<string, string | undefined> = {
    founding: process.env.STRIPE_PAYMENT_LINK_FOUNDING,
    standard: process.env.STRIPE_PAYMENT_LINK_STANDARD,
  };
  const baseUrl = links[tier];
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('client_reference_id', businessId);
    url.searchParams.set('prefilled_email', ownerEmail);
    return url.toString();
  } catch {
    console.error(`[api/admin/businesses POST] Malformed payment link URL for tier ${tier}: ${baseUrl}`);
    return null;
  }
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

  const parsed = OnboardBusinessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const data = parsed.data;

  let placeId: string | null = null;
  let placeIdVerified = false;

  if (data.googlePlaceId) {
    // Autocomplete path — validate format server-side
    if (!isPlaceId(data.googlePlaceId)) {
      return NextResponse.json({ error: 'Invalid Place ID format' }, { status: 400 });
    }
    placeId = data.googlePlaceId;
    placeIdVerified = true;
  } else if (data.googleMapsUrl) {
    // URL fallback — extract what we can, validation happens in worker
    placeId = extractPlaceId(data.googleMapsUrl);
    // placeId may be hex CID or null — that's OK, worker will resolve it
    placeIdVerified = false;
  } else {
    return NextResponse.json({ error: 'Place ID or Google Maps URL required' }, { status: 400 });
  }

  const businessId = uuidv7();
  const userId = uuidv7();
  const outboxId = uuidv7();

  // Build payment link URL BEFORE the transaction — if the env var is malformed,
  // we return null gracefully instead of crashing after the business is created.
  const paymentUrl = buildPaymentLinkUrl(data.subscriptionTier, businessId, data.ownerEmail);

  const staffNames = splitCommaOrNewline(data.staffNames);
  const highlightFacts = splitCommaOrNewline(data.highlightFacts);
  const avoidFacts = splitCommaOrNewline(data.avoidFacts);
  const sampleResponses = splitParagraphs(data.sampleResponses);

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO businesses (
          id,
          name,
          category,
          google_place_id,
          place_id_verified,
          google_maps_url,
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
          ${placeIdVerified},
          ${data.googleMapsUrl ?? null},
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

      if (placeIdVerified) {
        // Queue sync_reviews directly — Place ID is canonical
        const syncPayload: SyncReviewsPayload = {
          business_id: businessId,
          google_place_id: placeId!,
        };
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${outboxId},
            'sync_reviews',
            'business',
            ${businessId},
            ${JSON.stringify(syncPayload)}::jsonb,
            'pending'
          )
        `;
      } else {
        // Queue validate_place_id first — worker resolves then syncs
        const validatePayload: ValidatePlaceIdPayload = {
          business_id: businessId,
          google_maps_url: data.googleMapsUrl!,
        };
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${outboxId},
            'validate_place_id',
            'business',
            ${businessId},
            ${JSON.stringify(validatePayload)}::jsonb,
            'pending'
          )
        `;
      }
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

  return NextResponse.json({ id: businessId, paymentUrl }, { status: 201 });
}
