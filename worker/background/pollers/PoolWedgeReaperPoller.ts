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
// a boot-time async direct-route self-check that DISABLES + Sentry-alerts rather
// than ever falling back to the pooler, and a per-sweep op-timeout that recycles
// the reaper's own client if it wedges.
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
  // Default ON: the reaper is a safety backstop, so unset/blank means enabled;
  // only an explicit non-'true' value (e.g. 'false') disables it.
  if (raw === undefined || raw === '') return true;
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
let reaperSql: ReaperClient | null = null;
let isPolling = false;
let disabled = false;

/**
 * Genuine runtime direct-route check: a direct :5432 route echoes the
 * application_name we connected with; Supavisor swallows it to 'Supavisor'. Only
 * an exact echo counts as verified-direct.
 */
async function isVerifiedDirect(client: ReaperClient): Promise<boolean> {
  const [row] = await client<{ app_name: string }[]>`
    SELECT current_setting('application_name') AS app_name
  `;
  return row?.app_name === REAPER_APP_NAME;
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

/** end+rebuild the reaper's own client — used when a sweep times out (the
 *  reaper connection itself may have wedged). Rebuilds UNCONDITIONALLY even if
 *  the old end hangs/rejects, so the next cycle gets a fresh connection. */
async function recycleReaperClient(logger: ReturnType<typeof createWorkerLogger>): Promise<void> {
  const old = reaperSql;
  const url = resolveDirectUrl();
  reaperSql = url ? buildReaperClient(url) : null; // rebuild first — never leave the loop clientless
  if (!old) return;
  try {
    await withTimeout(old.end({ timeout: 1 }), 2_000, 'reaper-client-end');
  } catch (err) {
    logger.warn('Reaper client end during recycle failed (rebuilt anyway)', toError(err));
  }
}

export async function pollPoolWedgeReaper(): Promise<void> {
  if (disabled || isPolling || !reaperSql) return; // single-flight + fail-safe gates
  isPolling = true;
  const logger = createWorkerLogger(LOG_PREFIX);
  const client = reaperSql;
  try {
    await withTimeout(runSweep(client, logger), readOpTimeoutMs(), 'pool-wedge-reaper-sweep');
  } catch (err) {
    logger.error('Pool wedge reaper sweep failed', toError(err));
    // A wedged reaper connection would time out every cycle; recycle so the next
    // cycle runs on a fresh client. Any non-timeout error is log-swallowed too —
    // best-effort, never crash the worker.
    if (err instanceof TimeoutError) await recycleReaperClient(logger);
  } finally {
    isPolling = false;
  }
}

/**
 * Async bootstrap: build the dedicated client, verify it routes genuinely
 * direct, and only then schedule the loop. On an absent URL or a failed echo it
 * DISABLES + Sentry-alerts and never falls back to the pooler. Exported so tests
 * can await the (otherwise fire-and-forget) bootstrap deterministically.
 */
export async function initPoolWedgeReaper(): Promise<void> {
  const logger = createWorkerLogger(LOG_PREFIX);
  const url = resolveDirectUrl();
  if (!url) {
    disableWithAlert(logger, 'no DIRECT_URL / DATABASE_URL configured');
    return;
  }
  reaperSql = buildReaperClient(url);
  let verified = false;
  try {
    verified = await withTimeout(isVerifiedDirect(reaperSql), readOpTimeoutMs(), 'reaper-direct-verify');
  } catch (err) {
    logger.error('Direct-route verification errored', toError(err));
  }
  if (!verified) {
    disableWithAlert(logger, 'application_name did not echo back — routed through Supavisor or unreachable');
    await closeReaperClient();
    return;
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
 * End the dedicated reaper client. Exported and ready for the shutdown path, but
 * NOT yet wired into worker/index.ts's `closeDb` step — a later integration task
 * awaits this alongside health's `closeHealthSql()`. Best-effort: a failing end
 * must not block shutdown.
 */
// fallow-ignore-next-line unused-export
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
