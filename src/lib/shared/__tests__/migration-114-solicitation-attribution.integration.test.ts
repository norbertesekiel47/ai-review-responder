// Shape assertions for migration 114 — the four `solicitation_outreach`
// attribution columns, the one-directional consistency CHECK, and the three
// indexes (the unique attributed-review index, the candidate index and the
// `job_outbox` in-flight index).
//
// Task 0 authors every promised title parked; Task 1 lands the migration and
// the bodies. The runnable form follows
// `migration-091-send-mode-spine.integration.test.ts` for shape and
// `approval-system-halt.integration.test.ts` for the cross-process live-DB
// lock, and asserts the schema with `assertSchemaReady` from
// `@/lib/shared/__tests__/helpers/schema-ready` rather than applying any DDL at
// run time (`ci:live-db-suites` R2).

import { describe, it } from 'vitest';

describe('migration 114', () => {
  it.todo('migration 114: attribution columns, the consistency CHECK and the partial unique index exist');
  it.todo('migration 114: the CHECK and all three index definitions carry the required keys, uniqueness and predicates');
  it.todo('migration 114: one review cannot be attributed to outreach rows in two businesses');
  it.todo('migration 114: deleting an attributed review nulls attributed_review_id and leaves the outreach row');
});
