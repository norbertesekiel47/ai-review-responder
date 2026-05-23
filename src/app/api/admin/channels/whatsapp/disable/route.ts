// src/app/api/admin/channels/whatsapp/disable — admin disables a verified enrollment.
// Returns 404 if no verified row matches (user-facing signal that there's nothing to disable).
//
// Handler order: same-origin wrapper → flag → env → auth → businessId.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { disableWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { withSameOrigin } from '@/lib/auth/route-helpers';

async function disableWhatsApp(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  try {
    await requireRole(req, 'admin');
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  // M6: no-store for consistency across admin whatsapp routes.
  const noStore = { 'Cache-Control': 'no-store, private' };

  // Resolve account_id first — disableWhatsAppEnrollment is account-scoped
  // (org-default row, location_id IS NULL), so it must be keyed by account,
  // not by the legacy per-location business_id.
  const [acctRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  if (!acctRow) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  const result = await disableWhatsAppEnrollment(sql, acctRow.account_id);
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  // Invalidate channel cache — the disabled channel must be removed from
  // the dispatch resolution immediately.
  await safeInvalidateChannelCache(asAccountId(acctRow.account_id), 'admin.whatsapp.disable');

  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(disableWhatsApp);
