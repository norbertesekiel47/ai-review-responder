# RepWorth — Core Revenue Billing Audit
**Date:** 2026-06-23 · **Scope:** core customer-revenue billing (subscription lifecycle, Stripe checkout/webhooks/portal/tier-change, card-up-front trial, multi-location overage, reconciliation, billing audit log, offboarding subscription-cancellation). **Out of scope:** LLM cost-guard/COGS, admin margin, onboarding-demo cost lane, Stripe Tax deep-dive.
**Method:** Phase A = read-only static review of ~20 core files + 3 parallel deep-dive subagents + automated green-check. Phase B (dynamic, Stripe test mode) = planned, access-gated (see §7). Plan + cross-model (Codex) hardening log: `~/.claude/grill-codex/20260623-023509/`.

---

## 1. Executive summary

**The core revenue-billing system is correctly implemented and well-engineered.** Across subscription lifecycle, the 6-event Stripe webhook ingress, the card-up-front trial, multi-location overage, tier changes, the billing portal, reconciliation, and offboarding cancellation, the static audit found **zero P0 and zero P1 correctness bugs**. The architecture invariants hold (transactional outbox, idempotency, single-owner primitives, grandfathering, app-enforced tenant scope), and the automated gates are green (typecheck, 4 CI audits, Stripe price parity).

What the audit *did* surface is a set of **P2 robustness/observability items** and a few **P3 nits** — none block production operation, and several are already tracked in the worker-scaling backlog / accepted in ADR 0005.

| Severity | Count | Nature |
|---|---|---|
| **P0** (broken w/ money-or-data impact, or launch-blocking) | **0** | — |
| **P1** (real bug, meaningful impact) | **0** | — |
| **P2** (robustness / observability / known-accepted / modularization) | 11 | mostly resilience hardening + 1 consolidation refactor |
| **P3** (nit / cosmetic / stylistic) | ~12 | parity drift, dead defensive code, log wording |

**Headline:** Money paths are safe, and **Phase B live-verified them on staging** — trial convert/decline/cancel and overage ↑/↓ all passed end-to-end against the deployed worker (Stripe test clocks; all test data cleaned up). Dynamic verification also **corrected** the one trial-relevant static prediction: Reconcile-F2's hourly trialing error-spam **does not reproduce** (3/3 live reconcile runs clean). The strongest engineering is the webhook ingress (idempotent, advisory-locked, out-of-order-safe, trial-conversion-analytics-accurate — the dual-fire "convert-then-decline" net-zero logic was confirmed live) and the single status applier. Residual items are robustness/observability **P2s (none launch-blocking)** plus the documented single-replica overage invariant. Phase B also surfaced one operational finding: **FIND-ENV** (local `.env.local` points at the prod-labeled Supabase with mocks off).

---

## 2. Trial flip GO / NO-GO  ← your launch question

**VERDICT: GO — conditional on completing the documented Part C mechanics. No code-level correctness blocker was found for turning `TRIAL_ENABLED=true` in production.**

The trial *entitlement* model and *lifecycle* are verified correct and are the best-tested part of the billing surface (full `trial-test-clock.acceptance` + per-event trial suites). `trialing` is treated exactly like `active` everywhere it should be, and correctly **excluded** from recurring SerpAPI ranking (verified strict in both `RankingTrackingWorker.ts:149` and `RankingTrackingScheduler.ts:59`).

**Conditions before you flip (these are the runbook `trial-staging-e2e-and-rollout.md` Part C steps — mechanical, not bugs):**

