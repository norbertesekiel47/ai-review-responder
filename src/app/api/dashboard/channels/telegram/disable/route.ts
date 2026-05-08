// src/app/api/dashboard/channels/telegram/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { disableTelegramEnrollment } from '@/lib/channels/telegram-enrollment';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!user.locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const businessRows = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status FROM businesses WHERE id = ${user.locationId}
  `;
  if (businessRows[0]?.subscription_status !== 'active') {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  const result = await disableTelegramEnrollment(sql, user.locationId);

  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(handler);
