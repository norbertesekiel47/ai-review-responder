// Read-only health checks for the silent-failure / dropped-paid-work signals the
// beta-launch gate alerts on. Each check issues ONE query against confirmed
// schema and compares to an env-tunable threshold, returning HealthFinding(s) or
// null. No writes. Column references verified against supabase/migrations
// (job_outbox, notification_deliveries, flagged_responses, responses,
// inbound_events).
import type postgres from 'postgres';
import { getWorkerConfig } from '../../../../src/lib/config/worker';
import { QUEUE_NAMES } from '../../../../src/lib/shared/queue-names';
import { queryBacklogDepth, BACKLOG_DEPTH_TABLES } from '../../../../src/lib/shared/backlog-depth';
import { toError } from '../../../../src/lib/shared/logger';

export interface HealthFinding {
  key: string;
  level: 'warning' | 'error';
  title: string;
  detail: Record<string, unknown>;
}

export interface HealthAlertConfig {
  pendingAgeThresholdS: number;
  failedWindowS: number;
  failedThreshold: number;
  staleDispatchingThresholdS: number;
  flaggedOpenThreshold: number;
  zeroDeliveryWindowS: number;
  backlogDepthThreshold: number;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveHealthAlertConfig(): HealthAlertConfig {
  const cfg = getWorkerConfig();
  return {
    pendingAgeThresholdS: num(cfg.HEALTH_ALERT_PENDING_AGE_S, 900),
    failedWindowS: num(cfg.HEALTH_ALERT_FAILED_WINDOW_S, 3600),
    failedThreshold: num(cfg.HEALTH_ALERT_FAILED_THRESHOLD, 0),
    staleDispatchingThresholdS: num(cfg.HEALTH_ALERT_STALE_DISPATCHING_S, 600),
    flaggedOpenThreshold: num(cfg.HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD, 5),
    zeroDeliveryWindowS: num(cfg.HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S, 3600),
    backlogDepthThreshold: num(cfg.HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD, 1500),
  };
}

// Public-path outbox topics that exhausted all retries (status='failed') — a
// failed publish/notify is a customer-visible stall, and a terminal
// generate_response failure is a dropped paid draft. Not transient blips.
export async function checkFailedOutboxByTopic(sql: postgres.Sql, cfg: HealthAlertConfig): Promise<HealthFinding[]> {
  // Window on completed_at: markOutboxFailed sets completed_at = NOW() when a row
  // terminates, so a watchdog-terminated long-dispatched row (old dispatched_at)
  // is still inside the window by its failure time. (Codex review: window by
  // failure time, not dispatch time.)
  const rows = await sql<{ topic: string; count: number }[]>`
    SELECT topic, COUNT(*)::int AS count
    FROM job_outbox
    WHERE status = 'failed'
      AND topic IN (${QUEUE_NAMES.PUBLISH_RESPONSE}, ${QUEUE_NAMES.SEND_NOTIFICATION}, ${QUEUE_NAMES.GENERATE_RESPONSE})
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
  collect(await checkFailedOutboxByTopic(sql, cfg));
  collect(await checkOldestPendingOutbox(sql, cfg));
  collect(await checkStaleDispatching(sql, cfg));
  collect(await checkOpenFlaggedResponses(sql, cfg));
  collect(await checkZeroDeliveryNotifications(sql, cfg));
  collect(await checkFailedInboundEvents(sql, cfg));

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
