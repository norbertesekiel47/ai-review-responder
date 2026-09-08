## `src/lib/`

### `kpi/`

Analytics window vocabulary and the Review-time anchor fragments the dashboard payload composes.
No service layer — the consumer-less Stack A KPI service was deleted in #757.

| File | What it does |
|------|--------------|
| `types.ts` | `DASHBOARD_WINDOWS` / `DashboardWindow` / `resolveDashboardWindow` / `dashboardWindowParams` — the only window values that may reach windowed SQL, as bound integers (#403). |
| `fragments.ts` | `reviewTimeAnchor` / `reviewTimeWindowFilter` — single owner of the Review-time anchor `LEAST(review_date, detected_at)` (ADR 0019). Composed by `dashboard/service.ts` + `dashboard/aggregate-queries.ts`; carries no FROM/JOIN and no tenant predicate. |


### `agents/`

Run-spine write and owner-facing read contracts for attributed agent work.

| File | What it does |
|------|--------------|
| `run-spine.ts` | Single writer API for `agent_runs`, `agent_run_steps`, and `agent_outcomes`, including the authoritative step-to-persona map and idempotent active-run/outcome constraints. |
| `read.ts` | **(WS5)** Account-scoped review timeline reads, stored-attribution team-summary aggregates, and the ordered `RunDisplayState` derivation. Parses and narrows the PgBouncer-stringified `agent_runs.error` and `agent_run_steps.detail` JSONB columns. |


### `analytics/` *(Wave 2)*

First-party analytics queue and PostHog dispatch helpers.

| File | What it does |
|------|--------------|
| `events.ts` | Canonical analytics event allowlist, event-key helper, and property sanitizer. Kept in sync with migration 046 by a drift-guard test. |
| `enqueue.ts` | `enqueueAnalyticsEvent()` — inserts UUIDv7 rows into `analytics_events` with `ON CONFLICT (event_key) DO NOTHING` idempotency. |
| `posthog.ts` | Lazy PostHog server client wrapper used by Railway dispatch. Exposes configured/capture/flush/shutdown helpers. No browser SDK. |
| `activation-event.ts` | `buildActivationCompletedEvent(input)` — single owner of the activation rule and the `activation_completed` event shape: returns the `CaptureAnalyticsEventInput` for an account's first posted response, or `null` when `postedAt − accountCreatedAt` falls outside 0–7 days. Both the live publisher path and the historical backfill call it; the caller decides "is-first" in SQL and sets `timestamp`; `uuid = responseId` lets PostHog dedupe re-emits. |
| `trial-events.ts` | Durable server-side trial lifecycle facts — `enqueueTrialStarted` / `enqueueTrialConverted` / `enqueueTrialPaymentFailed` / `enqueueTrialCancelled(db, input)` call `enqueueAnalyticsEvent` in the SAME transaction as the subscription-status projection write. Deterministic keys make replays idempotent: `trial_started` is keyed by `accountId` alone; the other three by `(accountId, stripeSubscriptionId)` so a re-trial on a new subscription emits a fresh fact. |


### `audit/`

Account audit-log writer.

| File | What it does |
|------|--------------|
| `log.ts` | Two sinks, two writers. `writeAccountAuditLog(db, input)` — the ONLY writer of `account_audit_log` (never a raw `INSERT`): a UUIDv7 row with `account_id`, `event_type`, JSON `payload`, optional metadata columns. `writeAdminAuditLog(db, input)` **(#468, migration 117)** — the ONLY writer of `admin_audit_log`, the admin actor trail keyed on `actor_user_id`, no account column (admins have NULL `account_id`). Both take the base `Sql` (best-effort, e.g. the MFA route) or a `TransactionSql` — account-status writes use the SAME transaction as the state change. |


### `competitors/`

Competitor Delta (Named rival) resolution for the weekly digest and the owner-facing rival picker.

| File | What it does |
|------|--------------|
| `named-rival.ts` | Single owner of Competitor Delta resolution **(#546; map #528, semantics #532)**. `resolveNamedRival(db, businessId)` reads the primary-keyword local-pack lane in ONE statement (RankingTrackingWorker replaces packs wholesale) and returns a `CompetitorDelta` (`teaser`/`rival`/`dropout`/`null`) from the Auto-default rival or the owner's stored pick. `loadRivalPickerView(s)` load picker state; `setNamedRivalPick` stores/clears the pick in a tx and enqueues `competitor_rival_picked` (retry-safe key). Roots: WeeklySummaryWorker, settings route. |


### `google/`

Google Sheets service-account append for owner leads.

| File | What it does |
|------|--------------|
| `owner-leads-sheet.ts` | `appendOwnerLeadToSheet(row)` — appends an `OwnerLeadSheetRow` to the owner-leads Google Sheet using a service-account JWT (RS256 via `createSign`, exchanged at the OAuth token endpoint). No-op when `OWNER_LEADS_GOOGLE_SHEET_ID` is unset; throws when only partially configured (`GOOGLE_SHEETS_CLIENT_EMAIL` / `GOOGLE_SHEETS_PRIVATE_KEY`); range defaults to `Sheet1!A:K`. Both fetches carry a 5s `AbortSignal.timeout` because it runs on the user-facing `/api/lead-intake` path, whose caller try/catches this enrichment. |


### `ranking/`

Ranking-tracking feature flag.

| File | What it does |
|------|--------------|
| `flags.ts` | `rankingTrackingEnabled()` — single owner of the `RANKING_TRACKING_ENABLED` flag (the recurring paid SerpAPI ranking-tracking scheduler), a one-line wrapper over `readFlag` in the `<feature>/flags.ts` convention. Server-authoritative (invariant #13) — no `NEXT_PUBLIC_*` companion; the browser learns the state via API responses/props. |






### `auth/`

| File | What it does |
|------|--------------|
| `route-helpers.ts` | Route wrappers for rate limiting, same-origin checks and session reads. Cookie-only; #1183 did not widen it. |
| `mfa.ts` | **(Wave 2)** Supabase AAL helpers — `requireAal2FromSupabase` (lenient) / `requireCurrentAal2FromSupabase` (strict), `factorStatusBefore`, `mfaChallengePath`, `collectFactors`. Traps: `factorStatusBefore` (#468) is read BEFORE `verify`, which flips it — that flip separates `mfa_factor_enrolled` from `mfa_challenge_succeeded`; `src/proxy.ts` does NOT use these, inlining its own lenient read (`:92-103`), the divergence ADR 0025 D6 cites. |
| `require-owner-access.ts` | `requireOwnerAccess(sql)` — server-component guard for owner-only pages → `{ accountId, currentLocationId, role }`, redirecting on failure. Owns the three `getRender*` `React.cache` memos, so one render costs one `getUser()`, one `users` read, one `businesses` scan. Traps: the memos never redirect; route handlers and the proxy sit outside `cache()`, keeping `getCurrentUser(request)`. |
| `page-gate.ts` | **(Phase 2)** `requireAdminPage(sql, {from, aal2})` — server-component admin gate: auth user → `users` row → admin role, optional AAL2. Traps: fail-closed even when the AAL2 check throws; defense-in-depth behind `src/proxy.ts`; cookie-only (pages are same-origin). |
| `admin-mfa-gate.ts` | `requireAdminWithAal2` / `requireAdminJson` / `internalError` — the admin preamble, **dual-mode since #1183**: seam → `loadAppUser` → role → strict `aal2`; `{ ok, admin }` or a no-store refusal (401 `Unauthorized` / 403 `Forbidden`\|`mfa_required`\|`mfa_check_failed` / 500 `internal_error`), never a redirect, role before AAL. Traps: exported names and shapes frozen (`ci:admin-aal2`); `MFA_ENFORCEMENT_ENABLED` unread; CSRF at the export. |
| `admin-transport.ts` | **(#1183)** The **Admin transport** predicate — `isBearerRequest` (header PRESENCE, so a malformed `Authorization` never falls back to the cookie), `readBearerToken`. Traps: ONE owner — `verified-identity.ts` today, `src/proxy.ts` next (#1185); **Edge-safe**, asserted by a zero-imports test. Why: ADR 0025 D6. |
| `verified-identity.ts` | **(#1183)** The identity seam below the gates — `resolveCookieIdentity` / `resolveDualModeIdentity` → `{ authUserId, aal, transport }`, deciding nothing. Traps: the cookie arm is byte-for-byte today's path and classifies no faults (only the bearer arm does); `getUser(jwt)` closes revocation and must stay; a THROW from either SDK await is 401 (auth-js lets malformed JWTs escape raw), returned `AuthUnknownError`/`AuthRetryableFetchError`/5xx `AuthApiError` are 500. Why: ADR 0025. |
| `flags.ts` | `selfServeSignupEnabled()` — `SELF_SERVE_SIGNUP_ENABLED` over `readFlag`; means exactly "strangers may mint accounts" (gates `/signup`, the signup/finish-signup/resend-confirmation/verify-otp routes, `isTrialEligible`, marketing CTA copy — NOT `/login`, `/forgot-password`, `/reset-password` or the authenticated onboarding funnel; per-site inventory in `docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`). Plus `mfaEnforcementEnabled()` (`MFA_ENFORCEMENT_ENABLED`, proxy gate). Invariant #13. |
| `get-request-scope.ts` | `getRequestScope(sql, accountId, cookieLocationId)` → `{ accountId, currentLocationId, activeLocations }` for SSR. Traps: the `rw_location_scope` cookie is validated against the account and archived state, else falls back to the primary; throws when no active location exists. |
| `provision-auth-user.ts` | `provisionAuthUser` — signup identity provisioning for `POST /api/auth/signup`, plus `deleteProvisionedAuthUser` compensating a failed business creation. Traps: the advisory-locked email pre-check; the anti-enumeration disambiguation of `identities: []` into `account_exists` vs `email_rate_limited`. Rule: `.claude/rules/supabase-auth.md`. |
| `reset-password-error.ts` | `mapUpdateUserError(error)` — pure mapper from an `auth.updateUser` failure to what `POST /api/auth/reset-password` returns. Traps: `insufficient_aal` → 403 `mfa_required` matched on **`code`, never message**; statuses clamp to 400–599; an unmapped 401 carries a `report` payload. |
| `resolve-owner-scope.ts` | `resolveOwnerScope(sql, request, {allowReadOnly?})` → `{ accountId, locationId, userId }` or throws `ScopeError`. Traps: gate and `getRequestScope` run under `allSettled` so the gate's error wins; `past_due` writes only inside the recovery window (else 402); no CSRF here. Cookie-only. |


### `llm/`

The LLM task seam (A+ campaign PR 1c; **the sole path for every LLM
generation/insights call** — Q4/Q5 close-out) — a provider-agnostic executor
between callers (`responses/generator.ts`, `responses/review-summary.ts`,
`reviews/triage.ts`) and the OpenAI/Anthropic SDKs. Deliberately bounded: no
streaming, tool-calls, or multi-turn loops.

| File | What it does |
|------|--------------|
| `types.ts` | Task vocabulary (`LLMTaskId`: `reply_generation` \| `triage` \| `judge` \| `insights`), `LLMProvider` interface, `LLMTaskDescriptor`. Cost-guard contract: every `runLlmTask` call in production code must be wrapped in `withCostGuard` by its caller — the guard stays caller-side (the idempotent-cache write must happen inside the guarded closure). |
| `tasks.ts` | `getLlmTask(taskId)` — pinned-model registry. `OPENAI_MODEL` / `ANTHROPIC_MODEL` constants are guarded by `model-pinning.test.ts`. `reply_generation`, `insights`, `triage`, and **WS6 `judge`** are registered; judge uses the same pinned provider constants and structured `JudgeOutputSchema`. |
| `run-task.ts` | `runLlmTask(taskId, prompt)` — the executor: calls the primary provider, falls back to the secondary on failure, and classifies exhausted-attempt errors as `TransientLLMError` (worker retries) vs terminal (rethrown raw). Tasks declaring an `outputSchema` (`triage`, **WS6 `judge`**) get structured-output enforcement — fence-strip → `JSON.parse` → zod validate; schema-invalid counts as that provider attempt failing (fallback tried), all-invalid throws terminal `LLMStructuredOutputError`; validated value lands on `LLMCallResult.structured`. Production callers are cost-guarded; the explicit live-eval caller is the narrow exception. |
| `openai-provider.ts` / `anthropic-provider.ts` | Thin SDK adapters implementing `LLMProvider` — lazily construct a singleton client with `LLM_CLIENT_OPTIONS` and map the SDK response to `LLMCallResult`. |
| `client-options.ts` | `LLM_CLIENT_OPTIONS` — explicit `{ timeout: 30_000, maxRetries: 0 }`. Without it the SDKs default to a 10-minute timeout + 2 internal retries; `maxRetries: 0` makes the BullMQ + outbox-watchdog ladder the single source of retry truth. |
| `error-classifier.ts` | `isTransientLLMError(err)`, `TransientLLMError`, `redactProviderError(err)` (strips `.body`/`.response`/`.request` before logging — some 4xx provider errors echo the prompt). Moved here from the deleted `responses/llm-error-classifier.ts` re-export shim. |
| `circuit-breaker.ts` | `LlmCircuitBreaker` + the `llmCircuitBreaker` singleton — in-process per-provider breaker: trips after 5 consecutive transient failures, opens 30s, admits one half-open probe. `shouldAttempt(provider)` returns an epoch-stamped `Admission` (or null); `recordAttempt(admission, error?)` ignores stale-epoch outcomes. Kill switch `LLM_CIRCUIT_BREAKER_ENABLED`, read live per call. Correct only single-replica (ADR 0005). |
| `flags.ts` | `llmCircuitBreakerEnabled()` — `LLM_CIRCUIT_BREAKER_ENABLED` accessor over `readFlagEnabledByDefault` (default ON; only the literal `'false'` disables). |

**Connection:** `generator.ts` calls `runLlmTask('reply_generation', prompt)` and `review-summary.ts` calls `runLlmTask('insights', prompt)` instead of hand-rolling the primary/fallback loop. Invariant #1's ESLint ban (`@/lib/llm/*`) treats the whole directory as worker-only.


### `costs/`

LLM cost tracking and enforcement.

| File | What it does |
|------|--------------|
| `tracker.ts` | `reserveCost()` / `finalizeCost()` / `refundCost()` — Redis INCRBY/DECRBY for pessimistic reservation before LLM calls. Enforces per-business and global daily ceilings. |
| `audit.ts` | `recordApiCost()` — writes completed costs to the `api_costs` table (audit trail, reconciled hourly by `ReconciliationPoller`). |
| `concurrency-guard.ts` | Per-business generation concurrency semaphore on a Redis counter (`gen:active:<businessId>`, max 3, 5-min TTL safety net). `acquireConcurrencySlot` runs INCR + limit check + EXPIRE in one Lua script — a Redis transport failure throws `CostInfraUnavailableError`, a full slot throws `ConcurrencyLimitExceededError`; `releaseConcurrencySlot` DECRs and clamps at zero. |
| `cost-guard.ts` | `withCostGuard(opts, fn)` — the two-phase Redis reserve → finalize wrapper around every paid LLM call: `reserveCost` (task-scoped `estimateCents`, threaded unchanged through reserve/finalize/release), optional concurrency slot, then `finalizeCost` from actual cents or `releaseCost` on failure. `onFinalizeError` chooses `propagate` vs `log-and-return-value`; malformed cents throw before touching Redis. |
| `errors.ts` | Leaf module for `CostInfraUnavailableError` + `CostInfraTouchpoint` (`reserveCost` / `checkIdempotentCache` / `acquireConcurrencySlot` / `checkAskRegenBudget`): a pre-LLM cost-guard Redis TRANSPORT failure, re-thrown by the generation worker so BullMQ retries — never a budget decision, which stays terminal. |
| `onboarding-demo-cost-guard.ts` | Pre-pay onboarding-demo lane budget: `reserveOnboardingDemoBudget` (20¢ INCRBY against a global daily ceiling — Redis override → `ONBOARDING_DEMO_DAILY_CENTS` → $10 default — throws `CostCeilingExceeded`), `finalizeOnboardingDemoCost`, `checkCostThreshold` (fires each %-of-ceiling threshold once per day via SADD), and the `withOnboardingDemoCostGuard` wrapper. Distinct from `cost-guard.ts`. |
| `tier-cost-limits.ts` | Per-tier daily cost ceiling env vars (`DAILY_COST_LIMIT_CENTS_COPILOT` / `_AUTOPILOT`): `tierDailyCostLimitCents(tier)`, `parseRequiredPositiveCostLimitCents`, `assertTierDailyCostLimitsConfigured` (boot-time check), and `optionalNonnegativeCostLimitCents` for the optional global ceiling with fallback. |


### `demos/`

| File | What it does |
|------|--------------|
| `generator.ts` | `generateDemoResponses(reviews, context)` — calls `generateResponse` in `demo` mode for each review. |
| `types.ts` | Demo-specific types (`DemoRequest`, `DemoResult`). |
| `fallback-content.ts` | `getFallbackDemo(category)` — curated fallback reviews + responses for the demo when live content is unusable; normalizes a free-text category to a canonical key, every key currently sharing the general-business fixture (`__fixtures__/fallback-source-reviews`). |
| `fetch-reviews.ts` | `fetchSerpApiReviews(placeId)` — up to 15 reviews via `SerpApiSource`, or `MockReviewSource` when `MOCK_EXTERNAL_APIS=true`; fails fast at module load if `SERPAPI_API_KEY` is missing outside mock mode. Extracted from `generator.ts` so the worker does not choose the source. |
| `generate-responses.ts` | `generateResponsesForReviews(sql, reviews, businessContext)` — `Promise.allSettled` over `generateResponse` in `demo` mode (or `generateMockResponse`), mapping a failed review to `null` and returning success/failure/cost/duration metadata. Extracted from `generator.ts`. |
| `lifecycle.ts` | Demo-row state machine over `onboarding_demos` / `prospect_demos`: `claimDemo` (queued → running CAS, >5-min stale-running reset; returns `claimed` / `already_terminal` / `not_found` / `reset_to_queued` / `race_lost`), `completeDemo` (row + outbox in one tx; the 23505 race-loser archives itself and closes its outbox), `failDemo`. Called by `DemoGenerationWorker`. |
| `select-qualifying.ts` | `selectQualifyingReviews(reviews, opts)` — picks ≤3 demo reviews: `newest` (first three) or `positive-with-moderate-tail` (rating ≥3; a substantive 5-star anchor, up to two 4-stars, one trailing 3-star; returns `[]` when no ≥4 anchor so the caller falls back to curated content). |


### `publishing/`

GBP reply publishing logic.

| File | What it does |
|------|--------------|
| `zernio-publisher.ts` | `resolveZernioReviewId()` + `publishViaZernio()` — resolves our internal SerpAPI review ID to Zernio's canonical review ID via a Redis-cached field match (displayName + rating + comment + createTime ±24h), then posts the reply via `zernioClient.publishReply()`. Falls back on transient errors. |
| `flags.ts` | Zernio publishing flag accessors over `readFlag`: `zernioPublishingEnabled()` (`ZERNIO_PUBLISHING_ENABLED`), `externalReplyImportEnabled()` (`EXTERNAL_REPLY_IMPORT_ENABLED`), `zernioRecentReviewPollDisabled()` (the `ZERNIO_RECENT_REVIEW_POLL_DISABLED` kill-switch). |
| `orphan-markers.ts` | Single source of truth for the edit-publisher DELETE-before-POST recovery markers on `posting_error` (spec §4.5/§4.7): `PENDING_AFTER_DELETE`, `ZERNIO_AUTH_ERROR[_AFTER_DELETE]`, `deleteFailedMarker` / `postAfterDeleteFailedMarker`, `POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED`, `STALE_AFTER_REVIEW_CHANGED`, plus `isRecoverableFailedPostingError` (the `/retry` allowlist) and `isOrphanMarker`. Dependency-free. |
| `review-publisher.ts` | The `ReviewPublisher` seam (transport-only, locked 2026-06-26): `resolveTarget` / `publishReply` / `deleteReply` / `findReply` over neutral `ReviewRef` / `ReviewLocator` / `ResolveTargetResult` / `FindReplyResult` types. `getReviewPublisher(sql)` is the lazy singleton adapter selector; `getTransactionalReviewPublisher(tx)` the uncached, connection-locking variant for the auto-policy outcome lane. Error-taxonomy neutralization is deferred until a GBP adapter exists. |
| `zernio-review-publisher.ts` | `ZernioReviewPublisher` — the first adapter behind the seam. Owns the active `zernio_connections` lookup (optionally `FOR UPDATE`), review-id resolution + Redis page cache via `lookupZernioReviewId`, and the bounded verify walk (`MAX_VERIFY_PAGES` = 4); delegates transport to `zernioClient.postReply` / `deleteReply` / `listAllReviews` and reports raw publish failures to Sentry before rethrowing. |


### `zernio/`

All Zernio API client code and shared connect-flow state.

| File | What it does |
|------|--------------|
| `client.ts` | `ZernioClient` class — typed HTTP client for the Zernio API (all endpoint kinds: `createProfile`, `startConnect`, `selectLocation`, `listReviews`, `getReview`, `publishReply`, `editReply`, `deleteReply`). Handles auth errors, validation errors, transient vs permanent errors, and the no-body endpoint set. Includes strict allowlists for safe pre-mutation 400 codes and 409 "reply already exists" codes. |
| `connect-state.ts` | Lua CAS scripts (`luaTokenCAS`, `luaCASUpdate`, `luaCASDel`) + `pendingKey(businessId)` helper for the Redis connect-flow state machine. Prevents race conditions when concurrent start/cancel flows race. |
| `connect-session-cookie.ts` | HMAC-signed cookie for the Zernio connect session. Format: `{sessionId}.{hmac}`. Mirrors the approval device-cookie pattern (`SameSite=Lax` to survive top-level OAuth redirect). |
| `errors.ts` | Typed error classes: `ZernioAuthError`, `ZernioValidationError`, `ZernioTransientError`, `ZernioPermanentError`, `ZernioReviewNotFoundError`, `ZernioReplyAlreadyExistsError`, `ZernioReplyAlreadyDeletedError`, `ZernioReplyVerificationIndeterminateError`, `ZernioRateLimitError`, plus the `inbox_addon_required` validation classification. |
| `parse-review-webhook.ts` | Parses Zernio `review.new` / `review.updated` webhook bodies. Extracts nested `account.id` per spec §5.4 (NOT flat `accountId` — common gotcha). Returns the normalized review payload used for outbox fan-out. |
| `canonicalize-reply.ts` | Normalizes reply text for comparison — strips trailing whitespace, normalizes line endings. Used by the edit-publisher to detect whether owner edits actually changed anything before calling Zernio (skips no-op writes). |
| `auth-error-fallback.ts` | `applyTransientExhaustionFallback()` — single Postgres tx that flips `zernio_connections.status='disconnected'`, transitions the response to `awaiting_owner_connect`, and enqueues `send_owner_email` (connection_lost). Triggered when Zernio auth/transient errors exhaust retries. |
| `types.ts` | `EndpointKind`, `ZernioConnectionStatus`, `ZernioConnectionRow`, `ZernioReview`, `ZernioLocationOption`, `ConnectPendingMarker`. |
| `client/diagnostics.ts` | `summarizeShape(raw)` — JSON-safe key/type summary of an unknown response (never values) for `UNRECOGNIZED RESPONSE SHAPE` logs, so OAuth/connect tokens and account IDs cannot leak into worker logs. |
| `client/error-classifier.ts` | `classifyAndParse(res, endpointKind)` — maps a Zernio HTTP response to the typed errors: 401/403 → `ZernioAuthError`; `publish_reply` 409 → `ZernioReplyAlreadyExistsError` only for allowlisted codes (unknown 409 → transient), 404 → `ZernioReviewNotFoundError`; `select_location` 400 → `ZernioValidationError` only for `PRE_MUTATION_400_CODES`; other 4xx permanent (408/429 transient); 5xx transient. Handles the no-body endpoint set. |
| `client/locations.ts` | `createLocationClient(transport)` — `startConnect`, `listLocations` (shape-tolerant `normalizeLocations`), `selectLocation`, `listReviews` (forces an omitted `reviewReply` to `null`), `listAllReviews` (bounded pagination), `deleteAccount`. |
| `client/profiles.ts` | `createProfileClient(transport)` — `createProfile` (extracts the MongoDB-shaped `profile._id`, throws on an unrecognized shape) and `deleteProfile`. |
| `client/replies.ts` | `createReplyClient(transport)` — `postReply` and `deleteReply`; the delete endpoint requires `accountId` in the JSON body (**#355**). |
| `client/transport.ts` | `createZernioTransport(options)` / `request(opts)` — the fetch layer composed into `zernioClient` by `client.ts`: Bearer auth from `getServerConfig()`, per-call `AbortController` timeout (default 10s → `ZernioTransientError('request_timeout')`), network errors → `network_error`, already-classified errors preserved. `MOCK_EXTERNAL_APIS=true` short-circuits to a per-endpoint mock (`MOCK_ZERNIO_LOCATION_COUNT` locations, capped at 50). |


### `security/` *(Wave 1)*

| File | What it does |
|------|--------------|
| `phi-scanner.ts` | `detectLikelyPhi(text)` — conservative likely-PHI detector. Matches well-scoped MRN / insurance-identifier patterns (identifier + digits) and a co-occurrence rule (self-reference like `my`/`we` AND a medical-context term) to avoid quarantining ordinary reviews. `redactPhiForLog()` returns a placeholder so raw text never reaches logs. Used by every Zernio ingest path to block before persistence. |
| `botid-routes.ts` | `BOTID_PROTECTED_ROUTES` — single source of truth for the Vercel BotID-protected POST routes and their `checkLevel` (`deepAnalysis` on `/api/auth/signup`, `/api/onboarding/start`; `basic` on `/api/auth/login-attempt`, `/api/lead-intake`). Both `initBotId` in `src/instrumentation-client.ts` and the server gate derive from it — BotID requires identical client/server levels. `botIdOptionsForPath(path)` returns the `checkBotId()` options and throws for an unregistered path. Isomorphic (no server-only imports); `/api/contact` and `/api/demo-request` deliberately excluded. |
| `botid.ts` | Server-only. `botIdBlockResponse(path)` — the Vercel BotID gate: runs `checkBotId` with `botIdOptionsForPath(path)` and returns a 403 `NextResponse` when `isBot`, else `null`. Call it after the cheap deterministic guards (flag 404s, same-origin) and before rate limits or DB work. An unregistered path throws (not caught); a platform-check error is logged and **fails open**, matching the app-wide rate-limits-fail-open posture. |


### `legal/` *(Wave 1)*

| File | What it does |
|------|--------------|
| `content.ts` | Typed legal content module — the single source of truth for every `/legal/*` page (`legalDocs` keyed by slug; each `LegalDoc` has `version`, `effectiveDate`, and ordered `sections`). Includes the reconciled sub-processor table. No MDX/markdown runtime dependency. |

