// src/app/api/zernio/connect/_shared/finalize/__tests__/import-offer-junction.test.ts
//
// T0 EVAL suite for #677 — titles 14–19 of the intake's 69, authored VERBATIM
// before implementation.
//
// Producer 1 of 4: connect finalize. This is the junction site — subscription
// activated AND a connection just written — so it both CREATES the Import offer
// and gates the enqueue on consent.
//
// Mocked, not live (plan §2): what needs proving here is the BINDINGS and the
// branch structure — that finalize calls createImportOffer, that it enqueues on
// 'accepted' only, and that it does not enqueue twice. The SQL semantics of the
// predicate itself are proven against live Postgres in
// src/lib/reviews/__tests__/import-consent.integration.test.ts.
//
// Harness: the vi.hoisted + txScenario + txCalls recorder already established in
// this directory by finalize-modules.test.ts (:18-24) — same shape, so the two
// files stay readable side by side.
//
// ROUND-1 O3: finalize no longer spells its own payload / completed-run guard /
// deduped INSERT — it calls `enqueueInitialImport` (src/lib/reviews/import-consent.ts),
// the one implementation the three consent-honouring producers share. The
// enqueue DECISION is still finalize's (the `consent === 'accepted'` branch), so
// every title below is unchanged in subject; what moved is which statement the
// mock has to answer, and the completed-run guard is now scoped to
// `run_reason = 'initial'` (round-1 A4).
//
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, txCalls, txScenario } = vi.hoisted(() => {
  const txCalls: Array<{ raw: string; values: unknown[] }> = [];
  const txScenario = {
    importConsent: 'pending' as 'pending' | 'accepted' | 'declined' | 'expired' | null,
    subscriptionActivatedAt: new Date('2026-05-01T00:00:00.000Z') as Date | null,
    offerCreated: true,
    hasCompletedRun: false,
  };

  const mockTx: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('?');
    txCalls.push({ raw, values });

    // readImportConsent — matched first, on its aliased column.
    if (/import_decision_at AS decided_at/.test(raw)) {
      return Promise.resolve(
        txScenario.importConsent === null
          ? []
          : [{ state: txScenario.importConsent, decided_at: null, expires_at: null }],
      );
    }
    // createImportOffer.
    if (/SET import_offer_expires_at/.test(raw)) {
      return Promise.resolve(txScenario.offerCreated ? [{ id: 'biz-1' }] : []);
    }
    // `enqueueInitialImport`'s target resolution (round-1 O3): one statement
    // that reads the payload fields AND applies the completed-run guard, as a
    // `LEFT JOIN … AND br.id IS NULL` anti-join. A completed INITIAL run
    // therefore shows up as ZERO rows — no target, no payload, no enqueue —
    // which is why `hasCompletedRun` returns `[]` rather than a run row here.
    if (/LEFT JOIN zernio_backfill_runs/.test(raw)) {
      return Promise.resolve(
        txScenario.hasCompletedRun
          ? []
          : [{
            zernio_account_id: 'zernio-account-1',
            zernio_location_id: 'google-location-1',
            subscription_tier: 'copilot',
            subscription_activated_at: new Date('2026-05-01T00:00:00.000Z'),
          }],
      );
    }
    if (/subscription_activated_at[\s\S]*FROM businesses b[\s\S]*JOIN accounts a/.test(raw)) {
      return Promise.resolve([{
        account_id: 'acct-1',
        subscription_status: 'active',
        past_due_at: null,
        flags: {},
        subscription_tier: 'copilot',
        subscription_activated_at: txScenario.subscriptionActivatedAt,
      }]);
    }
    if (/FROM zernio_connections[\s\S]*FOR UPDATE/.test(raw)) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  mockTx.json = vi.fn((v: unknown) => v);

  const mockSql: any = vi.fn(() => Promise.resolve([]));
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));

  return { mockTx, mockSql, txCalls, txScenario };
});

vi.mock('uuid', () => ({ v7: vi.fn(() => 'mock-uuid-v7-junction-0000000001') }));

import { finalizeConnectionTx } from '../finalize-tx';

const USER = { id: 'user-1', accountId: 'acct-1', email: 'owner@test.local' };
const STORED = {
  businessId: 'biz-1',
  profileId: 'prof-1',
  locations: [{ id: 'google-location-1', name: 'Loc' }],
};

/** Did the import topic reach job_outbox? The topic is a BOUND value, so a raw-text regex would be vacuously false. */
function importEnqueued(): boolean {
  return txCalls.some(
    (c) => c.raw.includes('INSERT INTO job_outbox') && c.values.includes('zernio_initial_backfill'),
  );
}

function offerCreateAttempted(): boolean {
  return txCalls.some((c) => /SET import_offer_expires_at/.test(c.raw));
}

async function finalize(): Promise<void> {
  await finalizeConnectionTx(mockSql, {
    user: USER as never,
    stored: STORED as never,
    locationId: 'google-location-1',
    accountId: 'zernio-account-1',
  });
}

beforeEach(() => {
  // EVERY scenario field resets here. `hasCompletedRun` was added later and
  // initially missed, so title 17's `true` leaked into title 18 and its enqueue
  // silently vanished — the failure surfaced as `Cannot read properties of
  // undefined`, three tests away from the cause.
  txCalls.length = 0;
  txScenario.importConsent = 'pending';
  txScenario.subscriptionActivatedAt = new Date('2026-05-01T00:00:00.000Z');
  txScenario.offerCreated = true;
  txScenario.hasCompletedRun = false;
});

