# Worker Scaling-Hardening Backlog

**Status:** Backlog (deferred from the 2026-06-17 pre-beta worker audit)
**Author:** Pre-beta worker bug scan
**Date:** 2026-06-17
**Scope:** Worker (Railway / BullMQ) scaling and resilience items that are **safe for a small beta** but must be fixed before the system carries hundreds → 1000+ businesses. The correctness/security/leak items found in the same audit were fixed inline (see "Fixed before beta" at the bottom); this file is the *deferred* list.

---

## How to read this

Every item is real, file:line-cited, and was verified against the code. None of them bite a 10–50 business beta. Each lists the **trigger** — the scale or condition at which it starts to hurt — so you can sequence the work against actual growth instead of guessing.

**Load-bearing context for the whole list:** `railway.toml` sets **no `numReplicas`**, so the worker runs as a **single replica** today. Several items below are *latent* — they only bite once you scale the worker horizontally (the natural response to load). Adding a second replica without first addressing the "multi-replica" items will cause duplicate processing. There is currently no guard preventing horizontal scaling, so treat "add a replica" as a change that requires this list to be cleared first.

The fix pattern for most of the poller items already exists in-repo: **`ZernioRecentReviewPoller`** (keyset cursor + per-cycle connection cap + bounded fan-out concurrency + per-cycle deadline). "Port the ZernioRecentReviewPoller shape" below means copy that structure.

---

## P1 — Fix before ~hundreds of businesses

### 1. EngagementMonitorPoller: unbounded driving query + full-table aggregation
- **Where:** `worker/background/pollers/EngagementMonitorPoller.ts:84-128`
- **Problem:** The candidate query has **no `LIMIT`** and aggregates the entire `responses` and `notification_deliveries` tables (filtered only to active businesses) into one row per active business. No keyset cursor, no per-tick deadline.
- **Impact at scale:** At ~1000 businesses the driving `SELECT` materializes 1000 rows after a super-linear aggregation. Once that aggregation crosses the Postgres.js `statement_timeout: 30_000`, the **entire query aborts every tick** → the poller silently processes **zero** businesses and engagement alerts stop firing.
- **Trigger:** Aggregation cost is a function of total `responses` + `notification_deliveries` volume, not just business count. Watch when the daily tick latency climbs past a few seconds.
- **Fix:** Port the ZernioRecentReviewPoller shape — keyset cursor on `business_id` + `LIMIT` per tick + per-cycle deadline. Optionally pre-filter `active_biz` to businesses with recent activity before aggregating.

### 2. Summary/Impact/Drip workers run at BullMQ default `concurrency: 1` + no Resend rate-limit guard
- **Where:** `worker/index.ts:157-167` (workers registered with no `concurrency`); email client `src/lib/notifications/email/client.ts:9` (bare `new Resend()`, no limiter).
- **Problem:** Weekly/Monthly summaries fan out ~1 email per business inside a 1-hour scheduler window, but execute **one job at a time**. Separately, there is **no token-bucket / 429 handling** on the Resend send path (SerpAPI has a budget guard; email does not).
- **Impact at scale:** At ~1000 businesses the weekly/monthly batch can't drain inside (or near) its window → reports arrive hours/days late. Naively raising `concurrency` just relocates the bottleneck to a **Resend 429 storm**: 429s surface as thrown errors → BullMQ retries exhaust → silently dropped reports.
- **Trigger:** Total active businesses approaching the count that, at ~2–4s/job serial, exceeds the scheduler window (~roughly 500–900 depending on per-job latency).
- **Fix:** Set an explicit `concurrency` (≈5–10) on `weeklySummaryWorker` / `monthlyImpactWorker` / `onboardingDripWorker` **and** add a shared token-bucket (reuse `checkRateLimit`) sized to the Resend plan RPS; on 429 throw a typed retryable error and honor `Retry-After`. Fix both together or neither.

### 3. StripeLocationsReconcilePoller: unbounded, fully serial, ~3 Stripe calls/account
- **Where:** `worker/background/pollers/StripeLocationsReconcilePoller.ts:62-115` + `worker/background/pollers/billing-reconciliation/reconcile-account.ts` (retrieve + `subscriptions.list` + `invoices.createPreview` per account).
- **Problem:** Every active + past_due account is loaded with **no `LIMIT`** and reconciled **serially**, each costing ~3 sequential Stripe round-trips. No per-account/per-cycle deadline; single-flight `inProgress` flag.
- **Impact at scale:** ~3000 serial Stripe calls/hour at 1000 accounts (~17 min/cycle at ~1s/account, with no headroom). When a cycle exceeds the 1-hour interval, the single-flight guard makes subsequent ticks no-op → reconciliation cadence silently degrades. **This is read-only — no money-correctness risk**, only degraded drift *detection*.
- **Trigger:** Cycle wall-clock approaching the poll interval.
- **Fix:** Keyset paging + `LIMIT` rotation cursor + per-cycle deadline + bounded fan-out concurrency (3–5). Port the ZernioRecentReviewPoller shape.

