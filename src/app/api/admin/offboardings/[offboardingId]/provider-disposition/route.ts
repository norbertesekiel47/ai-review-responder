import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdminWithAal2, internalError } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import {
  ProviderDispositionError,
  ProviderDispositionInputSchema,
  recordProviderDisposition,
} from '@/lib/account-offboarding/provider-disposition';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

const ParamsSchema = z.object({ offboardingId: z.uuid() });

async function postProviderDisposition(
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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const parsedBody = ProviderDispositionInputSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: parsedBody.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await recordProviderDisposition({
      offboardingId: parsedParams.data.offboardingId,
      adminUserId: gate.admin.id,
      ...parsedBody.data,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent') ?? null,
      requestId: request.headers.get('x-request-id') ?? null,
    });

    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof ProviderDispositionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return internalError('[api/admin/offboardings/provider-disposition] failed:', err);
  }
}

export const POST = withSameOrigin()(postProviderDisposition);
