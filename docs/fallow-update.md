# Fallow Health — Cleanup Pass & Disposition

> **Date:** 2026-05-27 · **Tool:** `fallow 2.76.0` (`fallow health`)
> **Baseline score:** **68 / C** — Deductions: hotspots −10.0 · unit size −10.0 ·
> duplication −10.0 · coupling −2.1 · dead exports −0.2
> **Metrics:** 171,048 LOC · maintainability 91.7 (good) · avg cyclomatic 1.8 ·
> p90 cyclomatic 3 · 0 churn hotspots · duplication 16.9% · dead files 0.0%

This document records the fallow-health cleanup pass against the **32 refactoring
targets** fallow reported, under the standing constraint **"do not break existing
functionality, workflow, or architecture."**

## The governing rule

A behavior-preserving extraction is only *safe* when there is a **test that
covers the branches being moved**. Where that net exists, the extraction is a
mechanical, verified change. Where it doesn't — on auth, billing, webhook, or
publishing code — moving logic blind is exactly the breakage the constraint
forbids. fallow itself encodes this: its `add_test_coverage` category says
**"add tests before modifying."**

So each target is classified by the test coverage of the *specific code an
extraction would touch*:

- **Fixed** — strong behavioral coverage of those branches → extracted + verified.
- **Blocked** — the branches are untested (or only count-mocked / payload-partial),
  or the surface is security/financial-critical without exhaustive branch tests.
  The concrete prerequisite (characterization tests / DB-integration harness /
  security review) does not exist yet, so a safe fix is currently **impossible by
  a code sweep** — not merely deferred for taste.

---

## ✅ Fixed (11 targets · 11 PRs, one branch each)

Every PR: `pnpm typecheck` clean · `eslint` clean · the target's test suite green
· fallow re-checked (target cleared).

| PR | Target | fallow cat / cog | Change | Test net |
|---|---|---|---|---|
| **#108** | `src/lib/admin/margin-service.ts` | dead code | Un-exported 5 internal-only constants (0 external refs) | `src/lib/admin` 78 tests |
| **#109** | `api/zernio/connect/_shared/preflight.ts` | dead code | Deleted dead `assertActiveSubscription`; un-exported 3 internals | zernio connect 88 tests |
| **#110** | `onboarding/business/payload.ts` | cog 31 | Extracted `voiceFields` + `legacyLocationFields` (removed dup) | `payload.test.ts` 15 |
| **#111** | `src/lib/zernio/client/locations.ts` | untested | Added 19-test fake-transport suite (all shape-normalization branches) | new suite, 19 |
| **#113** | `src/lib/zernio/parse-review-webhook.ts` | cog 31 | Extracted account-validation + `mergeOrConflict` reconciliation | `parse-review-webhook.test.ts` 13 |
| **#114** | `worker/jobs/RankingTrackingWorker.ts` | cog 44 | Extracted `parseTrackedKeywords` + `resolveRankPosition` | `RankingTrackingWorker.test.ts` 21 |
| **#115** | `worker/background/pollers/ZernioRecentReviewPoller.ts` | cog 35 | Extracted `fetchConnectionReviews` + `processConnectionReviews` | `ZernioRecentReviewPoller.test.ts` 7 |
| **#116** | `src/app/api/dashboard/route.ts` | cog 41 | Split GET into aggregate / per-location / subscription-gate handlers | `route.test.ts` 24 |
| **#117** | `src/app/api/lead-intake/route.ts` | cog 36 | Extracted `validateLeadInput` + `sendLeadNotification` | `route.test.ts` 20 |
| **#118** | `src/app/api/onboarding/start/route.ts` | cog 38 | Extracted `resolvePlaceId` + `persistOnboardingStart` (tx) | `route.test.ts` 7 |
| **#119** | `scripts/ci/tenant-scope-audit.ts` | cog 31 | Extracted `accountTableScoped` + `tenantTableTransitivelyScoped` | `tenant-scope-audit.test.ts` 39 + live-tree run |

