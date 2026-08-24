// Live-DB half of #632's `review_attributed` shadow attribution: the candidate
// query's eight predicates, the write transaction, the spine outcome, the
// no-billing claim, crossed-tenant isolation, and the owner read model.
//
// Task 0 authors every promised title parked; the bodies land with the task
// named beside each group below. When they do, this suite takes the shape of
// `approval-system-halt.integration.test.ts`: `resolveTestDatabaseUrl` +
// `describeWithDb`, the cross-process live-DB lock, `assertSchemaReady` from
// `@/lib/shared/__tests__/helpers/schema-ready` (migration 114 asserted, never
// applied — `ci:live-db-suites` forbids run-time DDL), and the shared outreach
// fixtures from `@/lib/shared/__tests__/helpers/outreach-fixture`.

import { describe, it } from 'vitest';

// ── the candidate query and the write transaction (Task 3) ──────────────────

describe('attribution', () => {
  it.todo('attribution: the candidate query excludes bounced, complained and unknown outreach rows');
  it.todo('attribution: the candidate query excludes rows outside the 14-day attribution window');
  it.todo('attribution: an outreach row sent exactly 14 days before the review anchor remains eligible');
  it.todo('attribution: a review anchored before sent_at never yields that outreach row as a candidate');
  it.todo('attribution: a null review_date uses detected_at as the candidate-window anchor');
  it.todo('attribution: an unsubscribed outreach row is still a candidate');
  it.todo('attribution: an already-attributed outreach row is never a candidate for a second review');
  it.todo('attribution: deleting an attributed review does not make its outreach row eligible for another review');
  it.todo('attribution: the handler writes the attribution columns and the review_attributed outcome in one transaction');
  it.todo('attribution: an outcome-write failure rolls back the outreach attribution columns');
  it.todo('attribution: re-running the handler for the same review is idempotent and emits exactly one outcome');
  it.todo('attribution: attribution is sentiment-blind — a one-star review attributes like a five-star review');
  it.todo('attribution: a matched outreach row with a null agent_run_id writes columns and skips the outcome');
  it.todo('attribution: review_attributed attaches to the matched terminal Lazy child, never its parent');
});

// ── the shadow / never-billed claim (Task 3) ────────────────────────────────

describe('attributeReview', () => {
  it.todo('attributeReview: a successful attribution writes no api_costs, Stripe or metered-usage record');
});

// ── invariant #8: every read and write scoped by account and business (Task 3)

describe('tenant isolation', () => {
  it.todo('tenant isolation: crossed account, business, review and outreach ids expose or mutate neither tenant');
});

// ── the owner read model (Task 6) ───────────────────────────────────────────

describe('listAttributedReviews', () => {
  it.todo('listAttributedReviews: returns matches across batches within the last 30 days');
  it.todo('listAttributedReviews: excludes attribution older than 30 days');
  it.todo('listAttributedReviews: scopes every read by account_id and business_id');
  it.todo('listAttributedReviews: returns an empty list when SOLICITATION_SEND_ENABLED is off');
});
