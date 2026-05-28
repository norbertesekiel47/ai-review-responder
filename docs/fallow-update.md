# Fallow Health — Cleanup Pass & Disposition

> **Date:** 2026-05-27 · **Tool:** `fallow 2.76.0` (`fallow health`)
> **Baseline score:** **68 / C** — Deductions: hotspots −10.0 · unit size −10.0 ·
> duplication −10.0 · coupling −2.1 · dead exports −0.2
> **Metrics:** 171,048 LOC · maintainability 91.7 (good) · avg cyclomatic 1.8 ·
> p90 cyclomatic 3 · 0 churn hotspots · duplication 16.9% · dead files 0.0%

This document records the fallow-health cleanup pass: **what was fixed**, and —
per the standing constraint **"do not break existing functionality, workflow, or
architecture"** — **what was deliberately deferred and why**, with a safe path
forward for each.

The guiding principle: a health *sweep* may only make changes that are provably
behavior-preserving. fallow reports **32 refactoring targets**; 28 of them are
"extract complex function" recommendations on **entry-point orchestrators**
(API route handlers, webhook ingress, background pollers, worker jobs) and large
UI components — exactly the code CLAUDE.md designates as intentional orchestration
with auth/billing/publishing/webhook blast radius. Refactoring those safely
requires per-function, test-first work, not a sweep. They are documented here as
a prioritized backlog rather than rushed.

---

## ✅ Fixed in this pass (4 PRs, one branch each)

| PR | Target (fallow pri) | Category | Change | Risk |
|---|---|---|---|---|
| **#108** | `src/lib/admin/margin-service.ts` (26) | dead code | Un-exported 5 internal-only constants (0 external refs); surfaced via `MarginData.thresholds` | None — no behavior change |
| **#109** | `src/app/api/zernio/connect/_shared/preflight.ts` (25) | dead code | Deleted fully-dead `assertActiveSubscription` (+ unused import); un-exported 3 internal-only symbols | None — public preflight API unchanged |
| **#110** | `src/app/onboarding/business/payload.ts` (16.5) | complexity | Extracted pure `voiceFields()` + `legacyLocationFields()`; removed verbatim-duplicated voice block | None — 15 tests confirm parity |
| **#111** | `src/lib/zernio/client/locations.ts` (18.2) | untested risk | Added 19-test fake-transport suite covering all shape-normalization branches | None — additive only |

**Why these four:** all are either pure dead-code removal (verified zero external
references) or pure-function / additive-test work with no side effects and existing
or new test coverage proving parity. They move the dead-exports metric
(1.1% → ~0.8% and lower once merged) and implement fallow's own "add tests before
modifying" recommendation for the location client.

**Verification for every PR:** `pnpm typecheck` clean · `eslint` clean ·
relevant `vitest` suite green · fallow re-checked (dead-code targets cleared;
payload no longer a target).

---

## ⏸️ Deferred — with reasoning and safe path forward

### A. Entry-point API route handlers (9 targets) — **deferred**

`api/dashboard/route.ts` (GET, cog 41) · `api/auth/callback/route.ts` (GET, cog 47) ·
`api/auth/signup/route.ts` (POST, cog 31) · `api/onboarding/start/route.ts` (POST, cog 38) ·
`api/zernio/connect/start/route.ts` (cog 48) · `api/zernio/connect/cancel/route.ts` (cog 37) ·
`api/zernio/disconnect/route.ts` (cog 34) · `api/lead-intake/route.ts` (cog 36) ·
`api/admin/channels/sms/verify/route.ts` (cog 41)

**Why deferred:** CLAUDE.md invariant — *"Entry points orchestrate; modules own
failure behavior. Route handlers … may validate, orchestrate, and map errors."*
Much of the cyclomatic count in these handlers is request validation + error
mapping + cookie/redirect handling that is intentionally co-located. These sit on
auth, billing, OAuth-handshake, and signup paths where a subtle change in control
flow can silently break login, checkout, or the Zernio connect dance. They are
also high-churn (callback/signup/connect appear in the hotspot list), so churning
them again now would *worsen* the hotspot metric short-term.

