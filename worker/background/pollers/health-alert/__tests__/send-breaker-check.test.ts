import { describe, expect, it } from 'vitest';
import type postgresType from 'postgres';
import { checkSolicitationSendBreaker } from '../checks';

// Unit suite for the HealthAlertPoller's send-breaker check (#898).
//
// The poller is the breaker's ONLY tripper and its only pager, so what this
// suite pins is the FINDING — its key, its level, and that its detail is
// aggregate-only. The read model itself is proven against the real schema in
// src/lib/solicitation/__tests__/send-breaker.integration.test.ts; duplicating
// it here would only test the stub.

interface BreakerWindowRow {
  sends: number;
  hard_bounces: number;
  complaints: number;
}

/**
 * A POSITIONAL postgres.js stand-in: one queued result per statement, shifted in
 * dispatch order, `[]` once the queue runs dry.
 *
 * It has to be positional rather than "the same row for every query" because
 * `evaluateSendBreaker` is level-triggered and its statements are DIFFERENT:
 * first the open-trip probe, then — only when nothing is open — the window
 * aggregate, then the trip INSERT … RETURNING id. A stub answering them all
 * alike reports every healthy window as an open trip.
 *
 * No `any`: the shape is built as `unknown` and narrowed at the boundary. The
 * `json` passthrough stands in for `sql.json(window)` on the insert.
 */
function stubSql(results: unknown[][]): postgresType.Sql {
  const queue = [...results];
  const tagged = (): Promise<unknown[]> => Promise.resolve(queue.shift() ?? []);
  const stub: unknown = Object.assign(tagged, { json: (value: unknown) => value });
  return stub as postgresType.Sql;
}

/** No open trip, then this window, then a successful trip insert. */
function noTripThen(row: BreakerWindowRow): unknown[][] {
  return [[], [row], [{ id: '01920000-0000-7000-8000-000000000000' }]];
}

describe('checkSolicitationSendBreaker', () => {
  it('checkSolicitationSendBreaker returns an error finding naming the breached metric', async () => {
    const finding = await checkSolicitationSendBreaker(
      stubSql(noTripThen({ sends: 100, hard_bounces: 3, complaints: 0 })),
    );
    expect(finding?.key).toBe('solicitation_send_breaker_tripped');
    expect(finding?.level).toBe('error');
    expect(finding?.title).toContain('hard bounce');
    // Aggregate-only detail — counts and rates, never a recipient address or
    // message content (checkStalledSendBatches precedent).
    expect(JSON.stringify(finding?.detail)).not.toMatch(/@/);
  });

  it('checkSolicitationSendBreaker returns null when the window is healthy', async () => {
    // 0.2% and 0.1% — both under bar.
    expect(
      await checkSolicitationSendBreaker(
        stubSql(noTripThen({ sends: 5_000, hard_bounces: 10, complaints: 5 })),
      ),
    ).toBeNull();
  });

  it('checkSolicitationSendBreaker re-pages on every tick while a trip stays open', async () => {
    // LEVEL-TRIGGERED (round-1 adversarial-3 / std-2). The first shape returned
    // null on every tick after the one that inserted, so a single dropped Sentry
    // event left sending halted platform-wide with no notification and no
    // re-page, indefinitely. An open trip is a STATE and must page for as long
    // as it holds. It pages from the trip's own frozen snapshot without
    // re-running the expensive aggregate, which is why only ONE result is
    // queued: a second statement here would be a regression.
    const finding = await checkSolicitationSendBreaker(
      stubSql([
        [
          {
            id: '01920000-0000-7000-8000-0000000000aa',
            tripped_at: new Date('2026-08-19T00:00:00.000Z'),
            trip_reason: 'complaint_rate',
            metrics: {
              sends: 1000,
              hardBounces: 0,
              complaints: 9,
              hardBounceRate: 0,
              complaintRate: 0.009,
            },
          },
        ],
      ]),
    );
    expect(finding?.key).toBe('solicitation_send_breaker_tripped');
    expect(finding?.level).toBe('error');
    expect(finding?.title).toContain('STILL halted');
    expect(finding?.detail).toMatchObject({
      trip_reason: 'complaint_rate',
      trip_id: '01920000-0000-7000-8000-0000000000aa',
      still_open: true,
    });
    expect(JSON.stringify(finding?.detail)).not.toMatch(/@/);
  });
});