| # | Gate | Status from this audit |
|---|---|---|
| 1 | Migration 069 → **prod** Supabase (additive: column comment + analytics CHECK +4 trial events) | **Not yet applied to prod** (known Part C step). Migration is tested (`migration-069-trial-subscription.test.ts`) + live on staging. **Required pre-flip.** |
| 2 | 6 trial webhook events on **prod** Stripe endpoint + endpoint API-version == pinned `apiVersion` | Code handles exactly those 6 events (`stripe.ts:67-95`). Prod endpoint registration + version match **need prod-Stripe read** (Phase B). **Required pre-flip.** |
| 3 | `TRIAL_ENABLED` / `TRIAL_PERIOD_DAYS` / `SELF_SERVE_SIGNUP_ENABLED` set on **BOTH** Vercel + Railway | **Needs prod-env read.** Prior session notes flagged Vercel prod may lack `TRIAL_ENABLED`/`TRIAL_PERIOD_DAYS` — **verify both runtimes.** |
| 4 | Stripe built-in **trial-end email** enabled (Dashboard) | Manual dashboard step — verify. |
| 5 | **Tax parity** (Codex R2-6): `STRIPE_TAX_ENABLED` staging↔prod + Price `tax_behavior` | `verify:stripe-prices` **passed** (4 tiers); tax is default-off. Confirm prod flag parity (low-risk). |
| 6 | Post-flip watch: first signup → `trialing` + both Stripe IDs; first convert; reconcile drift quiet | Monitoring plan. **Note:** expect Reconcile-F2 log-spam (below) unless fixed first. |

**Strongly recommended to fix *with* the flip (not a hard blocker):** **Reconcile-F2** — trialing accounts generate an hourly "no recurring lines" *error* per account through the reconcile poller's `createPreview` path; at trial scale this is real log-noise and it masks the "duplicate-overage undetectable" signal. One-line guard (skip the upcoming-invoice check while `status==='trialing'`).

**Not relevant to the flip:** Overage-F1 (replica) — the flip doesn't change replica count.

---

## 2.5 Phase B (dynamic, staging) — results so far

Run against the real deployed staging stack (Supabase `kubdiqdhqbhwmqfditeg`, **test-mode** Stripe, worker `repworth-worker`), read-only so far — no test data written.

