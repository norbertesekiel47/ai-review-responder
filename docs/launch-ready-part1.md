# Launch Ready — Part 1: Production Readiness Audit

> **Date:** 2026-05-28
> **Scope:** Full-codebase audit of what remains before RepWorth goes to production (GA / self-serve launch).
> **Method:** Five parallel read-only audits (incomplete code, test coverage, env/deploy config, architecture invariants) + ground-truth command runs (`lint`, `typecheck`, `build`, `test`, CI audits) on `main` @ `d614b0c9`.
> **Companion doc:** `docs/launch-checklist.md` tracks external/operational readiness. This file is the code-side audit.

---

> **Progress markers (re-verified 2026-05-29):** ✅ = code-side work complete and confirmed in the current tree · 🟡 = partially done (residual noted — usually an ops/prod step) · unmarked = ops/config only, intentional waitlist, or still outstanding. These ticks were reconstructed from a fresh code-based audit (the worktree copy was lost), cross-checked against merged PRs **#152–#158** and **#132/#133/#135**.
>
> **Re-verified 2026-06-11 (PRs #276–#279):** every remaining code-side item in this doc is now closed — how-it-works palette + wizard aria-live + doc drift (#276), all open test-coverage gaps except the e2e/CI-DB infra items (#277), the auth-form island rebrand (#278, part 2's last P0), and the signup wizard-completion column (#279, migration 064). Outstanding work below is ops/config, launch-flag flips, the `TEST_DATABASE_POOL_URL` CI wiring (+ skipped e2e), and intentionally deferred items (demo view-counter debounce, GBP API application, PostHog dashboards).

## Headline

**The code is in strong shape. The remaining work is mostly operational, not code.** `lint`, `typecheck`, and `build` pass; CI is green on `main`; and every safety-critical architecture invariant **holds** in code — most importantly, there is a real, enforced gate preventing any auto-posting to Google without owner approval.

Remaining work clusters into: **infra/config setup**, **launch-gating flag flips**, **operational drills**, **test-coverage gaps**, and **in-flight multi-location fixes** (already open as PRs).

> **Framing note:** Config shows `ZERNIO_PUBLISHING_ENABLED` has been on in prod since 2026-04-28, and a 600-line beta deployment plan exists — so a beta deployment already exists. This audit reads "production" as **GA / opening self-serve signup**. If "first deploy" is meant instead, the priority order shifts.

---

## ✅ Ground-truth health (commands actually run)

| Check | Result |
|---|---|
| `pnpm lint` | **Pass** (1 warning: `<img>` in `src/app/(authenticated)/settings/security/SecurityClient.tsx:276`) |
| `pnpm typecheck` | **Pass**, clean |
| `pnpm build` | **Pass** (63 static pages) |
| `pnpm test` | **Pass in CI**; 2 tests flaky under local parallel load (pass 4/4 in isolation) |
| `pnpm ci:tenant-scope` | **Pass** |
| `pnpm ci:analytics-events` | **Pass** |
| `pnpm ci:rls-audit` | **Skipped** (no local test DB — expected) |
| CI on `main` HEAD (`d614b0c9`) | **success** |
| Safety invariants (7 audited) | **All HOLD** |

### ✅ Flaky test note
`worker/jobs/notification/__tests__/bounced-skip.test.ts` reported 2 failures during a full-suite parallel run (one 5000ms timeout, one fixture-ordering assertion: `"Response resp-1 belongs to business undefined, not biz-1"`). Re-run in isolation it passes **4/4 twice**, and CI on `main` is green. → **Flakiness under parallel load, not a correctness bug.** Worth hardening (event-based waits instead of fixed timeout; isolate the SQL-mock queue).

> ✅ **Resolved (PR #158).** De-flaked: the shared module-level `sqlReturnQueue` (drained positionally) was isolated per-test and the fixed timeout replaced — root-caused as fixture-queue drift under parallel load yielding the exact audited message.

---

## ✅ Safety invariants verified in code (not just docs)

| Invariant | Verdict | Evidence |
|---|---|---|
| **No auto-posting** | HOLDS | `worker/jobs/publisher/ResponsePublisherWorker.ts:49-56` hard-gates on `['approved','edited','awaiting_owner_connect']`; `pending_approval` cannot reach posting. Approval enqueues `publish_response` only after `UPDATE ... status='approved'` in same tx (`src/lib/approval/token-mode.ts:64-66`). |
| **Approval tokens never raw** | HOLDS | `src/lib/approval/create-link.ts:29-30,77` stores only `token_hash`; re-hash on read (`locks.ts:35`); no raw token in any INSERT or log. |
| **Moderation hold** | HOLDS | `src/lib/moderation/persist.ts:41` single `sql.begin()` wraps response INSERT + `flagged_responses` INSERT (line 139-148) + conditional outbox; `persist.ts:78` skips `send_notification` atomically when held. Local regex always runs (`moderate.ts:44`); OpenAI gated by `OPENAI_MODERATION_ENABLED`, fails open (`moderate.ts:68-71`). |
| **Transactional outbox** | HOLDS | All critical paths enqueue inside `sql.begin()`; `OutboxPoller.ts:160` is the only `queue.add()`, dispatching from committed rows. (See Gap: admin flagged route.) |
| **Vercel = UI only** | HOLDS | Only SerpAPI calls in routes carry documented exception comments (user-triggered, 2s timeout); no LLM calls in any `app/api` route. |
| **Subscription guard** | HOLDS | `src/lib/shared/subscription-guard.ts:34-63`; wired in notification, generator, publisher workers. |
| **Auth scope / no SERVICE_KEY in browser** | HOLDS | `SUPABASE_SERVICE_KEY` server-only (`db/server.ts:47`); removed from Edge proxy (`src/proxy.ts:11`); dashboard scoped by `account_id`. |

---

## 🔴 P0 — Hard blockers (don't go GA without these)

Most are **ops/config (set in Vercel + Railway)**, not code:

1. **Rotate `ZERNIO_WEBHOOK_SECRET`** — currently the dev dummy `test-secret-32-bytes-minimum-zzz` (`.env.local:204`). Forgeable Zernio webhooks otherwise.
2. **Set real production URLs** — `NEXT_PUBLIC_APP_URL`, `WORKER_SERVICE_URL`, `WORKER_PUBLIC_URL` (currently localhost / Cloudflare dev tunnel). Approval email links + Twilio callbacks break otherwise.
3. **Switch Stripe to live mode** — replace `sk_test_…` + all test `price_…` IDs with live ones in prod env.
4. 🟡 **Set `ADMIN_NOTIFICATION_EMAIL`** — **undocumented in `.env.example`** but all admin exception/failover/engagement alerts route here and **silently drop if unset** (`worker/jobs/AdminExceptionWorker.ts:121`, `worker/background/pollers/NotificationFailoverPoller.ts:172`, `worker/jobs/EngagementAlertWorker.ts:227`). Highest-risk hidden var. **→ ✅ Code-side closed (#156): now documented + boot-hardened in `.env.example`; setting the real prod value remains an ops step.**
5. 🟡 **Set `CONTACT_NOTIFY_TO`** — undocumented; contact/demo/lead emails silently fall back to a personal Gmail (`src/app/api/contact/route.ts:8`, `demo-request/route.ts:8`, `lead-intake/route.ts:145`). **→ ✅ Code-side closed (#156): documented in `.env.example`. (Correction 2026-06-11: unlike `ADMIN_NOTIFICATION_EMAIL`, this key is NOT boot-asserted in `startup-assert.ts` — setting the real prod value remains an ops step with no boot guard.)**
6. **External drills from `docs/launch-checklist.md` (can't verify from repo):**
   - PITR restore drill never run (🔴).
   - Email auth (DKIM/SPF/DMARC) unconfirmed — the approval email loop *is* the product (🔴).
   - Legal docs (ToS/Privacy/AUP/DPA) live at `/legal/*` but lawyer-unreviewed (🔴).

---

## 🟠 P1 — Before paying customers

- 🟡 **`SENTRY_DSN` blank** in both env files — Sentry fully wired (`src/instrumentation.ts`, `worker/sentry.ts`) but silently no-ops; prod errors untracked. **→ ✅ Key now documented in `.env.example` (#156); providing the real DSN is an ops step.**
- 🟡 **Cost circuit-breakers undocumented** — `DAILY_COST_LIMIT_CENTS_FOUNDING/STANDARD/PREMIUM` (500/1000/2000¢) + `GLOBAL_DAILY_COST_LIMIT_CENTS` (10000¢) have code defaults but aren't in `.env.example`. Set consciously before live LLM calls. **→ ✅ All four keys (`FOUNDING`, `STANDARD`, `PREMIUM`, `GLOBAL`) now documented in `.env.example:175-178` (re-verified 2026-06-11).**
- 🟡 **`STRIPE_PRICE_FOUNDING` + all `STRIPE_PRICE_*`** must be set before flipping `SELF_SERVE_SIGNUP_ENABLED`, or checkout/webhook silently mishandles tiers (`create-checkout-session.ts`, `subscription-updated.ts`). **→ ✅ All `STRIPE_PRICE_*` (+ `_OVERAGE`) keys now documented in `.env.example`; live values remain ops.**
- 🟡 **`IMPERSONATION_COOKIE_SECRET`** required before admin "view-as" works (fails closed). `openssl rand -hex 32`. **→ ✅ Documented in `.env.example` (#156); generating/setting the secret is ops.**
- 🟡 **`LIST_UNSUBSCRIBE_EMAIL` unset** → marketing emails fail Gmail/Outlook bulk-sender compliance (`src/lib/notifications/email/headers.ts:65`). **→ ✅ Documented + boot-hardened in `.env.example` (#156); value remains ops.**
- ✅ **Public pricing copy bug** — *FIXED (#152):* the Premium bullet now reads *"Multiple approval notification channels"* — the *", if implemented"* qualifier was removed in `src/app/(public)/pricing/PricingContent.tsx`.

---

## 🟡 P2 — Before scale / GA polish

- ✅ **Railway IaC added (#154)** — `railway.toml` now lives in repo (`builder = "RAILPACK"` — was NIXPACKS at audit time, changed post-audit; `startCommand = "pnpm worker"`, `healthcheckPath = "/api/health"`, supervised `ON_FAILURE` restart policy) so config survives project recreation. `vercel.json` intentionally deferred — no route needs a timeout above plan defaults yet.
- ✅ **`TEST_DATABASE_POOL_URL` not in CI** → cross-tenant RLS isolation test (`src/__tests__/tenant-isolation.test.ts`) and 13 Playwright E2E tests never run in the PR gate. Strongest correctness guarantee, currently dark. *(→ ✅ DONE in two parts: the Vitest half was wired ~2026-06-07 (postgres:16 service + bootstrap + migrations in the CI `test` job — this line was stale); the Playwright half landed 2026-06-11: a parallel `e2e` CI job runs the hermetic chromium specs via the shared `.github/actions/test-db` composite, and the live RLS audit now executes in the `test` job. Local setup: `docs/runbooks/e2e-local-setup.md`.)*
- ✅ **PII in `console.log`** — *FIXED (#152):* `contact`/`demo-request` routes now log only sanitized metadata (lengths/flags, no PII), and all four schedulers (`OnboardingDripScheduler.ts`, `WeeklySummaryScheduler.ts`, `MonthlyImpactScheduler.ts`, `StripeLocationsReconcilePoller.ts`) use `createWorkerLogger`.
- ✅ **`docs/runbooks/rollback.md` added (#154)** — full rollback runbook now in repo (was: only the Zernio kill-switch documented in the beta plan §10.5).
- ✅ **Founders tier price-lock gap** — *FIXED (#157):* migration `054_accounts_base_price_cents.sql` adds `accounts.base_price_cents` (backfilled, NOT NULL); `quota.ts` and `margin-service.ts` now read the stored column instead of `TIER_CONFIG.baseCents`, so the "3-year price lock" no longer drifts.
- **Demo page view counter** — direct hot-row Postgres `UPDATE` on every page load (`src/app/(public)/demo/[slug]/page.tsx`); now fire-and-forget (`.catch()`, non-blocking) with a `TODO` to debounce via Redis `INCR`. Fine at low traffic, still a bottleneck at scale. *(Softened, not fundamentally resolved.)*
- ✅ **`ADMIN_API_KEY` confusion** — *FIXED (#154):* the stale var/comment was removed from `.env.example`; `/api/admin/*` continues to use `requireRole(request, 'admin')`.

---

## 🚦 Launch-gating flag flips (currently all off)

| Flag | Prerequisite before flipping ON |
|---|---|
| `SELF_SERVE_SIGNUP_ENABLED` | Stripe prices + Supabase SMTP + OTP email templates using `{{ .Token }}` (NOT `{{ .ConfirmationURL }}`) + **migration 064 applied to PROD** (signup-status reads `accounts.onboarding_wizard_completed_at` once this flag is on; staging applied + verified 2026-06-11, prod pending — see PR #279) |
| `OPENAI_MODERATION_ENABLED` | Threshold tuning on real samples (local regex runs regardless) |
| `MFA_ENFORCEMENT_ENABLED` | Regression pass (AAL2 already enforced at sensitive routes; this only adds page-nav redirect) |
| `MULTI_LOCATION_ENABLED` | `STRIPE_PRICE_*_OVERAGE` ids; migrations 034–041 already shipped |
| `CHANNELS_SMS_ENABLED` | Twilio 10DLC registration (not critical path) |
| `CHANNELS_WHATSAPP_ENABLED` | Meta Business verification (2–4 wks) + WABA + template approval (not critical path) |
| `CHANNELS_TELEGRAM_ENABLED` | Prod `@RepWorthBot` + `setWebhook` (not critical path) |
| `RANKING_TRACKING_ENABLED` | Note: `RankingTrackingWorker.ts:161` caps at 1 keyword/business (temp rollout limit never lifted) |

---

## ✅ In-flight work (3 PRs — all merged)

All three fixed the same class of bug: **multi-location channel enrollment keyed by `business_id` instead of `account_id`**, causing misfired Twilio charges and stuck "active" enrollments on multi-location accounts. **All three have since merged to `main`.**

| PR | Title | Status |
|---|---|---|
| **#135** | account-scope SMS admin enrollment lock + cross-channel precheck | ✅ merged |
| #133 | account-scope dispatcher enrollment failure writes | ✅ merged |
| #132 | surface account-scoped org-default channel rows on business detail | ✅ merged |

Worktrees under `.claude/worktrees/` backed these three (all clean) + a `tracker-concurrency-shim-removal` refactor (now also done — see "Documented open / follow-up work").

---

## 🧪 Test-coverage gaps worth closing

**P0:**
- ✅ **`OutboxPoller` test added (#153)** — `worker/background/pollers/__tests__/OutboxPoller.test.ts` covers watchdog reset, dispatch, attempt-guard, and dead-letter (the entire outbox dispatch/watchdog/dead-letter path).
- ✅ **Resend webhook signature accept path covered (#155)** — `worker/ingress/__tests__/resend-webhook-signature.test.ts` exercises a real svix HMAC accept plus stale-timestamp reject (was: only the rejection path covered).

**P1:**
- ✅ **`hasOpenFlag` (`src/lib/moderation/held-draft.ts`)** has no direct unit test — a typo in its `status='open'` predicate would silently release held drafts. *(→ ✅ DONE (2026-06-11): `src/lib/moderation/__tests__/held-draft.test.ts` asserts the true/false paths AND the `status = 'open'` + response-id predicate text.)*
- ✅ **`past_due`/`pending_payment` subscription guard** tested in the pure unit but not exercised in worker integration tests. *(→ ✅ DONE (2026-06-11): `NotificationWorker.test.ts` now exercises `pending_payment`, `past_due` beyond the 7-day grace (skips), and `past_due` within grace (sends).)*

**P2:**
- Permanently-skipped e2e: `e2e/forgot-password.spec.ts` (4), `e2e/reset-password.spec.ts` (3), `e2e/signup-google.spec.ts` (1) — all `test.skip(true, ...)` (harness not wired). *(Still skipped — the Supabase `auth.admin` harness (staging-backed, local runs) is the in-flight follow-up PR; `signup-password.spec.ts` gained the same gate 2026-06-11, and the owner-offboarding DB-backed lifecycle specs are quarantined under issue #283.)*
- ✅ `session-mode.ts` / `token-mode.ts` only tested indirectly via `service.test.ts`. *(→ ✅ DONE (2026-06-11): direct unit suites `src/lib/approval/__tests__/{token-mode,session-mode}.test.ts` — lock-before-consume ordering, empty-edit rejection, device binding/conflict, supersede+regenerate, publish enqueue + audit shapes.)*
- ✅ Tenant-isolation integration test self-skips without `TEST_DATABASE_POOL_URL` (see P2 CI gap above). *(→ ✅ runs in CI since the test job gained its Postgres service (~2026-06-07); this line was stale — re-verified 2026-06-11.)*

---

## 📋 Incomplete-code inventory (lower-stakes)

- **Pricing page** — Basic/Standard/Premium cards hardcoded `'Coming soon'` + disabled; only Founders claimable (`src/app/(public)/pricing/PricingContent.tsx`). Intentional waitlist mode; flip when those tiers open. *(Unchanged — by design.)*
- **SMS owner self-enrollment** — admin widget exists; owner-facing widget hardcoded "coming soon" regardless of `CHANNELS_SMS_ENABLED` (`ChannelsClient.tsx`). *(Unchanged — intentional post-launch; honest "coming soon" row.)*
- ✅ **Admin Zernio panel** — no force-drain/dismiss buttons for stuck reconnect-queue responses (`ZernioConnectionPanel.tsx`). *(→ ✅ DONE: `POST /api/admin/businesses/[id]/zernio-queue` ships force-drain + per-row dismiss with audit logging; panel buttons added; `TODO(zernio)` removed. See part2 #23b.)*
- ✅ **Signup wizard-complete signal** is a timestamp proxy that can false-positive (`src/app/api/auth/signup-status/route.ts`); planned `business_profile_completed_at` column. *(→ ✅ DONE (2026-06-11): migration 064 adds `accounts.onboarding_wizard_completed_at` (account-level — the wizard is a per-account signup milestone, not a per-location fact), backfilled from the old proxy predicate; `/api/onboarding/business` stamps it in the wizard tx; signup-status's demo branch reads the column only — proxy deleted.)*
- 4 `any` usages (all low-risk UI/Google Maps typing); 8 `eslint-disable` (all `exhaustive-deps`/`no-img-element`). No `debugger`, no `throw "not implemented"` in prod paths.

---

## 📌 Documented open / follow-up work (from project docs)

- ✅ **Modularization (Tier 1):** *DONE* — `worker/jobs/publisher/edit-publish.ts` is now **378 LOC** (was 910; split into `edit-publish-tx.ts` + `edit-publish-errors.ts`) and `StripeLocationsReconcilePoller.ts` is now **185 LOC** (was 617). (`EditReplyDrawer` + `AddLocationWizard` already done.)
- ✅ **Concurrency-guard shim cleanup** — *DONE* — consumers now import directly from `./concurrency-guard`; `tracker.ts` is no longer a re-export shim.
- ✅ **Channel-scoping follow-ups** — *DONE* — PRs #132/#133/#135 merged (dispatcher failure branches + admin per-business channel page now account-scoped).
- ✅ **Telegram/SMS owner routes** — *DONE* — non-`AuthError` exceptions now re-throw (surface as 5xx) instead of collapsing to 401.
- ✅ **CSV bulk-import audit writes** — *DONE* — now writes an audit row via `writeCsvImportAuditLog` (`src/lib/admin/csv-import.ts`).
- ✅ **Worker grace-period clock** — *DONE* — migration 043 added `accounts.past_due_at`; `subscription-guard.ts` now reads `pastDueAt` for the recovery-state computation.
- **Production PostHog dashboards** — not yet created.
- **GBP API application** — pending; gates the full `EDIT_REPLIES_ENABLED` edit-existing-replies path.

---

## Suggested order

1. ✅ **Finish PR #135** (get all 3 channel-scoping PRs merged) — *DONE: #132/#133/#135 all merged.*
2. **P0 ops/config block** (secrets rotation, prod URLs, Stripe live, the two hidden alert/email vars) + the 3 external drills from `docs/launch-checklist.md`. *(Env vars now documented + boot-hardened in code (#156); the remaining work is setting real prod values + drills.)*
3. **Wire Sentry DSN + `TEST_DATABASE_POOL_URL` in CI** — restores error tracking and the RLS gate. *(CI half ✅ DONE — see P2 above; providing the real `SENTRY_DSN` value remains ops.)*
4. ✅ **Close `OutboxPoller` + Resend-signature test gaps.** *DONE (#153, #155).*
5. **Flip `SELF_SERVE_SIGNUP_ENABLED` + `OPENAI_MODERATION_ENABLED`** once prerequisites met.
6. ✅ **P2 cleanups** (IaC, rollback runbook, logging hygiene, founders price column) — *DONE (#154, #152, #157).*
