// src/app/api/dashboard/import-offer/__tests__/route.test.ts
//
// T0 EVAL suite for #677 — titles 26–30 (POST) and 34–39 (GET) of the intake's
// 70, authored VERBATIM before implementation.
//
// The MOCKED half of the decision API. Its live twin, route.integration.test.ts,
// owns titles 31–33, 61 and 68 — the committed-state, rollback and concurrency
// proofs a mocked `sql` tag cannot make.
//
// Division of labour (plan §2): this file asserts the ROUTE CONTRACT — that POST
// validates its body with zod, resolves scope via resolveOwnerScope, makes ONE
// call to recordImportDecisionAndEnqueue and maps its four outcomes; that GET
// needs no CSRF wrapper (GETs are exempt, draft-status:18-20) and returns the
// banner state. Invariant #12: the handler holds no sql.begin and no business
// logic, so "the route called the module once with the right arguments" IS the
// contract here.
//
import { describe, it } from 'vitest';

describe('POST /api/dashboard/import-offer', () => {
  it.todo('POST import-offer accept records the decision and enqueues the import in one transaction');

  it.todo('POST import-offer decline records the decision and enqueues nothing');

  // The late click. Derived expiry means nothing fires at the deadline (#670),
  // so a banner rendered at T+6d59m and clicked at T+7d01m is the ordinary case,
  // not an edge case — the guarded UPDATE is the only thing standing between it
  // and a manufactured consent.
  it.todo('POST import-offer rejects a late click on a derived-expired offer without writing or enqueueing');

  // F3 terminal-state contract. "Enqueues exactly one" is the assertion that
  // matters: a duplicate accept that re-enqueued would import twice while
  // looking perfectly idempotent at the decision column.
  it.todo('POST import-offer never overwrites an already-answered decision and enqueues exactly one import on a duplicate accept');

  // Invariant #8. Owner scope is app-enforced, and this route takes a decision
  // that gates a data import — a foreign business_id must not be reachable by
  // supplying it.
  it.todo('POST import-offer resolves its location from owner scope and rejects a foreign business');
});

describe('GET /api/dashboard/import-offer', () => {
  it.todo('GET import-offer returns the offer state only for a pending unexpired offer');

  // The self-heal (F105/F106). It is what makes best-effort offer creation on the
  // Stripe path acceptable — do not drop one without the other (plan T3). The
  // route does NOT re-implement a junction check: createImportOffer owns that
  // condition, and calling it "when at the junction" was revision 2's mistake.
  it.todo('GET import-offer re-attempts offer creation for a junction location whose offer was never created');

  // completed_at decides done, never imported_count — the count DEFAULTs to 0
  // and is written incrementally (ZernioBackfillWorker.ts:379).
  it.todo('GET import-offer reports importing while the accepted import has no completed run');

  it.todo('GET import-offer reports the imported count when the run completes');

  it.todo('GET import-offer reports the empty outcome when the import stored zero reviews');

  it.todo('GET import-offer reports a failed import when the outbox row reaches a terminal non-completed status');
});
