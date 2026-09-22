// src/lib/shared/__tests__/cancellation-grace.test.ts
//
// Pins the JS deadline calculator (cancellationGraceDeadline, consumed by
// the dashboard route's gracePeriodEndDate) and its SQL twin
// (cancellationGraceExpiredSql, consumed by CancellationGracePoller's
// archival scan) to the same CANCELLATION_GRACE_DAYS day count (#1371).
// Before this fix the two computed the 30-day window independently — a JS
// `+ 30 * 86_400_000` in the route and a SQL `INTERVAL '30 days'` in the
// poller — and had no shared test proving they agreed.

import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_GRACE_DAYS,
  cancellationGraceDeadline,
} from '../cancellation-grace';
import { cancellationGraceExpiredSql } from '../subscription-eligibility-sql';

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

/**
 * A fake Postgres.js tag function: records the interpolated values a
 * tagged-template SQL fragment builder passed it, without touching a
 * database. Same shape `exec` receives from postgres.js — `(strings,
 * ...values)` — so `cancellationGraceExpiredSql`'s real call, unmodified,
 * can run against it.
 */
function captureSqlValues(): {
  exec: Parameters<typeof cancellationGraceExpiredSql>[0];
  values: unknown[];
} {
  const values: unknown[] = [];
  const exec = ((_strings: TemplateStringsArray, ...vals: unknown[]) => {
    values.push(...vals);
    return { values: vals };
  }) as unknown as Parameters<typeof cancellationGraceExpiredSql>[0];
  return { exec, values };
}

describe('cancellationGraceExpiredSql', () => {
  it('binds the same CANCELLATION_GRACE_DAYS the JS deadline uses', () => {
    const { exec, values } = captureSqlValues();

    cancellationGraceExpiredSql(exec);

    expect(values).toContain(CANCELLATION_GRACE_DAYS);
  });

  it('never hardcodes a day count independent of the shared constant', () => {
    const { exec, values } = captureSqlValues();

    cancellationGraceExpiredSql(exec);

    // The only numeric literal bound into the fragment is the shared
    // constant — no stray `30` reintroduced as a second, driftable owner.
    const numericValues = values.filter((v) => typeof v === 'number');
    expect(numericValues).toEqual([CANCELLATION_GRACE_DAYS]);
  });
});
