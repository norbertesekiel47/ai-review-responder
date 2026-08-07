// src/app/api/dashboard/import-offer/route.ts
//
// GET  /api/dashboard/import-offer  → the banner's state for the location in scope
// POST /api/dashboard/import-offer  → record the owner's accept/decline
//
// Invariant #12: both handlers parse, call ONE domain function, and map the
// outcome. There is no `sql.begin` here and no business logic — the acceptance
// transaction belongs to `recordImportDecisionAndEnqueue`, which is also what
// makes its rollback behaviour testable against live Postgres (round-1 F109).
//
// GET is NOT wrapped with `withSameOrigin` — GETs are exempt from the CSRF threat
// model (`past-replies/draft-status/route.ts:18-20` sets the precedent). POST IS
// wrapped: it records a durable consent decision.
//
// THE GET WRITES, deliberately: it calls `createImportOffer` idempotently as a
// self-heal (round-1 F105/F106). That is what makes best-effort offer creation on
// the Stripe path acceptable — if the activation-time write failed, the first
// dashboard render repairs it. Do not remove one without the other.
//
// Three constraints on the self-heal, each a round-2 finding:
//   1. It runs in its OWN `sql.begin` holding the businesses row lock. A GET that
//      writes is unusual, but the write is idempotent and serialized; the
//      alternative — a read path calling a `TransactionSql` helper with no
//      transaction — is the F107 defect.
//   2. It relies on `createImportOffer`'s own junction predicate. This route does
//      NOT re-implement a junction check and must not call the helper "when at the
//      junction": one owner for that condition.
//   3. No analytics event (deviations D7). #679 restores
//      `import_offer_created` here, in the same transaction.
//
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { createImportOffer, recordImportDecisionAndEnqueue } from '@/lib/reviews/import-consent';
import { readImportOfferView } from '@/lib/reviews/import-offer-view';

export const dynamic = 'force-dynamic';

const decisionSchema = z.object({
  decision: z.enum(['accepted', 'declined']),
});

export async function GET(request: NextRequest): Promise<Response> {
  let accountId: string;
  let locationId: string;
  try {
    ({ accountId, locationId } = await resolveOwnerScope(sql, request, {
      allowReadOnly: true,
    }));
  } catch (err) {
    if (err instanceof ScopeError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }

  try {
    // Self-heal, then read. Its own transaction, row lock first.
    await sql.begin(async (tx) => {
      await tx`
        SELECT id FROM businesses
        WHERE id = ${locationId}::uuid
          AND account_id = ${accountId}::uuid
        FOR UPDATE
      `;
      await createImportOffer(tx, locationId, accountId);
    });

    const view = await readImportOfferView(sql, locationId, accountId);
    return NextResponse.json(view, { status: 200 });
  } catch (err) {
    reportCaughtError('dashboard/import-offer GET', err, { accountId, locationId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = withSameOrigin()(async (request: NextRequest): Promise<Response> => {
  let accountId: string;
  let locationId: string;
  try {
    ({ accountId, locationId } = await resolveOwnerScope(sql, request));
  } catch (err) {
    if (err instanceof ScopeError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }

  let decision: 'accepted' | 'declined';
  try {
    const parsed = decisionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_decision' }, { status: 400 });
    }
    decision = parsed.data.decision;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  try {
    const outcome = await recordImportDecisionAndEnqueue(
      sql,
      locationId,
      accountId,
      decision,
    );

    // Four outcomes, four responses. `expired` and `already_answered` are 409s
    // rather than 200s so the banner can distinguish "your click was too late"
    // from "recorded" without inspecting a body field — a late click is the
    // ordinary case here, because expiry is derived and nothing fires at the
    // deadline (#670), so a banner rendered at T+6d59m is still on screen after.
    switch (outcome) {
      case 'recorded':
        return NextResponse.json({ ok: true, decision }, { status: 200 });
      case 'expired':
        return NextResponse.json({ error: 'offer_expired' }, { status: 409 });
      case 'already_answered':
        return NextResponse.json({ error: 'already_answered' }, { status: 409 });
      case 'no_offer':
        return NextResponse.json({ error: 'no_offer' }, { status: 404 });
    }
  } catch (err) {
    reportCaughtError('dashboard/import-offer POST', err, {
      accountId,
      locationId,
      decision,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
});
