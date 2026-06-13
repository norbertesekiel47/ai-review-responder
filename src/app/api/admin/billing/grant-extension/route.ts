import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { requireAdminWithAal2, internalError } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { jsonb, sql } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
// ADDITIONAL days added ON TOP of whatever grace the account still has — NOT an
// absolute total. The deadline is anchored to max(past_due grace deadline, now)
// and then `days` are added (see the formula below), so for an in-window account
// a max grant of 7 yields an effective grace of UP TO ~14 days from past_due
// (deep-scan §6.3 — intentional, "additive" semantics chosen 2026-06-13). The
// real resulting deadline is surfaced to the admin in the success response and
// the UI, so "7" never silently becomes "14".
const MAX_ADDITIONAL_EXTENSION_DAYS = 7;
const DAY_MS = 86_400_000;
// Must match GRACE_MS in src/lib/shared/past-due-recovery.ts (the read-only clock).
const GRACE_MS = 7 * DAY_MS;

const GrantExtensionSchema = z.object({
  accountId: z.uuid(),
  days: z.number().int().min(1).max(MAX_ADDITIONAL_EXTENSION_DAYS),
  ticketId: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1_000),
});

class GrantExtensionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'GrantExtensionError';
  }
}

async function grantExtension(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;
  const admin = gate.admin;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const parsed = GrantExtensionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE },
    );
  }

  const { accountId, days, reason, ticketId } = parsed.data;
  const grantedAt = new Date();

  let extensionExpiresAt: string;
  try {
    extensionExpiresAt = await sql.begin(async (tx) => {
      const accountRows = await tx<{ past_due_at: Date | string | null }[]>`
        SELECT past_due_at
        FROM accounts
        WHERE id = ${accountId}::uuid
          AND subscription_status = 'past_due'
        FOR UPDATE
      `;
      const account = accountRows[0];
      if (!account) {
        throw new GrantExtensionError(409, 'account_not_past_due');
      }
      const pastDueAt = account.past_due_at ? new Date(account.past_due_at) : null;
      if (!pastDueAt || !Number.isFinite(pastDueAt.getTime())) {
        throw new GrantExtensionError(409, 'past_due_at_missing');
      }

      // Anchor to the LATER of the grace deadline and now, then add the days.
      // - In-window account: grace deadline > now, so this extends past it
      //   (avoids the "now + days collapses inside the window" no-op).
      // - Already-locked-out account (> grace): now > grace deadline, so this
      //   yields now + days — strictly in the future, so parseExtension honors
      //   it instead of discarding a past expires_at and leaving them read-only.
      const graceDeadlineMs = pastDueAt.getTime() + GRACE_MS;
      const expiresAt = new Date(Math.max(graceDeadlineMs, grantedAt.getTime()) + days * DAY_MS);
      const extension = {
        granted_at: grantedAt.toISOString(),
        granted_by_user_id: admin.id,
        days,
        reason,
        ticket_id: ticketId,
        expires_at: expiresAt.toISOString(),
      };

      const result = await tx`
        UPDATE accounts
        SET flags = jsonb_set(
          COALESCE(flags, '{}'::jsonb),
          '{past_due_extension}',
          ${jsonb(extension)},
          true
        )
        WHERE id = ${accountId}::uuid
          AND subscription_status = 'past_due'
      `;

      if (result.count !== 1) {
        throw new GrantExtensionError(409, 'account_not_past_due');
      }

      await writeAccountAuditLog(
        {
          accountId,
          actorUserId: admin.id,
          eventType: 'past_due_extension_granted',
          entityType: 'account',
          entityId: accountId,
          payload: {
            days,
            reason,
            ticket_id: ticketId,
            expires_at: extension.expires_at,
          },
        },
        tx,
      );

      return extension.expires_at;
    });
  } catch (err) {
    if (err instanceof GrantExtensionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return internalError('[api/admin/billing/grant-extension] Failed:', err);
  }

  return NextResponse.json(
    { ok: true, extension: { days, expires_at: extensionExpiresAt } },
    { headers: NO_STORE },
  );
}

// CSRF by construction: same-origin enforced at the export, not inside the gate.
export const POST = withSameOrigin()(grantExtension);
