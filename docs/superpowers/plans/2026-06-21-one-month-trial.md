# 1-Month Free Trial — Implementation Plan (executable, from PLAN.md rev 6)

> **For agentic workers:** Implement task-by-task with TDD (red→green→refactor). Steps use checkbox (`- [ ]`) syntax. Source of truth: `/Users/norbertesekiel/.claude/grill-codex/20260621-025715/PLAN.md` (rev 6, APPROVED). This file is the concrete executable form. Where this disagrees with PLAN.md, PLAN.md wins.

**Goal:** Add a Stripe-native, card-up-front 30-day free trial as the default self-serve onboarding path, behind server-only `TRIAL_ENABLED`. New explicit `'trialing'` subscription status, treated like `'active'` for entitlement except recurring paid ranking (SerpAPI) which stays active-only.

**Architecture:** Stripe is source of truth. DB status is a projection written by ONE applier `applyStripeSubscriptionState(tx, ref, stripeSub)` in `worker/ingress/stripe/shared.ts` (concrete transition table), backstopped by the reconcile poller which gains scoped corrective authority for trial rows. `accounts.trial_ends_at` already exists (migration 034). `subscription_activated_at` is the service-start anchor, set at trial start. No new column.

**Tech Stack:** Next.js 16 (UI), Railway worker (Fastify + BullMQ), Supabase/Postgres (Postgres.js + supabase-js), Stripe (pinned `getStripe()`), Vitest.

**Ground-truth facts (verified):**
- Migration head **068** → new migration is **069**. `accounts.subscription_status` = `VARCHAR(20) NOT NULL DEFAULT 'pending_payment'`, **no CHECK constraint**. `accounts.trial_ends_at TIMESTAMPTZ` exists (034:35). `accounts.subscription_activated_at TIMESTAMPTZ` exists (034:36).
- Status enum: `src/lib/shared/subscription-status.ts` — const object, 4 values, no string literals elsewhere.
- Stripe webhook router: `worker/ingress/stripe.ts` (`handleStripeWebhook`) → per-event handlers in `worker/ingress/stripe/{checkout-completed,subscription-updated,invoice-paid,invoice-payment-failed,subscription-deleted}.ts`. Shared helpers in `worker/ingress/stripe/shared.ts`. `invoice.payment_action_required` NOT handled today.
- Webhook test harness: `worker/ingress/__tests__/stripe-webhook-handlers.test.ts` — hoisted `mockSql` + `sqlReturnQueue` + `sqlCalls`, `mockConstructEvent`, `mockWriteAccountAuditLog`, `jsonb: (v)=>v`.
- Tenant-scope allowlist: `scripts/ci/tenant-scope-allowlist.ts` matches `sqlSnippet` byte-for-byte (normalized). `ALLOWLIST_BASELINE = 372` is an entry **count** (editing text in place keeps count). Shared SQL consts at lines 79/82/85/88. Editing a query's IN-clause REQUIRES editing its matching snippet(s) in lockstep.
- Analytics: `src/lib/analytics/events.ts` (`ANALYTICS_EVENT_NAMES`, `CLIENT_ENQUEUEABLE_EVENT_NAMES`), `src/lib/analytics/enqueue.ts` (`enqueueAnalyticsEvent(input, db)` + `makeAnalyticsEventKey`). CHECK constraint replaced in migration 058. CI audit `scripts/ci/analytics-events-audit.ts` cross-checks code list vs `docs/analytics/events.md` (NOT the migration).

---

## Decisions made autonomously (documented for report)

