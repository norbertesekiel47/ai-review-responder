import type { WorkerLogger } from '../../src/lib/shared/logger';

/**
 * Idle-cycle log suppression with a low-frequency liveness heartbeat, shared by
 * the account-offboarding pollers.
 *
 * Those pollers tick every 60s and almost always find nothing to do. Logging a
 * "Run complete" line on every idle tick floods the worker logs (5 pollers, once
 * a minute each) and buries real events. Instead a poller stays silent while
 * idle but emits one heartbeat at most every HEARTBEAT_INTERVAL_MS, so an
 * alive-but-idle loop is still observable and a stopped loop shows up as a
 * missing heartbeat. Errors and the boot "Starting" line are unaffected — only
 * the no-op success line is gated.
 *
 * State is per-process: each worker replica keeps its own clock, which is the
 * right granularity for liveness (a dead replica simply stops heart-beating). If
 * the worker is ever scaled past one replica and you need to tell their
 * heartbeats apart, add a replica id to the emitted line.
 */
const HEARTBEAT_INTERVAL_MS = 30 * 60_000; // 30 minutes

// key (a poller's LOG_PREFIX) -> wall-clock ms when it last emitted ANY line.
const lastLoggedAt = new Map<string, number>();

/**
 * Record that a poller logged a real work line this cycle. Call right after the
 * poller emits its own "did work" log, so the next heartbeat is a full interval
 * away instead of firing immediately after genuine activity.
 */
export function notePollerActivity(key: string, now: number = Date.now()): void {
  lastLoggedAt.set(key, now);
}

/**
 * Idle path: emit a single liveness heartbeat, but no more than once per
 * HEARTBEAT_INTERVAL_MS of continuous idle. The first idle tick for a cold key
 * starts the clock and stays silent — boot already logs "Starting", so a fresh
 * worker does not heartbeat-storm.
 */
export function maybeLogPollerHeartbeat(
  logger: WorkerLogger,
  key: string,
  now: number = Date.now(),
): void {
  const last = lastLoggedAt.get(key);
  if (last === undefined) {
    lastLoggedAt.set(key, now);
    return;
  }
  if (now - last >= HEARTBEAT_INTERVAL_MS) {
    logger.log('Idle heartbeat', { idle_min: Math.round((now - last) / 60_000) });
    lastLoggedAt.set(key, now);
  }
}

/** Test-only: clear all per-key idle clocks so cases don't leak state. */
export function __resetPollerHeartbeatState(): void {
  lastLoggedAt.clear();
}
