import { NextRequest, NextResponse } from 'next/server';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { UpdateBusinessSchema } from '@/lib/shared/schemas';
import { requireRole, AuthError } from '@/lib/db/auth';
import { getBusinessDetail } from '@/lib/admin/business-detail-service';
import type { BusinessPatch } from '@/lib/admin/business-detail-types';

export const dynamic = 'force-dynamic';

class AdminBusinessNotFoundError extends Error {}

// Column name mapping from camelCase API fields to snake_case DB columns.
// `as const satisfies` freezes the table at compile time so a future field
// addition can't bypass the COLUMN_RE whitelist by widening the type.
const FIELD_TO_COLUMN = {
  name: 'name',
  category: 'category',
  tone: 'tone',
  productsServices: 'products_services',
  staffNames: 'staff_names',
  highlightFacts: 'highlight_facts',
  avoidFacts: 'avoid_facts',
  website: 'website',
  ownerEmail: 'owner_email',
  ownerEmailBounced: 'owner_email_bounced',
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
// GET /api/admin/businesses/[id] — business detail + reviews + latest responses
// ---------------------------------------------------------------------------

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
    const detail = await getBusinessDetail(businessId);
    if (!detail) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error('[api/admin/businesses/[id] GET] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch business' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/businesses/[id] — update business settings
// ---------------------------------------------------------------------------

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

  // Defense-in-depth: every field must map to a hardcoded column whitelist
  // entry that also matches the COLUMN_RE pattern. Reject before any SQL is
  // built so a future refactor that accidentally accepts dynamic column
  // names hard-fails here instead of reaching `tx.unsafe`.
  const COLUMN_RE = /^[a-z][a-z0-9_]*$/;
  for (const field of fields) {
    const column = FIELD_TO_COLUMN[field];
    if (!column || !COLUMN_RE.test(column)) {
      return NextResponse.json(
        { error: `Invalid field: ${field}` },
        { status: 400 },
      );
    }
  }

  try {
    await updateBusiness(businessId, data);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AdminBusinessNotFoundError) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }
    // Duplicate email constraint (users.email or channel_enrollments UNIQUE) —
    // match the POST route's 409 semantics at src/app/api/admin/businesses/route.ts:281-287.
    // MUST come before the generic 500 fallback.
    const pgError = error as { code?: string };
    if (pgError.code === '23505') {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
    console.error('[api/admin/businesses/[id] PATCH] Failed:', error);
    return NextResponse.json({ error: 'Failed to update business' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Internal: PATCH update + email-channel upsert
// ---------------------------------------------------------------------------

async function updateBusiness(
  businessId: string,
  patch: BusinessPatch,
): Promise<void> {
  const fields = Object.keys(patch) as (keyof BusinessPatch)[];

  // Build dynamic SET clause: $1 reserved for businessId, fields start at $2.
  // Values bind via $N placeholders; column names come from the hardcoded
  // FIELD_TO_COLUMN whitelist. The COLUMN_RE assertion is enforced in the
  // PATCH handler before this function is called.
  const setClauses: string[] = [];
  const values: (string | string[] | boolean | null)[] = [businessId];

  for (const field of fields) {
    const column = FIELD_TO_COLUMN[field]!;
    const value = patch[field] ?? null;
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  }
  setClauses.push('updated_at = NOW()');

  const setClause = setClauses.join(', ');
  const query = `UPDATE businesses SET ${setClause} WHERE id = $1`;

  await sql.begin(async (tx) => {
    const result = await tx.unsafe(query, values);
    if (result.count === 0) {
      throw new AdminBusinessNotFoundError();
    }
    if (patch.ownerEmail !== undefined) {
      // Upsert: if the email enrollment row was previously disabled/
      // unsubscribed, a fresh owner_email edit is an explicit admin action
      // to re-enable the channel — refresh to verified state in the same
      // transaction as the business UPDATE.
      await tx`
        INSERT INTO channel_enrollments
          (id, business_id, channel, handle, status, verified_at)
        VALUES
          (${uuidv7()}, ${businessId}, 'email', ${patch.ownerEmail}, 'verified', NOW())
        ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO UPDATE SET
          handle              = EXCLUDED.handle,
          status              = 'verified',
          verified_at         = NOW(),
          disabled_at         = NULL,
          unsubscribed_at     = NULL,
          unsubscribed_reason = NULL,
          updated_at          = NOW()
      `;
    }
  });
}
