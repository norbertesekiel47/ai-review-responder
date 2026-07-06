import { v7 as uuidv7 } from 'uuid';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import {
  jsonResponse,
  requireOwnerWithAccount,
  withSameOrigin,
} from '@/lib/auth/route-helpers';
import { accountOffboardingEnabled } from '@/lib/account-offboarding/flags';
import { retryCancelOnlyBillingSchedule } from '@/lib/account-offboarding/retry-billing';

export const dynamic = 'force-dynamic';

async function retryOffboardingBilling(req: NextRequest): Promise<NextResponse> {
  if (!accountOffboardingEnabled()) {
    return jsonResponse({ error: 'account_offboarding_disabled' }, 404);
  }

  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  const idempotencyKey = parseIdempotencyKey(req.headers.get('Idempotency-Key'));
  if (!idempotencyKey.ok) {
    return jsonResponse({ error: idempotencyKey.error }, 400);
  }

  const result = await retryCancelOnlyBillingSchedule(sql, {
    accountId: owner.accountId,
    actorUserId: owner.user.id,
    idempotencyKey: idempotencyKey.value,
    requestId: req.headers.get('x-request-id') ?? uuidv7(),
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  });

  if (!result.ok) {
    return jsonResponse({ error: 'account_offboarding_billing_not_retryable' }, 409);
  }

  return jsonResponse({
    ok: true,
    offboarding: {
      id: result.offboarding.id,
      mode: result.offboarding.mode,
      status: result.offboarding.status,
    },
  }, 202);
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

export const POST = withSameOrigin()(retryOffboardingBilling);
