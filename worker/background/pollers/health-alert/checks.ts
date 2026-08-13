// Read-only health checks for the silent-failure / dropped-paid-work signals the
// beta-launch gate alerts on. Each check issues ONE query against confirmed
// schema and compares to an env-tunable threshold, returning HealthFinding(s) or
// null. No writes. Column references verified against supabase/migrations
// (job_outbox, notification_deliveries, flagged_responses, responses,
// inbound_events).
import type postgres from 'postgres';
import { getWorkerConfig } from '../../../../src/lib/config/worker';
import { QUEUE_NAMES } from '../../../../src/lib/shared/queue-names';
import {
  OUTBOX_COMPLETION_REASON,
  OWNER_UNREACHABLE_AGE_FLOOR_SECONDS,
} from '../../../../src/lib/shared/outbox-completion-reason';
import { queryBacklogDepth, BACKLOG_DEPTH_TABLES } from '../../../../src/lib/shared/backlog-depth';
import { toError } from '../../../../src/lib/shared/logger';
import { stalledThresholdMsForKind } from '../../../../src/lib/agents/read';
import type { AGENT_RUN_KINDS } from '../../../../src/lib/agents/run-spine';

export interface HealthFinding {
  key: string;
  level: 'warning' | 'error';
  title: string;
  detail: Record<string, unknown>;
}

export interface HealthAlertConfig {
  wedgedClientReadAgeS: number;
  wedgedClientReadThreshold: number;
  pendingAgeThresholdS: number;
  failedWindowS: number;
  failedThreshold: number;
  staleDispatchingThresholdS: number;
  flaggedOpenThreshold: number;
  zeroDeliveryWindowS: number;
  backlogDepthThreshold: number;
  ownerUnreachableAgeS: number;
  ownerUnreachableThreshold: number;
}

