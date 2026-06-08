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

## 0. Dry-run outcome — executed 2026-06-08 (operator: Claude, autonomous)

**VERDICT: NOT launch-ready. 3 launch-blocking defects found.** 6 of 9 scenarios
pass; the 3 failures are independent code defects (not infra), each of which
alone blocks a core path. All work ran on **disposable** accounts provisioned for
the dry-run; the real GBP-connected owner account (`norbertliverpool@gmail.com`)
and its Google Business Profile were never touched.

| Scenario | Result |
| --- | --- |
| 4.1 cancel_only confirmation | ❌ **FAIL (D1)** |
| 4.2 reactivation before access end | ✅ PASS¹ |
| 4.3 delete_data confirmation → teardown | ✅ PASS |
| 4.4 keep-my-data (authenticated) | ✅ PASS |
| 4.4 keep-my-data (email/token path) | ❌ **FAIL (D2)** |
| 4.5 delete_data through purge | ❌ **FAIL (D3)** |
| 4.6 edge accounts | ✅ PASS |
| 4.7 T-3d purge reminder | ✅ PASS |
| 4.8 reactivation stale-claim recovery | ✅ PASS |
| 4.9 stalled-teardown auto re-drive + cap | ✅ PASS |

¹ §4.2 validated on a `scheduled` state seeded via SQL, because D1 prevents
cancel_only from ever reaching `scheduled` through the normal billing path.

### Launch-blocking defects

**D1 — cancel_only billing schedule throws on `current_period_end`.**
`BillingScheduleWorker.readCurrentPeriodEnd()`
(`worker/jobs/account-offboarding/BillingScheduleWorker.ts:208-210`) reads
`subscription.current_period_end` (top-level), but the pinned Stripe SDK API
version (`2026-05-27.dahlia`, Basil-era) returns `current_period_end` **only on
the subscription item** (`subscription.items.data[0].current_period_end`); the
top-level field is `undefined`. `parseStripeCurrentPeriodEnd` then throws
`Stripe subscription update did not return a valid current_period_end`, the job
retries to exhaustion, and the row lands `status='failed', failed_step='billing'`
— never `scheduled`. cancel_only can never complete with the current API version.
*Fix:* read `subscription.items.data[0].current_period_end` (with a top-level
fallback). *Why CI is green:* the unit test mock
(`BillingScheduleWorker.test.ts:114`) returns `{ current_period_end: ... }`
top-level — pre-Basil mock drift that doesn't match the real API.
Live evidence: offboarding `019ea73d-0b61-74de-a4b8-23d40819e1ee`, worker log
`logger="AccountOffboardingBillingScheduleWorker"`.

