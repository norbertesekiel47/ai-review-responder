# Launch Ready — Part 1: Production Readiness Audit

> **Date:** 2026-05-28
> **Scope:** Full-codebase audit of what remains before RepWorth goes to production (GA / self-serve launch).
> **Method:** Five parallel read-only audits (incomplete code, test coverage, env/deploy config, architecture invariants) + ground-truth command runs (`lint`, `typecheck`, `build`, `test`, CI audits) on `main` @ `d614b0c9`.
> **Companion doc:** `docs/launch-checklist.md` tracks external/operational readiness. This file is the code-side audit.

---

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

### Flaky test note
`worker/jobs/notification/__tests__/bounced-skip.test.ts` reported 2 failures during a full-suite parallel run (one 5000ms timeout, one fixture-ordering assertion: `"Response resp-1 belongs to business undefined, not biz-1"`). Re-run in isolation it passes **4/4 twice**, and CI on `main` is green. → **Flakiness under parallel load, not a correctness bug.** Worth hardening (event-based waits instead of fixed timeout; isolate the SQL-mock queue).

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
4. **Set `ADMIN_NOTIFICATION_EMAIL`** — **undocumented in `.env.example`** but all admin exception/failover/engagement alerts route here and **silently drop if unset** (`worker/jobs/AdminExceptionWorker.ts:121`, `worker/background/pollers/NotificationFailoverPoller.ts:172`, `worker/jobs/EngagementAlertWorker.ts:227`). Highest-risk hidden var.
5. **Set `CONTACT_NOTIFY_TO`** — undocumented; contact/demo/lead emails silently fall back to a personal Gmail (`src/app/api/contact/route.ts:8`, `demo-request/route.ts:8`, `lead-intake/route.ts:145`).
6. **External drills from `docs/launch-checklist.md` (can't verify from repo):**
   - PITR restore drill never run (🔴).
   - Email auth (DKIM/SPF/DMARC) unconfirmed — the approval email loop *is* the product (🔴).
   - Legal docs (ToS/Privacy/AUP/DPA) live at `/legal/*` but lawyer-unreviewed (🔴).

---

## 🟠 P1 — Before paying customers

- **`SENTRY_DSN` blank** in both env files — Sentry fully wired (`src/instrumentation.ts`, `worker/sentry.ts`) but silently no-ops; prod errors untracked.
- **Cost circuit-breakers undocumented** — `DAILY_COST_LIMIT_CENTS_FOUNDING/STANDARD/PREMIUM` (500/1000/2000¢) + `GLOBAL_DAILY_COST_LIMIT_CENTS` (10000¢) have code defaults but aren't in `.env.example`. Set consciously before live LLM calls.
- **`STRIPE_PRICE_FOUNDING` + all `STRIPE_PRICE_*`** must be set before flipping `SELF_SERVE_SIGNUP_ENABLED`, or checkout/webhook silently mishandles tiers (`create-checkout-session.ts`, `subscription-updated.ts`).
- **`IMPERSONATION_COOKIE_SECRET`** required before admin "view-as" works (fails closed). `openssl rand -hex 32`.
- **`LIST_UNSUBSCRIBE_EMAIL` unset** → marketing emails fail Gmail/Outlook bulk-sender compliance (`src/lib/notifications/email/headers.ts:65`).
- **Public pricing copy bug** — Premium bullet reads *"Multiple approval notification channels, if implemented"* at `src/app/(public)/pricing/PricingContent.tsx:108`. Ships to every visitor.

---

## 🟡 P2 — Before scale / GA polish

- **No IaC for Railway** (no `railway.toml`/`Dockerfile`/Nixpacks) and **no `vercel.json`** — both deploy from dashboard config only. Add `railway.toml` (`startCommand = "pnpm worker"`, `healthcheckPath = "/api/health"`) so config survives project recreation; add `vercel.json` if any route needs a timeout above plan defaults.
- **`TEST_DATABASE_POOL_URL` not in CI** → cross-tenant RLS isolation test (`src/__tests__/tenant-isolation.test.ts`) and 13 Playwright E2E tests never run in the PR gate. Strongest correctness guarantee, currently dark.
- **PII in `console.log`** — `src/app/api/contact/route.ts:47`, `demo-request/route.ts:72`. Plus 4 worker schedulers use raw `console.log` instead of `createWorkerLogger`: `OnboardingDripScheduler.ts`, `WeeklySummaryScheduler.ts`, `MonthlyImpactScheduler.ts`, `StripeLocationsReconcilePoller.ts`.
- **No `docs/runbooks/rollback.md`** (only the Zernio kill-switch is documented in the beta plan §10.5).
- **Founders tier price-lock gap** — no `accounts.base_price_cents` column; if `TIER_CONFIG.baseCents` ever changes, the "3-year price lock" silently drifts (`src/lib/accounts/quota.ts:90`, `src/lib/admin/margin-service.ts:64`).
- **Demo page view counter** — direct hot-row Postgres `UPDATE` on every page load (`src/app/(public)/demo/[slug]/page.tsx:54`); fine at low traffic, bottleneck at scale.
- **`ADMIN_API_KEY` confusion** — `.env.example` implies it guards `/api/admin/*`, but routes actually use `requireRole(request, 'admin')`; the var is referenced nowhere. Stale comment; consider removing or adding a real prod assertion.

---

## 🚦 Launch-gating flag flips (currently all off)

| Flag | Prerequisite before flipping ON |
|---|---|
| `SELF_SERVE_SIGNUP_ENABLED` | Stripe prices + Supabase SMTP + OTP email templates using `{{ .Token }}` (NOT `{{ .ConfirmationURL }}`) |
| `OPENAI_MODERATION_ENABLED` | Threshold tuning on real samples (local regex runs regardless) |
| `MFA_ENFORCEMENT_ENABLED` | Regression pass (AAL2 already enforced at sensitive routes; this only adds page-nav redirect) |
| `MULTI_LOCATION_ENABLED` | `STRIPE_PRICE_*_OVERAGE` ids; migrations 034–041 already shipped |
| `CHANNELS_SMS_ENABLED` | Twilio 10DLC registration (not critical path) |
| `CHANNELS_WHATSAPP_ENABLED` | Meta Business verification (2–4 wks) + WABA + template approval (not critical path) |
| `CHANNELS_TELEGRAM_ENABLED` | Prod `@RepWorthBot` + `setWebhook` (not critical path) |
| `RANKING_TRACKING_ENABLED` | Note: `RankingTrackingWorker.ts:161` caps at 1 keyword/business (temp rollout limit never lifted) |

---

## 🔧 In-flight work (3 open PRs — finish these)

All three fix the same class of bug: **multi-location channel enrollment keyed by `business_id` instead of `account_id`**, causing misfired Twilio charges and stuck "active" enrollments on multi-location accounts.

| PR | Title | CI |
|---|---|---|
| **#135** | account-scope SMS admin enrollment lock + cross-channel precheck | **was failing, last run in progress — needs attention** |
| #133 | account-scope dispatcher enrollment failure writes | green |
| #132 | surface account-scoped org-default channel rows on business detail | green |

Worktrees under `.claude/worktrees/` back these three (all clean) + a `tracker-concurrency-shim-removal` refactor (spec only, not started).

---

## 🧪 Test-coverage gaps worth closing

**P0:**
- **No test for `OutboxPoller`** (`worker/background/pollers/OutboxPoller.ts`) — drives the *entire* outbox dispatch/watchdog/dead-letter path. A regression silently halts all generation + publishing. Add: watchdog reset, dispatch, attempt-guard, dead-letter.
- **Resend webhook signature acceptance path untested** — tests bypass via `MOCK_EXTERNAL_APIS=true`; only the rejection path is covered (`worker/ingress/resend.ts:24-66`). Add real svix HMAC accept + stale-timestamp reject.

**P1:**
- **`hasOpenFlag` (`src/lib/moderation/held-draft.ts`)** has no direct unit test — a typo in its `status='open'` predicate would silently release held drafts.
- **`past_due`/`pending_payment` subscription guard** tested in the pure unit but not exercised in worker integration tests.

**P2:**
- Permanently-skipped e2e: `e2e/forgot-password.spec.ts` (4), `e2e/reset-password.spec.ts` (3), `e2e/signup-google.spec.ts` (1) — all `test.skip(true, ...)` (harness not wired).
- `session-mode.ts` / `token-mode.ts` only tested indirectly via `service.test.ts`.
- Tenant-isolation integration test self-skips without `TEST_DATABASE_POOL_URL` (see P2 CI gap above).

---

## 📋 Incomplete-code inventory (lower-stakes)

- **Pricing page** — Basic/Standard/Premium cards hardcoded `'Coming soon'` + disabled; only Founders claimable (`src/app/(public)/pricing/PricingContent.tsx:59,80,102`). Intentional waitlist mode; flip when those tiers open.
- **SMS owner self-enrollment** — admin widget exists; owner-facing widget hardcoded "coming soon" regardless of `CHANNELS_SMS_ENABLED` (`ChannelsClient.tsx:72-76`).
- **Admin Zernio panel** — no force-drain/dismiss buttons for stuck reconnect-queue responses (`ZernioConnectionPanel.tsx:236`).
- **Signup wizard-complete signal** is a timestamp proxy that can false-positive (`src/app/api/auth/signup-status/route.ts:139`); planned `business_profile_completed_at` column.
- 4 `any` usages (all low-risk UI/Google Maps typing); 8 `eslint-disable` (all `exhaustive-deps`/`no-img-element`). No `debugger`, no `throw "not implemented"` in prod paths.

---

## 📌 Documented open / follow-up work (from project docs)

- **Modularization (Tier 1):** `worker/jobs/publisher/edit-publish.ts` (910 LOC), `StripeLocationsReconcilePoller.ts` (617 LOC). (`EditReplyDrawer` + `AddLocationWizard` already done.)
- **Concurrency-guard shim cleanup** — migrate consumers off `tracker.ts` re-export to `./concurrency-guard` (spec written, not started).
- **Channel-scoping follow-ups** — covered by PRs #132/#133/#135 above; plus migrate dispatcher failure branches and admin per-business channel page to account-scope.
- **Telegram/SMS owner routes** — re-throw non-`AuthError` instead of collapsing to 401.
- **CSV bulk-import audit writes** — migrate to `writeAccountAuditLog`.
- **Worker grace-period clock** — switch to new `past_due_at` column.
- **Production PostHog dashboards** — not yet created.
- **GBP API application** — pending; gates the full `EDIT_REPLIES_ENABLED` edit-existing-replies path.

---

## Suggested order

1. **Finish PR #135** (get all 3 channel-scoping PRs merged) — active failing CI.
2. **P0 ops/config block** (secrets rotation, prod URLs, Stripe live, the two hidden alert/email vars) + the 3 external drills from `docs/launch-checklist.md`.
3. **Wire Sentry DSN + `TEST_DATABASE_POOL_URL` in CI** — restores error tracking and the RLS gate.
4. **Close `OutboxPoller` + Resend-signature test gaps.**
5. **Flip `SELF_SERVE_SIGNUP_ENABLED` + `OPENAI_MODERATION_ENABLED`** once prerequisites met.
6. **P2 cleanups** (IaC, rollback runbook, logging hygiene, founders price column).
