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
- **A runbook rule is a REQUIREMENT, not a live alert, and a regex pin over its prose cannot catch a negation.** Rules 1, 11, 16, 17 and 18 in `docs/runbooks/beta-launch-alerting.md` are written but unconfigured in Sentry — check the §1 box before treating any of them as a page. A test pinning such a row to exported constants must assert POSITION (which cell, which sentence, found by column header); even then every pinned substring survives a `do **not**` prefix, which is why #1414 asks for a machine-readable record instead. The pin for rules 16–18 lives in `worker/jobs/account-offboarding/__tests__/failure-alert.test.ts` and parses the cells inside each test, so a malformed block fails a named test rather than collection. Story: lab-notes/false-coverage-mutation.md Summary + history/2026-09-19-to-30.md (2026-09-21, #1417).
- **A change that moves rows into a terminal state can delete the only alert watching them.** Before merging, name what watched the rows before and what watches them after; a closed allowlist beside a newly-opened terminal path is a regression (#1378). A closed list that stays closed is typed over its whole domain so a new member fails typecheck (`OFFBOARDING_STAGE_TOPICS` in `src/lib/account-offboarding/outbox.ts`, #1395). Terminal-path → signal inventory: the runbook's "Failed outbox rows, every topic" box. Story: lab-notes/history/2026-09-19-to-30.md (2026-09-20).

## Rules

- Nothing was moved from `.claude/CLAUDE.md`.
