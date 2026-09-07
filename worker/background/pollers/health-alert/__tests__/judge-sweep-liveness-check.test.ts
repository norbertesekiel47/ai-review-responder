import { afterEach, describe, expect, it, vi } from 'vitest';
import type postgresType from 'postgres';
import { checkJudgeSweepLiveness } from '../checks';
import { JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS } from '../../../../../src/lib/responses/judge-health';
import { resetWorkerConfigForTests } from '../../../../../src/lib/config/worker';

// Unit suite for the HealthAlertPoller's Judge-sweep liveness check (#949).
//
// The GATE in isJudgeHealthy makes a dead sweep safe — auto-policy posts
// downgrade to owner review — but completely silent. This check is the voice,
// so what this suite pins is the FINDING and the FLAG GATE. Whether the probe
// reads the heartbeat correctly is proven against the real schema in
// src/lib/responses/__tests__/judge-store.integration.test.ts.

/** One queued result per statement, `[]` once the queue runs dry. */
function stubSql(rows: unknown[][]): postgresType.Sql {
  const queue = [...rows];
  const sql = ((): Promise<unknown[]> => Promise.resolve(queue.shift() ?? [])) as unknown;
  return sql as postgresType.Sql;
}

const heartbeatRow = (ageSeconds: number) => [{
  last_cycle_at: new Date('2026-01-01T00:00:00Z'),
  age_seconds: ageSeconds,
}];

afterEach(() => {
  delete process.env.JUDGE_ENABLED;
  resetWorkerConfigForTests();
  vi.unstubAllEnvs();
});

function enableJudge(): void {
  vi.stubEnv('JUDGE_ENABLED', 'true');
  resetWorkerConfigForTests();
}

describe('checkJudgeSweepLiveness', () => {
  it('is silent while JUDGE_ENABLED is off, and issues no query at all', async () => {
    // The single most important case in this file. Every autonomy flag is OFF in
    // production, and the sweep writes no heartbeat while the flag is off — so an
    // unconditional check would page nonstop in prod for a system switched off on
    // purpose. This is the deliberate asymmetry with checkSolicitationSendBreaker,
    // which runs unconditionally because the Solicitation lane is never flag-gated.
    let queried = false;
    const sql = (() => { queried = true; return Promise.resolve([]); }) as unknown as postgresType.Sql;

    await expect(checkJudgeSweepLiveness(sql)).resolves.toBeNull();
    expect(queried).toBe(false);
  });

  it('is silent when the sweep completed a cycle inside the limit', async () => {
    enableJudge();
    const sql = stubSql([heartbeatRow(30)]);

    await expect(checkJudgeSweepLiveness(sql)).resolves.toBeNull();
  });

  it('fires at ERROR level once the heartbeat passes the limit', async () => {
    enableJudge();
    const sql = stubSql([heartbeatRow(JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS + 600)]);

    const finding = await checkJudgeSweepLiveness(sql);

    expect(finding?.key).toBe('judge_sweep_dead');
    expect(finding?.level).toBe('error');
    expect(finding?.title).toContain('25 min ago');
    // Detail is ids, times and durations only — never review or contact content.
    expect(finding?.detail).toEqual({
      poller: 'judge_sweep',
      last_cycle_at: '2026-01-01T00:00:00.000Z',
      age_s: JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS + 600,
      threshold_s: JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS,
    });
  });

  it('fires with a distinct title when the sweep has NEVER completed a cycle', async () => {
    enableJudge();
    const sql = stubSql([[]]);

    const finding = await checkJudgeSweepLiveness(sql);

    // A missing row and a stale row are both "dead", but only one of them means
    // the loop never started — an operator reading the page needs to know which.
    expect(finding?.key).toBe('judge_sweep_dead');
    expect(finding?.title).toContain('NEVER completed a cycle');
    expect(finding?.detail).toEqual({
      poller: 'judge_sweep',
      last_cycle_at: null,
      age_s: null,
      threshold_s: JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS,
    });
  });

  it('uses the SAME threshold the posting gate uses', async () => {
    enableJudge();
    // One second under the gate's limit must not page: an alert that disagreed
    // with the gate about whether the sweep is alive is worse than no alert.
    await expect(
      checkJudgeSweepLiveness(stubSql([heartbeatRow(JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS - 1)])),
    ).resolves.toBeNull();

    const atLimit = await checkJudgeSweepLiveness(
      stubSql([heartbeatRow(JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS)]),
    );
    expect(atLimit?.key).toBe('judge_sweep_dead');
  });
});
