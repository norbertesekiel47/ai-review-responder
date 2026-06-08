import { v7 as uuidv7 } from 'uuid';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  jsonResponse,
  requireOwnerWithAccount,
  withSameOrigin,
} from '@/lib/auth/route-helpers';
import { accountOffboardingEnabled } from '@/lib/account-offboarding/flags';
import {
  confirmCancelOnlyOffboarding,
  confirmDeleteDataOffboarding,
} from '@/lib/account-offboarding/confirm';
import { requireDeleteDataDestructiveAuth } from '@/lib/account-offboarding/destructive-auth';

export const dynamic = 'force-dynamic';

const ReasonCodeSchema = z.enum([
  'too_expensive',
  'missing_features',
  'switched_service',
  'unused',
  'other',
]);

const ConfirmCancelOnlySchema = z.strictObject({
  mode: z.literal('cancel_only'),
  reasonCode: ReasonCodeSchema.optional(),
});

const ConfirmDeleteDataSchema = z.strictObject({
  mode: z.literal('delete_data'),
  reasonCode: ReasonCodeSchema,
  confirmationText: z.literal('DELETE DATA'),
});

const ConfirmOffboardingSchema = z.discriminatedUnion('mode', [
  ConfirmCancelOnlySchema,
  ConfirmDeleteDataSchema,
]);

async function confirmOffboarding(req: NextRequest): Promise<NextResponse> {
  if (!accountOffboardingEnabled()) {
    return jsonResponse({ error: 'account_offboarding_disabled' }, 404);
  }

  const idempotencyKey = parseIdempotencyKey(req.headers.get('Idempotency-Key'));
  if (!idempotencyKey.ok) {
    return jsonResponse({ error: idempotencyKey.error }, 400);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const parsed = ConfirmOffboardingSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: 'invalid_body', issues: parsed.error.issues },
      400,
    );
  }

  const result = parsed.data.mode === 'delete_data'
    ? await confirmDeleteData(req, parsed.data, idempotencyKey.value)
    : await confirmCancelOnly(req, parsed.data, idempotencyKey.value);

  if (result instanceof NextResponse) {
    return result;
  }

  if (!result.ok) {
    if (result.reason === 'duplicate_active') {
      return jsonResponse({
        error: 'account_offboarding_already_active',
        offboarding: routeOffboarding(result.activeOffboarding),
      }, 409);
    }

    return jsonResponse({
      error: 'offboarding_snapshot_incomplete',
      detail: 'We could not safely prepare your cancellation. Please contact support so we can finish this for you.',
      missingFields: result.missingFields,
    }, 422);
  }

  return jsonResponse({
    ok: true,
    idempotent: result.status === 'idempotent',
    offboarding: routeOffboarding(result.offboarding),
  }, result.status === 'idempotent' ? 200 : 202);
}

async function confirmCancelOnly(
  req: NextRequest,
  body: z.infer<typeof ConfirmCancelOnlySchema>,
  idempotencyKey: string,
) {
  // Read-level owner gate, NOT requireWritableOwner: a past_due owner (live, still
  // billed subscription) must be able to cancel per the spec's edge-account
  // contract, and offboarding's own routes never use the writable-subscription
  // gate. The cancel_only snapshot still requires a stripe_subscription_id, so a
  // never-activated / no-subscription account gets a clean 422 instead.
  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  return confirmCancelOnlyOffboarding({
    accountId: owner.accountId,
    actorUserId: owner.user.id,
    idempotencyKey,
    reasonCode: body.reasonCode,
    requestId: req.headers.get('x-request-id') ?? uuidv7(),
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  });
}

async function confirmDeleteData(
  req: NextRequest,
  body: z.infer<typeof ConfirmDeleteDataSchema>,
  idempotencyKey: string,
) {
  const owner = await requireDeleteDataDestructiveAuth(req);
  if (!owner.ok) return owner.response;

  return confirmDeleteDataOffboarding({
    accountId: owner.accountId,
    actorUserId: owner.user.id,
    idempotencyKey,
    reasonCode: body.reasonCode,
    requestId: req.headers.get('x-request-id') ?? uuidv7(),
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  });
}

type IdempotencyKeyParseResult =
  | { ok: true; value: string }
  | { ok: false; error: 'missing_idempotency_key' | 'idempotency_key_too_long' };

function parseIdempotencyKey(raw: string | null): IdempotencyKeyParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: 'missing_idempotency_key' };
  }
  const source = raw.trim();
  if (source.length > 255) {
    return { ok: false, error: 'idempotency_key_too_long' };
  }
  return { ok: true, value: source };
}

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  return forwarded.split(',')[0]?.trim() || null;
}

function routeOffboarding(offboarding: {
  id: string;
  mode: string;
  status: string;
}) {
  return {
    id: offboarding.id,
    mode: offboarding.mode,
    status: offboarding.status,
  };
}

export const POST = withSameOrigin()(confirmOffboarding);
