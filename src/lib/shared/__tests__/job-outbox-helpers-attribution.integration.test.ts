// Live-DB behaviour of `enqueueSolicitationAttribution` (#632 Task 4).
//
// The guard is a deliberately COARSER superset of the candidate predicate —
// `delivery_status = 'sent' AND attributed_at IS NULL`, and nothing else. It
// carries no time bound and must never grow one (plan deviation D3): the
// candidate window is anchor-relative, so a `NOW()`-relative guard would drop
// legitimate matches silently. These cases exist because the mocked unit suite
// `job-outbox-helpers.test.ts` cannot prove a live `INSERT … SELECT … WHERE NOT
// EXISTS` guard at all (round-1 finding A8).
//
// Task 0 authors every promised title parked; Task 4 lands the helper and the
// bodies. The runnable form follows
// `approval-system-halt.integration.test.ts` for suite shape, the
// cross-process live-DB lock and the outreach fixtures, and asserts the schema
// with `assertSchemaReady` from `@/lib/shared/__tests__/helpers/schema-ready`
// instead of applying DDL at run time.

import { describe, it } from 'vitest';

describe('enqueueSolicitationAttribution', () => {
  it.todo('enqueueSolicitationAttribution: enqueues nothing when the business has never sent an ask');
  it.todo('enqueueSolicitationAttribution: enqueues exactly one row per new review with an eligible candidate');
  it.todo('enqueueSolicitationAttribution: a business whose only sent outreach is out of window still enqueues and resolves no_candidates');
  it.todo('enqueueSolicitationAttribution: a duplicate enqueue leaves one in-flight row for the review');
});
