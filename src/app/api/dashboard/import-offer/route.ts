// src/app/api/dashboard/import-offer/route.ts
//
// GET  /api/dashboard/import-offer  → the banner's state for the location in scope
// POST /api/dashboard/import-offer  → record the owner's accept/decline
//
// Invariant #12: both handler BODIES parse, call, and map — no business logic.
// The acceptance transaction belongs to `recordImportDecisionAndEnqueue`, which
// is also what makes its rollback behaviour testable against live Postgres
// (round-1 F109); the GET's self-heal is the named file-local step
// `selfHealImportOffer` below, so the handler body stays parse → call → map.
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
// Five constraints on the self-heal, each a review finding:
//   1. It runs in its OWN `sql.begin` holding the businesses row lock. A GET that
//      writes is unusual, but the write is idempotent and serialized; the
//      alternative — a read path calling a `TransactionSql` helper with no
//      transaction — is the F107 defect.
//   2. It relies on `createImportOffer`'s own junction predicate. This route does
//      NOT re-implement a junction check and must not call the helper "when at the
//      junction": one owner for that condition.
//   3. It mints `import_offer_created` in that same transaction — emitted by
//      `createImportOffer` itself (#679 T2), never by this route, and only when
//      the repair actually created an offer. A self-healed offer that did not
//      report itself would vanish from the offer-created → decision-recorded
//      ratio, which is exactly the population this route exists to rescue.
//   4. It does not run for an owner who cannot answer what it mints (round-1 A1).
//   5. It does not open the transaction at all unless an offer could be created
//      (round-1 A5). Both gates live in `selfHealImportOffer`, and both are
//      cheap filters rather than authorities — see its doc comment.
//
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import {
  createImportOffer,
  readImportConsent,
  recordImportDecisionAndEnqueue,
} from '@/lib/reviews/import-consent';
import { readImportOfferView } from '@/lib/reviews/import-offer-view';

export const dynamic = 'force-dynamic';

const decisionSchema = z.object({
  decision: z.enum(['accepted', 'declined']),
});

/**
 * Repair an Import offer whose junction-time write failed, before the banner is
 * read. This is what makes best-effort offer creation on the Stripe path
 * acceptable (F105/F106) — drop it and that path silently loses offers.
 *
 * TWO CHEAP GATES STAND IN FRONT OF THE TRANSACTION, AND NEITHER IS AN AUTHORITY.
 * `createImportOffer` re-proves every predicate — both junction halves included —
 * inside the transaction under the row lock, so a row that changes between these
 * reads and the lock is still handled correctly. Nothing here re-implements the
 * junction condition; that has exactly one owner.
 *
 *  1. IS THERE ANY OFFER TO CREATE (round-1 A5). `createImportOffer` can only act
 *     on a `pending` row with a NULL deadline — the same shape
 *     `recordImportDecisionAndEnqueue` classifies as `no_offer`. Without this
 *     read, EVERY location took an exclusive `businesses` row lock and ran a
 *     provably no-op UPDATE on every dashboard mount and on every 4s poll tick
 *     while importing, against the row four producers and the decision POST also
 *     lock. One indexed single-row read replaces a four-round-trip transaction.
 *  2. MAY THIS OWNER BE WRITTEN FOR (round-1 A1). `resolveOwnerScope` is
 *     documented as "subscription enforcement for owner MUTATION routes", and the
 *     GET passes `allowReadOnly: true` so a past-due read-only owner can still
 *     READ their banner. The self-heal is a MUTATION: minting a 7-day offer for an
 *     owner whose POST 402s hands them something they can never answer, and
 *     because expiry is derived and terminal (#670) that permanently consumes the
 *     location's one-time Import offer. `assertWritableSubscriptionForAccount` is
 *     the repo's existing answer to "may this account be written for"
 *     (`route-helpers.ts:194`) — no new signal, and it covers blocking
 *     offboarding too. Ordered second because gate 1 is cheaper and far more
 *     selective: it is false for every location that already has an offer.
 */
async function selfHealImportOffer(locationId: string, accountId: string): Promise<void> {
  const consent = await readImportConsent(sql, locationId, accountId);
  if (consent?.state !== 'pending' || consent.expiresAt !== null) return;

  const writable = await assertWritableSubscriptionForAccount(accountId, sql);
  if (!writable.ok) return;

  await sql.begin(async (tx) => {
    await tx`
      SELECT id FROM businesses
      WHERE id = ${locationId}::uuid
        AND account_id = ${accountId}::uuid
      FOR UPDATE
    `;
    await createImportOffer(tx, locationId, accountId);
  });
}

/**
 * `resolveOwnerScope` plus the `ScopeError` → Response mapping, once for the two
 * handlers below. They differ only in `allowReadOnly`, and a non-`ScopeError`
 * still rethrows — the mapping is the only thing shared.
 *
 * Extracted because BOTH handlers in this file carried the same nine-line
 * preamble; `fallow`'s duplication gate then also matched it against
 * `past-replies/draft-status/route.ts:48-54`, which is outside this ticket's
 * surface and is deliberately left alone. Two in-file callers justify the helper
 * on their own — the cross-file clone dissolving is a side effect, not the reason.
 */
type ScopeOutcome =
  | { ok: true; scope: Awaited<ReturnType<typeof resolveOwnerScope>> }
  | { ok: false; response: Response };

async function resolveScopeOrResponse(
  request: NextRequest,
  options?: { allowReadOnly: boolean },
): Promise<ScopeOutcome> {
  try {
    return { ok: true, scope: await resolveOwnerScope(sql, request, options) };
  } catch (err) {
    if (err instanceof ScopeError) {
      return {
        ok: false,
        response: NextResponse.json({ error: err.message }, { status: err.statusCode }),
      };
    }
    throw err;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const resolved = await resolveScopeOrResponse(request, { allowReadOnly: true });
  if (!resolved.ok) return resolved.response;
  const { accountId, locationId } = resolved.scope;

  try {
    // Self-heal, THEN read — never the reverse. Reading first would show state one
    // render stale immediately after a repair, the exact bug the self-heal exists
    // to prevent. The read itself is unconditional: a read-only owner still sees
    // their banner.
    await selfHealImportOffer(locationId, accountId);

    const view = await readImportOfferView(sql, locationId, accountId);
    return NextResponse.json(view, { status: 200 });
  } catch (err) {
    reportCaughtError('dashboard/import-offer GET', err, { accountId, locationId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = withSameOrigin()(async (request: NextRequest): Promise<Response> => {
  const resolved = await resolveScopeOrResponse(request);
  if (!resolved.ok) return resolved.response;
  const { accountId, locationId } = resolved.scope;

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
