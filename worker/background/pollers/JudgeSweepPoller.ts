import type { Sql } from 'postgres';
import { getWorkerConfig } from '@/lib/config/worker';
import { sql } from '@/lib/db/server';
import { judgeEnabled } from '@/lib/responses/judge-flags';
import { JUDGE_LOOKBACK_HOURS, listUnjudgedAutoPosts } from '@/lib/responses/judge-store';
import { enqueueJudgeVerdict } from '@/lib/shared/job-outbox-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';

const logger = createWorkerLogger('[JudgeSweepPoller]');
const DEFAULT_INTERVAL_MS = 60_000;
const CYCLE_TIMEOUT_MS = 30_000;
const BATCH_LIMIT = 50;

function getIntervalMs(): number {
  const parsed = Number.parseInt(getWorkerConfig().JUDGE_POLL_INTERVAL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

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
