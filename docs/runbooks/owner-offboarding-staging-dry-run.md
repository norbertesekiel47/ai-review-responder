# Owner Offboarding Staging Dry-Run

## Scope

PR7 Task 7.2. Prove the whole owner-offboarding feature end-to-end on the
persistent **staging** stack before `ACCOUNT_OFFBOARDING_ENABLED=true` is ever
set in production. Staging is the only non-prod lane where the full pipeline
(Railway worker + queues + webhooks + separate Supabase) runs, so it is the only
place the teardown/purge workers and pollers can be exercised.

This runbook is also the evidence record. Fill the **Result** / **Observed**
fields while running; do not pre-fill them. Production enablement (Task 7.3) is
gated on this record plus the legal launch gate being complete.

> Destructive purge is exercised **only** on disposable staging test accounts
> with a shortened purge window. Never run destructive purge against a real
> customer account, in any environment.

## 1. Preconditions

Confirm each before starting. Check the box and record the value/evidence.

- [ ] **Migrations applied to the staging Supabase project, staging-first**:
      `056_account_offboarding.sql`, `057_account_offboarding_tombstone_nullability.sql`
      (if present), `058_offboarding_analytics_events.sql`. Migrations-log head
      is `058`. Record applied-at timestamps.
- [ ] Production Supabase is **not** yet ahead of staging on any of 056/057/058
      (lockstep rule: staging first, prod during promotion).
- [ ] Railway **staging** worker is deployed from the offboarding branch and
      booted clean (startup assert lists `ACCOUNT_OFFBOARDING_ENABLED`; offboarding
      Workers and the two pollers registered).
- [ ] Vercel **staging** custom env is deployed from the same ref.
- [ ] Stripe **test-mode** creds configured on staging; a test subscription
      exists for each test account with a known `current_period_end`.
- [ ] Zernio **sandbox** creds configured; at least one connected sandbox
      location exists for the `delete_data` accounts.
- [ ] Resend (or the staging email transport) is reachable; confirmation and
      keep-my-data emails can be observed.

## 2. Environment & flags (staging only)

| Variable | Staging value | Notes |
| --- | --- | --- |
| `ACCOUNT_OFFBOARDING_ENABLED` | `true` | Enables routes, pollers, and worker paths. **Staging only during the dry-run.** |
| `ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` | small value (e.g. `60000`) | Server-only, non-production purge-window shortener so the 30-day window does not block the run. **Must be unset / refused in production.** Never exposed to browser code. |

After the dry-run, leave `ACCOUNT_OFFBOARDING_ENABLED` as the team decides for
staging, but **do not** carry `ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` into
production.

## 3. Status machine (expected transitions)

`pending → scheduled → tearing_down → purge_scheduled → purged`
with terminal branches `churned`, `reactivated`, and `failed`. Every terminal
status stamps `terminal_at`; non-terminal statuses keep `terminal_at IS NULL`.

## 4. Dry-run scenarios

Use a fresh disposable test account per destructive scenario. Record the
`account_offboardings` row id and the observed status path for each.

### 4.1 `cancel_only` confirmation
- [ ] Owner confirms `cancel_only` from the Account settings panel.
- [ ] Row inserts `status='pending'`; billing-schedule worker sets
      `cancel_at_period_end=true`, reads `current_period_end`, and moves to
      `status='scheduled'` with `access_ends_at` populated.
- [ ] Confirmation email observed once (dedup holds on retry).
- **Observed:** _row id / status path / access_ends_at_ →

### 4.2 Same-subscription reactivation before access end
- [ ] Owner reactivates while `status='scheduled'` and `teardown_started_at IS NULL`.
- [ ] `cancel_at_period_end` is reversed on the **same** snapshot subscription;
      row lands `status='reactivated'`, `terminal_at` set; reactivation email sent.
- [ ] Confirm the access-end poller can no longer claim this row (no double-win).
- **Observed:** →

### 4.3 `delete_data` confirmation
- [ ] Owner passes fresh re-auth (+ AAL2 when MFA enrolled) and type-to-confirm.
- [ ] Single transaction: row `status='pending'`, `purge_after = now()+30d`,
      `zernio_connections` marked disconnected (mark-then-call), audit written,
      teardown outbox row enqueued atomically.
- [ ] Operational dashboard UI is hidden; only the offboarding status page shows.
- [ ] Teardown worker runs from the **snapshot**: Stripe cancel + invoice cleanup,
      Zernio delete, location archive, job-outbox terminalization. Completion is
      derived only when every required step is `success`/`not_applicable`, then
      `status='purge_scheduled'`.
