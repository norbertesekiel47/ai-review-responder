// Owner-scoped rival picker (#546). Reads the pickable Competitor pack for one
// location and stores the owner's Named rival pick.
//
// The handlers parse, delegate to exactly one module function, and map errors —
// every membership rule, race guard and analytics write lives in
// `src/lib/competitors/named-rival.ts`.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOffboardingState, isOperationalUIBlocked } from '@/lib/account-offboarding/gate';
import { jsonResponse, requireOwnerWithAccount, withSameOrigin } from '@/lib/auth/route-helpers';
import {
  RivalPickNotFoundError,
  RivalPickStaleError,
  loadRivalPickerView,
  setNamedRivalPick,
} from '@/lib/competitors/named-rival';
import { sql } from '@/lib/db/server';
import { asLocationId, isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

type OwnerWithAccountResult = Awaited<ReturnType<typeof requireOwnerWithAccount>>;
type OwnerWithAccount = Extract<OwnerWithAccountResult, { ok: true }>;
type SettingsOwnerResult = OwnerWithAccount | { ok: false; response: NextResponse };

// `.strict()` is load-bearing: a client-supplied `title` must be a 400, not a
// silently ignored field. The display name reaching a rendered email is
// server-derived from the matched pack row, and nothing else may set it.
const RivalPickSchema = z.object({
  businessId: z.string().uuid(),
  placeId: z.string().min(1).max(255).nullable(),
}).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireSettingsOwner(request);
  if (!owner.ok) return owner.response;

  // Validated before the branded cast: an unchecked value reaches a uuid
  // column and turns a malformed request into a 500 plus Sentry noise.
  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId || !isValidUuid(businessId)) {
    return jsonResponse({ error: 'business_id_required' }, 400);
  }

  try {
    const view = await loadRivalPickerView(sql, {
      accountId: owner.accountId,
      businessId: asLocationId(businessId),
    });
    return jsonResponse(view);
  } catch (error) {
    const mapped = rivalPickErrorResponse(error);
    if (mapped) return mapped;

    reportCaughtError('api/settings/competitors GET', error, { accountId: owner.accountId });
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

async function putRivalPick(request: NextRequest): Promise<NextResponse> {
  const owner = await requireSettingsOwner(request);
  if (!owner.ok) return owner.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const parsed = RivalPickSchema.safeParse(rawBody);
  if (!parsed.success) return jsonResponse({ error: 'invalid_request' }, 400);

  try {
    const view = await setNamedRivalPick(sql, {
      accountId: owner.accountId,
      businessId: asLocationId(parsed.data.businessId),
      placeId: parsed.data.placeId,
      userId: owner.user.id,
    });
    return jsonResponse(view);
  } catch (error) {
    const mapped = rivalPickErrorResponse(error);
    if (mapped) return mapped;

    reportCaughtError('api/settings/competitors PUT', error, { accountId: owner.accountId });
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

async function requireSettingsOwner(request: NextRequest): Promise<SettingsOwnerResult> {
  if (request.nextUrl.searchParams.has('accountId')) {
    return { ok: false, response: jsonResponse({ error: 'account_id_not_allowed' }, 400) };
  }
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner;

  const offboardingState = await getOffboardingState(owner.accountId, sql);
  if (isOperationalUIBlocked(offboardingState)) {
    return { ok: false, response: jsonResponse({ error: 'account_offboarding_blocked' }, 403) };
  }

  return owner;
}

function rivalPickErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof RivalPickNotFoundError) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  if (error instanceof RivalPickStaleError) {
    return jsonResponse({ error: 'pack_refreshed' }, 409);
  }
  return null;
}

export const PUT = withSameOrigin()(putRivalPick);
