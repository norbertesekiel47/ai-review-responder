// The ingest call site (#632 Task 4): the `solicitation_attribution` outbox row
// is written inside `processReview`'s existing `sql.begin`, so the review INSERT
// and the enqueue share one transaction (invariant #2) — and the Zernio backfill
// lane (`importReview`) is deliberately excluded.
//
// A matcher failure must never fail review ingest: the match runs in its own
// worker, never inside the ingest transaction.
//
// Task 0 authors every promised title parked; Task 4 lands the bodies. The
// runnable form follows `approval-system-halt.integration.test.ts` for suite
// shape and the cross-process live-DB lock, and asserts the schema with
// `assertSchemaReady` from `@/lib/shared/__tests__/helpers/schema-ready`
// instead of applying DDL at run time.

import { describe, it } from 'vitest';

describe('processReview', () => {
  it.todo('processReview: the review INSERT and solicitation_attribution outbox row commit or roll back together');
  it.todo('processReview: a later attribution matcher failure cannot roll back a committed live-ingest review');
});

describe('importReview', () => {
  it.todo('importReview: never enqueues solicitation_attribution on the Zernio backfill lane');
});
