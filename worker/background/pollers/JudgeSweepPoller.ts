import type { Sql } from 'postgres';
import { getWorkerConfig } from '@/lib/config/worker';
import { sql } from '@/lib/db/server';
import { judgeEnabled } from '@/lib/responses/judge-flags';
import { JUDGE_LOOKBACK_HOURS, listUnjudgedAutoPosts } from '@/lib/responses/judge-store';
import { enqueueJudgeVerdict } from '@/lib/shared/job-outbox-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { POLLER_JUDGE_SWEEP, recordPollerCycle } from '@/lib/shared/poller-liveness';
import { createGuardedPoll } from '../guarded-poll';

const logger = createWorkerLogger('[JudgeSweepPoller]');
const DEFAULT_INTERVAL_MS = 60_000;
const CYCLE_TIMEOUT_MS = 30_000;
const BATCH_LIMIT = 50;

function getIntervalMs(): number {
  const parsed = Number.parseInt(getWorkerConfig().JUDGE_POLL_INTERVAL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * One sweep cycle: enqueue a Judge verdict for every unjudged auto-post, then
 * record the durable heartbeat `isJudgeHealthy` reads (#949, migration 118).
 *
 * The heartbeat is the LAST statement, and it is reached only when every
 * enqueue above has succeeded. Ordering is the whole contract:
 *
 * - A cycle that throws records NOTHING. A cycle that could not enqueue is not
 *   proof the Judge is being fed, and recording it would restore exactly the
 *   blind spot this heartbeat exists to close.
 * - A cycle that found ZERO candidates DOES record one. An idle sweep is a
 *   working sweep, and the probe must not confuse "no Judge work due" with
 *   "no Judge".
 *
 * The `judgeEnabled()` early return stays ABOVE the heartbeat, so a heartbeat
 * means a real Judge cycle completed — never merely that a timer fired. Two
 * consequences are deliberate and documented:
 *
 * 1. `checkJudgeSweepLiveness` must gate itself on the same flag, or it pages
 *    nonstop in production where every autonomy flag is off.
 * 2. Flipping `JUDGE_ENABLED` off→on leaves the probe unhealthy until the first
 *    cycle lands (≤ `JUDGE_POLL_INTERVAL_MS`, 60s by default). Auto-policy
 *    posts downgrade to owner review during that window. That is fail-closed
 *    and intended; the `flag-flip` skill carries the operator note.
 */
export async function runJudgeSweepCycle(exec: Sql): Promise<void> {
  if (!judgeEnabled()) return;

  const candidates = await listUnjudgedAutoPosts(exec, {
    lookbackHours: JUDGE_LOOKBACK_HOURS,
    limit: BATCH_LIMIT,
  });
  for (const candidate of candidates) {
    await exec.begin((tx) => enqueueJudgeVerdict(tx, {
      responseId: candidate.response_id,
      businessId: candidate.business_id,
      accountId: candidate.account_id,
    }));
  }

  await recordPollerCycle(exec, POLLER_JUDGE_SWEEP);
}

const guard = createGuardedPoll(() => runJudgeSweepCycle(sql), {
  label: 'judge-sweep',
  logger,
  intervalMs: getIntervalMs,
  timeoutMs: CYCLE_TIMEOUT_MS,
});

export function startJudgeSweepPoller(): void {
  guard.start(() => logger.log(`Starting (interval=${getIntervalMs()}ms)`));
}

export function stopJudgeSweepPoller(): void {
  guard.stop();
}
