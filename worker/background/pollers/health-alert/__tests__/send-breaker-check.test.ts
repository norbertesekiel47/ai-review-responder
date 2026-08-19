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
 * A postgres.js stand-in that answers every query with the same window row.
 *
 * `evaluateSendBreaker` issues two statements against a breached window — the
 * aggregate read and the trip INSERT … RETURNING id — so the stub carries an
 * `id` alongside the counts and a `json` passthrough for `sql.json(window)`.
 * No `any`: the shape is built as `unknown` and narrowed at the boundary.
 */
function stubSqlReturning(row: BreakerWindowRow): postgresType.Sql {
  const tagged = (): Promise<Record<string, unknown>[]> =>
    Promise.resolve([{ ...row, id: '01920000-0000-7000-8000-000000000000' }]);
  const stub: unknown = Object.assign(tagged, { json: (value: unknown) => value });
  return stub as postgresType.Sql;
}

describe('checkSolicitationSendBreaker', () => {
  it('checkSolicitationSendBreaker returns an error finding naming the breached metric', async () => {
    const finding = await checkSolicitationSendBreaker(
      stubSqlReturning({ sends: 100, hard_bounces: 3, complaints: 0 }),
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
        stubSqlReturning({ sends: 5_000, hard_bounces: 10, complaints: 5 }),
      ),
    ).toBeNull();
  });
});
