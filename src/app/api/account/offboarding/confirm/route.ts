import { v7 as uuidv7 } from 'uuid';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  jsonResponse,
  requireWritableOwner,
  withSameOrigin,
} from '@/lib/auth/route-helpers';
import { accountOffboardingEnabled } from '@/lib/account-offboarding/flags';
import { confirmCancelOnlyOffboarding } from '@/lib/account-offboarding/confirm';

export const dynamic = 'force-dynamic';

const ConfirmCancelOnlySchema = z.object({
  mode: z.literal('cancel_only'),
  reasonCode: z.string().trim().min(1).max(64).optional(),
}).strict();

async function confirmOffboarding(req: NextRequest): Promise<NextResponse> {
  if (!accountOffboardingEnabled()) {
    return jsonResponse({ error: 'account_offboarding_disabled' }, 404);
  }

  const owner = await requireWritableOwner(req);
  if (!owner.ok) return owner.response;

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

  const parsed = ConfirmCancelOnlySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: 'invalid_body', issues: parsed.error.issues },
      400,
    );
  }

  const result = await confirmCancelOnlyOffboarding({
    accountId: owner.accountId,
    actorUserId: owner.user.id,
    idempotencyKey: idempotencyKey.value,
    reasonCode: parsed.data.reasonCode,
    requestId: req.headers.get('x-request-id') ?? uuidv7(),
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  });

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