export function num(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveHealthAlertConfig(): HealthAlertConfig {
  const cfg = getWorkerConfig();
  return {
    wedgedClientReadAgeS: num(cfg.HEALTH_ALERT_WEDGED_CLIENT_READ_AGE_S, WEDGED_CLIENT_READ_AGE_DEFAULT_S),
    wedgedClientReadThreshold: num(cfg.HEALTH_ALERT_WEDGED_CLIENT_READ_THRESHOLD, 0),
    pendingAgeThresholdS: num(cfg.HEALTH_ALERT_PENDING_AGE_S, 900),
    failedWindowS: num(cfg.HEALTH_ALERT_FAILED_WINDOW_S, 3600),
    failedThreshold: num(cfg.HEALTH_ALERT_FAILED_THRESHOLD, 0),
    staleDispatchingThresholdS: num(cfg.HEALTH_ALERT_STALE_DISPATCHING_S, 600),
    flaggedOpenThreshold: num(cfg.HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD, 5),
    zeroDeliveryWindowS: num(cfg.HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S, 3600),
    backlogDepthThreshold: num(cfg.HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD, 1500),
    ownerUnreachableAgeS: num(cfg.HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S, OWNER_UNREACHABLE_AGE_FLOOR_SECONDS),
    ownerUnreachableThreshold: num(cfg.HEALTH_ALERT_OWNER_UNREACHABLE_THRESHOLD, 0),
  };
}

// Owner-impacting outbox topics that exhausted all retries (status='failed') —
// failed publish/notify jobs are customer-visible stalls, terminal response
// generation drops a paid draft, and terminal solicitation batch construction
// leaves the batch owner-hidden. Not transient blips.
//
// This is a CLOSED allowlist, so a new owner-impacting topic stays invisible
// until it is added here. `generate_solicitation_asks` shipped without it
// (#628 round 5), which silently voided that lane's dead-letter rationale:
// its terminal handler concedes the batch to "an operator will see the failed
// row", and nothing was watching the row.
export async function checkFailedOutboxByTopic(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding[]> {
  // Window on completed_at: markOutboxFailed sets completed_at = NOW() when a row
  // terminates, so a watchdog-terminated long-dispatched row (old dispatched_at)
  // is still inside the window by its failure time. (Codex review: window by
  // failure time, not dispatch time.)
  const rows = await sql<{ topic: string; count: number }[]>`
    SELECT topic, COUNT(*)::int AS count
    FROM job_outbox
    WHERE status = 'failed'
      AND topic IN (
        ${QUEUE_NAMES.PUBLISH_RESPONSE},
        ${QUEUE_NAMES.SEND_NOTIFICATION},
        ${QUEUE_NAMES.GENERATE_RESPONSE},
        ${QUEUE_NAMES.BUILD_SOLICITATION_BATCH},
        ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
      )
      AND COALESCE(completed_at, dispatched_at, available_at) > NOW() - make_interval(secs => ${cfg.failedWindowS})
    GROUP BY topic
  `;
  return rows
    .filter((r) => r.count > cfg.failedThreshold)
    .map((r) => ({
      key: `outbox_failed:${r.topic}`,
      level: 'error' as const,
      title: `${r.count} ${r.topic} job(s) exhausted retries and failed in the last ${cfg.failedWindowS}s`,
      detail: { topic: r.topic, count: r.count, window_s: cfg.failedWindowS },
    }));
}

// Oldest claimable pending row — a climbing age means dispatch is backed up or
// the OutboxPoller has stalled.
export async function checkOldestPendingOutbox(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding | null> {
  const [row] = await sql<{ age: number | null }[]>`
    SELECT EXTRACT(EPOCH FROM (NOW() - MIN(available_at)))::int AS age
    FROM job_outbox
    WHERE status = 'pending' AND available_at <= NOW()
  `;
  const age = row?.age ?? null;
  if (age === null || age <= cfg.pendingAgeThresholdS) return null;
  return {
    key: 'outbox_pending_age',
    level: 'warning',
    title: `Oldest claimable outbox row is ${age}s old (> ${cfg.pendingAgeThresholdS}s) — dispatch backed up or stalled`,
    detail: { oldest_age_s: age, threshold_s: cfg.pendingAgeThresholdS },
  };
}

// Rows stuck mid-dispatch far longer than the OutboxPoller watchdog's 2-min
// recovery window — a sign the watchdog itself isn't running.
export async function checkStaleDispatching(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM job_outbox
    WHERE status = 'dispatching'
      AND (dispatched_at IS NULL OR dispatched_at < NOW() - make_interval(secs => ${cfg.staleDispatchingThresholdS}))
  `;
  const count = row?.count ?? 0;
  if (count <= 0) return null;
  return {
    key: 'outbox_stale_dispatching',
    level: 'error',
    title: `${count} outbox row(s) stuck in 'dispatching' > ${cfg.staleDispatchingThresholdS}s — OutboxPoller watchdog may be down`,
    detail: { count, threshold_s: cfg.staleDispatchingThresholdS },
  };
}

// Unreviewed high-severity held drafts. A growing backlog means nobody is
// working /admin/flagged, so safe-but-held drafts never reach owners.
export async function checkOpenFlaggedResponses(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM flagged_responses WHERE status = 'open'
  `;
  const count = row?.count ?? 0;
  if (count <= cfg.flaggedOpenThreshold) return null;
  return {
    key: 'flagged_open_backlog',
    level: 'warning',
    title: `${count} unreviewed flagged responses (> ${cfg.flaggedOpenThreshold}) — admin disposition backlog at /admin/flagged`,
    detail: { count, threshold: cfg.flaggedOpenThreshold },
  };
}

// A send_notification job that COMPLETED but produced no delivery row at all —
// the owner was never told (e.g. no verified enrollment). Scoped to completed
// jobs so it never fires on the by-design suppression cases (Zernio backfill /
// high-severity moderation hold never enqueue a send_notification). Additionally
// filtered to responses that SHOULD still have been delivered — the response is
// still pending_approval and the business is live (Codex review): this excludes
// the worker's intentional skip paths (response superseded/posted, business
// archived/offboarding) which legitimately complete with no delivery row, while
// keeping the genuine "owner has no channel / never notified" signal.
// De-conflation (F1): rows whose latest completed send_notification carries the
// completion_reason='owner_unreachable' marker are the durable checkOwnerUnreachable
// signal — they are excluded here so a single owner-unreachable draft is not
// double-counted as a transient windowed zero-delivery error.
export async function checkZeroDeliveryNotifications(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM job_outbox jo
    JOIN responses r ON r.id = (jo.payload->>'response_id')::uuid
    JOIN businesses b ON b.id = r.business_id
    WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
      AND jo.status = 'completed'
      AND COALESCE(jo.completed_at, jo.dispatched_at, jo.available_at) > NOW() - make_interval(secs => ${cfg.zeroDeliveryWindowS})
      AND r.status = 'pending_approval'
      AND b.archived_at IS NULL
      AND jo.completion_reason IS DISTINCT FROM ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries nd
        WHERE nd.response_id = r.id
      )
  `;
  const count = row?.count ?? 0;
  if (count <= 0) return null;
  return {
    key: 'zero_delivery_notifications',
    level: 'error',
    title: `${count} completed approval notification(s) produced zero deliveries in the last ${cfg.zeroDeliveryWindowS}s — owners not told`,
    detail: { count, window_s: cfg.zeroDeliveryWindowS },
  };
}

// Durable owner-unreachable signal (F1). A pending_approval draft on a live
// business whose LATEST completed send_notification recorded
// completion_reason='owner_unreachable' (zero verified channel enrollments at
// send time) and that never got an approval_request delivery. Unlike the
// windowed checkZeroDeliveryNotifications, this is an AGE FLOOR, not a completion
// window: it keeps firing every cycle until the draft resolves (a real
// approval_request delivery clears it, or a later NULL-reason completion
// supersedes the marker). ORDER BY created_at DESC (NOT completed_at, which is
// nullable and would sort NULLs first); the '= owner_unreachable' comparison is
// NULL-safe so a later NULL-reason completion or no completion excludes the row.
// The approval_request-scoped NOT EXISTS means the admin-email delivery (a
// DIFFERENT template) cannot erase the signal. Uses migration 082 indexes
// (idx_responses_pending_approval_created, idx_jo_send_notification_by_aggregate).
export async function checkOwnerUnreachable(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.status = 'pending_approval'
      AND b.archived_at IS NULL
      AND r.created_at < NOW() - make_interval(secs => ${cfg.ownerUnreachableAgeS})
      AND (
        SELECT jo.completion_reason
        FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
          AND jo.aggregate_id = r.id
          AND jo.status = 'completed'
        ORDER BY jo.created_at DESC
        LIMIT 1
      ) = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE}
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries nd
        WHERE nd.response_id = r.id AND nd.template = 'approval_request'
      )
  `;
  const count = row?.count ?? 0;
  if (count <= cfg.ownerUnreachableThreshold) return null;
  return {
    key: 'owner_unreachable',
    level: 'warning',
    title: `${count} approval draft(s) have no verified owner channel (owner-unreachable > ${cfg.ownerUnreachableAgeS}s) — owners cannot be notified`,
    detail: { count, age_floor_s: cfg.ownerUnreachableAgeS },
  };
}

// Pending backlog depth per dispatch-queue table over the #474 capacity target
// (~1500 rows). A saturation warning — the 5s OutboxPoller normally drains it;
// a human should look, but it is not dropped work. Per-table independent findings.
export async function checkBacklogDepth(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding[]> {
  const depth = await queryBacklogDepth(sql);
  return BACKLOG_DEPTH_TABLES
    .filter((table) => depth[table] > cfg.backlogDepthThreshold)
    .map((table) => ({
      key: `backlog_depth:${table}`,
      level: 'warning' as const,
      title: `${table} backlog depth is ${depth[table]} pending rows (> ${cfg.backlogDepthThreshold}) — dispatch behind the ${cfg.backlogDepthThreshold}-row capacity target`,
      detail: { table, count: depth[table], threshold: cfg.backlogDepthThreshold },
    }));
}

// Inbound webhook events that failed processing. Provider-side retries
// (Stripe retries ~3 days) mask these — by the time the provider gives up,
// the bug has been silent for days. Grouped by (source, event_type): the
// event type is what identifies WHICH provider operation is failing (e.g.
// stripe/invoice.paid vs stripe/checkout.session.completed); source alone
// hides that. Uses the partial index idx_ie_status (WHERE status != 'processed').
export async function checkFailedInboundEvents(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding[]> {
  const rows = await sql<{ source: string; event_type: string; count: number }[]>`
    SELECT source, event_type, COUNT(*)::int AS count
    FROM inbound_events
    WHERE status = 'failed'
      AND received_at > NOW() - make_interval(secs => ${cfg.failedWindowS})
    GROUP BY source, event_type
  `;
  return rows
    .filter((r) => r.count > cfg.failedThreshold)
    .map((r) => ({
      key: `inbound_events_failed:${r.source}:${r.event_type}`,
      level: 'error' as const,
      title: `${r.count} inbound ${r.source} ${r.event_type} event(s) failed processing in the last ${cfg.failedWindowS}s`,
      detail: { source: r.source, event_type: r.event_type, count: r.count, window_s: cfg.failedWindowS },
    }));
}

// The send-batch parent kind this probe watches, typed against AGENT_RUN_KINDS so
// renaming the kind fails the build here rather than silently matching zero rows.
const SEND_BATCH_RUN_KIND: (typeof AGENT_RUN_KINDS)[number] = 'solicitation_send_batch';

// ONE owner for the 11-day number: stalledThresholdMsForKind (src/lib/agents/read.ts),
// which the owner timeline's `stalled` display state reads too. A send batch is
// bounded at 10 days BY CONSTRUCTION (7-day approval window + 72-hour send window),
// so a run past 11 days is genuinely wedged, not merely slow. Derived — never
// re-spelled — so a change to the kind→threshold mapping moves this probe with it.
const STALLED_SEND_BATCH_THRESHOLD_S = stalledThresholdMsForKind(SEND_BATCH_RUN_KIND) / 1000;
const STALLED_SEND_BATCH_THRESHOLD_DAYS = STALLED_SEND_BATCH_THRESHOLD_S / 86_400;

// A solicitation_send_batch parent run still 'running' past its construction
// bound — the drip never closed, so owner-approved asks are stuck unsent and the
// spine will never terminalize the run. Aggregate-only: one row by construction
// (no LIMIT needed), carrying the oldest wedged run id + its age so an operator
// can open the run directly. Detail is ids and durations only — never contact or
// review content. Served by the partial index on agent_runs (kind, subject_type,
// subject_id) WHERE status = 'running'.
export async function checkStalledSendBatches(sql: postgres.Sql): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number; oldest_run_id: string | null; oldest_age_s: number | null }[]>`
    SELECT
      COUNT(*)::int AS count,
      (ARRAY_AGG(id::text ORDER BY started_at))[1] AS oldest_run_id,
      MAX(EXTRACT(EPOCH FROM (NOW() - started_at))::int) AS oldest_age_s
    FROM agent_runs
    WHERE kind = ${SEND_BATCH_RUN_KIND}
      AND status = 'running'
      AND started_at < NOW() - make_interval(secs => ${STALLED_SEND_BATCH_THRESHOLD_S})
  `;
  const count = row?.count ?? 0;
  if (count <= 0) return null;
  return {
    key: 'solicitation_send_batch_stalled',
    level: 'error',
    title: `${count} solicitation send batch run(s) still running past ${STALLED_SEND_BATCH_THRESHOLD_DAYS} days — the drip never closed and approved asks are stuck unsent`,
    detail: {
      count,
      oldest_run_id: row?.oldest_run_id ?? null,
      oldest_age_s: row?.oldest_age_s ?? null,
      threshold_s: STALLED_SEND_BATCH_THRESHOLD_S,
    },
  };
}

/**
 * Default wedge age. Ten seconds is far above any legitimate ClientRead pause
 * and far below the shortest wedge ever observed (16.6s; the long one ran
 * 374.5s).
 */
export const WEDGED_CLIENT_READ_AGE_DEFAULT_S = 10;

/**
 * The #773 connection wedge, as a permanent signal.
 *
 * ALERTS ON AGE, NEVER ON PRESENCE. `wait_event='ClientRead'` on its own is
 * ordinary protocol behaviour — the server is simply waiting for the client's
 * next message — and it appeared constantly, at sub-100ms ages, throughout
 * clean staging runs (the step B measurement peaked at 0.056s across 1000+
 * samples). A presence check would page continuously and be turned off within a
 * day. What is pathological is a ClientRead that does not END: a query
 * pipelined onto a busy connection whose response parks server-side and never
 * returns, holding a client pool slot until the isolate is reaped.
 *
 * This check exists BECAUSE the admission chokepoint (src/lib/db/admission.ts)
 * cannot be proven complete by non-reproduction. If a wedge ever recurs — a new
 * un-gated client, a raw postgres.js client added somewhere, the kill switch
 * left off — this is what says so, instead of an owner reporting a hung page.
 *
 * `statement_timeout` cannot substitute: ClientRead is a WAIT state, not a
 * running statement, so the server timeout never fires on it (#773 fact 6).
 *
 * Cluster-wide by design: it reports wedges from ANY client against this
 * database — Vercel isolates included, which is where every observed wedge
 * happened — not just this worker's own pool.
 */
export async function checkWedgedClientRead(
  sql: postgres.Sql,
  cfg: HealthAlertConfig,
): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number; oldest_age_s: number | null }[]>`
    SELECT
      COUNT(*)::int AS count,
      MAX(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)))::int AS oldest_age_s
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND state = 'active'
      AND wait_event = 'ClientRead'
      AND clock_timestamp() - query_start > make_interval(secs => ${cfg.wedgedClientReadAgeS})
  `;
  const count = row?.count ?? 0;
  if (count <= cfg.wedgedClientReadThreshold) return null;
  return {
    key: 'db_connection_wedged',
    level: 'error',
    title:
      `${count} database session(s) stuck in state=active/wait_event=ClientRead for over ` +
      `${cfg.wedgedClientReadAgeS}s (oldest ${row?.oldest_age_s ?? 0}s) — the #773 connection ` +
      'wedge; a client pool slot is held and will not self-clear until that instance is reaped',
    detail: {
      count,
      oldest_age_s: row?.oldest_age_s ?? null,
      age_threshold_s: cfg.wedgedClientReadAgeS,
      threshold: cfg.wedgedClientReadThreshold,
    },
  };
}