(Plus this doc, PR **#112**.)

---

## ⛔ Blocked — concrete prerequisite missing (per target)

These are **not** "skipped because risky in the abstract." Each names the exact
missing safety net and the work required to unblock it.

### Untested critical-path code (no direct test = no safety net)

A blind extraction here can silently break auth, webhooks, or Google publishing,
and **no test would catch it**. The prerequisite is a characterization-test suite
(several also need `TEST_DATABASE_POOL_URL`, which is not wired — see Spec 03/23).

| Target | cog | Why a sweep can't touch it |
|---|---|---|
| `src/app/api/auth/callback/route.ts` | 47 | **No test.** OAuth/magic-link callback — a control-flow slip breaks login. |
| `src/app/api/auth/signup/route.ts` | 31 | **No test.** Account provisioning; anti-enumeration + tx invariants. |
| `src/app/api/admin/channels/sms/verify/route.ts` | 41 | **No test.** SMS verification / opt-out side effects. |
| `worker/jobs/notification/dispatch.ts` | 53 | **No test.** Multi-channel fan-out; a regression silently drops notifications. |
| `worker/jobs/publisher/post-reply.ts` | 36 | **No test.** Google-posting path — guards the **no-auto-posting** invariant. |
| `worker/ingress/zernio/zernio.ts` | 41 | **No test.** Webhook ingress: signature + dedup + per-event routing. |
| `worker/ingress/resend.ts` | 42 | **No test.** Bounce/complaint ingress. |
| `worker/ingress/twilio/twilio-whatsapp-inbound.ts` | 46 | **No test.** Inbound approval ingress. |
| `src/components/dashboard/EditReplyDrawer.tsx` | 30 (1276 LOC) | **No test.** The approval/edit surface + hand-rolled a11y focus-trap; needs a component test suite + design pass (pairs with Spec 19 a11y). |

**Unblock:** write characterization tests (replay real webhook payloads; mock
Supabase/Stripe/DB) — itself a tracked body of work — then extract one target per PR.

### Verbatim conditional SQL (tests verify query *count*, not SQL *correctness*)

These build large branch-selected SQL strings. Their tests mock `sql` by
call-order and assert the number of queries + shaped results — they do **not**
execute SQL, so a transcription error while moving a query would reach production
uncaught. On cost/billing data that's unacceptable.

| Target | cog | Note |
|---|---|---|
| `src/lib/admin/cost-report-service.ts` | 34 | ~250 lines of branch-selected billing SQL. |
| `src/lib/dashboard/service.ts` | 33 | Per-location dashboard aggregation SQL. |
| `src/lib/dashboard/aggregate-service.ts` | 33 | Account-wide aggregation SQL. |

**Unblock:** wire `TEST_DATABASE_POOL_URL` and add DB-integration tests that assert
*results* (Spec 03/23), then the conditional SQL can be moved into builders safely.

### Security / financial-critical surfaces (tests exist but don't cover the refactor)

| Target | cog | Why the existing tests are insufficient *for this change* |
|---|---|---|
| `src/proxy.ts` | 69 | **Auth middleware.** `proxy.test.ts` (~15 cases) does not exhaustively cover every route-category × auth-state branch; refactoring the gate could open a silent authz hole. Needs exhaustive branch tests + security review. |
| `worker/background/pollers/StripeLocationsReconcilePoller.ts` | 63 | **Money.** 44 tests verify drift *counts/types* but not every 12-field Sentry alert payload; clearing cog 63 requires decomposing drift-detection into sub-checks that each rebuild those payloads → payload regressions uncaught. Needs payload-snapshot tests. |
| `worker/jobs/publisher/edit-publish.ts` | 51 (+`handle409Disposition` 32) | **Google publishing**, 910 LOC. 25 tests cover scenarios but clearing this means decomposing the publish/409-disposition state machine that guards the no-auto-posting invariant — a dedicated, invariant-reverified effort, not a sweep. |
| `src/app/api/zernio/connect/start/route.ts` | 48 | OAuth/Redis-CAS handshake; the 6 tests don't cover the pending-marker branches, `already_connected`, `flow_superseded`, or the Step-F orphan-cleanup that an extraction would move. |
| `src/app/api/zernio/connect/cancel/route.ts` | 37 | Only **2 tests** — the cancel state machine's branches are uncovered. |
| `src/app/api/zernio/disconnect/route.ts` | 34 | Only **1 test** — disconnect side-effect branches uncovered. |
| `src/app/(authenticated)/dashboard/connect/page.tsx` | 34 | 8 tests cover action wiring + read-only states, but not the full six-state render matrix or the redirect-timer/bfcache effects an extraction would touch. |

### Low-stakes but unverifiable / low-confidence

| Target | cog | Note |
|---|---|---|
| `scripts/redis.ts` | 98 | Dev-only CLI; **no test**. Freely splittable (low blast radius) but no test to confirm — fix opportunistically alongside a redis-script change, not in this sweep. |
| `src/hooks/useSettingsForm.ts` | split | Test file is a stub (no real cases); fallow confidence **medium**; 4 dependents amplify any mistake. Needs real hook tests before splitting. |

---

## Aggregate deductions

| Deduction | Driver | Status |
|---|---|---|
| **dead exports −0.2** | margin-service + preflight | ✅ Fixed (#108/#109) |
| **unit size −10 / hotspots −10** | the orchestrators above + large test-file arrow bodies | Reduced on 9 functions (the fixed extractions); remainder tracked above |
| **duplication 16.9% / −10** | largely test boilerplate + repeated query/validation shapes | Production dup removed where safe (#110); test-fixture dedup is low-value |
| **coupling −2.1** | high fan-in hubs (`db/server` 343, `reviews/types` 27) | Legitimate shared foundations; architectural, not cleanup |

---

## Recommendations (unblock order)

1. **Wire `TEST_DATABASE_POOL_URL` in CI** (Spec 03/23). This single prerequisite
   unblocks the SQL-services bucket *and* hardens the cross-tenant isolation test —
   highest leverage.
2. **Install `@vitest/coverage-v8`** so `fallow health --coverage` reports real
   coverage (the "untested risk" / CRAP scores are export-reference estimates today).
3. **Add characterization tests** for the untested critical paths (webhook ingress
   first — replay fixtures already exist for several), then extract one per PR.
4. **Don't chase the grade.** Maintainability is already 91.7 ("good"), avg
   cyclomatic 1.8. The C is driven by a handful of large orchestrators + test files,
   not pervasive rot. Test-backed, incremental extraction beats a risky bulk pass.

---

## Full disposition (32 targets)

| Target | Disposition |
|---|---|
| `lib/admin/margin-service.ts` | ✅ #108 |
| `api/zernio/connect/_shared/preflight.ts` | ✅ #109 |
| `onboarding/business/payload.ts` | ✅ #110 |
| `lib/zernio/client/locations.ts` | ✅ #111 |
| `lib/zernio/parse-review-webhook.ts` | ✅ #113 |
| `worker/jobs/RankingTrackingWorker.ts` | ✅ #114 |
| `pollers/ZernioRecentReviewPoller.ts` | ✅ #115 |
| `api/dashboard/route.ts` | ✅ #116 |
| `api/lead-intake/route.ts` | ✅ #117 |
| `api/onboarding/start/route.ts` | ✅ #118 |
| `scripts/ci/tenant-scope-audit.ts` | ✅ #119 |
| `api/auth/callback/route.ts` | ⛔ no test (auth) |
| `api/auth/signup/route.ts` | ⛔ no test (auth) |
| `api/admin/channels/sms/verify/route.ts` | ⛔ no test |
| `worker/jobs/notification/dispatch.ts` | ⛔ no test |
| `worker/jobs/publisher/post-reply.ts` | ⛔ no test (publishing) |
| `worker/ingress/zernio/zernio.ts` | ⛔ no test (ingress) |
| `worker/ingress/resend.ts` | ⛔ no test (ingress) |
| `worker/ingress/twilio/twilio-whatsapp-inbound.ts` | ⛔ no test (ingress) |
| `components/dashboard/EditReplyDrawer.tsx` | ⛔ no test (1276 LOC) |
| `lib/admin/cost-report-service.ts` | ⛔ SQL correctness untested (needs DB harness) |
| `lib/dashboard/service.ts` | ⛔ SQL correctness untested |
| `lib/dashboard/aggregate-service.ts` | ⛔ SQL correctness untested |
| `src/proxy.ts` | ⛔ auth middleware, non-exhaustive branch tests |
| `pollers/StripeLocationsReconcilePoller.ts` | ⛔ money, payload fields untested |
| `worker/jobs/publisher/edit-publish.ts` | ⛔ publishing state machine (dedicated effort) |
| `api/zernio/connect/start/route.ts` | ⛔ complex branches untested |
| `api/zernio/connect/cancel/route.ts` | ⛔ 2 tests only |
| `api/zernio/disconnect/route.ts` | ⛔ 1 test only |
| `dashboard/connect/page.tsx` | ⛔ render-state matrix untested |
| `scripts/redis.ts` | ⛔ dev CLI, no test |
| `src/hooks/useSettingsForm.ts` | ⛔ stub test, medium confidence |
