// Alert emission for the HealthAlertPoller. Findings route to Sentry
// (captureMessage) — the mandatory NON-EMAIL paging route (Sentry → Slack/
// PagerDuty), since admin email shares the Resend provider with the product.
// The probe's own liveness is a Sentry Cron check-in (dead-man switch): if the
// poller dies, the missed check-in pages even though nothing threw.
import * as Sentry from '@sentry/node';
import { getWorkerConfig } from '../../../../src/lib/config/worker';
import type { HealthFinding } from './checks';

export function emitHealthFindings(findings: HealthFinding[]): void {
  for (const finding of findings) {
    Sentry.captureMessage(finding.title, {
      level: finding.level,
      tags: { subsystem: 'health_alert', finding: finding.key },
      extra: finding.detail,
    });
  }
}

export function recordProbeCheckIn(status: 'ok' | 'error', intervalMs: number): void {
  // Pass an upsert monitorConfig so Sentry auto-creates/updates the cron monitor
  // on check-in — without it, check-ins for a not-yet-existing monitor are
  // silently dropped (which is why the monitor never appeared). A *crontab*
  // schedule is required: Sentry rejects sub-hour `interval` schedules ("invalid
  // schedule on unit count"). `*/N * * * *` mirrors the poller's own cadence
  // (intervalMs, owned by HealthAlertPoller); one cycle of margin absorbs jitter
  // before the dead-man switch pages.
  const intervalMinutes = Math.max(1, Math.min(59, Math.round(intervalMs / 60_000)));
  const probeMonitorSlug = getWorkerConfig().HEALTH_ALERT_MONITOR_SLUG || 'health-alert-poller';
  Sentry.captureCheckIn(
    { monitorSlug: probeMonitorSlug, status },
    {
      schedule: { type: 'crontab', value: `*/${intervalMinutes} * * * *` },
      checkinMargin: intervalMinutes,
      timezone: 'UTC',
    },
  );
}
