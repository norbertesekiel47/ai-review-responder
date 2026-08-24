// @vitest-environment jsdom
//
// The owner surface for #632 (Task 7): the "Reviews from your requests" section
// and the fetch that mounts it.
//
// Attribution is sentiment-blind, so a one-star match renders exactly like a
// five-star one — the section is evidence, not a scoreboard. The count is a
// shadow metric and the copy says so; the section is absent entirely when
// `SOLICITATION_SEND_ENABLED` is off. `RequestsClient` mounts it from its own
// scoped endpoint, independently of batch-build state.
//
// Task 0 authors every promised title parked; Task 7 lands the bodies. The
// runnable form follows `batch-report.test.tsx` and `approval-panel.test.tsx`
// for render conventions.

import { describe, it } from 'vitest';

describe('AttributedReviews', () => {
  it.todo('AttributedReviews: renders reviewer name, stars, review date and ask date for each match');
  it.todo('AttributedReviews: renders the shadow-metric never-billed disclosure');
  it.todo('AttributedReviews: renders an empty state when no review is attributed');
  it.todo('AttributedReviews: renders nothing when enabled is false');
  it.todo('AttributedReviews: renders one-star and five-star matches identically');
});

describe('RequestsClient', () => {
  it.todo('RequestsClient: fetches the scoped attributed endpoint and mounts the section independently of batch-build state');
});
