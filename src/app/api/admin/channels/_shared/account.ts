// src/app/api/admin/channels/_shared/account.ts
//
// Shared opening for the admin channel-enrollment routes (telegram/whatsapp
// start/cancel/disable). Every one of them, after its channel-specific flag +
// env gate, runs the same chain: admin auth → parse `businessId` from the body
// → resolve the owning account_id. This owns that chain so the routes can't
// drift on auth role, error strings, or status codes.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export type AdminChannelAccount =
  | { ok: true; businessId: string; accountId: string }
  | { ok: false; response: NextResponse };

/**
 * Authenticates the admin caller, reads `businessId` from the JSON body, and
 * resolves the owning account_id. Returns the inline Response on any failure
 * (auth error, missing businessId → 400, unknown business → 404).
 */
export async function resolveAdminChannelAccount(req: NextRequest): Promise<AdminChannelAccount> {
  try {
    await requireRole(req, 'admin');
  } catch (e) {
    if (e instanceof AuthError) {
      return { ok: false, response: NextResponse.json({ error: e.message }, { status: e.statusCode }) };
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) {
    return { ok: false, response: NextResponse.json({ error: 'businessId required' }, { status: 400 }) };
  }

  const [acctRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  if (!acctRow) {
    return { ok: false, response: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
  }

  return { ok: true, businessId, accountId: acctRow.account_id };
}
