# Production Hardening — Follow-up Map (P4, P8, P9)

Companion to `docs/superpowers/specs/2026-07-16-prod-hardening-guards-design.md`.
Each ticket below is sized for one `/feature <ticket>` run (ticket-seeded path).
Decisions marked LOCKED were made by the owner 2026-07-16; open questions are
the deltas a grilling pass must resolve before implementation.

> **Status (2026-07-21): all three tickets SHIPPED** — F2/P8 → PR #514,
> F3/P9 → PR #515, F1/P4 → PR #516. The 10-finding report is closed. Note:
> F1's "no health check can see it" premise below was corrected during the
> run (conflated + transient, not invisible) — see ADR 0010's Context.

## Ticket F1 — P4: owner-unreachable escalation

**Blocking edges:** none (independent).
**LOCKED:** model as a distinct `owner_unreachable` outcome + a health-alert
check — not a silent `markOutboxCompleted`.
**Verified state (2026-07-16):** `NotificationWorker.ts:75-83` —
`no_verified_enrollments` → `logger.warn` + `markOutboxCompleted`; draft stays
`pending_approval`, no escalation, and no health check can see it (zero-enrollment
completions leave no queryable trace; cf. `checkZeroDeliveryNotifications`,
checks.ts:115-145, which covers the delivery-rows case only).
**Reusable escalation surfaces (do not invent new ones):**
- `worker/jobs/AutonomyAdminAlertWorker.ts` — `sendInternalEmail` to `ADMIN_NOTIFICATION_EMAIL`
- `worker/background/pollers/health-alert/emit.ts` — Sentry paging sink
- `alertCostCapExhausted` (`generate-draft.ts:54-69`) — Sentry-warning shape for dropped paid work
- Owner-facing escalations infra: `src/lib/escalations/*`, `src/app/api/dashboard/escalations/`
**Open questions (grill):** which surface is the primary escalation (admin email
vs health-alert finding vs both); whether a queryable marker (outbox reason code
or response status) is needed so the health check can observe it; retry cadence
once an owner later verifies a channel.

## Ticket F2 — P8: bound Stripe calls under tier-change locks

**Blocking edges:** none, but MUST be re-grounded first — the original review's
fix anchors are STALE: `STRIPE_READ_TIMEOUT_MS`, `reconcile-account.ts`, and
`checkout-completed.ts` do not exist in the current tree (verified 2026-07-16,
post-WS8). Treat the prescribed fix as directional only.
**LOCKED:** minimal fix — short per-call timeouts under lock only; NO structural
restructure of `tier-change.ts`.
**Verified state:** `applyTierChangeInTx` acquires advisory locks (:648) +
FOR UPDATE (:650) inside `sql.begin` (:716), then calls
`buildTierChangeProviderPlan` → `subscriptions.retrieve` (:612) and
`mutateStripe` (:680, item update/create :384-409) with the shared client's
`timeout: 20_000, maxNetworkRetries: 2` (stripe-client.ts:18-19) — worst case
~60s lock hold. `DB_POOL_MAX=3` per Vercel instance (db/server.ts:18).
**Open questions (grill):** per-call `{ timeout, maxNetworkRetries: 0 }` request
overrides vs a second bounded client from the factory; correct bound value;
behavior when the bounded call times out mid-tier-change (caller retry? webhook
reconcile?).

## Ticket F3 — P9: BullMQ concurrency + LLM primary circuit breaker

**Blocking edges:** ride AFTER the guards branch lands (it touches the same
`worker/index.ts` workerOpts region as P5/P6).
**LOCKED:** explicit BullMQ concurrency + in-process breaker in the LLM task
seam (`src/lib/llm/`).
**Verified state:** `workerOpts` = `{connection, drainDelay: 5_000}` → BullMQ
default concurrency 1; stale comment at worker/index.ts:157 claims
"Concurrency 5" (line 166 correctly says 1). No breaker exists anywhere in
`src/lib/llm/`; `runLlmTask` (run-task.ts:110) does primary→fallback with
`timeout: 30_000, maxRetries: 0` (client-options.ts:10). Per-business Redis
concurrency guard caps at **3** (`src/lib/costs/concurrency-guard.ts:17`) and is
independent of BullMQ concurrency.
**Open questions (grill):** target concurrency value (comment said 5; guard caps
3/business — pick a value and fix the stale comment); breaker scope (per-provider
in the seam adapters vs per-task); trip/half-open thresholds; whether fallback
promotion during open-breaker needs its own alert.
