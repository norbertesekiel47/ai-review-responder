// PoolWedgeReaperPoller — the out-of-band backstop for the pool-wedge self-heal
// (#500). A slow-cadence loop on its OWN dedicated, runtime-verified-DIRECT
// connection that bypasses the Supavisor pooler and server-side-kills any
// backend stuck in the wedge signature (active + ClientRead beyond the age
// threshold, query begins with the cooperative `/* rw-reapable */` marker).
//
// It is a backstop, not the primary fix: the in-process health-poller self-heal
// (T2) usually reclaims the wedge first via client-side end+rebuild. The reaper
// exists for the case where that FIN never lands or the poller's event loop is
// itself starved — a distinct failure domain, so it runs on a separate
// connection and its own timer.
//
// Structure mirrors HealthAlertPoller precisely: single-flight `isPolling`
// guard, setInterval cadence, createWorkerLogger, config read at runtime, and
// catch-and-swallow — a reaper failure must NEVER crash the worker or flip a job
// to failed (production.md log-and-swallow). Divergences from HealthAlertPoller:
// a direct-route self-check that DISABLES + Sentry-alerts rather than ever
// falling back to the pooler, and a per-sweep op-timeout that recycles the
// reaper's own client if it wedges.
//
// LIFECYCLE INVARIANT: the reaper only ever runs a sweep on a verified-direct
// connection — at boot, in steady state, AND after a recycle. Verification is
// unified behind `acquireVerifiedClient`, which returns a THREE-way outcome so
// boot and every re-acquire distinguish a *definitive* non-direct route from a
// merely *transient* verify failure:
//   - 'verified'  → run on this client.
//   - 'pooler'    → application_name echoed back a non-matching value: a proven
//                   Supavisor route → PERMANENT disable + Sentry alert.
//   - 'transient' → the verify threw/timed out (indeterminate) → do NOT disable;
//                   re-acquire on the next poll. The poll cadence IS the retry
//                   backoff — no separate jittered retry loop, matching the
//                   poller precedent (design.md: fewer moving parts). A boot-time
//                   DB blip therefore defers, it does not lose the backstop.
// Permanent disable happens ONLY on a definitive pooler route or absent config
// (env is immutable after boot); transient errors always retry on the cadence.
import * as Sentry from '@sentry/node';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { createDedicatedPostgresClient } from '../../../src/lib/db/server';
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';
import { TimeoutError, withTimeout } from '../../../src/lib/shared/with-timeout';
import { selectTerminations } from './pool-wedge-reaper/select-terminations';
import {
  REAPER_APP_NAME,
  selectWedgeCandidates,
  terminateWedges,
} from './pool-wedge-reaper/reaper-query';

const LOG_PREFIX = '[PoolWedgeReaperPoller]';

