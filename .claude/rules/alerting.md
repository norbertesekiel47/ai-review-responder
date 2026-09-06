---
paths:
  - "worker/background/pollers/health-alert/**"
  - "worker/background/pollers/HealthAlertPoller.ts"
  - "worker/sentry.ts"
  - "worker/config/startup-assert.ts"
---

# Alerting rules

## Read first

- Worker health alerting, the `HealthAlertPoller`, the `SENTRY_DSN` boot gate (`assertAlertSinkEnv`): runbook `docs/runbooks/beta-launch-alerting.md` + ADR `docs/adr/0005-beta-launch-posture.md` + `worker/background/pollers/health-alert/`.
- Lab notes: `.claude/reference/lab-notes/worker-startup-sentry.md` (startup asserts early-return unless `NODE_ENV==='production'`; unlistened EventEmitter `'error'` is fatal), `.claude/reference/lab-notes/worker-crash-net-cost-guard.md`.
- File map: `docs/directory/worker-background.md` (health-alert/), `docs/directory/worker-root.md` (`sentry.ts`, `config/startup-assert.ts`, `emitter-errors.ts`, `job-failure-sink.ts`).
- The sink conventions (Sentry init + scrubber, emitter `'error'` sink, terminal job-failure sink, single-replica registry) are in `.claude/rules/worker-layout.md`.

## Traps

- No trap clauses were moved from `.claude/CLAUDE.md` for this area; the worker-wide traps (single-replica registry paging via `HealthAlertPoller`, best-effort work needing its own `try/catch`) are in `.claude/rules/worker-layout.md`.

## Rules

- Nothing was moved from `.claude/CLAUDE.md`.
