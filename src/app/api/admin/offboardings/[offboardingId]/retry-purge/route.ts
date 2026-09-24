import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdminWithAal2, internalError } from '@/lib/auth/admin-mfa-gate';
import { sql } from '@/lib/db/server';
import {
  PurgeRetryError,
  retryAccountOffboardingPurge,
} from '@/lib/account-offboarding/retry-purge';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

const ParamsSchema = z.object({ offboardingId: z.uuid() });

/**
 * Admin "retry purge" action (#1411) — AAL2-gated, audited. Resets a
 * `status='failed'`/`failed_step='purge'` row to `purge_scheduled` and
 * re-enqueues the purge job through the transactional outbox, in ONE Postgres
 * transaction (`retryAccountOffboardingPurge`). No request body: the only
 * input is the offboarding id in the path, same shape as the sibling
 * provider-disposition route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ offboardingId: string }> },
): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: 'invalid_offboarding_id' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await retryAccountOffboardingPurge(sql, {
      offboardingId: parsedParams.data.offboardingId,
      adminUserId: gate.admin.id,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent') ?? null,
      requestId: request.headers.get('x-request-id') ?? null,
    });

    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof PurgeRetryError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return internalError('[api/admin/offboardings/retry-purge] failed:', err);
  }
}