// ── runtime config reads (NOT at import — convention #4; worker env is immutable
//    after boot, so these return the same value a once-at-import const would) ──
function readEnabled(): boolean {
  const raw = getWorkerConfig().POOL_WEDGE_REAPER_ENABLED?.trim();
  // Default OFF: the ticket #500 brief ships the reaper DORMANT — it has never
  // performed a live termination, so arming it is an explicit operator opt-in
  // (review finding on PR #502: an unset env var must not arm a backstop that
  // terminates backends).
  return raw === 'true';
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readIntervalMs(): number {
  return readPositiveInt(getWorkerConfig().POOL_WEDGE_REAPER_INTERVAL_MS, 60_000);
}
function readAgeThresholdS(): number {
  return readPositiveInt(getWorkerConfig().POOL_WEDGE_REAPER_AGE_S, 300);
}
function readMaxPerSweep(): number {
  return readPositiveInt(getWorkerConfig().POOL_WEDGE_REAPER_MAX_PER_SWEEP, 3);
}
function readOpTimeoutMs(): number {
  return readPositiveInt(getWorkerConfig().POOL_WEDGE_REAPER_OP_TIMEOUT_MS, 8_000);
}

/** DIRECT_URL ?? DATABASE_URL — the reaper's preferred non-pooler route. The
 *  cheap host/port hint is intentionally skipped: the app_name echo below is the
 *  authoritative direct-route proof, so a heuristic pre-filter would only add a
 *  second, weaker source of truth. */
function resolveDirectUrl(): string | undefined {
  const cfg = getWorkerConfig();
  return cfg.DIRECT_URL?.trim() || cfg.DATABASE_URL?.trim() || undefined;
}

type ReaperClient = ReturnType<typeof createDedicatedPostgresClient>;

function buildReaperClient(url: string): ReaperClient {
  return createDedicatedPostgresClient(url, {
    max: 2,
    connection: { statement_timeout: 5_000, application_name: REAPER_APP_NAME },
  });
}

// ── module state ────────────────────────────────────────────────────────────
let pollerInterval: ReturnType<typeof setInterval> | null = null;
let transientVerifyWarned = false;
let reaperSql: ReaperClient | null = null;
let isPolling = false;
let disabled = false;

/**
 * The three-way result of building + verifying a candidate reaper client. The
 * key distinction (F1): a query that RETURNS a non-matching application_name is a
 * *definitive* pooler route ('pooler'); a query that THROWS/times out is
 * *indeterminate* ('transient') and must be retried, not treated as a proven
 * pooler.
 */
type AcquireOutcome =
  | { status: 'verified'; client: ReaperClient }
  | { status: 'pooler' }
  | { status: 'transient' };

/** Best-effort end for a client we're discarding (verify failed or routed
 *  through the pooler). A failing end must never mask the acquire outcome. */
async function endQuietly(client: ReaperClient): Promise<void> {
  try {
    await client.end({ timeout: 1 });
  } catch {
    // discarding this client regardless — nothing to recover, nothing to log
  }
}

/**
 * Build a dedicated client and verify it routes genuinely direct: a direct :5432
 * route echoes back the application_name we connected with, while Supavisor
 * swallows it to 'Supavisor'. Only an exact echo counts as verified-direct.
 *
 * This is the SINGLE verification path used by both boot and every re-acquire,
 * so the lifecycle invariant holds everywhere. Callers own the absent-URL case
 * (a permanent disable — env is immutable after boot); acquire assumes a URL and
 * guards defensively.
 */
async function acquireVerifiedClient(
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<AcquireOutcome> {
  const url = resolveDirectUrl();
  if (!url) return { status: 'transient' }; // defensive — callers gate on this first
  const client = buildReaperClient(url);
  try {
    const [row] = await withTimeout(
      client<{ app_name: string }[]>`SELECT current_setting('application_name') AS app_name`,
      readOpTimeoutMs(),
      'reaper-direct-verify',
    );
    if (row?.app_name === REAPER_APP_NAME) {
      return { status: 'verified', client }; // keep this client — it's the one we sweep on
    }
    // A row came back but application_name was not echoed: a DEFINITIVE non-direct
    // route (Supavisor → 'Supavisor', or any other value). Permanent-disable-worthy.
    await endQuietly(client);
    return { status: 'pooler' };
  } catch (err) {
    // Thrown/timed-out verify is INDETERMINATE — a transient DB/network blip must
    // not be mistaken for a proven pooler route (F1). Retry on the next poll.
    await endQuietly(client);
    if (!transientVerifyWarned) {
      transientVerifyWarned = true;
      logger.warn(
        'Direct-route verification errored (will retry; further occurrences suppressed — expected on Railway, whose IPv4 egress cannot reach the direct route)',
        toError(err),
      );
    }
    return { status: 'transient' };
  }
}

function disableWithAlert(logger: ReturnType<typeof createWorkerLogger>, reason: string): void {
  disabled = true;
  logger.error('Disabled — will not run on the pooler it is meant to heal', { reason });
  // Own warning, decoupled from the health-alert route (tag subsystem).
  Sentry.captureMessage('PoolWedgeReaperPoller disabled: no verified-direct route', {
    level: 'warning',
    tags: { subsystem: 'pool_wedge_reaper' },
    extra: { reason },
  });
}

/**
 * One sweep: fetch candidates, decide (pure), terminate the survivors. Bounded
 * by the caller's op-timeout; every kill logs + emits a warning-level finding.
 */
async function runSweep(
  client: ReaperClient,
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  const ageThresholdS = readAgeThresholdS();
  const cap = readMaxPerSweep();
  const candidates = await selectWedgeCandidates(client, ageThresholdS);
  const { targets, droppedCount } = selectTerminations(candidates, { ageThresholdS, cap });
  if (droppedCount > 0) {
    logger.warn('Wedge candidates exceeded per-sweep cap', { cap, dropped: droppedCount });
  }
  if (targets.length === 0) return;
  const outcomes = await terminateWedges(client, targets, ageThresholdS);
  for (const outcome of outcomes) {
    if (!outcome.terminated) continue;
    const candidate = candidates.find((c) => c.pid === outcome.pid);
    logger.warn('Terminated wedged backend', { pid: outcome.pid, age_s: candidate?.ageS });
    Sentry.captureMessage('PoolWedgeReaperPoller terminated a wedged backend', {
      level: 'warning',
      tags: { subsystem: 'pool_wedge_reaper' },
      extra: { pid: outcome.pid, age_s: candidate?.ageS, backend_start: candidate?.backendStart },
    });
  }
}

/** end+null the reaper's own client — used when a sweep times out (the reaper
 *  connection itself may have wedged). It deliberately does NOT rebuild: the next
 *  poll re-acquires through `acquireVerifiedClient`, so a recycled client is
 *  re-verified before it is ever swept on (F2 — a post-recycle route change can
 *  never leak a Supavisor connection into a sweep). */
async function recycleReaperClient(logger: ReturnType<typeof createWorkerLogger>): Promise<void> {
  const old = reaperSql;
  reaperSql = null; // next tick re-acquires + re-verifies
  if (!old) return;
  try {
    await withTimeout(old.end({ timeout: 1 }), 2_000, 'reaper-client-end');
  } catch (err) {
    logger.warn('Reaper client end during recycle failed', toError(err));
  }
}

export async function pollPoolWedgeReaper(): Promise<void> {
  if (disabled || isPolling) return; // single-flight + permanent-disable gate
  isPolling = true;
  const logger = createWorkerLogger(LOG_PREFIX);
  try {
    // Acquire-on-demand: boot may have deferred (transient), or a recycle may have
    // nulled the client. Re-verify before sweeping so the lifecycle invariant holds.
    if (!reaperSql) {
      if (!resolveDirectUrl()) {
        disableWithAlert(logger, 'no DIRECT_URL / DATABASE_URL configured');
        return;
      }
      const outcome = await acquireVerifiedClient(logger);
      if (outcome.status === 'pooler') {
        disableWithAlert(logger, 'application_name did not echo back — routed through Supavisor');
        return;
      }
      if (outcome.status === 'transient') return; // fail-closed; retry next tick
      reaperSql = outcome.client;
      logger.log('Verified-direct route acquired');
    }
    const client = reaperSql;
    await withTimeout(runSweep(client, logger), readOpTimeoutMs(), 'pool-wedge-reaper-sweep');
  } catch (err) {
    logger.error('Pool wedge reaper sweep failed', toError(err));
    // A wedged reaper connection would time out every cycle; recycle so the next
    // cycle re-acquires a fresh, re-verified client. Any non-timeout error is
    // log-swallowed too — best-effort, never crash the worker.
    if (err instanceof TimeoutError) await recycleReaperClient(logger);
  } finally {
    isPolling = false;
  }
}

/**
 * Async bootstrap: acquire a verified-direct client and schedule the loop.
 * PERMANENT disable (+ Sentry alert) only on an absent URL (env-immutable) or a
 * DEFINITIVE pooler route; a TRANSIENT verify failure defers — the loop is still
 * scheduled and re-acquires on the next tick (F1). Exported so tests can await
 * the (otherwise fire-and-forget) bootstrap deterministically.
 */
export async function initPoolWedgeReaper(): Promise<void> {
  const logger = createWorkerLogger(LOG_PREFIX);
  if (!resolveDirectUrl()) {
    disableWithAlert(logger, 'no DIRECT_URL / DATABASE_URL configured');
    return;
  }
  const outcome = await acquireVerifiedClient(logger);
  if (outcome.status === 'pooler') {
    disableWithAlert(logger, 'application_name did not echo back — routed through Supavisor');
    return; // permanent — never schedule a loop that would run on the pooler
  }
  if (outcome.status === 'verified') {
    reaperSql = outcome.client;
    logger.log('Verified-direct route acquired at boot');
  } else {
    // transient: defer, do NOT disable — the poll loop re-acquires next tick.
    logger.warn('Direct-route verification deferred (transient error at boot) — will retry on the loop');
  }
  const intervalMs = readIntervalMs();
  logger.log('Starting', { interval_ms: intervalMs });
  pollPoolWedgeReaper().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    pollPoolWedgeReaper().catch(logUnhandledPollError(LOG_PREFIX));
  }, intervalMs);
}

export function startPoolWedgeReaperPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  if (!readEnabled()) {
    logger.log('Skipped — POOL_WEDGE_REAPER_ENABLED is not "true"');
    return;
  }
  // Fire-and-forget the async bootstrap (verification connects to the DB); the
  // interval is scheduled inside it once the route is verified-direct.
  initPoolWedgeReaper().catch(logUnhandledPollError(LOG_PREFIX));
}

export function stopPoolWedgeReaperPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}

/**
 * End the dedicated reaper client. Wired into worker/index.ts's `closeDb` step
 * via `closeAllPostgresClients([closeReaperClient, closeHealthSql])`, which
 * closes both dedicated clients (best-effort) before the shared pool. Best-effort:
 * a failing end must not block shutdown.
 */
export async function closeReaperClient(): Promise<void> {
  const client = reaperSql;
  reaperSql = null;
  if (!client) return;
  try {
    await client.end({ timeout: 5 });
  } catch {
    // best-effort — shutdown proceeds regardless
  }
}