- **D1 — `subscriptionAllowsDashboardRead('trialing') === true`.** Trial accounts get the full dashboard/KPI surface (§7). Add TRIALING to the function; add a test.
- **D2 — Hero CTA gating.** Landing reads `process.env.TRIAL_ENABLED === 'true'` in `src/app/(public)/page.tsx`, passes `trialEnabled` prop down to `Hero` via `LandingContent`/`SiteShell`. When `trialEnabled && !comingSoon`, primary CTA label = "Start your 30-day free trial". No `NEXT_PUBLIC_*` (inv #13). When off, behavior is byte-for-byte today's.
- **D3 — Applier owns mapping; handlers keep post-commit backfill.** The applier is the single status writer; each webhook handler calls it inside `sql.begin` and runs `maybeEnqueueBackfillResume` post-commit best-effort (`.catch`). Existing handlers are refactored to delegate status writes to the applier where the transition table covers them, but pre-existing tier/locations_paid logic in `subscription-updated` stays (applier handles status; tier sync stays in the handler). This bounds blast radius: applier owns status+audit+overage-on-status-change+trial_ends_at+activated-at; handler keeps tier/quantity.
- **D4 — `trial_started` analytics event_key.** `makeAnalyticsEventKey('trial_started', [accountId])` (one trial-start per account is the lean-abuse posture; residual multi-account abuse accepted per §0.2). Convert/fail/cancel keyed by `[accountId, stripeSubscriptionId]` so a re-trial on a new subscription emits fresh lifecycle events.
- **D5 — Trial events distinctId = accountId** (mirrors offboarding events).
- **D6 — Migration 069 scope:** clarifying COMMENT on `accounts.subscription_activated_at` + replace `analytics_events_event_name_check` to add the 4 trial events. Single migration file, transactional, no CONCURRENTLY, no data backfill. (Two logically-distinct DDLs but one feature; staging-first.)
- **D7 — Applier ref by checkout uses `client_reference_id` = accountId; subscription mode resolves account by `stripe_customer_id` + verifies `stripe_subscription_id` to ignore stale subs** (mirrors existing subscription-updated/deleted stale-sub guard).
- **D8 — Trial start path:** `checkout.session.completed` retrieves the subscription ONLY when `payment_status==='no_payment_required'` (a `paid` session is never a trial-start — avoids a needless Stripe retrieve on the hot paid path). If retrieved sub `status==='trialing'` with future `trial_end` and matching customer → applier `trialing` (checkout mode). Otherwise (active/paid/invalid-trial) the unchanged inline paid activation owns it. A trialing sub NEVER falls through to inline paid activation.
- **D9 — Convert via `subscription.updated`, not `invoice.paid`.** The plan (§4.12) says route convert through the applier "via `subscription.updated` + `invoice.paid`". Stripe ALWAYS emits `customer.subscription.updated` with `status:'active'` at trial→paid conversion, and that event carries the authoritative `sub.status` (the §4.12 gate). So `subscription.updated` is the primary converter (gate: DB `trialing` AND `sub.status==='active'`). `invoice.paid` keeps its existing `past_due→active` recovery only — adding a trialing-convert there would need an extra Stripe retrieve to confirm `status==='active'` (the invoice event lacks it) and would be redundant with the guaranteed subscription.updated. The $0 trial-start invoice.paid therefore does NOT convert. card-fail/SCA → past_due via applier (trialing source); cancel → cancelled via applier (trialing source). New `invoice.payment_action_required` handler delegates to the payment-failed past_due path.

---

## File map

**New files:**
- `supabase/migrations/069_trial_subscription.sql` — column comment + analytics CHECK.
- `worker/ingress/stripe/apply-subscription-state.ts` — `applyStripeSubscriptionState` applier + transition table + result type. (Kept separate from `shared.ts` to keep `shared.ts` lean and the applier independently testable; re-exported from `shared.ts` for handler imports.)
- `worker/ingress/stripe/__tests__/apply-subscription-state.test.ts` — transition-table units.
- `src/lib/analytics/trial-events.ts` — `enqueueTrialStarted/Converted/PaymentFailed/Cancelled` helpers (in-tx).
- `src/lib/analytics/__tests__/trial-events.test.ts`.
- `worker/ingress/stripe/__tests__/checkout-trial.test.ts` — `no_payment_required` + retrieve + $0-invoice-no-convert + trial→active.
- `src/components/dashboard/account-state/TrialBanner.tsx` + test.
- Stripe **test-clock acceptance** spec: `worker/ingress/stripe/__tests__/trial-test-clock.acceptance.test.ts` (skipped unless live Stripe env present; documents the day-30 boundary, cancel-in-trial $0, mid-trial add-location $0, mid-trial tier-change $0).

**Modified (status enum + guards):** `subscription-status.ts`, `subscription-guard.ts`, `writable-subscription.ts`, `auth/resolve-owner-scope.ts`, `auth/require-owner-access.ts`.
**Modified (Stripe lifecycle):** `worker/ingress/stripe.ts`, `checkout-completed.ts`, `subscription-updated.ts`, `invoice-paid.ts`, `invoice-payment-failed.ts`, `subscription-deleted.ts`, `shared.ts`.
**Modified (entitlement sweep ALLOW):** `db/account-guard.ts`, `locations/multi-location-mode.ts`, `accounts/quota.ts`, `accounts/tier-change.ts`, `admin/channels/_shared/start.ts`, `OnboardingDripScheduler.ts`, `OnboardingDripWorker.ts`, `UpdateStripeOverageWorker.ts`, `onboarding/business/route.ts`, `onboarding/business/guard.ts`, `dashboard/channels/route.ts`, `dashboard/route.ts`, `EmailChannelReconcilePoller.ts`, `EngagementMonitorPoller.ts`, `WeeklySummaryScheduler.ts`, `MonthlyImpactScheduler.ts`, `StripeLocationsReconcilePoller.ts`, `margin-service.ts`.
**Modified (BLOCK):** `billing/checkout/route.ts`.
**Modified (reconcile corrective):** `billing-reconciliation/reconcile-account.ts`.
**Modified (UI funnel):** landing `page.tsx`/`Hero.tsx`/`LandingContent.tsx`/`SiteShell`, onboarding `start/pay/demo` pages, `loginDestination.ts`, `signup-status/route.ts`, `PaymentSuccessClient.tsx`, dashboard `route.ts` (trialEndsAt), `SubscriptionStatusBanner.tsx`, `AnalyticsContent.tsx`, `ReviewsContent.tsx`, admin `ChannelsPanel.tsx`.
**Modified (allowlist + analytics + docs):** `scripts/ci/tenant-scope-allowlist.ts`, `src/lib/analytics/events.ts`, `docs/analytics/events.md`, `.env.example`, `.claude/reference/env-vars.md`, `.claude/reference/migrations-log.md`, `src/lib/shared/__tests__/subscription-status.test.ts`.

---

## Phases (each ends with a commit + checkpoint)

- **Phase 1 — Enum + dashboard-read.** `TRIALING` constant, `subscriptionAllowsDashboardRead`, enum tests. (Foundation; everything imports this.)
- **Phase 2 — Guards + service-start anchor.** `checkSubscription`, `writable-subscription`, `resolve-owner-scope`, `require-owner-access`. Migration 069 column comment.
- **Phase 3 — The applier.** `applyStripeSubscriptionState` + transition table + result + analytics-in-tx + tests (red→green).
- **Phase 4 — Webhook lifecycle via applier.** checkout (trial start), subscription.updated/invoice.paid (convert), payment_failed + payment_action_required (past_due), subscription.deleted (cancel). Router wiring. Tests.
- **Phase 5 — Reconcile corrective authority.** reconcile-account corrects stuck trial rows via applier. Tests.
- **Phase 6 — Entitlement sweep (ALLOW).** 18 ALLOW sites + tenant-scope allowlist snippet updates. Confirm ranking sites stay active-only. Tests where present.
- **Phase 7 — Checkout BLOCK + checkout-session trial_period_days.** Reject trialing from new checkout; thread `subscription_data.trial_period_days` into `createCheckoutSession` when TRIAL_ENABLED + pending_payment. Tests.
- **Phase 8 — Analytics events.** TS const + migration CHECK (069) + docs + helpers wired into applier. Tests + `ci:analytics-events`.
- **Phase 9 — UI funnel.** Hero CTA, onboarding redirects, loginDestination, signup-status, PaymentSuccessClient, dashboard trialEndsAt, TrialBanner, Analytics/Reviews/Channels gating, admin ChannelsPanel. Tests.
- **Phase 10 — Env docs + test-clock acceptance + full gate.** `.env.example`, `env-vars.md`, `migrations-log.md`. Test-clock acceptance spec (skipped offline). Run full verification gate.

Detailed task code lives inline as each phase executes (TDD). The verification gate after every phase: `pnpm typecheck` + the affected test file(s). Final gate (Phase 10): `pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events`.
</content>
</invoke>
