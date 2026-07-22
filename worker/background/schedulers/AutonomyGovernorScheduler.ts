import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { governorEnabled } from '@/lib/auto-approval/flags';
import {
  computeGovernorRates,
  evaluateAccount,
  listGovernorCandidates,
  revalidateGovernorCandidate,
  type GovernorBreach,
  type GovernorCandidate,
} from '@/lib/auto-approval/governor';
import { suspendAccountAutonomy } from '@/lib/auto-approval/suspension';
import { getWorkerConfig } from '@/lib/config/worker';
import { sql } from '@/lib/db/server';
import { createWorkerLogger } from '@/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';

const logger = createWorkerLogger('[AutonomyGovernorScheduler]');
const GOVERNOR_CANDIDATE_LIMIT = 50;
export const DEFAULT_GOVERNOR_INTERVAL_MS = 900_000;
export const GOVERNOR_CYCLE_TIMEOUT_MS = 60_000;

export interface GovernorScanCursor {
  afterAccountId: string | null;
}

const schedulerCursor: GovernorScanCursor = { afterAccountId: null };

export function getGovernorIntervalMs(): number {
  const configured = Number.parseInt(getWorkerConfig().GOVERNOR_INTERVAL_MS ?? '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GOVERNOR_INTERVAL_MS;
}

export async function suspendGovernorCandidateIfCurrent(
  exec: Sql,
  candidate: GovernorCandidate,
  breach: GovernorBreach,
): Promise<boolean> {
  return exec.begin(async (tx) => {
    const current = await revalidateGovernorCandidate(
      tx,
      candidate.account_id,
      candidate.window_start,
    );
    if (!current) {
      // A skipped breach must be visible: the 2026-07-22 window-truncation bug
      // hid every-cycle skips for >10 minutes precisely because this path was
      // silent.
      logger.log('autonomy_governor candidate-skipped stale snapshot', {
        account_id: candidate.account_id,
      });
      return false;
    }

    // Governor transactions lock policy rows, then touch account audit and
    // outbox only. They take NO review-lane locks, so they cannot form a cycle
    // with reviews -> businesses -> response children -> agent_runs.
    const result = await suspendAccountAutonomy(tx, {
      accountId: candidate.account_id,
      trigger: breach.trigger,
      suspensionEventId: uuidv7(),
      evidence: breach.evidence,
    });
    return result.newlySuspended;
  });
}

export async function runAutonomyGovernorCycle(
  exec: Sql,
  cursor: GovernorScanCursor = schedulerCursor,
): Promise<void> {
  if (!governorEnabled()) return;

  const candidates = await listGovernorCandidates(
    exec,
    GOVERNOR_CANDIDATE_LIMIT,
    cursor.afterAccountId,
  );
  for (const candidate of candidates) {
    // Advance before evaluation so one poison account cannot permanently
    // starve every later candidate; circular ordering revisits it after wrap.
    cursor.afterAccountId = candidate.account_id;
    try {
      const rates = await computeGovernorRates(exec, candidate.account_id, candidate.window_start);
      const breach = evaluateAccount(rates);
      if (!breach) continue;

      await suspendGovernorCandidateIfCurrent(exec, candidate, breach);
    } catch (error) {
      // Contain the failure to this candidate: one bad account must not abort
      // the rest of the batch for the whole 15-minute interval. Error class
      // only — DB error text can echo bound values.
      logger.error('autonomy_governor candidate-failed', {
        account_id: candidate.account_id,
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

const guard = createGuardedPoll(() => runAutonomyGovernorCycle(sql), {
  label: 'autonomy-governor',
  logger,
  intervalMs: getGovernorIntervalMs,
  timeoutMs: GOVERNOR_CYCLE_TIMEOUT_MS,
});

export function startAutonomyGovernorScheduler(): void {
  guard.start(() => logger.log(`Starting (interval=${getGovernorIntervalMs()}ms)`));
}

export function stopAutonomyGovernorScheduler(): void {
  guard.stop();
}
