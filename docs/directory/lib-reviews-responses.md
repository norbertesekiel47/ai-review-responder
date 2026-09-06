## `src/lib/`

### `approval/`

Everything related to the email approval link flow.

| File | What it does |
|------|--------------|
| `service.ts` | Barrel re-export of the modularized approval layer (errors, correlation, audit, locks, the three mode files). New code imports the specific module directly. |
| `token-mode.ts` / `session-mode.ts` / `callback-mode.ts` | The three approval lanes: token link (`/approve/[token]`), dashboard session, and Telegram/WhatsApp button callbacks (`approveViaCallback` — button lanes cannot edit). **(WS4)** each approve/edit chokepoint (five total) records `reply_approved_no_edit` / `reply_edited_by_owner` in-tx via `outcomes.ts`. |
| `locks.ts` | Lock + validation helpers shared by all three modes (`lockValidLink`, `lockPendingResponse`, `verifyDevice`, `consumeLink`) — `SELECT … FOR UPDATE` inside the caller's tx. |
| `http-routes.ts` | Route wrappers (`runTokenApprovalAction`, `runDashboardReviewAction`) — rate limit, CSRF, device binding, one tx, audit context, standard error mapping. **(WS4)** the dashboard wrapper takes the reviews-first lock anchor (`anchorReviewLockOrder`) as its tx's FIRST statement. |
| `outcomes.ts` | **(WS4)** Owner-decision outcome instrumentation shared by the five approve/edit chokepoints, plus `anchorReviewLockOrder` — the global lock-order anchor (unlocked pre-read of the immutable `review_id`, then reviews `FOR UPDATE` BEFORE any response lock; the veto.ts header owns the deadlock analysis). Regenerate lanes record no outcome. |
| `veto.ts` | **(WS4)** `vetoAutoPost()` — owner cancel of a scheduled auto-post (spec §2.6), takes `tx`. The pending `publish_response` outbox row is the atomicity token: succeeds IFF the tx terminalizes it while still `pending` (`completed` + `last_error='auto_post_vetoed_by_owner'` — the ONE `AUTO_POST_VETOED_BY_OWNER` marker, also written to `posting_error` below); then guarded downgrade to `pending_approval` (`posting_error='auto_post_vetoed_by_owner'`, clears `auto_post_scheduled_at`), audit `veto_cancel`, `reply_vetoed_by_owner` outcome on an active run, link consumed, re-notify enqueued. 0 rows ⇒ `too_late`/`already_cancelled` — never a posted-after-"cancelled" state. |
| `create-link.ts` | `createApprovalLink()` — generates a secure raw token (random bytes), hashes it with SHA-256, stores only the hash in `approval_links`. Channel-scoped. |
| `cookies.ts` | Device-cookie and CSRF-cookie management (set / read / clear). |
| `correlation.ts` | `recoverCorrelationId()` — reads correlation ID from the current approval session for audit logging. |
| `audit.ts` | `insertAuditLog()` — `approval_audit_log` writes, same-tx as the action they record. **WS6** adds `auto_policy_revoked_judge_unavailable` for the publisher's judge-health downgrade. |
| `errors.ts` | Approval-specific error classes (`ConsumedLinkError`, `RevokedLinkError`, `ExpiredLinkError`, `ChannelMismatchError`, `ResponseNotPendingError`; **(WS4)** `VetoTooLateError`). |
| `http-errors.ts` | Maps approval errors to HTTP status codes and response bodies. **(WS4)** maps a 40P01 deadlock-loser rollback to a retryable 409 `conflict_retry` (the veto ↔ mark-posted collision is expected concurrency, not a 500). |
| `types.ts` | Shared approval types (`ApprovalLink`, audit contexts). |

**Connection:** `NotificationWorker` and `pending-post-notice/dispatch.ts` call `create-link.ts` to produce tokens before sending. The approval API routes consume them via the mode files; the veto route calls `veto.ts`.


### `auto-approval/`

Auto-policy evaluation plus the WS6 account-level safety governor and suspension state machine.