describe('finalize connection — Import offer junction', () => {
  // Title 14. The default state after migration 100 is `pending` with a NULL
  // deadline for EVERY business row, so "creates the offer" and "does not
  // import" have to be asserted together: the offer write must not be mistaken
  // for consent.
  it('finalize-tx creates the import offer and enqueues no import when import consent is pending', async () => {
    txScenario.importConsent = 'pending';

    await finalize();

    // Both halves matter together: the offer IS written (so the banner can show
    // it) and the import is NOT enqueued. Asserting only the second would pass on
    // an implementation that never offers anything at all.
    expect(offerCreateAttempted()).toBe(true);
    expect(importEnqueued()).toBe(false);
  });

  // Spec §7: re-connect after declining stays declined. Derived-expired is the
  // same shape — nothing fires at the expiry moment (#670), so the read-side
  // predicate is what has to hold.
  it('finalize-tx enqueues no import for declined or derived-expired consent', async () => {
    for (const state of ['declined', 'expired'] as const) {
      txCalls.length = 0;
      txScenario.importConsent = state;

      await finalize();

      // 'expired' is DERIVED by readImportConsent, never stored (#670) — so the
      // gate must reject on the returned state and not by re-inspecting the
      // deadline. Spec §7: re-connect after declining stays declined.
      expect(importEnqueued(), `consent=${state} must not enqueue`).toBe(false);
    }
  });

  it('finalize-tx enqueues the import on reconnect when import consent is already accepted and no run has completed', async () => {
    txScenario.importConsent = 'accepted';

    await finalize();

    expect(importEnqueued()).toBe(true);
    // Tagged 'initial', which is what puts it under the worker's
    // ON CONFLICT … WHERE run_reason = 'initial' dedup — unlike reactivation.
    const enqueue = txCalls.find(
      (c) => c.raw.includes('INSERT INTO job_outbox') && c.values.includes('zernio_initial_backfill'),
    );
    expect(JSON.stringify(enqueue!.values)).toContain('initial');
  });

  // Round-1 High (F101): accept-then-reconnect would otherwise insert a second
  // job. The completed-run predicate and the in-flight dedup are two distinct
  // guards and title 17 vs 18 keeps them distinguishable — one asserts against a
  // finished run, the other against a job still in flight.
  // Titles 17 and 18 are asserted at the SQL level rather than by stubbing rows.
  // The enqueue is a single `INSERT … SELECT … WHERE NOT EXISTS (…) AND NOT
  // EXISTS (…)`, so Postgres — not JavaScript — decides whether a row lands.
  // A mocked `sql` tag cannot make that decision at all: it returns whatever it is
  // told regardless of the predicate. What IS falsifiable here, and what actually
  // breaks if someone drops a guard, is that both guards are present in the
  // statement. Their runtime behaviour is proven against live Postgres by titles
  // 33 and 61 (concurrent producers → exactly one row).
  it('finalize-tx enqueues no import when accepted consent already has a completed run', async () => {
    // A completed run SUPPRESSES the enqueue, and here the mock returns none — so
    // this is a real behavioural assertion, not a shape check. Since round-1 O3
    // the guard is the anti-join inside `enqueueInitialImport`'s target
    // resolution, so "a completed run exists" and "no target row" are the same
    // fact, decided by Postgres in one statement.
    txScenario.importConsent = 'accepted';
    txScenario.hasCompletedRun = true;

    await finalize();

    // The guard ran…
    const guard = txCalls.find((c) => /LEFT JOIN zernio_backfill_runs/.test(c.raw));
    expect(guard).toBeDefined();
    // …scoped to `run_reason = 'initial'` (round-1 A4). Unscoped, a completed
    // REACTIVATION run — which recurs by design, unlike the once-per-business
    // `initial` run — would permanently suppress an initial import the banner
    // still reports as `importing`, forever, on a 4s poll. This is the assertion
    // that keeps the three gates aligned with `readImportOfferView`.
    expect(guard!.raw).toContain("br.run_reason = 'initial'");
    expect(guard!.raw).toContain('br.completed_at IS NOT NULL');
    // …and nothing was enqueued.
    expect(importEnqueued()).toBe(false);
  });

  // Dedups against OUTBOX_IN_FLIGHT_STATUSES, imported and never re-spelled
  // (invariant #2's byte-for-byte contract).
  it('finalize-tx enqueues no second import when an in-flight zernio_initial_backfill row already exists', async () => {
    txScenario.importConsent = 'accepted';

    await finalize();

    const enqueue = txCalls.find(
      (c) => c.raw.includes('INSERT INTO job_outbox') && c.values.includes('zernio_initial_backfill'),
    );
    // Byte-for-byte, in this order. A bind parameter here would defeat
    // partial-index inference (invariant #2), so the literal must stay spelled out
    // — which also makes it checkable.
    expect(enqueue!.raw).toContain("jo.status IN ('pending', 'dispatching', 'dispatched')");
  });

  // The other half of the junction. Without activation there is no junction, so
  // there is no offer — and this is the case that proves the eligibility check
  // lives inside createImportOffer's own SQL rather than in the caller.
  it('finalize-tx creates no offer when subscription_activated_at is null', async () => {
    txScenario.subscriptionActivatedAt = null;

    await finalize();

    // Without activation there is no junction, so there is nothing to offer and
    // nothing to import. This is also the case that proves the eligibility check
    // is not merely inside createImportOffer's SQL — finalize does not even reach
    // it, so a location holding one half of the junction never gets a deadline.
    expect(offerCreateAttempted()).toBe(false);
    expect(importEnqueued()).toBe(false);
  });
});
