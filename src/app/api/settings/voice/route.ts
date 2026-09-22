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
import { getLocationsForAccount } from '@/lib/locations/repo';
import { getDisplayLabel, type HasDisplayLabel } from '@/lib/locations/display-label';
import { jsonResponse, requireOwnerWithAccount, requireWritableOwner, withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { isValidUuid } from '@/lib/shared/ids';
import {
  readVoiceConfig,
  updateVoiceConfig,
  VOICE_FIELD_LIMITS,
  type VoiceConfig,
} from '@/lib/responses/voice-settings';

export const dynamic = 'force-dynamic';

// ── GET: Fetch voice config for one or all locations ────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  const locationId = request.nextUrl.searchParams.get('locationId');

  // Fetch voice config for a single location.
  //
  // THE READER, not an inline copy of it: `readVoiceConfig` is exactly this
  // query — same columns, same `id = … AND account_id = … AND archived_at IS
  // NULL`, same null-for-404 — and it is the reader the Owner Operator uses, so
  // maintaining a second hand-edited copy here is how the two drift. The
  // display label is the one genuine difference and it is a different concern
  // (`getDisplayLabel`), so it is read on its own, account-scoped the same way.
  if (locationId) {
    // #1362: a malformed id reached `${locationId}::uuid` in the reader and
    // surfaced as a 22P02 500. Refuse it before the first query, as a 400.
    if (!isValidUuid(locationId)) {
      return jsonResponse({ error: 'Invalid location ID' }, 400);
    }

    const voice = await readVoiceConfig(sql, {
      accountId: owner.accountId,
      locationId,
    });
    if (!voice) {
      return jsonResponse({ error: 'Location not found' }, 404);
    }

    const [labelRow] = await sql<{ id: string; name: string; display_label: string | null }[]>`
      SELECT id, name, display_label
      FROM businesses
      WHERE id = ${locationId}::uuid
        AND account_id = ${owner.accountId}::uuid
        AND archived_at IS NULL
    `;
    if (!labelRow) {
      return jsonResponse({ error: 'Location not found' }, 404);
    }

    return jsonResponse({
      locationId: labelRow.id,
      displayName: getDisplayLabel(labelRow as HasDisplayLabel),
      tone: voice.tone ?? '',
      productsServices: voice.productsServices ?? '',
      avoidFacts: voice.avoidFacts,
      highlightFacts: voice.highlightFacts,
      sampleResponses: voice.sampleResponses,
    });
  }

  // Fetch voice config for all active locations in the account
  const locations = await getLocationsForAccount(sql, owner.accountId);

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
    highlight_facts: string[] | null;
    sample_responses: string[] | null;
    is_primary: boolean;
  }[]>`
    SELECT id, name, display_label, tone, products_services, avoid_facts, highlight_facts, sample_responses, is_primary
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
      highlightFacts: r.highlight_facts ?? [],
      sampleResponses: r.sample_responses ?? [],
    })),
  });
}

// ── PUT: Update voice config for a specific location ───────────────────

// Every limit comes from VOICE_FIELD_LIMITS (src/lib/responses/voice-settings.ts),
// which the Owner Operator catalog's input schemas read too — one definition of
// each field's domain, so a proposal can never carry a value this route would
// reject and this route can never accept one the catalog refuses.
const VoiceConfigSchema = z
  .object({
    locationId: z.uuid(),
    tone: z.string().trim().max(VOICE_FIELD_LIMITS.tone.maxLength).optional(),
    productsServices: z.string().max(VOICE_FIELD_LIMITS.productsServices.maxLength).nullable().optional(),
    avoidFacts: z.array(z.string().trim().max(VOICE_FIELD_LIMITS.avoidFacts.maxLength))
      .max(VOICE_FIELD_LIMITS.avoidFacts.maxItems, `Maximum ${VOICE_FIELD_LIMITS.avoidFacts.maxItems} avoid facts`)
      .optional(),
    highlightFacts: z.array(z.string().trim().max(VOICE_FIELD_LIMITS.highlightFacts.maxLength))
      .max(VOICE_FIELD_LIMITS.highlightFacts.maxItems, `Maximum ${VOICE_FIELD_LIMITS.highlightFacts.maxItems} highlight facts`)
      .optional(),
    sampleResponses: z.array(z.string().trim().max(VOICE_FIELD_LIMITS.sampleResponses.maxLength))
      .max(VOICE_FIELD_LIMITS.sampleResponses.maxItems, `Maximum ${VOICE_FIELD_LIMITS.sampleResponses.maxItems} sample responses`)
      .optional(),
  })
  .refine((data) => {
    const keys = Object.keys(data).filter((k) => k !== 'locationId');
    return keys.length > 0;
  }, {
    message: 'At least one voice config field must be provided',
  });

async function putVoiceConfig(request: NextRequest): Promise<NextResponse> {
  const owner = await requireWritableOwner(sql, request);
  if (!owner.ok) return owner.response;

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

  const { locationId, ...voiceFields } = parsed.data;

  try {
    const result = await sql.begin((tx) =>
      updateVoiceConfig(tx, {
        // `owner.accountId`, never `user.accountId!`: requireWritableOwner
        // already returned a non-nullable `accountId` beside the user.
        accountId: owner.accountId,
        locationId,
        fields: voiceFields satisfies Partial<VoiceConfig>,
      }),
    );

    if (!result.ok) {
      return result.reason === 'no_fields'
        ? jsonResponse({ error: 'No fields to update' }, 400)
        : jsonResponse({ error: 'Location not found or not accessible' }, 404);
    }

    return jsonResponse({ success: true, updatedAt: result.updatedAt });
  } catch (error) {
    reportCaughtError('api/settings/voice PUT', error, { locationId });
    return jsonResponse({ error: 'Failed to update voice config' }, 500);
  }
}

export const PUT = withSameOrigin()(putVoiceConfig);
