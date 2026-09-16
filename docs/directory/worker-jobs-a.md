## `worker/`

### `worker/jobs/` — BullMQ Job Handlers

Each file exports a single `handle*` function that a BullMQ `Worker` calls per job.

**All handlers follow this contract:**
1. Parse the typed job payload.
2. Load DB data.
3. Check subscription status (via `checkSubscription`).
4. Do the work.
5. Call `markOutboxCompleted()` or `markOutboxFailed()`.
6. All operations are idempotent — safe to replay.

| File | Queue | What it does |
|------|-------|--------------|
| `zernio/ZernioReviewIngestWorker.ts` | `ingest_zernio_review` | Zernio webhook → outbox → this handler. Per-location `listReviews` call, runs `guardZernioJobEligibility` + the PHI gate, then `processReview` — dedup on `(provider, provider_review_name)`, INSERT `reviews`, start the run spine, enqueue `generate_response` via outbox (the `responses` row is created later by `ResponseGeneratorWorker`). Migration 030's partial unique index on `(business_id, zernio_review_id)` keeps in-flight rows from duplicating during webhook retries. Maps `ZernioReviewNotFoundError` to a `review_exceptions` row + admin alert. |
| `zernio/ZernioBackfillWorker.ts` | `zernio_initial_backfill` | **(#675)** Consented Review import executor — NOT an answering backfill. Pure `selectImportWindow`: newest 100 reviews with `createTime ∈ [now − 12 months, live-ingest cutoff)` (`docs/context/core-reviews-responses.md` glossary; upper bound keeps lane ownership disjoint from the live lane). Pages `listReviews` up to `ZERNIO_IMPORT_MAX_PAGES` (default 6); cap-out with target unmet is TERMINAL (`ZernioImportPaginationCapExhaustedError`, failed outbox row + Sentry, `completed_at` NULL for ops re-enqueue); non-descending pages disable both early stops (best-effort to feed end). **(#679)** Runs `guardImportConsent` FIRST — before `guardZernioJobEligibility` and before the run-row INSERT — so a job for a non-`accepted` business no-op-completes and mints no run row. Unanswered → `importReview` (zero `job_outbox` writes); answered → `reconcileExternallyAnsweredReview({consentedImport:true})`. Writes ONLY collapsed `imported_count`/`skipped_count` on `zernio_backfill_runs` — the four legacy gap/historical counters freeze at DEFAULT 0, DROP at #680 after a reconciliation preflight. Concurrency 1 (heavy). Subscription-guarded. |
| `ResponseGeneratorWorker.ts` | `generate_response` | Loads review + business context, calls `generateResponse()`, saves draft, enqueues notification via outbox. **(WS5)** terminal draft failures close the matching outbox attempt and complete the active review run as failed in one reviews-first transaction. **(#728, ADR 0017)** `persistResponseAndNotify` (`response-generation/persist.ts`) runs the lane-independent **content-freshness gate** before the lane split: under the review `FOR UPDATE` lock (the tx's first statement) it re-reads `review_content_hash`; both hashes non-null and different → skip-the-INSERT, and the handler completes the job with `markOutboxCompletedWithReason(…, STALE_REVIEW_CONTENT, …)` — nothing written, the `(review_id, version)` slot stays free for the colliding fresh job. Null on either side passes. |
| `notification/NotificationWorker.ts` | `send_notification` | Orchestrates the notification send loop. Delegates context loading to `notification/context.ts`, eligibility filtering to `notification/eligibility.ts`, and per-channel dispatch to `notification/dispatch.ts`. Skips `pending_payment` and `cancelled`. |
| `escalation-notice/EscalationNoticeWorker.ts` | `escalation_notice` | **(WS3)** Sends the Guardian escalation notice to the owner's channels. Re-checks `ESCALATION_ENABLED` at SEND time (kill switch stops outbound notices without hiding raised escalations), reuses the approval worker's eligibility primitive, then hands off to `escalation-notice/dispatch.ts`. Afterwards records the `escalation_sent` step BEST-EFFORT (log-and-swallow — `notification_deliveries` is the authoritative per-channel record). |
| `auto-post-notice/AutoPostNoticeWorker.ts` | `auto_post_notice` | Sends the auto-approved post FYI ("your reply was posted") to the owner's channels after an `auto_policy` publish. Reuses the approval worker's eligibility primitive, then hands off to `auto-post-notice/dispatch.ts`. NEVER mutates the already-posted response — a send failure retries on this job alone. |
| `pending-post-notice/PendingPostNoticeWorker.ts` | `pending_post_notice` | **(WS4)** Sends the veto-window "your reply will post automatically" notice. Re-checks `AUTO_APPROVAL_ENABLED` at SEND time (spec §2.12; flag off ⇒ complete without sending — the publisher's downgrade backstop owns the record), loads the still-scheduled `auto_policy` response via `pending-post-notice/context.ts` freshness guards, reuses the approval worker's eligibility primitive, then hands off to `pending-post-notice/dispatch.ts`. NEVER mutates the response; the delayed publish outbox row is independent and fires at the deadline regardless. |
| `solicitation-veto-notice/SolicitationVetoNoticeWorker.ts` | `solicitation_veto_notice` | **(#631)** Sends the **Auto-approval lane**'s **Veto notice** ("N review requests were auto-approved… they will send once your veto window closes; stop them from the Requests page") after `autoApproveBatch` stamps a batch `auto_policy`. Gates on BATCH STATE ONLY via `solicitation-veto-notice/context.ts` — no flag reads anywhere in the family (owner re-lock decision 11); anchored is deliberately NOT a skip, since the **Veto anchor** reads this notice's own `sent_at`. Reuses the approval worker's eligibility primitive, then hands off to `solicitation-veto-notice/dispatch.ts`. Tokenless CTA `${appUrl}/dashboard/requests` — no approval link, unlike `pending-post-notice`. |
| `AutonomyAdminAlertWorker.ts` | `autonomy_admin_alert` | **(WS6)** Renders an internal account-suspension alert from bounded trigger/evidence facts, sends it to `ADMIN_NOTIFICATION_EMAIL`, then independently attempts Sentry warning telemetry so observability cannot poison a successful email path. |
| `billing/StripeSubscriptionMirrorSyncWorker.ts` | `stripe_subscription_mirror_sync` | **(WS8)** Converges deprecated business subscription status/activation from canonical account state. Locks business rows in id order, then entitlement, reads the account without a row lock, updates the mirror, and completes the originating outbox entry in one transaction. |
| `publisher/ResponsePublisherWorker.ts` | `publish_response` | POST-only flow. Checks `zernio_connections` for the business. **WS6:** every unposted `auto_policy` response first passes the judge flag/health gate; disabled or unhealthy downgrades to owner review under a durable audit action, while query failures retry. Active Zernio → resolves review ID + posts via `zernio-publisher.ts`, marking `posted`. Connection required but absent → transitions to `awaiting_owner_connect` + enqueues `send_owner_email` (reconnect_required). Uses `publisher-error-handlers.ts` for error classification. The DELETE+POST edit branch (`runEditPublisherIfApplicable`) is parked on tag `wip/edit-existing-replies-zernio-v1` pending direct GBP API. |
| `DrainOwnerConnectWorker.ts` | `drain_pending_owner_connect` | Re-enqueues stuck `publish_response` outbox rows when an owner (re)connects Zernio. Inserts fresh outbox entries for all `awaiting_owner_connect` responses, with three layers of idempotency (partial unique index, NOT EXISTS guard, ResponsePublisher early-exit). |
| `OwnerEmailWorker.ts` | `send_owner_email` | Discriminated payload router for owner-directed Zernio emails. `reconnect_required` → owner needs to reconnect Zernio so the queued reply can be published. `connection_lost` → Zernio reported GBP connection went offline. Both handlers apply subscription guard + bounce check + claim-before-send deduplication. |
| `AdminExceptionWorker.ts` | `notify_admin_review_exception` | Sends an internal alert email when a review processing failure requires human review. |
| `WeeklySummaryWorker.ts` | `weekly_summary` | Queries 7-day metrics and sends the Insights-labeled weekly report via Resend. **(WS5)** a newly claimed send first records and completes a `weekly_insights` run with a `digest_sent` step/outcome in the same transaction as the `sent_at` flip; replayed claims emit neither spine rows nor email. |
| `PlaceIdValidationWorker.ts` | `validate_place_id` | Verifies a Place ID is still accessible via SerpAPI; updates `place_id_verified` flag. |
| `MonthlyImpactWorker.ts` | `send_monthly_impact` | Generates monthly impact report email. |
| `EngagementAlertWorker.ts` | `engagement_alert` | Checks engagement thresholds, sends alert if below floor. |
| `RankingTrackingWorker.ts` | `track_ranking` | Calls SerpAPI for each keyword, saves ranking snapshots. |
| `OnboardingDripWorker.ts` | `onboarding_drip` | Sends onboarding email at the configured step (day 1 / 7 / 30). |
| `DemoGenerationWorker.ts` | `generate_demo` | Fetches SerpAPI reviews for a prospect, calls `generateResponse()` in `demo` mode, saves to `prospect_demos`. |
| `csv-ingest/index.ts` | `csv_ingest` | **(#541)** Contacts/visits CSV ingest (`handleCsvIngest`). Subscription gate derived from the upload row's business→account join (`subscriptionGrantsFullAccess`, invariant #11 — gated accounts leave the upload `pending`); delegates all match/merge/upsert + report behavior to `src/lib/solicitation/ingest.ts`. PII contract: logs counts/ids only — never names, handles, notes, or raw CSV. |
| `live-draft-guard.ts` | — (helper) | **(WS5)** `hasLiveOwnerActionableResponse(tx, reviewId)` — shared by `ResponseGeneratorWorker` and `publisher/failed-hook` terminal checkpoints; a run is never completed `failed` while an owner-actionable draft (non-terminal status) exists for the review. |
| `OnboardingDemoWorker.ts` | `onboarding_demo_response` | `handleOnboardingDemo` — pre-pay onboarding demo. Mock-leak guard on production-config lanes **(#611)**, inverted subscription guard (account no longer `pending_payment` → `failDemo`), `claimDemo` → resolve place → build source (SerpAPI or curated fallback) → `completeDemo`. Reconciles the 20¢ cost-guard reservation via `finalizeOnboardingDemoCost`; threshold check + Sentry are best-effort. Helpers in `onboarding-demo/`. |
| `summary-report-helpers.ts` | — (helper) | Shared by `WeeklySummaryWorker`, `MonthlyImpactWorker`, `OnboardingDripWorker`. `prepareSummaryReport` loads the business⋈account row and applies the skip gates (`completeOrFailSkippedSummaryReport`: not found → failed; archived / subscription-denied / bounced email → completed); `sendSummaryReportEmail` marks the outbox failed on send error; `loadLatestRankingSummary`, `resolveDashboardUrl` (post-034 owner join, **#719**), `calculateBaselineResponseRate`, `mapSummaryReviews`. |
| `solicitation-send.ts` | `solicitation_send` | **(#899)** Success-path root for the dispatch lane (`handleSolicitationSend`): extracts the outbox handle and makes one `dispatchOutreach` call — every gate, the token mint, the provider call and the terminal transaction live in `src/lib/solicitation/dispatch.ts` (invariant #12). Registered with an explicit `concurrency: 1` and pinned by `assertSingleConcurrencyWorker`: serial sending is what keeps the lane under Resend's per-TEAM 10 req/s limit and keeps the provider idempotency key's one-attempt-at-a-time assumption true, and the guard rejects an *undefined* concurrency too, so bare `workerOpts` fails boot. Deliberately absent from `assertSummedLlmWorkerSlots` — this lane calls no `runLlmTask`. |
| `solicitation-attribution/SolicitationAttributionWorker.ts` | `solicitation_attribution` | **(#632)** The **Attributed review** lookback for ONE newly ingested review (`handleSolicitationAttribution`). Orchestrates only (invariant #12) — every rule lives in `src/lib/solicitation/attribution.ts`: the invariant-#11 subscription guard runs FIRST over a file-local `businesses ⋈ accounts` read (`workerType: 'summary'`, because the choice moves only `pending_payment`, which is exempt for `generator` alone and must not attribute), then ONE `sql.begin` in which `markOutboxCompletedIfOwned` claims the attempt BEFORE `attributeReview` runs. That order is load-bearing (round-1 A1): the completion and the domain write share the transaction, so a matcher fault rolls the completion back and the entry stays redispatchable, and a `false` claim — a stale attempt, or a replay of the same one — mutates nothing. Idempotence keys on the outbox id, never the BullMQ job id; `account_id` is resolved inside `attributeReview` from the business FK and is deliberately absent from the payload (D3). Traps: there is NO `'failed'` exhaustion hook **by design** — attribution is a shadow metric with no downstream consumer, so an exhausted job costs one uncounted review and the shared `job-failure-sink.ts` still raises the Sentry issue on the terminal attempt; a business deleted between enqueue and dispatch settles the outbox row rather than looping the watchdog to exhaustion; the single `attribution_resolved` line logs the closed-set resolution, candidate count and rule and NEVER the reviewer name or review text, and needs no `try/catch` because `createWorkerLogger` is already fail-open twice over. |
| `agent-turn/AgentTurnWorker.ts` | `agent_turn` | **(Owner Operator Run A)** `handleAgentTurn` — one **Operator turn**. Kill-switch-first: `OWNER_OPERATOR_ENABLED` off fails the turn `operator_disabled` and completes the outbox row with zero LLM calls and no tenant load (the `judge_verdict` posture). Otherwise **Turn claim** on a 180 s lease → predecessor wait → re-authorize from the DB → **Context snapshot** → one cost-guarded `owner_operator` call → **Fenced completion**. Concurrency 1 and `flagGated: true` in `assertSummedLlmWorkerSlots` — the third gated LLM lane (ADR 0005, flag-on envelope 12). |

#### `worker/jobs/agent-turn/` — AgentTurnWorker package **(Owner Operator Run A)**

| File | What it does |
|------|--------------|
| `AgentTurnWorker.ts` | Kill-switch-first turn processor (see queue table above). A healthy predecessor wait atomically releases its claim and refreshes the exact dispatch attempt, including delivery before enqueue acknowledgement, then uses `moveToDelayed` + `DelayedError` without spending retries. Scheduling failures still reject for retry; transient errors release without a heartbeat. Writes segments/proposals/unsupported rows in one fenced transaction; a lost lease discards output. |
| `failed-hook.ts` | Retry-exhaustion terminalizer. ONE transaction, outbox fence FIRST: `markOutboxFailed` decides whether this exhausted dispatch still owns the row, and only then does the status-guarded turn transition run. A superseded dispatch leaves a newer running attempt alone. |
| `constants.ts` | Lease (180 s), predecessor stall limit (1200 s) and wait delay (10 s), each with the number it is derived from. Provisional per spec §14 — tune from staging p50/p95 at the checkpoint. |

#### `worker/jobs/csv-ingest/` — contacts CSV ingest package **(#541)**

| File | What it does |
|------|--------------|
| `index.ts` | Composition root for the `csv_ingest` queue (see the queue table above). |
| `failed-hook.ts` | Retry-exhaustion terminalizer (`handleCsvIngestFailed`, mirrors `zernio/ingest-failed-hook.ts`). Takes the SAME per-business advisory lock as the ingest tx, re-reads `status='pending'` under it, then — gated by the exact outbox-attempt CAS — terminalizes the upload to `failed` with an `ingest_failed` report and clears `raw_csv` in one transaction (§3: the raw blob's lifetime is bounded by processing, success or failure). Persists only the bounded error CLASS — raw messages can embed handle values. |

#### `worker/jobs/judge/` — JudgeWorker package **(WS6)**

| File | What it does |
|------|--------------|
| `JudgeWorker.ts` | Kill-switch-first post-hoc evaluator. Loads eligible posted auto-policy context, executes the cost-guarded pinned judge task, then anchors the review lock before inserting the verdict; `flag` suspends account autonomy in the same transaction. It adds no agent-run completion. |
| `context.ts` | Loads response/review/business/account context and applies post-hoc eligibility guards without leaking source-specific data into the judge prompt. |
| `failed-hook.ts` | Terminal BullMQ exhaustion checkpoint: exact-attempt-CAS fails the outbox and records an `error` verdict in a reviews-first transaction; stale replays cannot write terminal state. |

#### `worker/jobs/autonomy-suspended-notice/` — owner safety notice package **(WS6)**

| File | What it does |
|------|--------------|
| `AutonomySuspendedNoticeWorker.ts` | Account-level owner-notice orchestrator. Re-checks the current suspension event, subscription/offboarding posture, and owner channels, dispatches without review/reply content, and keeps a live delivery claim retryable. |
| `context.ts` | Loads the suspension audit event, account, delivery-anchor business, and verified enrollments; guard-and-return branches make stale/mismatched/offboarded notices harmless. |
| `dispatch.ts` | Per-channel claim-before-send loop. Handles settled claims, keeps concurrent/live pending claims incomplete, pre-filters the optional WhatsApp template, and isolates provider errors from delivery-lifecycle DB failures. |
| `errors.ts` | Pure transient-vs-terminal notice-send classifier; never mutates enrollment state. |

#### `worker/jobs/notification/` — NotificationWorker sub-modules

Extracted from `NotificationWorker.ts` to keep each concern focused. The orchestrator imports all four.

| File | What it does |
|------|--------------|
| `NotificationWorker.ts` | Orchestrator. Imports all four sub-modules below and runs the notification send loop. |
| `context.ts` | Loads response + business rows; applies early-exit guards (not found, ID mismatch, wrong status). Returns discriminated `{ result: 'ok' | 'skip' | 'fail' }`. |
| `dispatch.ts` | Per-channel send loop with isolated error handling. One failed channel does not abort the rest. Calls `getChannel()`, `createApprovalLink()`, `recordNotificationDelivery()`. |
| `eligibility.ts` | Subscription guard + feature-flag check + `getVerifiedEnrollments()`. Returns the list of channels eligible to receive the notification. |
| `errors.ts` | `classifyChannelError()` — maps provider errors to a discriminated dispatch directive (enrollment mutation, failure reason, log level). No DB writes; the dispatcher applies the directive. |
| `outcomes.ts` | `DispatchOutcome` — the `{ attempted, succeeded }` counters `dispatch.ts` returns. |
| `plan.ts` | Canonical channel dispatch order (`NOTIFICATION_DISPATCH_CHANNEL_ORDER = CHANNEL_IDS`). `buildNotificationDispatchPlan` filters it by eligibility; `orderNotificationDispatchEnrollments` sorts enrollments into that order and drops unknown/stale channel rows (e.g. `'sms'`) instead of crashing. Used by `dispatch.ts`. |

#### `worker/jobs/escalation-notice/` — EscalationNoticeWorker sub-modules

| File | What it does |
|------|--------------|
| `EscalationNoticeWorker.ts` | Orchestrator (see the queue table above). |
| `context.ts` | Loads escalation + review + business rows with escalation-specific guards: not-found/id-mismatch → fail; `resolved` → skip (moot); archived/offboarding → skip. Triage snapshot comes from the `review_escalations` row — no LLM call. |
| `dispatch.ts` | Per-channel delivery loop, SEPARATE from the approval dispatcher (no `approval_links`). Claim-before-send idempotency on `notification_deliveries` (partial-unique claim index, migration 073); pre-filters WhatsApp when `WHATSAPP_ESCALATION_TEMPLATE_SID` is unset. Log lines carry escalation ids only. |
| `errors.ts` | `classifyEscalationNoticeSendError()` — retryable (claim released for BullMQ retry) vs terminal (failed delivery row), driven by the single-owner `isTransientChannelSendError` predicate; never flips enrollment. |

#### `worker/jobs/auto-post-notice/` — AutoPostNoticeWorker sub-modules

| File | What it does |
|------|--------------|
| `AutoPostNoticeWorker.ts` | Orchestrator (see the queue table above). |
| `context.ts` | Loads the posted `auto_policy` response + business rows; skip guards (not found/mismatch → fail; not posted / not auto-policy / archived / offboarding → skip). |
| `dispatch.ts` | Per-channel FYI loop — no `approval_links` (the post already happened; single "View on Google" CTA). Claim-before-send idempotency via `claimAutoPostNoticeDelivery`; pre-filters WhatsApp when `WHATSAPP_AUTOPOST_TEMPLATE_SID` is unset. |
| `errors.ts` | Retryable-vs-terminal classification for FYI sends; never flips enrollment. |

#### `worker/jobs/pending-post-notice/` — PendingPostNoticeWorker sub-modules **(WS4)**

Third topic-clone sibling of `auto-post-notice`/`escalation-notice` (bounced-owner email skip included from day one).

| File | What it does |
|------|--------------|
| `PendingPostNoticeWorker.ts` | Orchestrator (see the queue table above). |
| `context.ts` | Loads response + review + business rows with veto-window freshness guards: not found/mismatch → fail; no longer `approved`/`auto_policy` (vetoed, kill-switch-downgraded, posted, superseded) → skip; `auto_post_scheduled_at` NULL or already passed → skip (stale backlog — an unactionable notice is noise); archived/offboarding → skip. Deadline staleness is compared IN SQL against the same DB clock that stamped it. |
| `dispatch.ts` | Per-channel delivery loop. Unlike its two siblings it creates an approval link per delivery (`create-link.ts`) — the notice's single CTA is the tokenized approve page (view / edit / cancel). Claim-before-send idempotency via `claimPendingPostNoticeDelivery` (partial-unique claim index, migration 074); pre-filters WhatsApp when `WHATSAPP_PENDING_POST_TEMPLATE_SID` is unset. Log lines carry ids only; the raw token is redacted from `failure_reason` too (invariant #5). |
| `errors.ts` | Retryable (claim released for BullMQ retry) vs terminal (failed delivery row), driven by the single-owner `isTransientChannelSendError`; never flips enrollment. Notice delivery failure never blocks the publish. |

#### `worker/jobs/solicitation-veto-notice/` — SolicitationVetoNoticeWorker sub-modules **(#631)**

Fourth topic-clone sibling of `auto-post-notice`/`escalation-notice`/`pending-post-notice`, for the **Auto-approval lane**'s **Veto notice** — BATCH-scoped, not response/review-scoped.

| File | What it does |
|------|--------------|
| `SolicitationVetoNoticeWorker.ts` | Orchestrator (see the queue table above). |
| `context.ts` | Loads business+account rows FIRST (unlike its siblings, which load their subject first) — `account_id` isn't on the payload, so the batch lookup below needs it to be tenant-scoped by BOTH `account_id` AND `business_id`. Skip guards: archived / offboarding → skip; batch not found (incl. cross-tenant, indistinguishable by the scoped WHERE) → fail; `approval_method != 'auto_policy'` / halted / `send_closed_at` → skip. Anchored is deliberately NOT a skip — a retry must still claim any channel that hasn't delivered, and the **Veto anchor** is computed FROM this notice's own `sent_at`. Reads N (live rendered Outreach count) fresh at send time, not off the payload. |
| `dispatch.ts` | Per-channel delivery loop. Tokenless CTA — creates no approval link, unlike `pending-post-notice`. Claim-before-send idempotency via `claimSolicitationVetoNoticeDelivery` (migration 113's `notification_deliveries_solicitation_veto_notice_claim` index); pre-filters WhatsApp when `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID` is unset. Logs the systemic-failure signal (decision 12's dispatch-zero-sent half) when every attempted channel skips or fails. |
| `errors.ts` | Retryable (claim released for BullMQ retry) vs terminal (failed delivery row), driven by the single-owner `isTransientChannelSendError`; never flips enrollment. |
