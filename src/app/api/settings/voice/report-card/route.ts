// src/app/api/settings/voice/report-card/route.ts
//
// Voice Report Card read model (ticket #540). Derives the five register
// traits from the SAME voice-learning corpus the prompt path uses —
// deterministic, on read, nothing persisted.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { UUID_RE } from '@/lib/locations/owner-route';
import { getVoiceCorpusStatus, MIN_EXAMPLES_FOR_ACTIVATION } from '@/lib/responses/voice-learning';
import { deriveVoiceReportCard } from '@/lib/responses/voice-report-card';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;
  const user = owner.user;

  const locationId = request.nextUrl.searchParams.get('locationId');
  if (!locationId || !UUID_RE.test(locationId)) {
    return jsonResponse({ error: 'locationId is required' }, 400);
  }

  try {
    const [location] = await sql<{ id: string }[]>`
      SELECT id FROM businesses
      WHERE id = ${locationId}::uuid
        AND account_id = ${user.accountId}::uuid
        AND archived_at IS NULL
    `;
    if (!location) {
      return jsonResponse({ error: 'Location not found' }, 404);
    }

    const status = await getVoiceCorpusStatus(sql, locationId);
    const card = deriveVoiceReportCard(status.examples);
    return jsonResponse({
      locationId,
      activationThreshold: MIN_EXAMPLES_FOR_ACTIVATION,
      editedCount: status.editedCount,
      activated: status.examples.length > 0,
      traits: card.traits,
      fallbackSnippet: card.fallbackSnippet,
    });
  } catch (error) {
    reportCaughtError('api/settings/voice/report-card GET', error, { locationId });
    return jsonResponse({ error: 'Failed to load voice report card' }, 500);
  }
}