**Safe path forward (per handler, not a sweep):** the invariant already prescribes
it — *"Extract any error-handling branch over ~30 lines into a named module
interface next to its caller, with focused tests for the branch."* Do one handler
at a time: write characterization tests for the current behavior first, extract the
validation/error-mapping branch into a sibling module, confirm the test suite +
e2e are green, ship as its own PR.

### B. Third-party webhook ingress (3 targets) — **deferred**

`worker/ingress/zernio/zernio.ts` (`handleZernioWebhook`, cog 41) ·
`worker/ingress/resend.ts` (`handleResendWebhook`, cog 42) ·
`worker/ingress/twilio/twilio-whatsapp-inbound.ts` (`handleTwilioWhatsAppInbound`, cog 46)

**Why deferred:** CLAUDE.md — *"Third-party ingress terminates on Railway."* These
are the live entry points for Stripe/Resend/Twilio/Zernio events; their branching
encodes signature verification, idempotency/dedup, and per-event-type routing.
Breakage here means dropped reviews, missed bounces, or lost approvals — with no
user-visible error until data goes missing. Highest blast radius in the codebase.

**Safe path forward:** extract per-event-type handlers behind a dispatch map,
guarded by integration tests that replay real webhook payloads (fixtures already
exist for several). Requires `TEST_DATABASE_POOL_URL` to be wired (see Spec 03/23)
so the dedup/outbox paths are exercised end-to-end.

### C. Background pollers & worker jobs (6 targets) — **deferred**

`StripeLocationsReconcilePoller.ts` (`runOnce`, **cog 63**) ·
`ZernioRecentReviewPoller.ts` (`runOnce`, cog 35) ·
`worker/jobs/notification/dispatch.ts` (`dispatchAll`, **cog 53**) ·
`worker/jobs/publisher/edit-publish.ts` (cog 51 + `handle409Disposition` cog 32) ·
`worker/jobs/publisher/post-reply.ts` (cog 36) ·
`worker/jobs/RankingTrackingWorker.ts` (`handleTrackRanking`, cog 44)

**Why deferred:** CLAUDE.md — *"Entry points orchestrate; modules own durable side
effects."* These own transactional-outbox writes, reconciliation drift detection,
and Google-posting publish paths (including the no-auto-posting invariant). The
reconcile/dispatch/publish logic is genuinely complex because the *domain* is
complex (Stripe drift classification, multi-channel notification fan-out, 409
edit-publish disposition). Splitting it carelessly risks double-posting, dropped
notifications, or broken reconciliation.

**Safe path forward:** these are the best long-term candidates for extraction
because the per-branch logic *is* separable (e.g. each drift type in the reconcile
poller → its own classifier function). But each needs a test-first pass with the
DB-backed harness. Tackle `StripeLocationsReconcilePoller.runOnce` (cog 63) and
`dispatch.ts` (cog 53) first — highest complexity, clearest internal seams.

### D. Service-layer aggregation modules (4 targets) — **deferred**

`src/lib/dashboard/service.ts` (`getActiveDashboardData`, cog 33) ·
`src/lib/dashboard/aggregate-service.ts` (`getAggregateDashboardData`, cog 33) ·
`src/lib/admin/cost-report-service.ts` (`getCostReport`, cog 34) ·
`src/lib/zernio/parse-review-webhook.ts` (`parseZernioReviewWebhook`, cog 31)

