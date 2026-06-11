// src/app/api/settings/channels/override/route.ts
//
// Per-location channel override endpoints — parse → auth → one module call →
// status-map. All business logic (in-tx pre-checks, revive-vs-insert, audit,
// cache invalidation) lives in src/lib/channels/override.ts.
//
// POST: Create a per-location channel override (clones org-default handle values).
// DELETE: Remove a per-location channel override (reverts to org-default).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonResponse, requireWritableOwner, withSameOrigin } from '@/lib/auth/route-helpers';
import {
  createOrReviveOverride,
  removeOverride,
  type OverrideInput,
} from '@/lib/channels/override';

export const dynamic = 'force-dynamic';

const OverrideSchema = z.object({
  locationId: z.uuid(),
  channel: z.enum(['email', 'telegram', 'whatsapp']),
});

type ParsedOverrideRequest =
  | { ok: true; input: OverrideInput }
  | { ok: false; response: NextResponse };

async function parseOverrideRequest(request: NextRequest): Promise<ParsedOverrideRequest> {
  const owner = await requireWritableOwner(request);
  if (!owner.ok) return { ok: false, response: owner.response };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: jsonResponse({ error: 'Invalid request body' }, 400) };
  }

  const parsed = OverrideSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonResponse({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, 400),
    };
  }

  return {
    ok: true,
    input: {
      accountId: owner.accountId,
      actorUserId: owner.user.id ?? null,
      locationId: parsed.data.locationId,
      channel: parsed.data.channel,
    },
  };
}

async function createOverride(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseOverrideRequest(request);
  if (!parsed.ok) return parsed.response;

  let result;
  try {
    result = await createOrReviveOverride(parsed.input);
  } catch (error: unknown) {
    console.error('[api/settings/channels/override POST] Failed:', error);
    return jsonResponse({ error: 'Failed to create override' }, 500);
  }

  switch (result.kind) {
    case 'not_eligible':
      return jsonResponse({ error: 'not_eligible' }, 403);
    case 'location_not_found':
      return jsonResponse({ error: 'Location not found or not accessible' }, 404);
    case 'no_org_default':
      return jsonResponse({ error: 'No org-default enrollment found for this channel' }, 404);
    case 'conflict':
      return jsonResponse({ error: 'Override already exists for this location and channel' }, 409);
    case 'created':
    case 'revived':
      return jsonResponse({ success: true, override: result.override }, 201);
  }
}

async function deleteOverride(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseOverrideRequest(request);
  if (!parsed.ok) return parsed.response;

  let result;
  try {
    result = await removeOverride(parsed.input);
  } catch (error: unknown) {
    console.error('[api/settings/channels/override DELETE] Failed:', error);
    return jsonResponse({ error: 'Failed to remove override' }, 500);
  }

  if (result.kind === 'not_found') {
    return jsonResponse({ error: 'No override found for this location and channel' }, 404);
  }
  return jsonResponse({ success: true });
}

export const POST = withSameOrigin()(createOverride);
export const DELETE = withSameOrigin()(deleteOverride);
