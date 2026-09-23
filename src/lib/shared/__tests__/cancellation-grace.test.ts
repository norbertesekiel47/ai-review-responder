// src/lib/shared/__tests__/cancellation-grace.test.ts
//
// Pins the day-count constant CANCELLATION_GRACE_DAYS and the JS deadline
// calculator (cancellationGraceDeadline, consumed by the dashboard route's
// gracePeriodEndDate) that derives from it. CancellationGracePoller's
// archival-scan predicate imports the same constant directly (its own test
// pins the bound SQL value to it) — before this fix the two computed the
// 30-day window independently — a JS `+ 30 * 86_400_000` in the route and a
// SQL `INTERVAL '30 days'` in the poller — with no shared owner (#1371).

import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_GRACE_DAYS,
  cancellationGraceDeadline,
} from '../cancellation-grace';

describe('cancellationGraceDeadline', () => {
  it('adds exactly CANCELLATION_GRACE_DAYS (in ms) to the cancellation date', () => {
    const cancelledAt = new Date('2026-01-01T00:00:00.000Z');
    const deadline = cancellationGraceDeadline(cancelledAt);

    expect(deadline.getTime() - cancelledAt.getTime()).toBe(
      CANCELLATION_GRACE_DAYS * 86_400_000,
    );
  });

  it('matches the day count baked into route.ts prior to this fix (30)', () => {
    // Pin the constant's value itself — a silent change to
    // CANCELLATION_GRACE_DAYS is a behavior change for both consumers and
    // must be a deliberate, visible edit here.
    expect(CANCELLATION_GRACE_DAYS).toBe(30);
  });
});
