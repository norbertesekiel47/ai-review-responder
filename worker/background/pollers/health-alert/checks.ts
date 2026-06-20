// Read-only health checks for the silent-failure / dropped-paid-work signals the
// beta-launch gate alerts on. Each check issues ONE query against confirmed
// schema and compares to an env-tunable threshold, returning HealthFinding(s) or
// null. No writes. Column references verified against supabase/migrations
// (job_outbox, notification_deliveries, flagged_responses, responses).
import { sql } from '../../../../src/lib/db/server';

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
}

function num(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveHealthAlertConfig(): HealthAlertConfig {
  return {
    pendingAgeThresholdS: num(process.env.HEALTH_ALERT_PENDING_AGE_S, 900),
    failedWindowS: num(process.env.HEALTH_ALERT_FAILED_WINDOW_S, 3600),
    failedThreshold: num(process.env.HEALTH_ALERT_FAILED_THRESHOLD, 0),
    staleDispatchingThresholdS: num(process.env.HEALTH_ALERT_STALE_DISPATCHING_S, 600),
    flaggedOpenThreshold: num(process.env.HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD, 5),
    zeroDeliveryWindowS: num(process.env.HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S, 3600),
  };
}

// Public-path outbox topics that exhausted all retries (status='failed') — a
// failed publish/notify is a customer-visible stall, not a transient blip.
export async function checkFailedOutboxByTopic(cfg: HealthAlertConfig): Promise<HealthFinding[]> {
  // Window on completed_at: markOutboxFailed sets completed_at = NOW() when a row
  // terminates, so a watchdog-terminated long-dispatched row (old dispatched_at)
  // is still inside the window by its failure time. (Codex review: window by
  // failure time, not dispatch time.)
  const rows = await sql<{ topic: string; count: number }[]>`
    SELECT topic, COUNT(*)::int AS count
    FROM job_outbox
    WHERE status = 'failed'
      AND topic IN ('publish_response', 'send_notification')
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
export async function checkOldestPendingOutbox(cfg: HealthAlertConfig): Promise<HealthFinding | null> {
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
export async function checkStaleDispatching(cfg: HealthAlertConfig): Promise<HealthFinding | null> {
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
export async function checkOpenFlaggedResponses(cfg: HealthAlertConfig): Promise<HealthFinding | null> {
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
export async function checkZeroDeliveryNotifications(cfg: HealthAlertConfig): Promise<HealthFinding | null> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM job_outbox jo
    JOIN responses r ON r.id = (jo.payload->>'response_id')::uuid
    JOIN businesses b ON b.id = r.business_id
    WHERE jo.topic = 'send_notification'
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

export async function runHealthChecks(): Promise<HealthFinding[]> {
  const cfg = resolveHealthAlertConfig();
  const results = await Promise.all([
    checkFailedOutboxByTopic(cfg),
    checkOldestPendingOutbox(cfg),
    checkStaleDispatching(cfg),
    checkOpenFlaggedResponses(cfg),
    checkZeroDeliveryNotifications(cfg),
  ]);
  const findings: HealthFinding[] = [];
  for (const result of results) {
    if (Array.isArray(result)) findings.push(...result);
    else if (result) findings.push(result);
  }
  return findings;
}
