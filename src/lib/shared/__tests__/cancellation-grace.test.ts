// src/lib/shared/__tests__/cancellation-grace.test.ts
//
// Pins the day-count constant CANCELLATION_GRACE_DAYS and the JS deadline
// calculator (cancellationGraceDeadline, consumed by the dashboard route's
// gracePeriodEndDate) that derives from it. CancellationGracePoller's
// archival-scan predicate imports the same constant directly (its own test
// pins the bound SQL value to it) — before this fix the two computed the
// 30-day window independently — a JS `+ 30 * 86_400_000` in the route and a
// SQL `INTERVAL '30 days'` in the poller — with no shared owner (#1371).
//
// Also pins resolveCancellationGraceState — the single owner of WHICH date is
// the grace clock (#1455). Before this fix the dashboard route fell back to
// subscription_activated_at when cancelled_at was NULL while
// CancellationGracePoller required cancelled_at outright; migration 125
// backfilled the legacy rows and this function is now the one place a NULL
// cancelled_at is handled, for either consumer.

import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_GRACE_DAYS,
  cancellationGraceDeadline,
  resolveCancellationGraceState,
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

describe('resolveCancellationGraceState', () => {
  it('computes gracePeriodEnd = cancelledAt + 30 days and readAccess=true while still within grace', () => {
    const cancelledAt = new Date(Date.now() - 5 * 86_400_000); // 5 days ago
    const state = resolveCancellationGraceState(cancelledAt);

    expect(state.gracePeriodEnd?.getTime()).toBe(
      cancelledAt.getTime() + CANCELLATION_GRACE_DAYS * 86_400_000,
    );
    expect(state.readAccess).toBe(true);
  });

  it('flips readAccess=false once gracePeriodEnd is in the past', () => {
    const cancelledAt = new Date(Date.now() - 40 * 86_400_000); // 40 days ago
    const state = resolveCancellationGraceState(cancelledAt);

    expect(state.gracePeriodEnd!.getTime()).toBeLessThan(Date.now());
    expect(state.readAccess).toBe(false);
  });

  it('a null cancelledAt (unrepresentable post-migration-125) is fail-safe: indefinite grace, no countdown', () => {
    // #1455: no fallback to subscription_activated_at anymore. A NULL clock
    // means "unknown", and unknown must never mean "locked out" — the same
    // stance CancellationGracePoller already takes (it never archives without
    // a known cancelled_at).
    const state = resolveCancellationGraceState(null);

    expect(state.gracePeriodEnd).toBeNull();
    expect(state.readAccess).toBe(true);
  });
});