**Why deferred:** the dashboard/cost services are high fan-in (the `db/server` and
dashboard modules have very high fan-in) — *"4+ dependents amplify every change."*
`parse-review-webhook.ts` is the `ReviewSource` contract chokepoint (*"No
source-specific fields leak into the prompt builder"*); it is pure and already
tested, but it is central, stable ingestion code where added churn carries more
risk than the marginal readability gain. The validation branching reads clearly
inline.

**Safe path forward:** the dashboard services can be split by query-group into
focused sub-services behind the same return type — low behavioral risk if the
aggregate shape is asserted by tests. `parse-review-webhook` only if a future
change forces it; extract `reconcileReviewIdentifiers` then, behind its existing
tests.

### E. Large UI components (2 targets) — **deferred**

`src/components/dashboard/EditReplyDrawer.tsx` (**1276 LOC**, cog 30) ·
`src/app/(authenticated)/dashboard/connect/page.tsx` (`ConnectPage`, cog 34, 541 LOC)

**Why deferred:** `EditReplyDrawer` is the approval/edit surface — it carries the
hand-rolled focus-trap and the AI-disclosure approval UX. It is the single largest
unit in the tree and a real refactor candidate, but a component split touches user
interaction, accessibility, and the approval flow at once; it needs a dedicated
design pass (and pairs with the Spec 19 a11y/Radix decision), not a health sweep.

**Safe path forward:** extract presentational sub-components and custom hooks
(`useEditReplyForm`, etc.) incrementally, each with the existing component tests
kept green. Treat as its own scoped PR series, ideally alongside the a11y work.

### F. Scripts & dev tooling (3 targets) — **deferred (low priority)**

`scripts/redis.ts` (`main`, **cog 98**) · `scripts/ci/tenant-scope-audit.ts`
(`hasTenantScopeForTable`, cog 31) · `src/proxy.ts` (`proxy`, cog 69)

**Why deferred:** `scripts/*` are not production runtime (lower user-facing blast
radius), but `tenant-scope-audit.ts` *is* a CI gate — breaking it weakens the
tenant-isolation guard. `src/proxy.ts` is dev/proxy plumbing. Low health ROI
relative to risk; the CRAP score on `redis.ts`/`tenant-scope-audit.ts` is inflated
because they're untested.

**Safe path forward:** add tests to `tenant-scope-audit.ts` before touching it
(it protects a launch-critical invariant), then extract. `scripts/redis.ts` and
`src/proxy.ts` can be split freely (dev-only) when convenient.

### G. High-impact file split (1 target) — **deferred**

`src/hooks/useSettingsForm.ts` (split high-impact, 169 LOC, 4 dependents) —
fallow confidence: **medium**.

**Why deferred:** medium confidence + 4 dependents means a split amplifies any
mistake across the settings surface. Worth doing, but as a deliberate hook
decomposition with its consumers' tests green — not a sweep.

---

## Aggregate deductions not addressable by a sweep

| Deduction | Driver | Why a sweep can't safely fix it | Lever |
|---|---|---|---|
| **duplication −10** (16.9%) | Largely test boilerplate (the largest "functions" in the tree are `__tests__` arrow bodies of 400–900 LOC) plus repeated query/validation shapes | Deduping production code = the same risky extractions above; deduping tests has low value and can reduce test clarity | Extract shared *test* fixtures/builders where it improves clarity; `health.ignore` already excludes `dist`/`__generated__` |
| **unit size −10** | 699 functions >15 LOC, 6% >60 LOC — dominated by test arrows and the orchestrators in A–F | Same as A–F | Addressed incrementally via the per-target backlog above |
| **hotspots −10** | churn × complexity on auth/billing/connect/whatsapp files | Churn is git history (can't be edited); only complexity is reducible — and re-churning now makes it worse short-term | Reduce complexity on the *stable* high-complexity files first; let churn age out |
| **coupling −2.1** | High fan-in hubs (`db/server` 343, `reviews/types` 27, `quota` 16) | These are legitimately shared foundations; splitting them is architectural, not cleanup | Leave as-is; revisit only if a hub starts changing for unrelated reasons |
| **dead exports −0.2** | margin-service + preflight | **Fixed** (PRs #108/#109) | — |

---

## Recommendations

1. **Enable coverage instrumentation.** Install `@vitest/coverage-v8` (the matching
   provider for the pinned Vitest v4) so `fallow health --coverage` reports *real*
   coverage instead of the export-reference estimate. This makes the "untested
   risk" / CRAP scores trustworthy and directly supports the Spec 23 coverage gate.
   *(Not done in this pass — adding a dev dependency is a team decision, not a
   sweep change.)*
2. **Work the A–G backlog test-first, one target per PR**, in this risk-ordered
   sequence: C (pollers/jobs — highest complexity, clearest seams) → A (route
   handlers) → B (webhook ingress, once DB-harness is wired) → E (EditReplyDrawer,
   with a11y) → D, F, G as convenient.
3. **For genuinely-intentional complexity**, fallow supports a `suppress-line`
   action to acknowledge a finding without refactoring — use it sparingly on
   orchestrators whose complexity is inherent, with a comment explaining why.
4. **Don't chase the grade.** Maintainability is already 91.7 ("good") and avg
   cyclomatic is 1.8. The C grade is driven by a handful of large orchestrators and
   test files, not by pervasive rot. Incremental, test-backed extraction beats a
   risky bulk refactor.

---

## Full target disposition (32)

| # | Target | Category | Disposition |
|---|---|---|---|
| 1 | `lib/admin/margin-service.ts` | dead code | ✅ Fixed — PR #108 |
| 2 | `api/zernio/connect/_shared/preflight.ts` | dead code | ✅ Fixed — PR #109 |
| 3 | `onboarding/business/payload.ts` | complexity | ✅ Fixed — PR #110 |
| 4 | `lib/zernio/client/locations.ts` | untested | ✅ Fixed — PR #111 |
| 5 | `api/dashboard/route.ts` | complexity | ⏸️ Deferred (A) |
| 6 | `scripts/ci/tenant-scope-audit.ts` | complexity | ⏸️ Deferred (F) |
| 7 | `lib/dashboard/service.ts` | complexity | ⏸️ Deferred (D) |
| 8 | `pollers/ZernioRecentReviewPoller.ts` | complexity | ⏸️ Deferred (C) |
| 9 | `jobs/publisher/edit-publish.ts` | complexity | ⏸️ Deferred (C) |
| 10 | `ingress/twilio/twilio-whatsapp-inbound.ts` | complexity | ⏸️ Deferred (B) |
| 11 | `jobs/RankingTrackingWorker.ts` | complexity | ⏸️ Deferred (C) |
| 12 | `hooks/useSettingsForm.ts` | split high-impact | ⏸️ Deferred (G) |
| 13 | `pollers/StripeLocationsReconcilePoller.ts` | complexity | ⏸️ Deferred (C) |
| 14 | `api/admin/channels/sms/verify/route.ts` | complexity | ⏸️ Deferred (A) |
| 15 | `api/zernio/connect/cancel/route.ts` | complexity | ⏸️ Deferred (A) |
| 16 | `api/zernio/connect/start/route.ts` | complexity | ⏸️ Deferred (A) |
| 17 | `api/onboarding/start/route.ts` | complexity | ⏸️ Deferred (A) |
| 18 | `ingress/resend.ts` | complexity | ⏸️ Deferred (B) |
| 19 | `jobs/notification/dispatch.ts` | complexity | ⏸️ Deferred (C) |
| 20 | `lib/dashboard/aggregate-service.ts` | complexity | ⏸️ Deferred (D) |
| 21 | `dashboard/connect/page.tsx` | complexity | ⏸️ Deferred (E) |
| 22 | `api/auth/signup/route.ts` | complexity | ⏸️ Deferred (A) |
| 23 | `api/zernio/disconnect/route.ts` | complexity | ⏸️ Deferred (A) |
| 24 | `jobs/publisher/post-reply.ts` | complexity | ⏸️ Deferred (C) |
| 25 | `src/proxy.ts` | complexity | ⏸️ Deferred (F) |
| 26 | `lib/zernio/parse-review-webhook.ts` | complexity | ⏸️ Deferred (D) |
| 27 | `api/lead-intake/route.ts` | complexity | ⏸️ Deferred (A) |
| 28 | `api/auth/callback/route.ts` | complexity | ⏸️ Deferred (A) |
| 29 | `ingress/zernio/zernio.ts` | complexity | ⏸️ Deferred (B) |
| 30 | `lib/admin/cost-report-service.ts` | complexity | ⏸️ Deferred (D) |
| 31 | `components/dashboard/EditReplyDrawer.tsx` | complexity | ⏸️ Deferred (E) |
| 32 | `scripts/redis.ts` | complexity | ⏸️ Deferred (F) |