| Check | Result |
|---|---|
| Staging Stripe = test mode | ✅ confirmed |
| Staging Stripe webhook → staging worker, 6 events | ✅ `…/ingress/stripe` enabled, exactly the 6 events (= go/no-go gate #2, **for staging**) |
| Migration 069 trial schema on staging | ✅ `trial_ends_at` present/populated; 1 live `trialing` account |
| Staging worker health | ✅ online, all pollers/schedulers booted, **zero billing errors** in buffer |
| Reconcile poller live behavior | ✅ 3/3 hourly runs vs the live trialing account = "no drift detected"; 0 drift, 0 errors |
| **Reconcile-F2 (predicted trialing error-spam)** | ❌ **NOT reproduced** — corrected to P3 (see register) |

**Write-scenarios — live end-to-end on staging (Stripe test clocks → deployed worker → DB), all cleaned up afterward (staging restored to its original 1 trialing account, 0 leftover rows):**

| Scenario | Path exercised | Result |
|---|---|---|
| **Trial convert** | seed trialing → advance clock past trial-end → valid card charged → `subscription.updated(active)`+`invoice.paid` → worker | ✅ `trialing→active`, `trial_ends_at` cleared, `subscription_activated_at` preserved, `trial_converted` analytics + audit |
| **Overage increment** | add 2nd location + overage outbox → OutboxPoller → `UpdateStripeOverageWorker` | ✅ Stripe overage item **created** ($25 ×1) alongside base; `locations_paid`→1 via webhook |
| **Overage decrement** | archive location + overage outbox → worker | ✅ overage item **deleted** (qty 0); `locations_paid`→0 |
| **Card-decline → past_due** | seed trialing w/ failing card → advance clock past trial-end → charge fails | ✅ ends `past_due`; **dual-fire analytics validated** — Stripe flips trialing→active before charge, so `trial_converted` then `trial_payment_failed` fire ⇒ net conversions = 0 (exactly the Phase A design note, confirmed live) |
| **Cancel during trial** | delete subscription → `subscription.deleted` → worker | ✅ `trialing→cancelled`, `trial_ends_at` cleared, `trial_cancelled` analytics + audit |

These directly verify your two headline questions live — the trial lifecycle (incl. the day-30 convert) **and** the subscription→add-location→multi-location overage billing — on the real deployed staging stack.

**Still outstanding (needs read-only PROD access — deliberately untouched after the local→prod-DB confusion, see FIND-ENV):** migration 069 on **prod**, the 6 webhook events + endpoint API-version on **prod** Stripe, `TRIAL_ENABLED`/`TRIAL_PERIOD_DAYS`/`SELF_SERVE` on both **prod** runtimes, prod tax parity. These are the genuine remaining go/no-go items for the prod flip. Heavier write-scenarios (trial test-clock lifecycle, overage qty, payment-success recovery) are available on staging but largely re-prove the already-green `trial-staging-e2e-and-rollout.md` runbook.

---

## 2.6 New finding from Phase B

**FIND-ENV (P1 — CONFIRMED by owner):** local `.env.local` points BOTH the Supabase read/auth client (`NEXT_PUBLIC_SUPABASE_URL`) AND the transactional writer (`DATABASE_URL` = `db.udeyaqnvpojbwgoaxwdg.supabase.co:5432`, `DATABASE_POOL_URL` = the prod pooler) at `udeyaqnvpojbwgoaxwdg` = **PROD**, with `MOCK_EXTERNAL_APIS=false`. So any unmocked local run (`pnpm dev`/`pnpm worker`, a seed, a one-off script) reads **and writes the production database** — violates deployment-guide §1.3 ("don't share prod with dev"). **Mitigant:** prod backend is not deployed yet (only the Vercel frontend), so prod is effectively empty today — fix now, before real data exists. **Fix:** repoint local `.env.local` DB + Supabase vars at a non-prod project — best: a local stack via `supabase start`; or a dedicated cloud "RepWorth-dev" project; staging (`kubdiqdhqbhwmqfditeg`) only as a stopgap (it's the shared integration anchor). *(The audit never wrote to prod: Phase B ran on staging; the Phase A green-check didn't touch the DB. This is also why Phase B writes were moved to staging.)*

---

## 2.7 Remediation status (updated 2026-06-24)

Findings were remediated across two risk-split PRs. **PR A is merged; PR B is open, CI-green, and staging-soak-validated** — the §2.5 convert / decline / cancel / overage scenarios were re-run end-to-end against the deployed **PR-B** worker on 2026-06-24 and all passed (staging restored + cleaned afterward).

**PR A — `billing: safety + quick wins + nits` ([#365](https://github.com/RepWorth/ai-review-responder/pull/365), MERGED):**

| Finding | Disposition |
|---|---|
| FIND-ENV (P1) | ✅ Documented the "local dev DB must never be prod" rule in `deployment-guide.md` §1.3 + `env-vars.md` (`.env.local` is gitignored; repointed locally). |
| OVERAGE-F2 | ✅ `Sentry.captureMessage` on the ambiguous overage dead-letter. |
| STATUS-1.1 | ✅ trialing-Basic shows the "upgrade" copy via a tested `lockedAddLocationReason` helper. |
| FIND-001 | ✅ Deleted the orphaned `/admin/payment-success` route + page + all refs. |
| OVERAGE-F5 | ✅ Documented the intentional archive offboarding-gate exemption (billing-contracting). |
| RECONCILE-F4 | ✅ Logs the trial correction only when the applier returns `changed:true`. |
| OVERAGE-F4 | ✅ `recordOutboxTransientError` is attempt-guarded. |
| SELECTPLAN-1 | ✅ Explicit tier-config guard; dead `?? 1/2500/7900` fallbacks removed. |
| OVERAGE-F3 | ✅ Clarifying comment (the `billing_role` stamp is the primary defense). |

**PR B — `billing: robustness + status-applier consolidation` ([#366](https://github.com/RepWorth/ai-review-responder/pull/366), OPEN · green · soaked):**

| Finding | Disposition |
|---|---|
| QUALITY-OBS + PARITY-1 + PARITY-2 | ✅ Consolidated all 4 inline status transitions into the single applier — auto-resolves PARITY-1 (column clears) and PARITY-2 (id COALESCE). |
| OVERAGE-F1 | ✅ Account-scoped `pg_advisory_xact_lock` around the overage sync, with the live count recomputed **inside** the lock; `concurrency:1` boot-assert kept. (Full horizontal scale-out remains a tracked backlog item.) |
| RECONCILE-F5 | ✅ AbortController loop-control + bounded per-request Stripe read timeouts (Stripe SDK v22 has no request `AbortSignal`); read-before-tx invariant documented. |
| RECONCILE-F1 | ✅ `locations_paid_mirror` drift-observability check (no auto-correct). Column retirement deferred → `docs/future-plans/2026-06-23-retire-locations-paid-mirror.md`. |
| RECONCILE-F3 | ✅ Documented `StripeCheckoutReconcileWorker` as the `pending_payment` backstop. |
| RECONCILE-F6 | ✅ Duplicate-subscription scan scoped to the account's own subscription lineage. |
| CONFIG-1 | ✅ Verified Sentry routing; revenue-affecting drift now emits at `level:'error'` (benign observability types stay `warning`). |
| NOTE-A | Preserved by design (the businesses-mirror asymmetry is intentional per NOTE-A); covered by per-transition applier tests. |
| NOTE-B | ✅ Rationale comment folded in (`incomplete_expired → PAST_DUE` preserves the grace window). |
| OVERAGE-F6 | ✅ Validated live in the §2.5 soak (mid-trial overage add = $0 until trial_end). |

**Additional PR-B hardening — from three post-build review rounds, beyond the original register:**
- **Adversarial (Codex):** scoped `invoice.paid` recovery and `invoice.payment_failed` to `(stripe_customer_id, stripe_subscription_id)` so one Stripe customer mapped to multiple accounts can't transition the wrong account; escalated `status_mismatch` reconcile drift to `error`.
- **Codex review:** transient Postgres errors in the overage lock tx now retry (not terminal); overage quantity recomputed inside the lock.
- **Thermo-nuclear quality:** `invoice.paid` trial-convert reduced to a single lineage-matched account (was a fan-out loop). Applier-contract simplification deferred → `docs/future-plans/2026-06-24-simplify-stripe-status-applier-contract.md`.

**Not addressed (low-risk P3, out of remediation scope):** PORTAL-1 (`configurations.list` 100-limit), SELECTPLAN-2 (select-plan inline DB logic). **No fix needed:** RECONCILE-F2 (refuted by Phase B).

---

## 3. Findings register

> Severity is impact-based. Items marked *tracked* already exist in `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md` or ADR 0005.

### P2 — robustness / observability / modularization

| ID | Area | Finding | One-line fix |
|---|---|---|---|
| **RECONCILE-F2** ⟶ **downgraded P3 by Phase B** | reconcile | Static analysis predicted DB-trialing accounts hit `invoices.createPreview` → "no recurring lines" → **hourly ERROR per trialing account**. **Phase B live staging REFUTED this:** 3/3 hourly reconcile runs against the live trialing account were clean "no drift detected", zero errors. Likely the trial sub's preview returns recurring lines in practice (or only manifests under trialing+overage). **Not a launch concern.** | If ever observed: skip upcoming-invoice while `status==='trialing'` + add a trial-path test. |
| **OVERAGE-F1** *(tracked: ADR 0005 + backlog)* | overage | Stripe idempotency key is per-**outbox-row**, not per-`(account,qty)`. No-double-bill rests on `concurrency:1` + **single Railway replica**, enforced only per-process. A 2nd replica (or the brief redeploy-overlap window) could double-`create` overage items → double-bill. **Single-replica is the committed state (`railway.toml` has no `numReplicas`)**, so safe today. | Account-scoped `pg_advisory_xact_lock` around the overage sync (closes the overlap window too); keep as a hard gate before any worker scale. |
| **OVERAGE-F2** | overage | An overage item matchable only by descriptor → `ambiguous` → terminal-fail with **only `logger.error`** (no Sentry) → that account's location growth silently stops being billed until ops notices. | `Sentry.captureMessage` on `ambiguous`; confirm reconcile covers this drift. |
| **OVERAGE-F5** | overage | `/api/locations/archive` has **no offboarding gate** while `add`/`reactivate` do. Decrement-only, so low billing risk, but inconsistent. | Add the same `isBillingMutationBlocked` gate, or document why archive is exempt. |
| **RECONCILE-F1** *(subagent rated P1; downgraded)* | reconcile | `accounts.locations_paid` drift is **never reconciled** (expected overage derived from live `COUNT`, persisted `locations_paid` never compared). Downgraded to P2: `locations_paid` is a mirror neither the worker nor the snapshot bill from (both use `COUNT`). | Add a 3-way `locations_paid`↔Stripe-qty↔live-count check, **or** confirm no consumer bills off it and treat as vestigial. |
| **RECONCILE-F5** | reconcile | `withTimeout` doesn't cancel the underlying Stripe/PG work → under a prolonged Stripe outage, detached cycles accumulate and hold Postgres pool (`max:10`) connections → exhaustion. Hourly cadence slows it. | Track the in-flight promise (gate next cycle on settle) or pass an `AbortSignal`. |
| **STATUS-1.1** | UI/entitlement | `settings/locations/page.tsx:54` shows a **trialing-Basic** owner "subscription must be active" instead of "upgrade to add locations" (raw `=== ACTIVE`). Cosmetic, trial-only, **no entitlement leak**. | `subscriptionGrantsFullAccess(status) && tier===BASIC`. |
| **QUALITY-OBS** | webhooks (modularization) | Non-trial status transitions are re-implemented **inline** in 4 handlers, duplicating the transition-table the applier already owns → demonstrated drift (PARITY-1/2). | Extend the single applier to own **all** status transitions; shrink handlers to orchestration. (See §5.) |
| **NOTE-A** | applier | `businesses` deprecated-mirror scoping is asymmetric: trialing/active update primary-only; past_due/cancelled update **all** businesses. Low impact (deprecated column). | Make scoping consistent (or retire the mirror). |
| **CONFIG-1** | observability | Reconcile drift alerts emit at Sentry `level:'warning'` — confirm the Sentry→Discord/Pager rule routes `warning` (else drift is captured-but-not-paged). *(Sentry DSN itself is boot-gated in prod — drift can't go fully un-recorded.)* | Confirm alert routing includes `warning` + `feature:stripe_reconciliation`. |
| **FIND-001** | admin route | `/api/admin/payment-success` reads `client_reference_id` as a **business** id but Checkout writes an **account** id → the admin landing page spins forever on the current flow. **Owner self-serve flow + activation webhook are unaffected** (they're correct). | Mirror `checkout-completed.ts` account-first resolution, or delete the route if `/admin/payment-success` is dead. |

### P3 — nits / cosmetic

| ID | Finding |
|---|---|
| PARITY-1 | `checkout-completed` inline ACTIVE path doesn't clear `past_due_at`/`trial_ends_at` (applier does) → stale `past_due_at` on an active row after re-checkout recovery. Harmless (guards key off status). |
| PARITY-2 | `checkout-completed` inline **overwrites** stripe ids; applier **COALESCEs**. Equivalent on first activation. |
| NOTE-B | `incomplete_expired` maps to PAST_DUE (not CANCELLED) — confirm vs intended dunning. |
| OVERAGE-F3 | `unit_amount` overage match requires `originalCount>1` (documented blind spot). |
| OVERAGE-F4 | `recordOutboxTransientError` not attempt-guarded — can write a stale `last_error` (cosmetic). |
| OVERAGE-F6 | mid-trial overage add syncs Stripe qty immediately; "$0 until trial_end" is asserted, not code-tested → **Phase B staging check**. |
| RECONCILE-F3 | `pending_payment` accounts not reconciled (confirm another backstop owns missed-activation). |
| RECONCILE-F4 | Logs "Corrected stuck trialing row" even when the applier returns `changed:false` (misleading). |
| RECONCILE-F6 | duplicate-subscription scan assumes one Stripe customer ↔ one account. |
| PORTAL-1 | `configurations.list({limit:100}).find(safe)` could miss + recreate a config if >100 exist (unlikely). |
| SELECTPLAN-1 | TIER_CONFIG snapshot fallbacks (`?? 1 / ?? 2500 / ?? 7900`) are dead code (tier is schema-validated). |
| SELECTPLAN-2 | `select-plan` route carries more inline DB logic (lock-then-read + snapshot) than its siblings — borderline "routes orchestrate" (vs `tier-change` which delegates to a module). |

---

## 4. Per-area correctness verdicts

| Area | Verdict | Notes |
|---|---|---|
| Stripe client (`getStripe`) | ✅ Correct | Single owner, pinned apiVersion/timeout/retries; CI static-policy + price-parity green. |
| Checkout + trial start (`create-checkout-session`, `/billing/checkout`, `/onboarding/select-plan`) | ✅ Correct | Thin routes, IDOR-safe, offboarding-gated, trial-eligibility identical across both entry points (no bypass), `$0`/`no_payment_required` trial signal handled, well-documented staging-caught fix. |
| Webhook ingress (dispatcher + 6 handlers + applier) | ✅ Correct (high quality) | Signature-first; >7d stale guard; dedup-reclaim; advisory locks + `FOR UPDATE`; out-of-order `AccountNotProvisionedYetError`→retry; offboarding-snapshot aware; trial-conversion analytics dedup accurate. Minor inline/applier parity drift (P3). |
| Subscription status model + worker guards | ✅ Correct | `trialing==active` except SerpAPI (verified); 7-day grace math + consistent application; `pending_payment`→generator-only. |
| Tiers + grandfathered snapshot | ✅ Correct | Reads STORED columns (#9a); `tier-change` intentionally re-snapshots; all 4 tier values match spec. |
| Multi-location overage pipeline | ✅ Correct *within single-replica invariant* | Recompute-from-committed-state (immune to staleness); idempotent on retry; tier gating triple-defended; transient/terminal classification sound. F1/F2 are the caveats. |
| Reconciliation pollers | ✅ Correct, ⚠ trial-noise | Scoped auto-correct (trialing-only, via applier, no other writes); timeout/single-flight cannot wedge; SENTRY_DSN boot-gated. F1/F2/F5 are robustness gaps. |
| Billing portal + tier-change routes | ✅ Correct | Thin, IDOR-safe, offboarding-gated, cancellation kept in RepWorth offboarding. |
| Offboarding subscription cancellation | ✅ Correct (high quality) | Idempotency-keyed, tolerates already-canceled, precise retryable-vs-permanent classification. |
| Billing audit logging | ✅ Correct | Single `writeAccountAuditLog`, in-tx at every transition, change-only payloads. |

---

## 5. Code quality & modularization  ← "do we need to modularize?"

**Short answer: the billing code is already well-modularized. There is ONE consolidation worth doing; everything else is fine and should be left alone.**

**Already good (do not touch):** single Stripe client, single overage-item resolver (`resolveOverageItem`, 4 consumers), single price→tier map, single audit writer, single quota/snapshot module, single status **applier**. Webhook handlers are split one-per-event (cohesive, not god-files). Largest files (`tier-change.ts` 389, `apply-subscription-state.ts` 370, `add-location-tx.ts` 278) are each single-concept and dense-but-cohesive — no split needed. No over-abstraction, no shallow pass-throughs of note, no speculative layers. This matches the project's "deep modules / no new files" philosophy well.

**The one worthwhile refactor (QUALITY-OBS, P2):** *status-transition ownership is split.* The applier owns trial transitions; the 4 webhook handlers re-implement non-trial transitions (`→active`, `→past_due`, `→cancelled`) **inline**. That duplication is the root of the PARITY-1/2 drift (inline activation doesn't clear `past_due_at`/`trial_ends_at` the way the applier does). The applier already exists and already encodes the monotonic table — so this isn't speculative extraction, it's *consolidating a second implementation into the first*. Extending the applier to own **all** status transitions would (a) give status changes one authoritative owner, (b) delete the drift class, (c) shrink each handler to "resolve account → call applier → post-commit best-effort." Medium effort, real risk (money paths), so: **track it, do it deliberately with the existing trial test-suite as the safety net — not a rush.**

**Minor (P3):** `select-plan/route.ts` carries more inline DB logic (lock-then-read + tier snapshot) than its sibling routes; consider delegating to a module for parity with how `tier-change` delegates to `tier-change.ts`.

---

## 6. Automated gates (Phase A green-check)

| Gate | Result |
|---|---|
| `pnpm typecheck` | ✅ clean |
| `pnpm ci:tenant-scope` | ✅ 377/377 |
| `pnpm ci:rls-audit` | ✅ static coverage (27 tenant tables; live skipped — no test DB locally) |
| `pnpm ci:analytics-events` | ✅ passed |
| `pnpm ci:static-policy` | ✅ 805 files; 35 subscription-status carve-outs allowlisted |
| `pnpm verify:stripe-prices` | ✅ **price parity OK for 4 tiers** (ran against real Stripe) |
| `pnpm build` | ✅ success (full route tree emitted) |
| `pnpm test` (billing subset, 44 files) | ✅ **551 passed, 6 skipped, 0 failed** (19.6s) |

Test coverage is **strong**, with the best density on the trial paths (full `trial-test-clock.acceptance` + per-event trial suites + applier). Gaps: reconciliation poller has only `drift.tax-safety` (the trialing `createPreview` path + poller timeout/single-flight are untested — ties to RECONCILE-F2); confirm non-trial inline webhook branches have coverage.

---

## 7. Phase B — dynamic verification plan (remaining; access-gated)

Phase A answered correctness statically with high confidence. The following require **Stripe test-mode + staging + read-only prod** access (and per-scenario write manifests, per the plan). Priority order:

1. **Trial lifecycle end-to-end (staging, real Stripe→staging delivery):** start→`trialing`; convert via `customer.subscription.updated`/`invoice.paid`; card-fail→past_due; cancel-during-trial; **expiry via Stripe test clock** (subscription-layer, not real Checkout — harness limit).
2. **Reconcile-F2 repro:** confirm the hourly trialing `createPreview` error-spam on staging (decides fix-before vs fix-with flip).
3. **Overage-F6:** confirm mid-trial overage proration is **$0 until trial_end** on a real trialing sub.
4. **Overage add/archive/reactivate → Stripe item quantity** + duplicate-outbox behavior.
5. **Go/no-go prod reads:** migration 069 prod parity, 6 webhook events + endpoint API-version, `TRIAL_ENABLED`/`TRIAL_PERIOD_DAYS`/`SELF_SERVE` on both runtimes, tax parity.
6. **Payment-success recovery (isolated):** real Checkout session → seed reconcile outbox with the real `cs_…` → `StripeCheckoutReconcileWorker` activates (don't disable global staging webhooks).

**Access needed from you:** Stripe test-mode keys, staging Supabase/Railway/Vercel, `stripe` CLI auth, and read-only prod Stripe + prod Supabase. (Railway MCP is currently unauthorized — `! railway login`.)

---

## 8. Bottom line

- **Is billing implemented properly?** Yes — zero P0/P1 correctness bugs across the core revenue surface; invariants hold; gates green.
- **Subscription → add-location → multi-location wiring working?** Yes — recompute-from-committed-state overage is correct and idempotent; the one caveat is the documented single-replica invariant (Overage-F1), safe in the committed config.
- **Safe to launch the trial?** GO, conditional on the mechanical Part C steps + (recommended) the Reconcile-F2 one-liner.
- **Do we need to modularize?** Mostly no — it's already well-factored. One worthwhile consolidation: unify non-trial status transitions into the existing applier.