- **Observed:** →

### 4.4 Keep-my-data before purge
- [ ] On a `delete_data` account in `purge_scheduled` (purge not started), owner
      uses keep-my-data (authenticated and/or token path).
- [ ] Raw keep-my-data token is **never** in `job_outbox`, logs, or analytics —
      only the SHA-256 hash is stored; the email worker mints the raw token at
      send time.
- [ ] Row sets `purge_cancelled_at`, tokens revoked; lands `churned` if teardown
      complete, otherwise stays non-terminal until teardown completion lands `churned`.
- [ ] Expired / consumed / revoked tokens are rejected.
- **Observed:** →

### 4.5 `delete_data` confirmation again (separate account), through purge
- [ ] Second disposable account confirms `delete_data` and is **not** rescued.
- [ ] With the shortened window, the purge poller claims
      `status='purge_scheduled' AND purge_after<=now() AND purge_cancelled_at IS NULL`
      with `FOR UPDATE SKIP LOCKED`, stamps `purge_started_at`, revokes tokens,
      enqueues purge.
- [ ] Purge worker runs short, restartable stages; auth-user deletion is
      revalidated immediately before `deleteUser()`. Final verification is derived
      from `table-disposition.ts`; `purged_at` is stamped only when every table is
      empty / scrubbed / retained under an approved disposition. Terminal scrub
      nulls `recipient_email`, raw snapshot provider IDs, and `auth_user_id`.
- [ ] Row lands `status='purged'`.
- **Observed:** →

### 4.6 Edge accounts
Run `delete_data` (or `cancel_only` where billing is absent) against accounts in
`pending_payment`, never-activated, trial, and `past_due` states.
- [ ] Absent provider/billing steps become `not_applicable` and never hang
      teardown completion.
- **Observed (per state):** →

## 5. Evidence to record

- [ ] **Stripe invoice cleanup** — observed behavior for draft / open /
      uncollectible / void / paid invoices tied to the cancelled subscriptions,
      cross-checked against the PR5 spike
      (`owner-offboarding-stripe-invoice-spike.md`). **Observed:** →
- [ ] **Analytics** — durable server-side events fired exactly once:
      `offboarding_started`, `offboarding_reactivated`,
      `offboarding_teardown_completed`, `offboarding_purged`; identifiers/properties
      scrubbed at purge time. **Observed:** →
- [ ] **Provider disposition override** — exercise the admin override on a
      deliberately-stuck provider step, or explicitly state why none was needed.
      Confirm override cannot blind force-purge (a concrete disposition record is
      required). **Observed / N/A reason:** →
- [ ] **Email dedup** — each offboarding email sent once per
      `account_offboarding_id + email_type`. **Observed:** →

## 6. Audit & test commands

Run against the offboarding branch. Per the worktree footgun, do **not** treat a
nested-worktree run as the gate — push the branch and read the GitHub Actions
runner for the authoritative result.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ci:tenant-scope
pnpm ci:rls-audit
pnpm ci:analytics-events
pnpm ci:static-policy
pnpm build
```

Record the runner conclusion (URL + green/red) here: →

## 7. Launch gate (Task 7.3) — must be complete before production

- [ ] ToS non-refundable mid-cycle `delete_data` clause + forfeiture disclosure
      shipped (`src/lib/legal/content.ts`); legal review covering the
      jurisdictions RepWorth sells into is recorded.
- [ ] No product copy promises absolute deletion (delete-or-anonymize +
      retained-records language confirmed).
- [ ] 056 / optional 057 / 058 applied to **both** Supabase projects in lockstep,
      staging-first.
- [ ] Staging dry-run evidence (sections 4–6) recorded and reviewed.
- [ ] Only then: set `ACCOUNT_OFFBOARDING_ENABLED=true` on production Railway and
      Vercel. `ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` stays unset in prod.
- [ ] Post-enable smoke test on a controlled test/customer account: status route,
      `cancel_only` confirmation, and cancellation reversal **only**. Do not test
      destructive purge on a real customer account.

## 8. Kill switch / rollback

`ACCOUNT_OFFBOARDING_ENABLED=false` disables routes, pollers, and worker paths.
If the flag is flipped off after rows exist, `ResponsePublisherWorker` and the
gated paths behave per the dark-flag contract; pollers go inactive. Any row left
mid-flight resumes when the flag is re-enabled. Record any rollback exercised
during the dry-run here: →

## Sign-off

| Role | Name | Date | Notes |
| --- | --- | --- | --- |
| Dry-run operator | | | |
| Eng reviewer | | | |
| Legal launch gate | | | |
