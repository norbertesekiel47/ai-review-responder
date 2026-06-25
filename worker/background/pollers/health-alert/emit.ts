// Alert emission for the HealthAlertPoller. Findings route to Sentry
// (captureMessage) — the mandatory NON-EMAIL paging route (Sentry → Slack/
// PagerDuty), since admin email shares the Resend provider with the product.
// The probe's own liveness is a Sentry Cron check-in (dead-man switch): if the
// poller dies, the missed check-in pages even though nothing threw.
import * as Sentry from '@sentry/node';
import type { HealthFinding } from './checks';

const PROBE_MONITOR_SLUG = process.env.HEALTH_ALERT_MONITOR_SLUG || 'health-alert-poller';

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
  // Pass an upsert monitorConfig so Sentry auto-creates the cron monitor on the
  // first check-in — without it, check-ins for a not-yet-existing monitor are
  // silently dropped (which is why the monitor never appeared). The schedule
  // mirrors the poller's own cadence (intervalMs, owned by HealthAlertPoller) so
  // a missed cycle is flagged; one cycle of margin absorbs jitter before the
  // dead-man switch pages.
  const intervalMinutes = Math.max(1, Math.round(intervalMs / 60_000));
  Sentry.captureCheckIn(
    { monitorSlug: PROBE_MONITOR_SLUG, status },
    {
      schedule: { type: 'interval', value: intervalMinutes, unit: 'minute' },
      checkinMargin: intervalMinutes,
      timezone: 'UTC',
    },
  );
}