| File | What it does |
|------|--------------|
| `flags.ts` | Server-only `autoApprovalEnabled()` / provider-readiness accessors; **WS6** adds `governorEnabled()` over `readFlag`, default off. |
| `account-lock.ts` | **(WS6)** `lockAutonomyAccount()` serializes suspend, governor, and admin-unsuspend transactions on the billing-parent account row and throws a typed not-found error. It takes no review-lane locks. |
| `governor.ts` | **(WS6)** Fair circular candidate scan, in-transaction stale revalidation, batched seven-day owner-edit/veto/judge-signal rates, minimum sample floors, and threshold evaluation for account-level suspension. |
| `suspension.ts` | **(WS6)** Idempotent account-default policy suspension (including override-only accounts), durable account audit + owner/admin outboxes in one transaction, manual admin re-arm, and the bounded admin suspension read model. WS4 suspension semantics remain authoritative. |
| `policy.ts` | Pure policy math shared by the worker evaluator, the settings service and the admin mappers: `resolveEffectivePolicy(accountDefault, locationOverride)` (override wins the threshold; account-level `suspended_at` still applies), `starMeetsThreshold`, `exposureRank`, `resolveDailyCap` (`DEFAULT_DAILY_AUTO_POST_CAP` 10), `DEFAULT_VETO_WINDOW_MINUTES` 15, and the **(WS8)** exposure classifiers (`classifyThresholdExposure`, `classifyVetoWindowExposure`, `classifyDailyCapExposure` — removing a cap is always an expansion — combined by `classifyPolicyExposure`, any expansion wins; `completeDisable` is never an expansion). |
| `readiness.ts` | `buildAutoApprovalReadiness(input)` — folds `runtimeEnabled`, `autopilotAvailable`, provider-moderation enabled/validated, `accountWritable`, `policySuspended`, `previewEnvironment` and `impersonated` into an `AutoApprovalReadiness` (`canExpand` + ordered `blockReasons`). Suspension blocks expansion only; contractions stay allowed. Consumed by `settings.ts` and the admin business-detail mappers. |
| `settings-guards.ts` | **(#631 fallow-gate fix wave)** The shared write-guards BOTH settings lanes enforce on every policy write: `SettingsAccountEntitlementRow` (the FOR UPDATE-captured entitlement row), `accountSubscriptionWritable` (one owner of "which subscription states may write settings"), `assertConfirmationProvided` (the `standard` expansion confirmation rule), and the two errors those gates throw (`AutoApprovalConfirmationRequiredError`, `AutoApprovalExpansionBlockedError`). Housed outside `settings.ts` because `settings.ts` imports the Solicitation lane for its PATCH/GET join points — guards living there made the two settings lanes a module cycle. Imports no DB client (invariant #15). |
| `settings.ts` | Server-owned read/write of `auto_approval_policies` (invariant #14 — browser code never touches the table): `getAutoApprovalSettings(db, { accountId, impersonated })` and `patchAutoApprovalSettings(sql, input)` behind `GET`/`PATCH /api/settings/auto-approval`. PATCH runs in one tx: account row `FOR UPDATE`, offboarding gate, before-state read, pure after-state, then archived-location → `standard` confirmation → readiness gates BEFORE any write, upsert/delete, `auto_approval_policy_changed` audit. Throws `AutoApprovalConfirmationRequiredError` / `AutoApprovalExpansionBlockedError` / `AutoApprovalSettingsError`. The Solicitation lane (#631 D20) lives in `solicitation-settings.ts` — this file keeps the public interface and joins to it at exactly two points: `updatePolicyInTransaction`'s solicitation branch (PATCH) and the GET response's `solicitation` block. |
| `solicitation-settings.ts` | **(#631 D20; extracted from `settings.ts` in the round-1 review)** The Solicitation lane of the auto-approval settings: `applySolicitationMutation` (the PATCH branch — classify exposure → `standard` confirmation → expansion gate → declarative upsert/DELETE of the ONE `persona='solicitation' AND action_class='sending' AND location_id IS NULL` account-default row → audit) and `loadSolicitationApiState` (the GET `solicitation` block; `available` = both lane flags AND `tierGrantsAutopilot`). Traps: enabling — no row before — is ALWAYS an expansion (the D20 opt-in IS the exposure); the cap dimension classifies through `resolveAccountDailySendCap`'s ≤10 clamp, so storing 50 over 30 is `no_change`; the suspension input is the D19 account-wide read via `readAccountWideSuspension` (`src/lib/solicitation/auto-approval.ts` — the locked semantic's ONE owner), never a re-spelled EXISTS; disabling DELETEs only the solicitation row — laundering-safe because the Governor's account-wide kill switch lives on the REPLY account-default row. Injected `Sql`/`TransactionSql` (invariant #15). |
| `types.ts` | Auto-approval vocabulary and API contract: `AutoApprovalThreshold` (4 | 5 — positive quadrant only, WS4 §2.2), `VetoWindowMinutes` (15 | 30), daily-cap schema (1..50 or null), `APPROVAL_METHOD` (`owner` / `auto_policy`), `POLICY_PERSONA_REPLY` / `POLICY_ACTION_POSTING`, `PolicyRowState`, `EffectiveAutoApprovalPolicy`, `AutoApprovalReadiness` + block reasons, the settings response DTOs, `autoApprovalThresholdLabel`, and `AutoApprovalPatchSchema` (zod discriminated union — the single source of the `PATCH /api/settings/auto-approval` contract, incl. **(WS8)** dial ops). |


### `reviews/`

Everything about fetching and normalising Google reviews.

> **Review import consent — rules the code does not make obvious** (moved here
> from the CLAUDE.md routing row on 2026-08-16; spec
> `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` — §2
> decision table D1–D10 is **locked**; ADR
> `docs/adr/0015-consented-import-unflagged-replacement.md`; ADR
> `docs/adr/0016-import-consent-enforcement-locus.md` — enforcement locus, why
> not a `job_outbox` trigger; `docs/context/core-reviews-responses.md` → **Review import**, **Import
> consent**, **Import offer**, **Import window**, **Live-ingest cutoff**).
> `import-consent.ts` is the SINGLE owner of the predicate and of every consent
> write — including `enqueueInitialImport`, which all four producers delegate
> to; do not re-spell its guard. Enforcement is at the four producers **and,
> since #679, at the chokepoint**: `guardImportConsent`
> (`worker/jobs/zernio/job-eligibility.ts`) is a fail-closed pre-flight in
> `ZernioBackfillWorker` that proceeds only on `accepted` — so a hand-inserted
> `zernio_initial_backfill` row no-op-completes with a logged reason instead of
> importing. It is deliberately a SEPARATE function from
> `guardZernioJobEligibility` (a merged guard would have two callers, one of
> which must never reach consent code), and its whole body must stay inside
> `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompletedWithReason(tx, …)`
> — without that serialization an owner's accept races the guard into silent
> permanent data loss. Enqueue-path inventory:
> `.claude/reference/review-ingestion.md`.

| File | What it does |
|------|--------------|
| `types.ts` | `NormalizedReview` DTO, `ReviewSource` interface, `MonitoredReview`. |
| `serpapi-source.ts` | `SerpApiSource` — implements `ReviewSource`. Calls SerpAPI to fetch reviews for a Place ID. |
| `serpapi-normalize.ts` | Converts raw SerpAPI JSON to `NormalizedReview`. Computes `provider_review_id` and `review_content_hash`. |
| `serpapi-prefill.ts` | Calls SerpAPI to get business name, address, and initial star rating (used at signup). |
| `url-parser.ts` | `extractPlaceId()` / `isPlaceId()` — extracts or validates a Place ID from a Google Maps URL. |
| `place-id-resolver.ts` | Resolves a canonical Place ID from a business name + address string via SerpAPI. |
| `process-review.ts` | **Two** exported entry points over one private `insertNewReviewRow` seam. `processReview` — the live-ingest lane: deduplication, identity-collision detection, upsert into `reviews`, and `generate_response` enqueue. `importReview` (#674) — the **Review import** lane: insert-only, classifies sentiment at the write site, writes AND completes a `review_ingested` run-spine record in the insert transaction, enqueues **nothing**, and never mutates an existing row (an existing row and a lost insert race both return `'unchanged'` with zero writes). Ships callerless; its caller is #675. Carries a KNOWN HAZARD in its JSDoc — a review stored by the import is never drafted by any lane, and this needs no race; owned by #675. |
| `import-consent.ts` | **(#677)** The single owner of **Import consent**: spec §5.3's derived-expiry predicate and every write to it. `importConsentStateSql` (composable fragment — **callers must alias `businesses` as `b`**; it takes no interpolation, because the four producers' suites use hand-rolled `sql` mocks that only implement the tagged-template call form), `readImportConsent`, `createImportOffer` (proves the junction in its own SQL; deadline `now() + 7 days`, no anchor; caller must hold the `businesses` row lock), `recordImportDecisionAndEnqueue` (owns `sql.begin` → row lock → guarded transition → deduped raw `job_outbox` INSERT, so the route stays a thin mapper per invariant #12). Every export binds `accountId` directly (invariant #8). No analytics events — deferred to #679. |
| `import-offer-view.ts` | **(#677)** Read model for `ImportOfferBanner`: `readImportOfferView` → discriminated union `none / offer / importing / imported / empty / failed`. `completed_at` decides done, never `imported_count` (which DEFAULTs to 0 and is written incrementally); `empty` requires completed AND zero. Run rows are scoped to `run_reason = 'initial'` so recurring reactivation catch-ups cannot flip the banner back to `importing`. Outbox status maps per the `draft-status` precedent, importing `OUTBOX_IN_FLIGHT_STATUSES` rather than re-spelling it. |
| `status.ts` | `REVIEW_STATUS` — canonical `reviews.status` value vocabulary (the reviews-table sibling of `shared/response-status.ts`). Guarded by `scripts/ci/reviews-status-audit.ts` (baseline ratchet on raw status literals in reviews-table SQL). |
| `detect-language.ts` | Detects the language of a review text (used to make AI respond in the same language). |
| `sentiment.ts` | `classifySentiment(starRating)` — deterministic star-based sentiment (`deterministic_star_v1`), written at review-content write sites. |
| `triage-schema.ts` | WS2/WS3 Guardian triage vocabulary — severities, issue taxonomy, suggested actions (+ `ESCALATING_ACTIONS`), `TRIAGE_SOURCE` tags, owner-facing labels (`TRIAGE_SEVERITY_LABELS` / `TRIAGE_ISSUE_LABELS`), `TriageOutputSchema` (zod), and the `TriageClassification` result type (owned here so `escalations/raise.ts` avoids a triage ⇄ raise type cycle). Leaf module (imports only zod); values in lockstep with migration 072's CHECKs. |
| `triage.ts` | WS2: `classifyReviewTriage` (cost-guarded `triage` LLM task, severity-high fallback on terminal errors) + `persistTriage` (review lock → `reviews.triage_*` UPDATE → guardian `triage` step → `ESCALATION_ENABLED`-gated `raiseEscalation` (WS3), one tx). Re-exports `TriageClassification` from `triage-schema.ts`. |
| `flags.ts` | `triageEnabled()` — `TRIAGE_ENABLED` accessor over `readFlag`. |
| `mock-source.ts` | Canned data used when `MOCK_EXTERNAL_APIS=true`. |
| `on-demand-generate.ts` | **(#729)** `onDemandGenerateTx(tx, {reviewId, businessId})` — the Generate transaction for a never-replied review: review `FOR UPDATE`, in-tx writable re-check, posted / non-terminal / orphan sibling exclusions, `pendingGenerateExists`, `nextResponseVersion`, then `enqueueGenerateResponse` pinned to `ON_DEMAND_GENERATE` + `suppressNotification: true` (excluded from auto-approval twice over). Callers run it inside `sql.begin`. |
| `zernio-field-match.ts` | Canonical field-match for "is this Zernio review the same as a local `serpapi_poll` row": `fromZernioReview` → `ZernioFieldMatchTarget` (name, rating, trimmed text, epoch ms) and `matchesLocalRow` (±24h `MATCH_WINDOW_MS`). Must stay in sync with the SQL fragment in `zernio-ingest-shared.ts`; a unit test runs both on one corpus. |
| `zernio-normalize.ts` | Zernio → `NormalizedReview` / `MonitoredReview`: `zernioReviewToNormalized` (per-review `ZernioReviewNormalizationError`), `buildZernioMonitoredReview` (identity `zernio_id`), `zernioProviderReviewName` / `zernioProviderLocationName` — the ONLY spelling of the synthetic `zernio://` names (**#764**) — `extractLocationFromReviewName` (null = fail closed), `normalizeGoogleReviewName`. |

**Connection:** live ingestion is Zernio-only — `worker/ingress/zernio/zernio.ts` fans out one `ingest_zernio_review` outbox row per active connection and `worker/jobs/zernio/ZernioReviewIngestWorker.ts` calls `process-review.ts` per review, which enqueues `generate_response`; `ZernioRecentReviewPoller` is the second entry into `process-review.ts` (in-process, no outbox row). `SerpApiSource` serves only the demo/prefill lane (`src/lib/demos/fetch-reviews.ts`, `serpapi-prefill.ts`); the legacy `ReviewSyncWorker`/`SerpApiMonitor` path was deleted.


### `escalations/`

WS3 Guardian escalations — triage said "alert the owner", so a durable
`review_escalations` row is raised, the owner is notified, and the owner works
it acknowledge → resolve (spec `docs/superpowers/specs/2026-07-07-ws3-guardian-escalation-design.md`).

| File | What it does |
|------|--------------|
| `types.ts` | `ESCALATION_STATUS` — single owner of the `review_escalations` status vocabulary (forward-only escalated → acknowledged → resolved); `OpenEscalationStatus` (resolved rows never reach the client). |
| `flags.ts` | `escalationEnabled()` — `ESCALATION_ENABLED` accessor over `readFlag`. Checked at RAISE time (`persistTriage`) and again at SEND time (`EscalationNoticeWorker`). |
| `raise.ts` | `shouldEscalate(classification)` (derives from `ESCALATING_ACTIONS`) + `raiseEscalation()` — inside the triage-persist tx: `review_escalations` INSERT (one-open-per-review `ON CONFLICT` dedup, migration 073), `review_escalated` outcome + `escalation_raised` step (skipped for run-less legacy reviews), `escalation_notice` outbox enqueue. Lost conflict = full no-op. |
| `transitions.ts` | `acknowledgeEscalation()` / `resolveEscalation()` — owner-driven forward-only state machine; same-action repeat is an idempotent no-op, backward transition → `invalid_transition` (route maps to 409); review row FOR UPDATE first (lock-ordering rule); resolve on a completed run records `escalation_resolved`. |
| `list.ts` | **(WS5)** Account-scoped, bounded read model for the Needs-attention queue. Counts and lists unresolved escalations with explicit status/severity/oldest-first ordering and inline review/business scope joins. |
| `http-routes.ts` | `runEscalationTransitionRoute(sql, request, params, transition, invalidTransitionMessage)` — shared runner for the owner-facing acknowledge/resolve routes, following the `approval/http-routes.ts` precedent so each `route.ts` stays a thin composition root. Owner guard (`requireDashboardReviewOwner`) → `assertWritableSubscriptionForAccount` → the passed `transitions.ts` function → HTTP mapping: `not_found` → uniform 404, `invalid_transition` → 409 with the supplied message, success → `{success, status}`, all with `NO_STORE_HEADERS`. |

**Connection:** `persistTriage` (`reviews/triage.ts`) calls `raiseEscalation()` in the same tx as the triage write → OutboxPoller dispatches `escalation_notice` → `EscalationNoticeWorker` sends. The dashboard escalation routes call `transitions.ts`.


### `responses/`

AI response generation.

| File | What it does |
|------|--------------|
| `types.ts` | `BusinessContext`, `GenerationOptions`, `GenerationResult`, `VoiceExample`. |
| `generator.ts` | `generateResponse(review, context, options)` — full pipeline: cost guard → idempotent cache → `runLlmTask('reply_generation')` via the LLM seam → save → cache. Two modes: `demo` (fast, no cost guard) and `production`. **(#728)** The `(reviewId, version)` cache payload is provenance-bound: `CachedGeneration.reviewContentHash` must strict-equal the current attempt's `options.loadedReviewContentHash` (`null===null` for legacy entries) or the entry is rejected + cleared best-effort — a colliding same-version replacement job legitimately shares the key, so key equality is not content equality. |
| `prompt-builder.ts` | Builds the system prompt and user message from `BusinessContext` + `VoiceExample[]`. |
| `voice-learning.ts` | Queries DB for recent owner-edited responses to use as few-shot examples. Returns empty array until ≥ 5 examples exist. |
| `review-summary.ts` | Generates a one-line summary of a review for the weekly report. |
| `mock-generator.ts` | Returns a template response string when `MOCK_EXTERNAL_APIS=true`. |
| `judge-schema.ts` | **(WS6)** Strict structured-output contract: `pass`/`warn`/`flag`, up to five bounded reason categories, and a rationale capped at 500 characters. Shared by the LLM task and offline/live eval lane. |
| `judge-policy.ts` | **(WS6)** Versioned, hashable post-hoc safety rubric prompt covering compensation, PII, fabricated claims, and hostile tone. |
| `judge.ts` | **(WS6)** Builds delimiter-safe prompts and executes `runLlmTask('judge')` inside caller-side two-phase `withCostGuard`; Redis transport failures remain retryable and budget decisions terminal. |
| `judge-store.ts` | **(WS6)** Injected-SQL verdict insert and read helpers: idempotent verdict persistence, latest run correlation, and the subscription-eligible 24-hour unjudged auto-post anti-join. |
| `judge-health.ts` | **(WS6)** Fail-closed publisher health probe over verdict freshness and recent error density; query errors are deliberately propagated to the worker retry path. |
| `judge-flags.ts` | **(WS6)** Server-only `JUDGE_ENABLED` accessor over `readFlag`, default off. |
| `limits.ts` | **(#765)** `MAX_REPLY_LENGTH` — the shared 2000-character server/client edit contract. |
| `generation-state.ts` | **(#765)** Injected-SQL helpers for the in-flight `generate_response` predicate and monotonic per-review `MAX(version)+1` allocation; callers retain their existing tenant proof and review locks. |
| `review-ownership.ts` | **(#765)** Whole-query account ownership proof for the Reviews-list Generate door and its account-scoped poll route; deliberately not used by cookie-location past-replies routes. |
| `edit-existing.ts` | Two primitives shared by the Past Replies routes (spec §4.1/§4.6): `assertCanEditReply` (account ownership + location match + writable subscription + known tier, fail-closed) and `validateOptimisticConcurrency` (in-tx review-hash + posted-version check; caller must hold the review lock). Throws `NotFoundError` / `ForbiddenError` / `ReviewChangedError` / `ResponseChangedError` / `SubscriptionReadOnlyError`. |
| `prompt-policy.ts` | Owns the prompt policy: `SYSTEM_PROMPT_BASE` (the versioned safety base prepended to every production system prompt), `PROMPT_VERSION`, and the memoized `systemPromptHash()` (SHA-256) recorded on `api_costs`. Dynamic business details are assembled in `prompt-builder.ts`; only this base is versioned and hashed. |
| `voice-report-card.ts` | `deriveVoiceReportCard(examples)` — deterministic register-trait derivation for `/settings/voice` (greeting, length, sign-off, point of view, critical reviews) over the same `VoiceExample` pairs the prompt few-shots from (#540). A trait renders only on a strict majority AND ≥2 conforming pairs; critical reviews detects at ≥1 substantive negative rewrite. |

**Connection:** `ResponseGeneratorWorker` calls `generateResponse()`. `DemoGenerationWorker` calls it in `demo` mode.


### `moderation/`

Output moderation for generated drafts — the always-on local regex filter, the optional OpenAI Moderation call, and the held-draft gate that makes a high-severity flag binding (invariant #4).

| File | What it does |
|------|--------------|
| `flags.ts` | `openaiModerationEnabled()` — `OPENAI_MODERATION_ENABLED` accessor over `readFlag` for the inline moderation path. Auto-approval's `providerModerationEnabled()` reads the same flag for a different gate; two named accessors over one flag is intentional. |
| `held-draft.ts` | The held-draft gate: `openFlagExistsSql(db, ref)` — the one composable spelling of "response has an OPEN `flagged_responses` row" (`'open'` is a literal, matching migration 051's partial index byte-for-byte) — `hasOpenFlag(tx, responseId)` (in-tx, post-lock), and `HeldForReviewError`. Every owner-facing release path must call it; admin, health-alert, purge and producer consumers stay deliberately separate (#725). |
| `moderate.ts` | Worker-only `moderateResponse(text)` — always runs the local filter; when `OPENAI_MODERATION_ENABLED` also calls `omni-moderation-latest` (10s timeout) and merges (provider flag → `high`). Never throws: a provider outage falls back to the local decision with `providerStatus: 'error'`. |
| `output-filter.ts` | `runOutputFilter(text)` — the local regex filter: word-boundaried rule table (refund/discount, legal fault, injection compliance, profanity → `high`; competitor, advice → `medium`) producing a `ModerationDecision` (`flagged`, `severity`, `reason`, `categories`, `score`, `source`, `providerStatus`). Also owns `SEVERITY_RANK`. |