export async function runHealthChecks(sql: postgres.Sql): Promise<HealthFinding[]> {
  const cfg = resolveHealthAlertConfig();
  const findings: HealthFinding[] = [];
  const collect = (result: HealthFinding[] | HealthFinding | null): void => {
    if (Array.isArray(result)) findings.push(...result);
    else if (result) findings.push(result);
  };

  // SEQUENTIAL, one query in flight at a time — do NOT re-introduce a Promise.all
  // of these queries here (#505). Firing them concurrently on ONE postgres.js
  // client over the Supabase Supavisor TRANSACTION pooler pipelines the extra
  // queries onto a shared connection; a pipelined query's response parks
  // server-side in state=active / wait_event=ClientRead and never returns — a
  // PERMANENT connection wedge every poller cycle on the max:2 health client.
  // Proven by the #505 staging differential repro (6/6 concurrent iterations
  // wedged vs 0/6 sequential). Sequential naturally preserves the core checks'
  // shared-fate: a core-check rejection propagates and fails the cycle, and the
  // poller's catch recycles the wedged-free client. See .claude/reference/lab-notes.md.
  // FIRST: a wedged connection is the failure that makes every other signal
  // below unreliable, so it is reported even if a later check throws.
  collect(await checkWedgedClientRead(sql, cfg));
  collect(await checkFailedOutboxByTopic(sql, cfg));
  collect(await checkOldestPendingOutbox(sql, cfg));
  collect(await checkStaleDispatching(sql, cfg));
  collect(await checkOpenFlaggedResponses(sql, cfg));
  collect(await checkZeroDeliveryNotifications(sql, cfg));
  collect(await checkOwnerUnreachable(sql, cfg));
  collect(await checkFailedInboundEvents(sql, cfg));
  collect(await checkStalledSendBatches(sql));

  // Isolate the backlog check: it reads the DB precisely when the DB is under
  // pressure, so its rejection must NOT fail the whole cycle and suppress the
  // critical findings above. A failure degrades to a diagnostic warning finding
  // instead (adversarial-review F-medium) — preserved exactly from the prior
  // `.catch(...)` behavior, now expressed as a try/catch around this one call.
  try {
    collect(await checkBacklogDepth(sql, cfg));
  } catch (err) {
    findings.push({
      key: 'health_check_error:backlog_depth',
      level: 'warning',
      title: `Backlog depth check failed: ${toError(err).message}`,
      detail: { check: 'backlog_depth' },
    });
  }

  return findings;
}