### 4. Unbounded single-statement purge DELETEs (GDPR completion risk)
- **Where:** `worker/jobs/account-offboarding/purge-helpers.ts:75-89` (`deleteByBusiness`) and `worker/jobs/account-offboarding/purge-stages.ts:164-256`.
- **Problem:** Each purge stage runs one giant unbounded `DELETE … WHERE business_id IN (…)` / `UPDATE api_costs … WHERE account_id = …` with no `LIMIT`/batching, inside one `sql.begin` transaction.
- **Impact at scale:** A high-volume location (tens of thousands of `reviews`/`responses`/`api_costs` rows) can exceed `statement_timeout`; the purge then **retries from scratch and times out again** — a permanently-stuck GDPR erasure that never makes incremental progress, plus long lock holds.
- **Trigger:** First purge of any high-review-volume account.
- **Fix:** Batch destructive deletes (`DELETE … WHERE … LIMIT n` loop, or `ctid`-batched) so each statement is bounded and the stage is resumable. Confirm a stuck-purge alert exists.

---

## P2 — Fix before adding a second worker replica (multi-replica latent races)

> Dormant at the current single replica. Each becomes a live bug the moment a second replica runs (including the brief overlap during a zero-downtime redeploy). The root cause is the same across all of them: an unbounded driving `SELECT` with **process-local single-flight** (`isPolling`) instead of a DB row lease.

### 5. CancellationGracePoller: no `LIMIT`, no row lease → duplicate audit rows
- **Where:** `worker/background/pollers/CancellationGracePoller.ts:39-105`
- **Problem:** Candidate `SELECT` has no `LIMIT` and no `FOR UPDATE SKIP LOCKED`. The inner archive `UPDATE` is idempotent (`archived_at IS NULL`), but each replica writes `account_audit_log` rows from its **own** `RETURNING` set.
- **Impact:** Two replicas both archive the same expired account → **duplicate audit-log entries** for one archival event (the location UPDATE itself is a safe no-op for the second replica).
- **Fix:** Add `LIMIT` + claim each account with `FOR UPDATE SKIP LOCKED` (or an `account_id` advisory lock).

### 6. CleanupAbandonedSignupsPoller: bounded but no row lease → wasted work
- **Where:** `worker/background/pollers/CleanupAbandonedSignupsPoller.ts:86-100`
- **Problem:** Candidate `SELECT` is `LIMIT`ed (good) but lacks `FOR UPDATE SKIP LOCKED`. The destructive path is already **safe** (per-email `pg_advisory_xact_lock` + re-validate-under-`FOR UPDATE` inside the tx, exactly as documented in CLAUDE.md), so `deleteUser()` cannot fire on a wrong row.
- **Impact:** Two replicas select the same oldest candidates and serialize on the advisory locks → redundant Supabase admin round-trips and held locks. **Not corruption** — wasted work.
- **Fix:** Add `FOR UPDATE SKIP LOCKED` to the candidate `SELECT` so replicas claim disjoint sets.

---

## P3 — Resilience / throughput hardening (lower urgency)

### 7. Single OutboxPoller is global FIFO across all topics
- **Where:** `worker/background/pollers/OutboxPoller.ts:154-166` (`ORDER BY available_at LIMIT BATCH_SIZE`, ~100 rows/min at defaults).
- **Problem:** One poller drains 25 topics in global `available_at` order. A bulk fan-out (e.g. ~1000 monthly-report rows enqueued in one window) interleaves with and **delays dispatch of latency-sensitive topics** (`send_notification`, `publish_response`).
- **Impact at scale:** Owner-approval notifications queue behind bulk report fan-out at month boundaries.
- **Fix:** Raise `OUTBOX_BATCH_SIZE` (env-tunable up to 500) and shorten the interval, and/or add lightweight per-topic priority so latency-sensitive topics aren't starved. At minimum, document the dispatch-rate ceiling vs expected peak enqueue.

### 8. NotificationFailoverPoller holds a DB connection across the Resend round-trip
- **Where:** `worker/background/pollers/NotificationFailoverPoller.ts:81-107` (`tryClaimAlert`: `sql.begin` → advisory lock → `sendFn()` (Resend/Twilio) → `INSERT`, all in one tx). The file's own comment flags this as deferred.
- **Problem:** Each claim holds a `sql.begin()` connection across the external HTTP send. The driving SELECTs are capped at `BATCH_LIMIT = 200`; the worker pool `max` defaults to 10.
- **Impact at scale:** During a large stuck backlog (exactly when this poller fires), up to 200 sends each hold a connection for the full Resend round-trip → pool starvation for every other worker job (publisher, generator, outbox dispatch) on the same Postgres.js client.
- **Fix:** Acquire the advisory lock + dedup re-check in a short tx, COMMIT, send outside any tx, then record delivery in a second short tx (or use a provider idempotency key + `ON CONFLICT`).

