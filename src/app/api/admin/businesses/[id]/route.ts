import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { UpdateBusinessSchema } from '@/lib/shared/schemas';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

// PgBouncer returns text[] columns as JSON strings — guard both shapes.
const parseArray = (val: unknown): string[] => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  return [];
};

// ---------------------------------------------------------------------------
// GET /api/admin/businesses/[id] — business detail + reviews + latest responses
// ---------------------------------------------------------------------------

interface BusinessRow {
  id: string;
  name: string;
  category: string | null;
  google_place_id: string | null;
  tone: string | null;
  products_services: string | null;
  staff_names: unknown;
  highlight_facts: unknown;
  avoid_facts: unknown;
  sample_responses: unknown;
  subscription_status: string;
  subscription_tier: string;
  owner_name: string | null;
  owner_email: string | null;
  last_sync_at: Date | null;
}

interface ReviewRow {
  id: string;
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
  review_date: string | null;
  detected_language: string | null;
  review_status: string;
  detected_at: Date | null;
  response_id: string | null;
  response_status: string | null;
  response_text: string | null;
  approved_text: string | null;
  version: number | null;
}

export async function GET(
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

  try {
    const [businessRows, reviewRows] = await Promise.all([
      sql<BusinessRow[]>`
        SELECT
          id, name, category, google_place_id, tone, products_services,
          staff_names, highlight_facts, avoid_facts, sample_responses,
          subscription_status, subscription_tier, owner_name, owner_email, last_sync_at
        FROM businesses
        WHERE id = ${businessId}
      `,
      sql<ReviewRow[]>`
        SELECT
          r.id, r.reviewer_name, r.star_rating, r.review_text, r.review_date,
          r.detected_language, r.status AS review_status, r.detected_at,
          resp.id AS response_id, resp.status AS response_status,
          resp.response_text, resp.approved_text, resp.version
        FROM reviews r
        LEFT JOIN LATERAL (
          SELECT id, status, response_text, approved_text, version
          FROM responses
          WHERE review_id = r.id AND status != 'superseded'
          ORDER BY version DESC LIMIT 1
        ) resp ON true
        WHERE r.business_id = ${businessId}
        ORDER BY r.detected_at DESC
      `,
    ]);

    const business = businessRows[0];
    if (!business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    return NextResponse.json({
      business: {
        id: business.id,
        name: business.name,
        category: business.category ?? null,
        googlePlaceId: business.google_place_id ?? null,
        tone: business.tone ?? null,
        productsServices: business.products_services ?? null,
        staffNames: parseArray(business.staff_names),
        highlightFacts: parseArray(business.highlight_facts),
        avoidFacts: parseArray(business.avoid_facts),
        sampleResponses: parseArray(business.sample_responses),
        subscriptionStatus: business.subscription_status,
        subscriptionTier: business.subscription_tier,
        ownerName: business.owner_name ?? null,
        ownerEmail: business.owner_email ?? null,
        lastSyncAt: business.last_sync_at ? business.last_sync_at.toISOString() : null,
      },
      reviews: reviewRows.map((row) => ({
        id: row.id,
        reviewerName: row.reviewer_name,
        starRating: row.star_rating,
        reviewText: row.review_text ?? null,
        reviewDate: row.review_date ?? null,
        detectedLanguage: row.detected_language ?? null,
        detectedAt: row.detected_at ? row.detected_at.toISOString() : null,
        responseId: row.response_id ?? null,
        responseStatus: row.response_status ?? null,
        responseText: row.response_text ?? null,
        approvedText: row.approved_text ?? null,
        responseVersion: row.version ?? null,
      })),
    });
  } catch (error) {
    console.error('[api/admin/businesses/[id] GET] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch business' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/businesses/[id] — update business settings
// ---------------------------------------------------------------------------

// Column name mapping from camelCase API fields to snake_case DB columns.
const FIELD_TO_COLUMN: Record<string, string> = {
  name: 'name',
  category: 'category',
  tone: 'tone',
  productsServices: 'products_services',
  staffNames: 'staff_names',
  highlightFacts: 'highlight_facts',
  avoidFacts: 'avoid_facts',
};

export async function PATCH(
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = UpdateBusinessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const fields = Object.keys(data) as (keyof typeof data)[];

  // Build dynamic SET clause: $1 reserved for businessId, fields start at $2.
  const setClauses: string[] = [];
  const values: (string | string[] | null)[] = [businessId];

  for (const field of fields) {
    const column = FIELD_TO_COLUMN[field];
    const value = data[field] ?? null;
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  }
  setClauses.push('updated_at = NOW()');

  const setClause = setClauses.join(', ');
  const query = `UPDATE businesses SET ${setClause} WHERE id = $1`;

  try {
    const result = await sql.unsafe(query, values);

    if (result.count === 0) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api/admin/businesses/[id] PATCH] Failed:', error);
    return NextResponse.json({ error: 'Failed to update business' }, { status: 500 });
  }
}
