---
paths:
  - "src/lib/account-offboarding/**"
  - "worker/jobs/account-offboarding/**"
  - "worker/background/pollers/AccountOffboarding*.ts"
  - "src/app/api/admin/offboardings/**"
---

# Owner offboarding rules

## Read first

- Spec `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md` (cancel_only / delete_data / purge) + runbook `docs/runbooks/owner-offboarding-staging-dry-run.md`.
- Lab notes: `.claude/reference/lab-notes/owner-offboarding.md` (the purge VERIFIER is a gate, not a report; keep-my-data exemptions; `purge_after` trigger).
- File map: `docs/directory/lib-account-offboarding.md` § `account-offboarding/`; `docs/directory/worker-jobs-*.md` (account-offboarding/); `docs/directory/worker-background.md` (the offboarding pollers).
- Skill `outbox-pattern`: every offboarding transition pairs its state change with its `job_outbox` row in one transaction.

## Traps

- No trap clauses were moved from `.claude/CLAUDE.md` for this area; the mechanics and traps are in the lab-notes topic page above.
- **A terminally failed purge has NO recovery path and is an unmet deletion obligation (#1016 / #1411).** `validatePurgeableOffboarding`, `AccountOffboardingPurgePoller` and `shouldTransitionToPurgeScheduled` all disqualify a `status='failed'` / `failed_step='purge'` row, and there is no per-stage checkpoint — the account holds live PII. `alertPurgeFailure` fingerprints terminal failures per offboarding (`PURGE_TERMINAL_FINGERPRINT_PREFIX`) so one account never suppresses another's page, but **runbook rule 16 is written, not configured** and the terminal path deliberately returns without throwing, so `attachJobFailureSink` never fires for it. Three sibling paths raise no `terminal:true` event (#1413) and two sibling workers keep the old shared-issue shape (#1412). Details: `docs/runbooks/beta-launch-alerting.md` rule 16.
- Invariant #11 (subscription guard; Stripe is the source of truth via `worker/ingress/stripe/apply-subscription-state.ts`) and the audit-write rule (`writeAccountAuditLog` in the SAME transaction) stay in `.claude/CLAUDE.md`.

## Rules

- Nothing was moved from `.claude/CLAUDE.md`.