### 9. Regen daily budget consumed on every retry, even on a free cache hit
- **Where:** `worker/jobs/response-generation/generate-draft.ts:52-62` (`checkRegenBudget` INCRs before the in-`generateResponse` idempotent-cache check).
- **Problem:** `checkRegenBudget` does an unconditional `INCR` *before* the cache check that would make a retry free. With `MAX_REGEN_PER_REVIEW_PER_DAY = 3` and BullMQ `attempts: 3` + the 1h watchdog, transient retries of one owner-requested regen burn the daily cap without new LLM spend, then terminally reject the owner's *next legitimate* regen and inflate the read-only UX counter.
- **Impact:** Per-owner UX bug; severity independent of fleet size but more visible with more active owners.
- **Fix:** Move the `checkRegenBudget` INCR after the idempotent-cache miss is confirmed (only count a regen when an LLM call will actually happen).

---

## P4 — Sign-off items (by-design tradeoffs / low-stakes; confirm or accept)

| # | Item | Where | Note |
|---|---|---|---|
| 10 | Stripe `customer.subscription.updated` has no event-ordering guard — out-of-order updates on the current sub can leave stale tier/qty | `worker/ingress/stripe/subscription-updated.ts:89-112` | Reconcile poller **detects** the drift (read-only alert) but doesn't auto-heal. Add an `event.created` high-water mark when convenient. |
| 11 | `invoice.payment_failed` / `invoice.paid` not scoped to the current subscription | `worker/ingress/stripe/invoice-payment-failed.ts:7-41` | An unrelated failed one-off invoice can flip a paying customer to `past_due`. Gate on `invoice.subscription === acctRow.stripe_subscription_id` + `billing_reason`. |
| 12 | `cancel_only` offboarding doesn't disconnect Zernio connections created *during* the scheduled window (stale confirm-time snapshot) | `worker/jobs/account-offboarding/teardown-zernio.ts` + `src/lib/account-offboarding/confirm.ts` | Live ingest can continue on a churned account. Mirror delete_data's `UPDATE zernio_connections SET status='disconnected'` in cancel_only confirm, or block `connect` in the cancellation-pending lane. |
| 13 | Publisher marks a genuinely-posted reply `failed` if the Zernio read feed lags through all 3 verify attempts | `worker/jobs/publisher/verify-posted.ts:135-145` | Customer-visible false failure during a Zernio read-replica lag spike; self-corrects on manual retry (re-post 409s → verifies). Consider parking-for-delayed-re-verify on the `review_found_but_reply_null` exhaustion case. |
| 14 | OnboardingDemo cost accounting can drift below actual spend (`Promise.allSettled` masks partial LLM failures); `reset_to_queued` re-dispatch leaks the 20¢ reservation | `src/lib/demos/generate-responses.ts`; `worker/jobs/OnboardingDemoWorker.ts:99-101` | Bounded by the $10/day global pre-pay ceiling. Reconcile actual fulfilled-call cost into the daily counter; add a reserve↔finalize parity test across reset→redispatch→complete. |
| 15 | `computeContentHash` ignores reviewer-name/date changes | `src/lib/reviews/types.ts:33` | A name/date-only edit is treated as `unchanged` (no regen, and not caught by the auto-approval review-hash gate). Either include `reviewerName` in the hash or document the intent. |
| 16 | `releaseConcurrencySlot` DECR + conditional `SET 0` is non-atomic | `src/lib/costs/concurrency-guard.ts:65` | Self-healing + bounded by the 300s TTL; collapse into one Lua script mirroring the acquire path when next touched. |

---

## Fixed before beta (for cross-reference — NOT deferred)

These were fixed inline on branch `fix/pre-beta-worker-hardening` in the same pass:

1. **`finalizeCost` Redis flake silently lost a paid-for draft** → `src/lib/responses/generator.ts:171` now passes `onFinalizeError: 'log-and-return-value'` (matches `review-summary.ts`).
2. **Approval-notification double-send window** (record-after-send) → `worker/jobs/notification/dispatch.ts` now claims a pending `notification_deliveries` row **before** the send (`insertPendingApprovalDelivery`), finalizes on success, flips to failed on error; the normal-mode dedup now uses `failed_at IS NULL` so it catches pending claims. *(No migration: `approval_request` has historical multi-row deliveries from failover re-sends, so a partial-unique claim index like `auto_post_notice`'s can't be built over existing data; dispatch is single-flight per response, and an orphaned claim is recovered by the failover poller's stale branch.)*
3. **SerpAPI 60s default timeout** → explicit `SERPAPI_TIMEOUT_MS = 12_000` in `serpapi-source.ts` and `place-id-resolver.ts` (under the 25s shutdown grace window).
4. **`formatAutoPostNoticeWhatsApp` missing length cap** → now `truncate(oneLine(...), MAX)` for business/reviewer names (mirrors the approval formatter; closes the same 21656 class).
5. **`reviewDate` rendered "Invalid Date"** → `NotificationWorker.formatReviewDate` guards `NaN`/null and degrades to empty string.
6. **Core infra env vars not asserted at boot** → `assertCoreInfraEnv` (in `worker/config/startup-assert.ts`) now fails fast on missing `DATABASE_POOL_URL` / `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `REDIS_QUEUE_URL`.
