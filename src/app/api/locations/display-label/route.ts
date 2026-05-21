// src/app/api/locations/display-label/route.ts
//
// PUT /api/locations/display-label — Updates the display_label on a location.
// Validates that the location belongs to the requesting user's account.
//
// Used by the Locations tab for inline display_label editing.
// VAL-SETTINGS-040: Locations tab provides editable display_label field.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { updateDisplayLabel } from '@/lib/locations/update-display-label';
import { withSameOrigin } from '@/lib/auth/route-helpers';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UpdateDisplayLabelSchema = z.object({
  locationId: z.string().regex(UUID_RE, 'Invalid location ID format'),
  accountId: z.string().regex(UUID_RE, 'Invalid account ID format'),
  displayLabel: z.string().trim().max(255).nullable(),
});

function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function updateLocationDisplayLabel(request: NextRequest): Promise<NextResponse> {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const parsed = UpdateDisplayLabelSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      400,
    );
  }

  const { locationId, accountId, displayLabel } = parsed.data;

  // Verify the account ID matches the authenticated user
  if (accountId !== user.accountId) {
    return jsonResponse({ error: 'Account ID mismatch' }, 403);
  }

  try {
    const result = await updateDisplayLabel(
      locationId,
      accountId,
      displayLabel,
      user.id,
    );

    if (!result.updated) {
      return jsonResponse({ error: 'Location not found or not owned' }, 404);
    }

    return jsonResponse({ success: true, displayLabel: result.displayLabel });
  } catch (err) {
    console.error('[api/locations/display-label PUT] Failed:', err);
    return jsonResponse({ error: 'Failed to update display label' }, 500);
  }
}

export const PUT = withSameOrigin()(updateLocationDisplayLabel);
