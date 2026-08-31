// Composition root for the Solicitation release lane (#900).
//
// Deliberately SHALLOW. It owns the `sql` singleton, the interval and the
// guarded-poll scaffolding, and nothing else. Every rule — the phase order, the
// governor order, the Judge split, the per-tick budget — lives in
// `src/lib/solicitation/release.ts`, which takes its DB client as a parameter
// (invariant #15). A rule that lands in this file escapes that invariant.
//
// IT DOES NOT READ `SOLICITATION_SEND_ENABLED`, and that is the one way it
// departs from its `JudgeSweepPoller` precedent. The flag gates the RELEASE
// PHASE only, inside the domain module. Gating the whole cycle here would stop
// the `send_window_elapsed` sweep on a flag-off, so a batch flipped off
// mid-drip would keep its `queued` rows forever and migration 091's
// one-active-send index would block that location permanently — the wedge
// issue #915 exists to close.
//
// One new entry on the P2 single-replica list in
// docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md. Exactly one
// for the whole send-mode map, and it carries amendment B3's condition: if the
// releaser is ever parallelized, the single-choke-point cap resolution must be
// revisited.

import * as Sentry from '@sentry/node';
import type { Sql } from 'postgres';
import { getWorkerConfig } from '@/lib/config/worker';
import { sql } from '@/lib/db/server';
import { runReleaseCycle } from '@/lib/solicitation/release';
import { createWorkerLogger } from '@/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';

const logger = createWorkerLogger('[SolicitationReleasePoller]');
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Below the interval on purpose (`GuardedPollOptions.timeoutMs`): a hung cycle
 * must free the single-flight flag before the next tick, so recovery costs one
 * interval rather than two.
 */
const CYCLE_TIMEOUT_MS = 45_000;

function getIntervalMs(): number {
  const parsed = Number.parseInt(
    getWorkerConfig().SOLICITATION_RELEASE_POLL_INTERVAL_MS || '',
    10,
  );
  // `JUDGE_POLL_INTERVAL_MS`'s parse, with ONE extra rejection: a configured
  // interval at or below `CYCLE_TIMEOUT_MS` is treated as invalid. The helper's
  // own contract (`GuardedPollOptions.timeoutMs`) requires the deadline to sit
  // BELOW the interval so a hung cycle frees the single-flight flag before the
  // next tick; a shorter interval would let ticks land on an in-flight cycle and
  // silently turn "recovery costs one interval" into "recovery costs several".
  // Rejected values fall back to the default, exactly like a non-numeric one.
  const withinContract = Number.isFinite(parsed) && parsed > CYCLE_TIMEOUT_MS;
  return withinContract ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * One release cycle, plus the ONE thing this composition root owns beyond
 * handing over the singleton: the cycle's alert path.
 *
 * WHY IT EXISTS (#1010 red-team P1-B). This poller is a guarded poll, NOT a
 * BullMQ worker, so `attachJobFailureSink` never sees a failure here and
 * `createGuardedPoll`'s shared catch emits `logger.error` alone. Before this
 * branch nothing terminal could happen in the cycle. This branch routes a NEW
 * terminal failure into it: `latchSystemHalt` — reached only from
 * `runReleaseCycle`'s `platform_halt` and `send_window_elapsed` paths — now
 * writes a `batch_halted` Refusal, and a writer bug there aborts the halt. Left
 * at the log line alone, the batch stays UN-halted and the same abort repeats
 * silently every minute, on the lane that stops sending. Issue shape follows
 * `worker/job-failure-sink.ts`, and the whole shape follows
 * `AutonomyGovernorScheduler`'s #1009 precedent.
 *
 * IT RETHROWS, and that is the difference from the Governor. That catch
 * CONTAINS a failure to one candidate and therefore swallows; this one only
 * OBSERVES. Rethrowing leaves the guarded-poll harness owning what it already
 * owned — the structured `Poll cycle failed` line and, in `finally`, the
 * single-flight flag — so the durable line survives even when Sentry does not,
 * and a swallow here would instead report a cycle to Sentry while telling the
 * loop it succeeded.
 *
 * THE CAPTURE IS ITSELF WRAPPED, and it swallows. Reporting a failure must
 * never escalate it: a throwing transport would replace the cycle's real error
 * with its own on the way out, and the log line and Sentry issue would then
 * disagree about what failed.
 *
 * NO NEW RULE LANDS HERE. This adds a sink, not behaviour — the phase order,
 * the governor order, the Judge split and the per-tick budget all stay in
 * `release.ts` (invariant #15, and this file's header).
 */
export async function runSolicitationReleaseCycle(exec: Sql): Promise<void> {
  let report: Awaited<ReturnType<typeof runReleaseCycle>>;
  try {
    report = await runReleaseCycle(exec);
  } catch (error) {
    try {
      Sentry.captureException(error, {
        tags: { subsystem: 'solicitation_release' },
        // Error CLASS only — a DB error's text can echo bound values, and the
        // structured line the harness writes carries no more than this either.
        extra: { error_name: error instanceof Error ? error.name : typeof error },
      });
    } catch {
      // Reporting a failure must never escalate it.
    }
    throw error;
  }
  logger.log('Release cycle complete', { ...report });
}

const guard = createGuardedPoll(() => runSolicitationReleaseCycle(sql), {
  label: 'solicitation-release',
  logger,
  intervalMs: getIntervalMs,
  timeoutMs: CYCLE_TIMEOUT_MS,
});

export function startSolicitationReleasePoller(): void {
  guard.start(() => logger.log(`Starting (interval=${getIntervalMs()}ms)`));
}

export function stopSolicitationReleasePoller(): void {
  guard.stop();
}
