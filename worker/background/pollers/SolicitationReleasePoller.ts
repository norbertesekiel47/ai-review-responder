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

import type { Sql } from 'postgres';
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
  // TODO(#900 task 8): read SOLICITATION_RELEASE_POLL_INTERVAL_MS from
  // getWorkerConfig(), parsed like JUDGE_POLL_INTERVAL_MS.
  return DEFAULT_INTERVAL_MS;
}

export async function runSolicitationReleaseCycle(exec: Sql): Promise<void> {
  const report = await runReleaseCycle(exec);
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