**D2 — keep-my-data email/token path is 401'd by the auth proxy.**
The keep-my-data route is designed to be public/token-authenticated (clicked from
an email by a logged-out user: GET renders a public page, POST validates the raw
token). But `isProtectedOwnerApiRoute` (`src/lib/shared/protected-routes.ts:40`)
matches `normalized.startsWith('/api/account/')`, which traps
`/api/account/offboarding/keep-my-data`, and `src/proxy.ts:170-173` returns
`401 {"error":"Unauthorized"}` for any unauthenticated request. So a customer
clicking the keep-my-data link in their email — the primary rescue path — gets a
401 instead of the keep-data page. *Fix:* exempt
`/api/account/offboarding/keep-my-data` from the owner-API gate (the route does
its own token validation), mirroring the `/admin/login` exemption. Affects
production (this is the app's own proxy, not Vercel Deployment Protection).

**D3 — delete_data purge fails permanently; data is never deleted.**
The PurgeWorker scrub stage (`worker/jobs/account-offboarding/purge-stages.ts:179-188`)
runs `UPDATE approval_audit_log SET … approval_link_id = NULL, … user_agent = NULL, …`
but the real `approval_audit_log` table has **no `approval_link_id` and no
`user_agent` column** (its columns: `id, response_id, business_id, token_hash,
device_cookie_hash, action, ip_address, metadata, created_at, actor_user_id,
auth_method, account_id, response_text_at_approval`). The statement raises
`column "approval_link_id" of relation "approval_audit_log" does not exist`, the
purge retries to the cap and lands `status='failed', failed_step='purge'`,
`purged_at` never set. delete_data accounts therefore reach `purge_scheduled` but
the data is **never actually deleted** — a functional *and* compliance failure
(deletion promised, not delivered). The scrub *does* correctly null the real PII
columns (incl. `response_text_at_approval`, line 189); the only defect is the two
phantom columns. `purge-verification.ts:204,207` reference the same two phantoms.
*Fix (DONE):* drop `approval_link_id` + `user_agent` from the scrub + verification
— verified against the real staging schema (old SQL errors, corrected SQL runs
clean) and locked with a real-DB integration test. Same mock-drift root cause as
D1 — `PurgeWorker.test.ts` asserted the SQL *text* (it even asserted the phantom
columns were present), never against the real table. Live evidence: offboarding
`019ea745-aff9-7434-96fb-43bdfba424e2`, `failed_step='purge'`, `retry_count=3`.

> Common theme across D1 + D3: tests assert on mocked Stripe responses / SQL
> strings, so schema/API drift sails through CI. Recommend an integration test
> that runs purge + billing-schedule against the real staging schema/API.

### Disposable accounts provisioned (cleanup pending — all test-mode, no real GBP)

`c1 c2 c3 d1 d2 d3 d4 epend enever etrial epast f1` — emails
`norbertesekiel+offb-<label>@gmail.com`, throwaway Supabase auth users, Stripe
**test** customers/subscriptions, no real Zernio link. Left in place as defect
evidence (e.g. d3 = failed purge, c1 = failed billing); safe to purge on request.

## 1. Preconditions

Confirm each before starting. Check the box and record the value/evidence.

- [x] **Migrations applied to the staging Supabase project, staging-first**
      (`kubdiqdhqbhwmqfditeg`). Verified by schema object existence (this project
      applies migrations outside the Supabase CLI — no `schema_migrations`
      ledger, so object existence is authoritative): tables
      `account_offboardings` + `account_offboarding_tokens` (056); column
      `purge_reminder_sent_at` (059); columns `reactivation_claimed_at` +
      `reactivation_claim_token` + index `idx_account_offboardings_reactivation_claim`
      (060); `analytics_events_event_name_check` contains all 4 offboarding events
      (058). Migrations-log head = `060`.
- [x] Production Supabase is **not** ahead of staging on 056–060. Satisfied by
      construction: staging is at head 060, no migration > 060 exists in the repo,
      and the prod Railway worker has `ACCOUNT_OFFBOARDING_ENABLED` unset with no
      app config (no `DATABASE_URL`), so the feature is not adopted in prod. Not
      directly queried (no autonomous prod-DB read available).
- [x] Railway **staging** worker deployed from the offboarding branch, booted
      clean. Boot log: `[worker] Feature flags: … ZernioPublishing=on`,
      `Worker service running on port 8080`; **all five** pollers logged
      `Starting (interval=60000ms, …)` — `AccountOffboardingAccessEndPoller`,
      `…PurgePoller`, `…PurgeReminderPoller`, `…ReactivationResetPoller`,
      `…TeardownRetryPoller` — and tick every 60s. Deployment
      `e7fc2c29-0ab0-4035-b211-79c8a1429e41`, health endpoint `status:ok`.
- [x] Vercel **staging** custom env deployed + reachable. `staging.repworth.net`
      returns 401 without the bypass, 200 with `x-vercel-protection-bypass`;
      offboarding routes deployed (status route returns app-level 401).
      ⚠️ **`ACCOUNT_OFFBOARDING_ENABLED` was NOT set on Vercel** at the start —
      every route returned `404 account_offboarding_disabled`. Added to the
      Vercel `staging` env (staging only, never production) and redeployed
      staging (deployment `rep-worth-kj572huli`) to unblock the dry-run. See §2.
- [x] Stripe **test-mode** creds configured (`STRIPE_SECRET_KEY` = `sk_test_…`,
      account `RepWorth, Inc.`). A test subscription with a known billing period
      was created per disposable account.
- [x] Zernio **sandbox** creds configured (`ZERNIO_API_KEY` set,
      `ZERNIO_PUBLISHING_ENABLED=true`); `ZernioRecentReviewPoller` live
      (`checked=1 seen=165 processed=1`). Disposables use **synthetic** sandbox
      connections only (never the real GBP).
- [x] Resend reachable (`RESEND_API_KEY` set); confirmation, keep-my-data, and
      purge-reminder emails observed in the staging inbox.
- [x] **Access to the SSO-gated staging UI/API.** Drove all `/api/account/offboarding/*`
      routes headlessly with the **Vercel Protection Bypass for Automation** token
      (`x-vercel-protection-bypass` header) + minted Supabase SSR session cookies +
      minted `rw_delete_data_fresh_auth` HMAC stamp for delete_data. Webhook/worker/
      poller work on Railway is ungated.

## 2. Environment & flags (staging only)

| Variable | Staging value | Notes |
| --- | --- | --- |
| `ACCOUNT_OFFBOARDING_ENABLED` | `true` | Enables routes, pollers, and worker paths. **Staging only during the dry-run.** Confirmed `true` on the Railway worker; **had to be added to the Vercel `staging` env + staging redeployed** — without it every Next.js route returned `404 account_offboarding_disabled`. |
| `ACCOUNT_OFFBOARDING_TEARDOWN_MAX_RETRIES` | `3` (dry-run) | Confirmed `3` on the staging worker. §4.9 cap verified at 3. |
| `ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_COOLDOWN_MS` | `60000` (dry-run) | Confirmed `60000` on the staging worker. |

> ⚠️ **`ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` does NOT work on this staging
> worker.** Confirmed: the Railway staging worker runs `NODE_ENV=production`, which
> refuses the override. Purge/reminder timing was driven by shortening `purge_after`
> directly via SQL on disposable rows. **Additional finding:** a DB trigger
> (`enforce_account_offboarding_purge_after_token_expiry`) rejects setting
> `purge_after` earlier than an *active* keep-my-data token's `expires_at`, so the
> §4.5 shortcut also requires revoking/expiring the keep-my-data token first
> (good safety invariant — but the bare `UPDATE purge_after = NOW()` in §4.5 is
> insufficient on its own).

The recovery/reminder pollers below were left **unset** (defaults exercised):

| Variable | Default | Notes |
| --- | --- | --- |
| `ACCOUNT_OFFBOARDING_PURGE_REMINDER_INTERVAL_MS` / `_BATCH_SIZE` | `60000` / `25` | Default. Reminder fires at **T-3 days** before `purge_after`. Verified. |
| `ACCOUNT_OFFBOARDING_REACTIVATION_RESET_INTERVAL_MS` / `_BATCH_SIZE` | `60000` / `25` | Default. Stale claim after **5 min**. Verified. |
| `ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_INTERVAL_MS` / `_BATCH_SIZE` | `60000` / `10` | Default. Verified. |

After the dry-run, leave `ACCOUNT_OFFBOARDING_ENABLED` as the team decides for
staging (currently left **on** for both Railway + Vercel staging), and revert the
lowered `…TEARDOWN_MAX_RETRIES` / `…TEARDOWN_RETRY_COOLDOWN_MS` to defaults.
`ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` must never be set in production.

## 3. Status machine (expected transitions)

`pending → scheduled → tearing_down → purge_scheduled → purged`
with terminal branches `churned`, `reactivated`, and `failed`. Every terminal
status stamps `terminal_at`; non-terminal statuses keep `terminal_at IS NULL`.

A `failed` row whose `failed_step = 'teardown'` is **not** terminal-by-policy:
`TeardownRetryPoller` re-drives it back to `tearing_down` after the cooldown,
up to `ACCOUNT_OFFBOARDING_TEARDOWN_MAX_RETRIES`, after which it remains `failed`
for an operator. A stale `reactivation_claimed_at` (>5 min) on a `scheduled`
`cancel_only` row is released by `ReactivationResetPoller` (Stripe re-stamped to
`cancel_at_period_end=true`) so the row is never stranded mid-reversal.
**Observed live:** `pending → scheduled` is broken by D1; `pending → tearing_down
→ purge_scheduled` works; `purge_scheduled → purged` is broken by D3; the
`failed(teardown) → tearing_down` re-drive, the cap, and the stale-claim reset
all work as documented.

## 4. Dry-run scenarios

Use a fresh disposable test account per destructive scenario. Record the
`account_offboardings` row id and the observed status path for each.

### 4.1 `cancel_only` confirmation
- [x] Owner confirms `cancel_only` (driven via `POST /api/account/offboarding/confirm`,
      authenticated). Route returned **202 created**.
- [ ] ❌ Billing-schedule worker did **not** reach `scheduled`. It set
      `cancel_at_period_end=true` on the Stripe sub but then threw reading
      `current_period_end` (defect **D1**); the row went `pending → failed`,
      `failed_step='billing'`, `stripe_step='failed'`, `access_ends_at` NULL.
- [ ] ❌ No confirmation email (cancel_only emails only on a successful schedule).
- **Observed:** account `c1` (`019ea735-dcec-7007-a99a-a221aab91005`), offboarding
  `019ea73d-0b61-74de-a4b8-23d40819e1ee`, status path `pending → failed (billing)`,
  `access_ends_at` never set. **Cause: D1.** →

### 4.2 Same-subscription reactivation before access end
- [x] Owner reactivated while `status='scheduled'` and `teardown_started_at IS NULL`
      (`scheduled` state seeded via SQL because D1 blocks the natural path).
      `POST /reactivate` returned **202 (`queued`)**.
- [x] Row claimed via `reactivation_claimed_at` + `reactivation_claim_token`;
      `cancel_at_period_end` reversed on the **same** snapshot subscription
      (Stripe `cancel_at_period_end: true → false`); row landed
      `status='reactivated'`, `terminal_at` set, claim columns cleared; reactivation
      email sent (`cancel_only_reactivation_confirmation` ×1).
- [x] Access-end poller can no longer claim the row (terminal + claim cleared).
- **Observed:** account `c3`, offboarding `bd615df3-61d3-4fcd-ab2e-a09f1bc27048`,
  `scheduled → reactivated` (terminal), Stripe reversed to `cancel_at_pe=false`,
  claim cleared. ✅ →

### 4.3 `delete_data` confirmation
- [x] Owner passed fresh re-auth (minted `rw_delete_data_fresh_auth` HMAC; AAL2 not
      required — no MFA enrolled) and type-to-confirm (`confirmationText: 'DELETE DATA'`).
      `POST /confirm` returned **202 created**.
- [x] Single transaction: row `status='pending'`, `purge_after = now()+30d`
      (2026-07-08), zernio connections marked disconnected (n/a here — no real
      Zernio), audit written, teardown outbox row enqueued atomically.
- [x] Operational dashboard hidden / offboarding status route serves (flag-gated).
- [x] Teardown ran from the snapshot: Stripe cancel (sub → `canceled`), invoice
      cleanup, location archive (`archived_at` set), job-outbox terminalization.
      Completion derived only when every step is `success`/`not_applicable`, then
      `status='purge_scheduled'`. Steps: `stripe_step=success`,
      `zernio_accounts_step=not_applicable`, `location_archival_step=success`,
      `job_terminalization_step=success`.
- **Observed:** account `d1`, offboarding `019ea743-4a20-719c-9440-c132562cf807`,
  `pending → tearing_down → purge_scheduled`. ✅ (Confirms delete_data teardown is
  unaffected by D1 — it uses `subscriptions.cancel`, not `current_period_end`.) →

### 4.4 Keep-my-data before purge
- [x] **Authenticated path** on a `delete_data` account in `purge_scheduled`
      (teardown complete): `POST /keep-my-data` (session) → **200**, row landed
      `churned`, `purge_cancelled_at` set, `terminal_at` set. ✅
- [ ] ❌ **Email/token path** is broken (defect **D2**): the GET keep-my-data page
      and the POST token submission both return `401 {"error":"Unauthorized"}` from
      the auth proxy, because `/api/account/offboarding/keep-my-data` is trapped by
      the blanket `/api/account/*` owner-API gate. A logged-out customer clicking
      the email link cannot rescue their data. (Tokens themselves are correct —
      see below.)
- [x] Raw keep-my-data token **never** in `job_outbox`/logs/analytics — verified:
      `account_offboarding_tokens` stores only `token_hash` (no raw-token column);
      email outbox payload keys are `idempotency_key_hash/account_id/
      account_offboarding_id/correlation_id/email_type` (no raw token). The raw
      token appears only in the email body (minted at send time).
- [x] Revoked/invalid tokens: could not exercise the *happy* token path (D2 blocks
      it), but the token validation itself is sound by inspection + the hash-only
      storage above.
- **Observed:** authenticated rescue — account `d1`, offboarding
  `019ea743-4a20-719c-9440-c132562cf807` → `churned`. Token path — **FAIL (D2)**,
  401 on GET form + POST token. →

### 4.5 `delete_data` confirmation again (separate account), through purge
- [x] Second disposable account confirmed `delete_data`, not rescued, teardown
      completed → `purge_scheduled`.
- [x] Made purge-eligible via Supabase: revoked the active keep-my-data token (the
      `enforce_account_offboarding_purge_after_token_expiry` trigger blocks
      `purge_after = NOW()` while a token is live — see §2), then
      `UPDATE … SET purge_after = NOW()`. The PurgePoller **claimed** it
      (`claimed=1`), stamped `purge_started_at`, and enqueued purge.
- [ ] ❌ Purge worker **failed** (defect **D3**): `column "approval_link_id" of
      relation "approval_audit_log" does not exist`. Retried to `retry_count=3`,
      row landed `status='failed', failed_step='purge'`, `purged_at` never set.
      **Data was not deleted.**
- [ ] ❌ Row never reached `status='purged'`.
- **Observed:** account `d3`, offboarding `019ea745-aff9-7434-96fb-43bdfba424e2`,
  `purge_scheduled → purge_started → failed (purge)`. **Cause: D3.** →

### 4.6 Edge accounts
Ran `delete_data` against `pending_payment`, never-activated (no active location /
archived), trial, and `past_due` accounts.
- [x] Absent provider/billing steps became `not_applicable` and never hung teardown
      completion. All four reached `purge_scheduled`.
- **Observed (per state):** `epend` (pending_payment, no sub) → `purge_scheduled`,
  `stripe_step=not_applicable`; `enever` (never-activated, archived location, no
  sub) → `purge_scheduled`, `stripe=not_applicable`, `location_archival=success`;
  `etrial` (trial, no sub) → `purge_scheduled`, `stripe=not_applicable`;
  `epast` (past_due, sub) → `purge_scheduled`, `stripe=success`. ✅ (All would then
  hit D3 at purge, like §4.5.) →

### 4.7 T-3d purge reminder (migration 059 / `PurgeReminderPoller`)
- [x] On a `delete_data` account in `purge_scheduled`, brought `purge_after` within
      3 days but still future (`NOW() + 1 hour`, after revoking the keep-my-data
      token per the §2 trigger). The reminder poller sent the
      `delete_data_purge_reminder` email exactly once and stamped
      `purge_reminder_sent_at`; the purge poller did **not** fire (purge_after future).
- [x] Re-poll: not reminded again (`purge_reminder_sent_at IS NOT NULL` guard holds);
      audit `account_offboarding_purge_reminder_sent` written once;
      `delete_data_purge_reminder` email count = 1.
- [x] Rescued rows (`purge_cancelled_at` set, e.g. churned accounts) are not reminded.
- **Observed:** account `d4`, offboarding `019ea74b-d0f2-739d-ba5b-5f0c5e8a179e`,
  `purge_reminder_sent_at` stamped, 1 reminder email, audit ×1, status stayed
  `purge_scheduled`. ✅ →

### 4.8 Reactivation stale-claim recovery (migration 060 / `ReactivationResetPoller`)
- [x] Seeded a `cancel_only` `scheduled` row with `reactivation_claimed_at` 6 min
      old + `reactivation_claim_token` set, Stripe at `cancel_at_period_end=false`
      (simulating a crash mid-reversal).
- [x] The reset poller re-stamped Stripe to `cancel_at_period_end=true` (idempotent
      compensate key), cleared the claim columns, wrote audit
      `account_offboarding_reactivation_claim_reset` (×1), and left the row
      `status='scheduled'`.
- [x] Token-guarded clear (`WHERE reactivation_claim_token = <observed>`) means a
      concurrently-taken-over / mismatched claim is not clobbered (by inspection).
- **Observed:** account `c2`, offboarding `818c7f6c-f7ac-4dcf-a4b2-78c6c4547fc5`,
  Stripe `cancel_at_pe: false → true`, claim cleared, status stayed `scheduled`,
  audit ×1. ✅ →

### 4.9 Stalled-teardown auto re-drive (`TeardownRetryPoller`)
- [x] A live `delete_data` teardown could not be forced to fail naturally (the
      sandbox tolerates the synthetic Zernio delete as 404 → idempotent success).
      Seeded the `failed`/`failed_step='teardown'` states directly instead.
- [x] **Re-drive:** row at `retry_count=1` (< MAX), `updated_at` past cooldown →
      the retry poller flipped it to `tearing_down`, cleared `last_error`, wrote
      audit `account_offboarding_teardown_retry_scheduled`, re-enqueued teardown;
      teardown then completed → `purge_scheduled`.
- [x] **Cap:** row at `retry_count=3` (= `MAX_RETRIES`) was **not** re-driven —
      stayed `failed` for an operator, no loop.
- **Observed:** re-drive — account `f1`, offboarding
  `019ea74d-de8e-764b-a5fd-3868fd71bc1b`, `failed(teardown) → tearing_down →
  purge_scheduled`, audit ×1. Cap — account `epast`, offboarding
  `019ea74b-c578-7479-bb87-e07bdef5cfb1`, stayed `failed` at `retry_count=3`. ✅ →

## 5. Evidence to record

- [x] **Stripe invoice cleanup** — for a teardown'd account the only invoice was the
      initial **paid** invoice, correctly **retained** (paid invoices are not
      voidable). draft/open/uncollectible/void handling was **not** live-fabricated
      this run (covered by `stripe-invoices` unit tests + the PR5 spike
      `owner-offboarding-stripe-invoice-spike.md`). **Observed:** d2 customer
      `cus_UfNKABUVnn2Hkv` → 1 invoice `status=paid total=4900` retained. (Partial
      live coverage.) →
- [x] **Analytics** — durable server-side events fired exactly once (count =
      distinct accounts): `offboarding_started` ×10, `offboarding_teardown_completed`
      ×9, `offboarding_reactivated` ×1. `offboarding_purged` ×0 — **blocked by D3**
      (nothing purged), so the purge-time identifier/property scrub could **not** be
      observed. Events are inserted server-side (durable); `dispatched_at` NULL on
      staging (PostHog shipping is a no-op without a key). **Observed:** as above. →
- [x] **Provider disposition override** — **not exercised / N/A this run.** No
      provider step was stuck (the synthetic Zernio delete succeeds as 404). The
      admin override path (`/api/admin/offboardings/[id]/provider-disposition`) was
      not driven; recommend covering it once D3 is fixed and a real stuck-provider
      case can be produced. By inspection, force-purge still requires a concrete
      disposition record. **N/A reason:** no stuck provider step occurred. →
- [x] **Email dedup** — each offboarding email sent once per
      `account_offboarding_id + email_type`: `delete_data_confirmation` 9/9,
      `delete_data_purge_reminder` 1/1, `keep_my_data_confirmation` 1/1,
      `cancel_only_reactivation_confirmation` 1/1. **Observed:** as above. →
- [x] **Recovery-poller audit trail** — `account_offboarding_purge_reminder_sent`
      ×1, `account_offboarding_reactivation_claim_reset` ×1, and
      `account_offboarding_teardown_retry_scheduled` ×1 (teardown `retry_count`
      advanced per §4.9). **Observed:** as above. →

## 6. Audit & test commands

Per the worktree footgun, the gate is **PR #244's GitHub Actions runner**, not a
nested-worktree local run.

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

Runner conclusion: **ALL GREEN** — `lint`, `fallow`, `react-doctor`, `typecheck`,
`test`, `build`, `deploy-install` all SUCCESS. Run:
https://github.com/RepWorth/ai-review-responder/actions/runs/27136392049
> ⚠️ Note: CI is green **despite D1 and D3**, because both are masked by mock drift
> (tests assert on mocked Stripe responses / SQL strings, not the real API/schema).
> The green runner is necessary but **not sufficient** — the launch gate must not
> rely on it alone for the offboarding Stripe + purge paths. →

## 7. Launch gate (Task 7.3) — must be complete before production

- [ ] ToS non-refundable mid-cycle `delete_data` clause + forfeiture disclosure
      (`src/lib/legal/content.ts`); legal review recorded. *(Not verified this run.)*
- [x] No product copy promises absolute deletion — confirmed in the
      delete_data_confirmation email: "Some records may be retained when legally or
      operationally required" (delete-or-anonymize language present).
- [x] 056 / optional 057 / 058 / 059 / 060 applied to **staging** (head `060`).
      Prod application is a promotion-time step (currently behind — feature off).
- [ ] ❌ Staging dry-run evidence (sections 4–6) recorded — **3 launch-blocking
      defects (D1, D2, D3) must be fixed and re-validated before this is cleared.**
- [ ] **DO NOT** set `ACCOUNT_OFFBOARDING_ENABLED=true` on production until the
      above is green. `ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` stays unset in prod.
- [ ] Post-enable smoke test — pending defect fixes.

## 8. Kill switch / rollback

`ACCOUNT_OFFBOARDING_ENABLED=false` disables routes, pollers, and worker paths.
Rollback not exercised this run (flag left on for staging). The dark-flag downgrade
contract for unposted rows is unchanged.

## Sign-off

| Role | Name | Date | Notes |
| --- | --- | --- | --- |
| Dry-run operator | Claude (autonomous) | 2026-06-08 | Executed on disposable staging accounts; 6/9 pass, 3 launch-blocking defects (D1/D2/D3). Real GBP owner account untouched. |
| Eng reviewer | | | Pending — review D1/D2/D3 fixes |
| Legal launch gate | | | Pending |
