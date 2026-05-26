// src/app/api/settings/voice/route.ts
//
// Per-location voice configuration endpoint.
// GET: Fetches voice config (tone, products_services, avoid_facts, sample_responses)
//      for a specific location or all locations in the account.
// PUT: Updates voice config for a specific location.
//
// VAL-SETTINGS-017: Voice tab renders per-location voice config sections.
// VAL-SETTINGS-018: Voice config for each location is independently editable.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { getDisplayLabel, type HasDisplayLabel } from '@/lib/locations/display-label';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';

export const dynamic = 'force-dynamic';

function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

// ── GET: Fetch voice config for one or all locations ────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ error: err.message }, err.statusCode);
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!user.accountId) {
    return jsonResponse({ error: 'No account associated with this user' }, 403);
  }

  const locationId = request.nextUrl.searchParams.get('locationId');

  // Fetch voice config for a single location
  if (locationId) {
    const [row] = await sql<{
      id: string;
      name: string;
      display_label: string | null;
      tone: string | null;
      products_services: string | null;
      avoid_facts: string[] | null;
      sample_responses: string[] | null;
    }[]>`
      SELECT id, name, display_label, tone, products_services, avoid_facts, sample_responses
      FROM businesses
      WHERE id = ${locationId}::uuid
        AND account_id = ${user.accountId}::uuid
        AND archived_at IS NULL
    `;

    if (!row) {
      return jsonResponse({ error: 'Location not found' }, 404);
    }

    return jsonResponse({
      locationId: row.id,
      displayName: getDisplayLabel(row as HasDisplayLabel),
      tone: row.tone ?? '',
      productsServices: row.products_services ?? '',
      avoidFacts: row.avoid_facts ?? [],
      sampleResponses: row.sample_responses ?? [],
    });
  }

  // Fetch voice config for all active locations in the account
  const locations = await getLocationsForAccount(user.accountId);

  if (locations.length === 0) {
    return jsonResponse({ locations: [] });
  }

  const locationIds = locations.map((l) => l.id);
  const voiceRows = await sql<{
    id: string;
    name: string;
    display_label: string | null;
    tone: string | null;
    products_services: string | null;
    avoid_facts: string[] | null;
    sample_responses: string[] | null;
    is_primary: boolean;
  }[]>`
    SELECT id, name, display_label, tone, products_services, avoid_facts, sample_responses, is_primary
    FROM businesses
    WHERE id = ANY(${locationIds}::uuid[])
      AND archived_at IS NULL
    ORDER BY is_primary DESC, created_at ASC
  `;

  return jsonResponse({
    locations: voiceRows.map((r) => ({
      locationId: r.id,
      displayName: getDisplayLabel(r as HasDisplayLabel),
      isPrimary: r.is_primary,
      tone: r.tone ?? '',
      productsServices: r.products_services ?? '',
      avoidFacts: r.avoid_facts ?? [],
      sampleResponses: r.sample_responses ?? [],
    })),
  });
}

// ── PUT: Update voice config for a specific location ───────────────────

const VoiceConfigSchema = z
  .object({
    locationId: z.string().uuid(),
    tone: z.string().trim().max(100).optional(),
    productsServices: z.string().max(2000).nullable().optional(),
    avoidFacts: z.array(z.string().trim().max(500)).max(20, 'Maximum 20 avoid facts').optional(),
    sampleResponses: z.array(z.string().trim().max(2000)).max(10, 'Maximum 10 sample responses').optional(),
  })
  .refine((data) => {
    const keys = Object.keys(data).filter((k) => k !== 'locationId');
    return keys.length > 0;
  }, {
    message: 'At least one voice config field must be provided',
  });

const VOICE_FIELD_TO_COLUMN: Record<string, string> = {
  tone: 'tone',
  productsServices: 'products_services',
  avoidFacts: 'avoid_facts',
  sampleResponses: 'sample_responses',
};

async function putVoiceConfig(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ error: err.message }, err.statusCode);
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!user.accountId) {
    return jsonResponse({ error: 'No account associated with this user' }, 403);
  }

  const writable = await assertWritableSubscriptionForAccount(user.accountId);
  if (!writable.ok) {
    return jsonResponse({ error: writable.error }, writable.status);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const parsed = VoiceConfigSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      400,
    );
  }

  const data = parsed.data;
  const { locationId, ...voiceFields } = data;

  // Validate the location belongs to this account and is active
  const [locRow] = await sql<{ id: string }[]>`
    SELECT id FROM businesses
    WHERE id = ${locationId}::uuid
      AND account_id = ${user.accountId}::uuid
      AND archived_at IS NULL
  `;

  if (!locRow) {
    return jsonResponse({ error: 'Location not found or not accessible' }, 404);
  }

  const fields = Object.keys(voiceFields) as (keyof typeof voiceFields)[];

  if (fields.length === 0) {
    return jsonResponse({ error: 'No fields to update' }, 400);
  }

  // Build dynamic UPDATE query
  const setClauses: string[] = [];
  const values: unknown[] = [locationId];

  for (const field of fields) {
    const column = VOICE_FIELD_TO_COLUMN[field];
    const value = voiceFields[field] ?? null;
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  }
  setClauses.push('updated_at = NOW()');

  const setClause = setClauses.join(', ');
  const query = `UPDATE businesses SET ${setClause} WHERE id = $1 AND account_id = $${values.length + 1} AND archived_at IS NULL`;
  values.push(user.accountId);

  try {
    const result = await sql.unsafe(query, values as (string | string[] | boolean | null)[]);

    if (result.count === 0) {
      return jsonResponse({ error: 'Location not found or not updated' }, 404);
    }

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('[api/settings/voice PUT] Failed:', error);
    return jsonResponse({ error: 'Failed to update voice config' }, 500);
  }
}

export const PUT = withSameOrigin()(putVoiceConfig);
