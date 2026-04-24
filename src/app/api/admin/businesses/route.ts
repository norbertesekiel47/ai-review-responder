import { NextRequest, NextResponse } from 'next/server';
import { OnboardBusinessSchema } from '@/lib/shared/schemas';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isPlaceId, extractPlaceId } from '@/lib/reviews/url-parser';
import {
  createBusinessTx,
  DuplicateEmailError,
  type BusinessTxInput,
  type PlaceIdInput,
} from '@/lib/onboarding/create-business';

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  let authUser;
  try {
    authUser = await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

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

  const placeIdInput: PlaceIdInput = placeIdVerified && placeId
    ? { placeIdVerified: true, placeId, googleMapsUrl: data.googleMapsUrl ?? null }
    : { placeIdVerified: false, placeId: placeId ?? null, googleMapsUrl: data.googleMapsUrl! };

  const input: BusinessTxInput = {
    ownerEmail: data.ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone ?? null,
    businessName: data.name,
    category: data.category ?? null,
    tone: data.tone,
    productsServices: data.productsServices ?? null,
    staffNames: splitCommaOrNewline(data.staffNames),
    highlightFacts: splitCommaOrNewline(data.highlightFacts),
    avoidFacts: splitCommaOrNewline(data.avoidFacts),
    sampleResponses: splitParagraphs(data.sampleResponses),
    subscriptionTier: data.subscriptionTier,
    website: data.website ?? null,
    placeId: placeIdInput,
  };

  try {
    const result = await createBusinessTx(input, {
      mode: 'admin',
      onboardedBy: authUser.id,
    });
    return NextResponse.json(
      { id: result.businessId, paymentUrl: result.paymentUrl },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 409 },
      );
    }
    console.error('[api/admin/businesses POST] createBusinessTx failed:', err);
    return NextResponse.json({ error: 'Failed to onboard business' }, { status: 500 });
  }
}
