import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

const UpdateSettingsSchema = z
  .object({
    tone: z.string().trim().max(100).optional(),
    productsServices: z.string().max(2000).nullable().optional(),
    avoidFacts: z.array(z.string().trim().max(500)).max(20, 'Maximum 20 avoid facts').optional(),
    sampleResponses: z.array(z.string().trim().max(2000)).max(10, 'Maximum 10 sample responses').optional(),
    ownerPhone: z.string().trim().max(20).nullable().optional(),
    weeklySummaryEnabled: z.boolean().optional(),
    monthlyImpactEnabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

const FIELD_TO_COLUMN: Record<string, string> = {
  tone: 'tone',
  productsServices: 'products_services',
  avoidFacts: 'avoid_facts',
  sampleResponses: 'sample_responses',
  ownerPhone: 'owner_phone',
  weeklySummaryEnabled: 'weekly_summary_enabled',
  monthlyImpactEnabled: 'monthly_impact_enabled',
};

function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function putSettings(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ error: err.message }, err.statusCode);
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!user.locationId) {
    return jsonResponse(
      { error: 'No business associated with this account' },
      403,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const parsed = UpdateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      400,
    );
  }

  const data = parsed.data;

  const fields = Object.keys(data) as (keyof typeof data)[];

  // $1 reserved for locationId, fields start at $2.
  const setClauses: string[] = [];
  const values: unknown[] = [user.locationId];

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
    const result = await sql.unsafe(query, values as (string | string[] | boolean | null)[]);

    if (result.count === 0) {
      return jsonResponse({ error: 'Business not found' }, 404);
    }

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('[api/settings PUT] Failed:', error);
    return jsonResponse({ error: 'Failed to update settings' }, 500);
  }
}

export const PUT = withSameOrigin()(putSettings);
