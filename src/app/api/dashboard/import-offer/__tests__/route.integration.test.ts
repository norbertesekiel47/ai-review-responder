// src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts
//
// T0 EVAL suite for #677 — titles 31–33 and 61 of the intake's 69, authored
// VERBATIM before implementation.
//
// The LIVE half of the decision API. Every title here is one a mocked `sql` tag
// structurally cannot express:
//
//  - 31 is a ROLLBACK. Proving the consent write disappears when the outbox
//    INSERT fails requires a real transaction boundary; a mock can only prove
//    the calls were made in order.
//  - 32 is a BYTE-IDENTICAL row comparison after a rejected write, across five
//    facts (decision, decision_at, expires_at, zero new outbox rows, zero new
//    analytics rows). Round 1 set this bar precisely because "the offer row was
//    written" is the assertion that passes while the feature is still wrong.
//  - 33 and 61 are RACES. Two concurrent accepts, and an acceptance racing
//    connect-finalize, must each yield exactly one zernio_initial_backfill row.
//
// A fifth title lived here until 2026-08-07 — "GET import-offer self-heal records
// import_offer_created in the same transaction" — and moved to #679 with the rest
// of the analytics slice (deviations D7): the event name needs the
// analytics_events.event_name CHECK extended, which needs a migration this
// ticket's non-goals forbid. #679 must restore it as a SAME-TRANSACTION
// assertion, because the self-healed offer is precisely the one that would
// otherwise vanish from the offer-created → decision-recorded ratio.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema, and
// NEVER applies migration SQL.
//
import { describe, it } from 'vitest';

describe('import-offer decision API against live Postgres', () => {
  it.todo('live DB: accept rolls back the import consent write when the job_outbox INSERT fails');

  it.todo('live DB: a rejected late POST leaves decision, decision_at, expires_at, outbox rows and analytics rows unchanged');

  it.todo('live DB: two concurrent accept requests commit one transition and exactly one zernio_initial_backfill row');

  // Title 61 — the cross-producer race, and note WHICH producers: acceptance vs
  // connect-finalize. Reactivation is deliberately EXCLUDED from this assertion:
  // it enqueues with backfill_reason 'reactivation' and the worker's
  // ON CONFLICT … WHERE run_reason = 'initial' does not dedup it, because the
  // archived-period catch-up is supposed to recur. Round 3 flagged the earlier
  // unqualified wording for exactly this reason — read across all four
  // producers it contradicted reactivation's intended behaviour.
  it.todo('concurrent acceptance and connect finalize under the businesses row lock create exactly one zernio_initial_backfill row');
});
