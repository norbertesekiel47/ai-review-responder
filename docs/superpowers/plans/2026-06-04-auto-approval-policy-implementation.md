# Auto-Approval Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement owner-configured auto-approval for safe, first-time live-ingest review responses while preserving moderation, tenant scope, subscription, outbox, and kill-switch guarantees.

**Architecture:** Add schema and small reusable helpers first, then land the runtime path behind the disabled `AUTO_APPROVAL_ENABLED` server flag, then expose settings and read-only visibility. The auto decision is made only inside `persistResponseAndNotify` after response insertion and moderation hold logic, using current transaction-time state. Settings mutations compute exposure changes in one account-locked transaction and apply writability only to expansions.

**Tech Stack:** Next.js App Router API/UI, Railway worker jobs, Postgres.js transactions, Supabase/PostgreSQL RLS, BullMQ via transactional `job_outbox`, Vitest, Playwright.

---

## Non-Negotiable Constraints

- Work from a fresh branch/worktree per PR. Main is protected, so every phase lands through GitHub PR.
- Any migration, worker, webhook, publisher, or billing-adjacent behavior rides staging first, then main. Migrations are applied to staging Supabase before production Supabase.
- Keep the current no-auto-posting invariant authoritative through Phase 0 and PR1. PR2 is the first PR that may update `.claude/CLAUDE.md` and `AGENTS.md` to the new "owner approval or owner-configured auto policy" wording, in the same change that introduces the disabled runtime path.
- Do not add `NEXT_PUBLIC_AUTO_APPROVAL_*` or any browser-readable auto-approval feature flag. The settings route returns derived readiness booleans and reason codes only.
- Do not add `canGenerateForAccount`, `canPublishForAccount`, or `canExpandAutoApprovalPolicy`. Reuse `checkSubscription({ workerType })`, `assertWritableSubscriptionForAccount`, and `requireOwnerWithAccount` exactly as specified.
- Every state transition that schedules follow-up work writes the state change and `job_outbox` row in the same Postgres transaction.
- Do not cache runtime policy in Redis or memory. Re-read current state at response persistence time.
- Keep the root implementation spec and this plan synchronized before opening each PR. If the surviving worktree already contains spec updates, treat those as part of the PR review surface.

## File Structure Map

### Phase 0 Provider-Moderation Validation

- Modify: `src/lib/moderation/output-filter.ts`
- Modify: `src/lib/moderation/moderate.ts`
- Modify: `src/lib/moderation/__tests__/moderate.test.ts`
- Create: `docs/runbooks/auto-approval-provider-moderation-validation.md`

### PR1 Schema And Helper Hardening

- Create: `supabase/migrations/055_auto_approval_policy.sql`
- Create: `src/lib/shared/__tests__/migration-055-auto-approval-policy.test.ts`
- Modify: `.claude/reference/migrations-log.md`
- Modify: `docs/security/rls-inventory.md`
- Modify: `scripts/ci/tenant-tables.ts`
- Create: `src/lib/auto-approval/flags.ts`
- Create: `src/lib/auto-approval/types.ts`
- Create: `src/lib/auto-approval/policy.ts`
- Create: `src/lib/auto-approval/__tests__/flags.test.ts`
- Create: `src/lib/auto-approval/__tests__/policy.test.ts`
- Modify: `src/lib/shared/worker-types.ts`
- Create: `src/lib/shared/job-outbox-helpers.ts`
- Create: `src/lib/shared/__tests__/job-outbox-helpers.test.ts`
- Modify: `src/lib/approval/audit.ts`
- Create or extend: `src/lib/approval/__tests__/audit.test.ts`

### PR2 Runtime Path Behind Disabled Flag

- Modify: `worker/jobs/ResponseGeneratorWorker.ts`
- Modify: `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts`
- Modify: `worker/jobs/response-generation/load-context.ts`
- Modify: `worker/jobs/response-generation/persist.ts`
- Create: `worker/jobs/response-generation/auto-approval.ts`
- Create: `worker/jobs/response-generation/__tests__/auto-approval.test.ts`
- Create or extend: `worker/jobs/response-generation/__tests__/persist.test.ts`
- Modify: `src/lib/reviews/process-review.ts`
- Modify: `src/lib/reviews/__tests__/process-review.test.ts`
- Modify generate producers in `src/lib/approval/token-mode.ts`, `src/lib/approval/session-mode.ts`, `src/lib/approval/callback-mode.ts`, `src/app/api/admin/flagged/route.ts`, and `src/app/api/dashboard/past-replies/draft/route.ts`
- Modify publish producers in `src/lib/approval/token-mode.ts`, `src/lib/approval/session-mode.ts`, `src/lib/approval/callback-mode.ts`, `src/app/api/dashboard/past-replies/publish/route.ts`, `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts`, and `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts`
- Modify: `worker/jobs/publisher/load-context.ts`
- Modify: `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Create: `worker/jobs/publisher/auto-policy-downgrade.ts`
- Extend: `worker/jobs/publisher/__tests__/load-context.test.ts`
- Extend: `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts`
- Extend: `worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts`
- Modify docs in `.claude/CLAUDE.md`, local `AGENTS.md` if present, `.env.example`, `docs/eservices-variables.md`, `.claude/reference/env-vars.md`, and `.claude/skills/approval-security/SKILL.md`

### PR3 Settings API/UI And Visibility

- Create: `src/app/api/settings/auto-approval/route.ts`
- Create: `src/app/api/settings/auto-approval/__tests__/route.test.ts`
- Create: `src/lib/auto-approval/settings-service.ts`
- Create: `src/lib/auto-approval/settings-types.ts`
- Create: `src/lib/auto-approval/readiness.ts`
- Create: `src/lib/auto-approval/__tests__/settings-service.test.ts`
- Create: `src/lib/admin/impersonation/route-guard.ts`
- Create: `src/lib/admin/impersonation/__tests__/route-guard.test.ts`
- Modify: `src/components/dashboard/shell/SettingsTabs.tsx`
- Create: `src/app/(authenticated)/settings/auto-approval/page.tsx`
- Create: `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx`
- Create: `src/components/dashboard/settings/AutoApprovalPanel.tsx`
- Create: `src/components/dashboard/settings/__tests__/AutoApprovalPanel.test.tsx`
- Modify: `src/lib/dashboard/types.ts`, `src/lib/dashboard/service.ts`, `src/lib/dashboard/active-mappers.ts`, `src/lib/dashboard/aggregate-service.ts`
- Modify: dashboard UI components that render recent review rows
- Modify: `src/components/dashboard/reviews/PastReplyCard.tsx`
- Modify: `src/app/(authenticated)/dashboard/past-replies/page.tsx`
- Modify: `src/lib/admin/business-detail-types.ts`, `src/lib/admin/business-detail/queries.ts`, `src/lib/admin/business-detail/mappers.ts`, `src/app/admin/businesses/[id]/types.ts`, and `src/app/admin/businesses/[id]/_components/ReviewsList.tsx`
- Extend related tests under `src/lib/dashboard/__tests__`, `src/app/(authenticated)/dashboard/past-replies/__tests__`, and `src/lib/admin/__tests__`

---

## Phase 0: Provider-Moderation Validation

Purpose: prove the typed provider moderation verdict is usable before any auto runtime code exists. This phase must not add auto-approval state, settings, runtime auto-posting, or docs that weaken the current no-auto-posting invariant.

### Task 0.1: Lock Provider Marker Semantics

**Files:**
- Modify: `src/lib/moderation/output-filter.ts`
- Modify: `src/lib/moderation/moderate.ts`
- Modify: `src/lib/moderation/__tests__/moderate.test.ts`
- Create: `docs/runbooks/auto-approval-provider-moderation-validation.md`

- [ ] Confirm current behavior in `src/lib/moderation/moderate.ts`: provider disabled returns `providerStatus=null`, provider clean returns `providerStatus='clean'`, provider error returns `providerStatus='error'`, and provider flagged returns `providerStatus=null` with `flagged=true` and `openai_categories`. Legacy `categories.openai_moderation` metadata may remain for `api_costs`, but runtime auto gates must not read it.

- [ ] Add tests in `moderate.test.ts` for the exact provider states used by auto approval:
  - disabled provider returns `providerStatus=null`
  - enabled provider clean plus local clean returns `flagged=false` and `providerStatus='clean'`
  - provider error returns `providerStatus='error'` and fails open to the local decision
  - provider flag returns `providerStatus=null` and sets `flagged=true`

- [ ] Add the runbook with the validation checklist:
  - environment must use `OPENAI_MODERATION_ENABLED=true`
  - validation covers clean, error, and provider-flagged cases
  - ops must not set `AUTO_APPROVAL_PROVIDER_MODERATION_READY=true` until the validation is complete in the target environment
  - this phase does not permit runtime auto posting

- [ ] Run:

```bash
pnpm exec vitest run src/lib/moderation/__tests__/moderate.test.ts
pnpm build
```

- [ ] Open a small PR for Phase 0. After merge, do not enable any auto-approval flags because the runtime and settings surfaces do not exist yet.

---

## PR1: Schema And Helper Hardening

Purpose: add database shape and reusable helpers without changing runtime behavior. After PR1, no producer should auto-approve, no response should be posted without owner approval, and `AUTO_APPROVAL_ENABLED` should still be inert because no runtime branch uses it.

### Task 1.1: Add Migration 055

**Files:**
- Create: `supabase/migrations/055_auto_approval_policy.sql`
- Create: `src/lib/shared/__tests__/migration-055-auto-approval-policy.test.ts`
- Modify: `.claude/reference/migrations-log.md`
- Modify: `docs/security/rls-inventory.md`
- Modify: `scripts/ci/tenant-tables.ts`

- [ ] Write migration 055 with:
  - `auto_approval_policies` using UUIDv7 app-side IDs, `account_id`, nullable `location_id`, nullable `auto_approve_min_star`, timestamps, and the `1..5` CHECK when non-null
  - `businesses_id_account_id_key` unique constraint on `(id, account_id)`
  - composite FK `(location_id, account_id)` referencing `businesses(id, account_id)` with default `MATCH SIMPLE`
  - partial unique index for account default where `location_id IS NULL`
  - partial unique index for location override where `location_id IS NOT NULL`
  - RLS enabled on `auto_approval_policies` with no authenticated owner DML policies
  - `responses.approval_method text NULL` plus CHECK for `owner` and `auto_policy`
  - conservative backfill: approved, edited, awaiting_owner_connect as `owner`; posted as `owner` only when an approval audit row exists; ambiguous and external posted rows remain `NULL`
  - replacement of the `approval_audit_log.auth_method` CHECK to include `auto_policy`

- [ ] Add migration structure tests that assert every item above, including exact partial-index predicates because `ON CONFLICT` must match them byte-for-byte.

- [ ] Add `auto_approval_policies` to `scripts/ci/tenant-tables.ts` and `docs/security/rls-inventory.md` with account/location scope notes.

- [ ] Update `.claude/reference/migrations-log.md` current head from 054 to 055 and summarize the schema. Do not update `.claude/CLAUDE.md` or `AGENTS.md` no-auto-posting invariant in PR1.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-055-auto-approval-policy.test.ts scripts/ci/__tests__/rls-audit.test.ts
pnpm ci:rls-audit
pnpm ci:tenant-scope
pnpm build
```

### Task 1.2: Add Server-Only Auto-Approval Helpers

**Files:**
- Create: `src/lib/auto-approval/flags.ts`
- Create: `src/lib/auto-approval/types.ts`
- Create: `src/lib/auto-approval/policy.ts`
- Create: `src/lib/auto-approval/__tests__/flags.test.ts`
- Create: `src/lib/auto-approval/__tests__/policy.test.ts`

- [ ] Add small flag helpers:
  - `autoApprovalRuntimeEnabled()` returns true only when `process.env.AUTO_APPROVAL_ENABLED === 'true'`
  - `providerModerationEnabled()` returns true only when `process.env.OPENAI_MODERATION_ENABLED === 'true'`
  - `providerModerationValidated()` returns true only when `process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY === 'true'`
  - `isPreviewEnvironment()` returns true only when `process.env.VERCEL_ENV === 'preview'`

- [ ] Add threshold and policy types:
  - `AutoApprovalThreshold = 1 | 2 | 3 | 4 | 5`
  - `ApprovalMethod = 'owner' | 'auto_policy'`
  - `PolicySource = 'location_override' | 'account_default' | 'none'`
  - `PolicyRowState` and `EffectiveAutoApprovalPolicy`

- [ ] Add pure policy functions:
  - `exposureRank(threshold)` maps `null -> 0`, `5 -> 1`, `4 -> 2`, `3 -> 3`, `2 -> 4`, `1 -> 5`
  - `isThresholdExpansion(before, after)` compares ranks
  - `starMeetsThreshold(starRating, threshold)` returns false for null star or null threshold
  - `resolveEffectivePolicy(accountDefault, locationOverride)` honors location row existence, including explicit `NULL`

- [ ] Add tests proving missing, empty, invalid, and uppercase env values do not enable auto.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/auto-approval/__tests__/flags.test.ts src/lib/auto-approval/__tests__/policy.test.ts
pnpm ci:static-policy
pnpm build
```

### Task 1.3: Add Typed Outbox And Payload Helpers

**Files:**
- Modify: `src/lib/shared/worker-types.ts`
- Create: `src/lib/shared/job-outbox-helpers.ts`
- Create: `src/lib/shared/__tests__/job-outbox-helpers.test.ts`

- [ ] Add `GenerateResponseOriginLane` with the exact values `live_ingest_new`, `live_ingest_update`, `backfill`, and `regenerate`.

- [ ] Add `parseGenerateResponsePayload(data)` or `normalizeGenerateResponsePayload(data)` that:
  - preserves existing fail-fast validation for `review_id`, `business_id`, and `version`
  - normalizes `suppress_notification === true`
  - returns `originLane: GenerateResponseOriginLane | null`
  - returns a sanitized `unknownOriginLane` string only when the payload carries an unknown non-empty lane
  - accepts old missing-lane jobs and extra keys

- [ ] Keep `GenerateResponsePayload.origin_lane` optional in PR1 so old queued jobs and producers compile before PR2 call-site migration.

- [ ] Add `enqueueGenerateResponse(tx, input)` that requires a lane in its input and writes a `generate_response` outbox payload through `jsonb()`. It must not add dedupe behavior.

- [ ] Add `enqueuePublishResponse(tx, { responseId, businessId, correlationId })` that writes `publish_response` payload identifiers only and preserves the in-flight conflict guard matching `idx_jo_publish_response_inflight`.

- [ ] Add tests that inspect generated SQL text and `jsonb()` payload objects for exact lane and publish payload shape.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/job-outbox-helpers.test.ts
pnpm build
```

### Task 1.4: Add Auto Approval Audit Helper

**Files:**
- Modify: `src/lib/approval/audit.ts`
- Create or extend: `src/lib/approval/__tests__/audit.test.ts`

- [ ] Add `insertAuditLogAutoPolicy(tx, input)` beside `insertAuditLog` and `insertAuditLogSession`.

- [ ] The helper writes:
  - `action='auto_approved_by_policy'` or a caller-provided auto action for kill-switch downgrade
  - `auth_method='auto_policy'`
  - `token_hash=NULL`
  - `device_cookie_hash=NULL`
  - `actor_user_id=NULL`
  - `ip_address=NULL`
  - `response_text_at_approval` from caller for auto approval, null for downgrade
  - compact metadata through `jsonb()`

- [ ] Tests must assert it never persists raw review text, response text outside `response_text_at_approval`, raw review hashes, tokens, or full policy JSON.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/approval/__tests__/audit.test.ts
pnpm build
```

### PR1 Verification And Rollout

- [ ] Run the full PR1 narrow set:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-055-auto-approval-policy.test.ts src/lib/auto-approval/__tests__/flags.test.ts src/lib/auto-approval/__tests__/policy.test.ts src/lib/shared/__tests__/job-outbox-helpers.test.ts src/lib/approval/__tests__/audit.test.ts
pnpm ci:rls-audit
pnpm ci:tenant-scope
pnpm ci:static-policy
pnpm build
```

- [ ] Open PR1. Apply migration 055 to staging Supabase first after PR approval. Apply to production only after staging validation and merge/promotion.

---

## PR2: Runtime Path Behind Disabled Flag

Purpose: implement the complete auto runtime machinery while `AUTO_APPROVAL_ENABLED` defaults false. This PR is the point where docs may update the no-auto-posting invariant to include owner-configured auto policy, because the code path exists but remains server-flag disabled by default.

### Task 2.1: Normalize Generate Payload At Worker Boundary

**Files:**
- Modify: `worker/jobs/ResponseGeneratorWorker.ts`
- Modify: `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts`

- [ ] Call the payload parser before destructuring `job.data`.

- [ ] Pass the normalized lane and normalized suppress flag into `persistResponseAndNotify`.

- [ ] Log unknown non-empty lanes once per job with sanitized low-cardinality text. Missing legacy lanes should fail closed without noisy logs.

- [ ] Add tests for missing lane, unknown lane, extra keys, and valid lanes.

- [ ] Run:

```bash
pnpm exec vitest run worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
```

### Task 2.2: Carry Load-Time Review Hash

**Files:**
- Modify: `worker/jobs/response-generation/load-context.ts`
- Extend: `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` or create `worker/jobs/response-generation/__tests__/load-context.test.ts`

- [ ] Extend the review SELECT to include `review_content_hash`.

- [ ] Add `loadedReviewContentHash: string | null` to the ready context returned to the generator worker.

- [ ] Do not include `review_content_hash` in the Redis generation cache key.

- [ ] Add a test that the SELECT includes `review_content_hash` and ready context carries the value.

- [ ] Run:

```bash
pnpm exec vitest run worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
```

### Task 2.3: Implement Persist-Time Auto Predicate

**Files:**
- Modify: `worker/jobs/response-generation/persist.ts`
- Create: `worker/jobs/response-generation/auto-approval.ts`
- Create: `worker/jobs/response-generation/__tests__/auto-approval.test.ts`
- Create or extend: `worker/jobs/response-generation/__tests__/persist.test.ts`

- [ ] In `persistResponseAndNotify`, keep the first insert as `status='pending_approval'`, `approval_method=NULL`, and `original_draft_text=response_text`.

- [ ] Keep `recordModerationAndHold` before auto decision. A high-severity hold must continue to suppress owner notification and prevent auto.

- [ ] Re-read current review, business, account, effective policy, active location, and active Zernio connection inside the same `sql.begin()` transaction after moderation hold logic.

- [ ] Implement `providerModerationClean(moderation)` through the typed provider verdict: `moderation.providerStatus === 'clean'`, plus `moderation.flagged === false` and `providerModerationEnabled() === true`. Do not read `moderation.categories.openai_moderation` in runtime auto gates.

- [ ] Compose the predicate exactly:
  - effective policy exists and current star meets threshold
  - `originLane === 'live_ingest_new'`
  - loaded and current review hashes are non-null and equal
  - current star rating is non-null
  - provider moderation clean
  - moderation not flagged and not held
  - `checkSubscription({ workerType: 'publisher', ... })` allows current account
  - active location now
  - active Zernio connection now
  - `autoApprovalRuntimeEnabled()`
  - defensive checks for `version === 1`, `suppressNotification === false`, and provider moderation enabled

- [ ] Auto branch transaction work:
  - update just-inserted response to `status='approved'`
  - set `approval_method='auto_policy'`
  - set `approved_text=response_text`
  - set `approved_at=NOW()`
  - write one auto approval audit row with compact metadata
  - enqueue `publish_response` through `enqueuePublishResponse` in the same transaction
  - do not enqueue `send_notification`

- [ ] Manual fallback keeps `pending_approval`, keeps `approval_method=NULL`, and enqueues `send_notification` unless held or `suppress_notification=true`.

- [ ] SQL/schema/connection errors during the current-state lookup should abort the transaction and let the job retry. Do not catch those errors as manual fallback.

- [ ] Add success tests for status, approval method, approved text, audit row, publish outbox, no approval link, and no notification.

- [ ] Add manual fallback matrix tests for bad lane, version greater than 1, suppress flag, hash mismatch, null loaded/current hash, below threshold, no/disabled policy, provider disabled, provider error, provider flag, local medium/low flag, runtime disabled, publisher subscription denied, missing active Zernio connection, and archived location.

- [ ] Run:

```bash
pnpm exec vitest run worker/jobs/response-generation/__tests__/auto-approval.test.ts worker/jobs/response-generation/__tests__/persist.test.ts
```

### Task 2.4: Put Every Generate Producer On Explicit Lanes

**Files:**
- Modify: `src/lib/reviews/process-review.ts`
- Modify: `src/lib/reviews/__tests__/process-review.test.ts`
- Modify: `src/lib/approval/token-mode.ts`
- Modify: `src/lib/approval/session-mode.ts`
- Modify: `src/lib/approval/callback-mode.ts`
- Modify: `src/app/api/admin/flagged/route.ts`
- Modify: `src/app/api/dashboard/past-replies/draft/route.ts`
- Extend route/helper tests that assert outbox payloads

- [ ] Use `enqueueGenerateResponse` instead of hand-built `GenerateResponsePayload` inserts.

- [ ] Assign lanes:
  - live first-time `processReview` new review: `live_ingest_new`
  - live content update branches: `live_ingest_update`
  - Zernio backfill/import calls: `backfill`
  - token/session/callback regenerate: `regenerate`
  - admin flagged redraft: `regenerate`
  - Past Replies regenerate/draft: `regenerate`

- [ ] If `processReview` is reused by backfill, extend its options with an explicit source/lane input so backfill new rows do not look like `live_ingest_new`.

- [ ] Add a targeted static or unit test that fails if a production `generate_response` outbox insert is not routed through `enqueueGenerateResponse`.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/reviews/__tests__/process-review.test.ts src/lib/approval/__tests__/service.test.ts src/lib/approval/__tests__/approve-via-callback.test.ts src/app/api/admin/flagged/__tests__/route.test.ts src/app/api/dashboard/past-replies/__tests__/draft.test.ts
```

### Task 2.5: Move Publish Producers To Shared Helper And Set Owner Attribution

**Files:**
- Modify: `src/lib/approval/token-mode.ts`
- Modify: `src/lib/approval/session-mode.ts`
- Modify: `src/lib/approval/callback-mode.ts`
- Modify: `src/app/api/dashboard/past-replies/publish/route.ts`
- Modify: `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts`
- Modify: `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts`
- Extend tests under `src/lib/approval/__tests__` and `src/app/api/dashboard/past-replies/__tests__`

- [ ] Use `enqueuePublishResponse` for token approve/edit, session approve/edit, callback approve, Past Replies publish, Past Replies retry, and Past Replies restore-original.

- [ ] Set `approval_method='owner'` atomically in every manual owner transition to `approved` or `edited`.

- [ ] Ensure manual owner approval after a kill-switch downgrade clears stale `posting_error` and sets `approval_method='owner'`.

- [ ] Add tests proving no manual approve/edit/publish path can move to `approved` or `edited` without `approval_method='owner'`.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/approval/__tests__/service.test.ts src/lib/approval/__tests__/approve-via-callback.test.ts src/app/api/dashboard/past-replies/__tests__/publish.test.ts src/app/api/dashboard/past-replies/__tests__/retry.test.ts src/app/api/dashboard/past-replies/__tests__/restore-original.test.ts
```

### Task 2.6: Add Publisher Kill-Switch Downgrade

**Files:**
- Modify: `worker/jobs/publisher/load-context.ts`
- Modify: `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Create: `worker/jobs/publisher/auto-policy-downgrade.ts`
- Extend: `worker/jobs/publisher/__tests__/load-context.test.ts`
- Extend: `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts`

- [ ] Add `approval_method` to `PublishResponseContext.response`.

- [ ] Keep `business.archived_at` loaded, but stop returning `terminal` solely for archived locations in `loadPublishResponseContext`.

- [ ] In `handlePublishResponse`, run kill-switch downgrade immediately after the publishable-state gate and before archived-location terminal handling, subscription guard, connection lookup, Zernio review lookup, delete-before-post, or post calls.

- [ ] The downgrade transaction must:
  - update matching auto-policy rows in `approved`, `edited`, or `awaiting_owner_connect` to `pending_approval`
  - set `approval_method=NULL`, `approved_at=NULL`, `approved_text=NULL`
  - set `posting_error='auto_policy_revoked_by_kill_switch'`
  - keep `response_text` unchanged
  - write `approval_audit_log` action `auto_policy_revoked_by_kill_switch` with `auth_method='auto_policy'`
  - enqueue normal `send_notification` regardless of old suppression metadata
  - preserve publish job `correlation_id` into notification payload when present
  - mark the triggering publish outbox completed in the same transaction

- [ ] If the guarded update returns no row, complete the publish outbox and do not enqueue notification or audit.

- [ ] Tests must cover approved, edited, awaiting-owner-connect, zero-row guard, duplicate/retry notification behavior, archived auto rows downgraded before archive terminal, and owner rows preserving current publisher behavior.

- [ ] Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/load-context.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

### Task 2.7: Runtime Documentation And Flag Inventory

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify locally if present: `AGENTS.md` (gitignored/absent in some worktrees; local documentation sync only, not a PR/CI gate)
- Modify: `.env.example`
- Modify: `docs/eservices-variables.md`
- Modify: `.claude/reference/env-vars.md`
- Modify: `.claude/skills/approval-security/SKILL.md`

- [ ] Update the no-auto-posting invariant to say posting requires an approval decision: explicit owner approval or owner-configured auto policy.

- [ ] Document that auto policy cannot bypass moderation, provider clean, runtime flag, publisher subscription, active connection, active location, live-ingest-new lane, version 1, no suppression, and review-hash freshness gates.

- [ ] Add `AUTO_APPROVAL_ENABLED` and `AUTO_APPROVAL_PROVIDER_MODERATION_READY` as server-only flags that default false unless exactly `'true'`.

- [ ] Keep `NEXT_PUBLIC_*` unchanged. Do not add browser companions.

- [ ] Add or extend static verification that settings UI/browser code does not read or write `auto_approval_policies` directly through Supabase; owner access must flow through the server route.

- [ ] Update `approval-security` so it no longer assumes every post is human-approved, while preserving raw-token rules for manual paths.

- [ ] Run:

```bash
pnpm ci:static-policy
pnpm build
```

### PR2 Verification And Rollout

- [ ] Run:

```bash
pnpm exec vitest run worker/jobs/__tests__/ResponseGeneratorWorker.test.ts worker/jobs/response-generation/__tests__/auto-approval.test.ts worker/jobs/response-generation/__tests__/persist.test.ts src/lib/reviews/__tests__/process-review.test.ts src/lib/approval/__tests__/service.test.ts src/lib/approval/__tests__/approve-via-callback.test.ts src/app/api/admin/flagged/__tests__/route.test.ts src/app/api/dashboard/past-replies/__tests__/draft.test.ts src/app/api/dashboard/past-replies/__tests__/publish.test.ts src/app/api/dashboard/past-replies/__tests__/retry.test.ts src/app/api/dashboard/past-replies/__tests__/restore-original.test.ts worker/jobs/publisher/__tests__/load-context.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
pnpm ci:tenant-scope
pnpm ci:static-policy
pnpm build
```

- [ ] In staging, deploy worker/UI with `AUTO_APPROVAL_ENABLED=false`. Validate legacy owner approval, notification, and publisher flows still pass.

- [ ] Do not enable runtime auto in production until PR3 settings and admin visibility are merged, reviewed, and staging-validated.

---

## PR3: Settings API/UI And Admin/DTO Visibility

Purpose: expose owner controls, server-side expansion gates, and read-only visibility. Runtime code already exists behind flags from PR2; PR3 adds the control plane and display surfaces.

### Task 3.1: Add Settings Service And Readiness Model

**Files:**
- Create: `src/lib/auto-approval/settings-types.ts`
- Create: `src/lib/auto-approval/readiness.ts`
- Create: `src/lib/auto-approval/settings-service.ts`
- Create: `src/lib/auto-approval/__tests__/settings-service.test.ts`

- [ ] Define GET/PATCH response types exactly as the spec:
  - `PolicyRowState`
  - per-location effective threshold/source/inherited state
  - `AutoApprovalReadiness` with stable reason codes

- [ ] Implement account/location policy reads from `auto_approval_policies` and active `businesses`.

- [ ] Derive readiness booleans from server helpers and account writability. Do not expose raw env names or values.

- [ ] Implement pure before/after exposure calculations that compare effective exposure, not just row values.

- [ ] Tests must cover account default inheritance, explicit null override, deleted location override inheriting default, future-effective account expansion with zero active locations, and readiness reason combinations.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/auto-approval/__tests__/settings-service.test.ts
```

### Task 3.2: Add Owner GET/PATCH API

**Files:**
- Create: `src/app/api/settings/auto-approval/route.ts`
- Create: `src/app/api/settings/auto-approval/__tests__/route.test.ts`
- Create: `src/lib/admin/impersonation/route-guard.ts`
- Create: `src/lib/admin/impersonation/__tests__/route-guard.test.ts`

- [ ] `GET /api/settings/auto-approval` uses `requireOwnerWithAccount(request)`, is dynamic/no-store, accepts no `accountId`, and returns only session-account data.

- [ ] `PATCH /api/settings/auto-approval` is wrapped with `withSameOrigin()`, uses `requireOwnerWithAccount(request)`, and rejects active impersonation at the route layer.

- [ ] Use one operation enum:
  - `set_account_default`
  - `set_account_manual`
  - `clear_account_default`
  - `set_location_override`
  - `set_location_manual`
  - `delete_location_override`

- [ ] Implement the mutation in one `sql.begin()` block:
  - `SELECT ... FOR UPDATE` the account row inside the transaction
  - read before row/effective state and active inheriting locations
  - validate location account relationship
  - enforce active location requirement for expansions and active edits
  - apply mutation
  - read after state
  - compute expansion from before/after exposure rank
  - for expansions only, require runtime enabled, provider enabled, provider validated, writable account via `assertWritableSubscriptionForAccount(accountId, tx)`, non-preview, non-impersonated session, and confirmation level
  - write `account_audit_log` through `writeAccountAuditLog(input, tx)`
  - return refreshed state

- [ ] Missing confirmation returns `400` with `auto_approval_confirmation_required`. Runtime/account readiness blocks return `409` with `auto_approval_expansion_blocked` and stable `blockReasons`.

- [ ] Tests must cover same-origin rejection, impersonation rejection, no accepted `accountId`, cross-account location rejection, contractions allowed under blocked readiness, expansion blocked under each readiness reason, `all_ratings` confirmation for threshold 1, and account row lock inside transaction.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/admin/impersonation/__tests__/route-guard.test.ts src/app/api/settings/auto-approval/__tests__/route.test.ts
```

### Task 3.3: Add Owner Settings UI

**Files:**
- Modify: `src/components/dashboard/shell/SettingsTabs.tsx`
- Create: `src/app/(authenticated)/settings/auto-approval/page.tsx`
- Create: `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx`
- Create: `src/components/dashboard/settings/AutoApprovalPanel.tsx`
- Create: `src/components/dashboard/settings/__tests__/AutoApprovalPanel.test.tsx`

- [ ] Add a settings tab labeled `Automation` or `Auto-approval` with a route at `/settings/auto-approval`. Use existing `SettingsShell` layout.

- [ ] The page fetches current state from the server route, renders account default and active location overrides, and does not read env vars directly.

- [ ] Use semantic threshold labels: Off/manual, 5-star only, 4-5, 3-5, 2-5, All rated.

- [ ] Do not hide controls when runtime is disabled. Show current state and allow contractions/disables.

- [ ] Disable expansion controls using server-provided reason codes, and map reason codes to copy in the client.

- [ ] No optimistic updates before PATCH succeeds. On success, replace local state with the response body.

- [ ] For threshold 1, require stronger confirmation copy and submit `confirmationLevel: 'all_ratings'`; for other expansions submit `standard`.

- [ ] Tests must cover disabled expansion controls, contraction still enabled while blocked, confirmation prompts, no optimistic state change on failed PATCH, and refreshed state on success.

- [ ] Run:

```bash
pnpm exec vitest run src/components/dashboard/settings/__tests__/AutoApprovalPanel.test.tsx
pnpm build
```

### Task 3.4: Add Owner And Admin DTO Visibility

**Files:**
- Modify: `src/lib/dashboard/types.ts`
- Modify: `src/lib/dashboard/service.ts`
- Modify: `src/lib/dashboard/active-mappers.ts`
- Modify: `src/lib/dashboard/aggregate-service.ts`
- Modify dashboard recent-review components that render badges
- Modify: `src/components/dashboard/reviews/PastReplyCard.tsx`
- Modify: `src/app/(authenticated)/dashboard/past-replies/page.tsx`
- Modify: `src/lib/admin/business-detail-types.ts`
- Modify: `src/lib/admin/business-detail/queries.ts`
- Modify: `src/lib/admin/business-detail/mappers.ts`
- Modify: `src/app/admin/businesses/[id]/types.ts`
- Modify: `src/app/admin/businesses/[id]/_components/ReviewsList.tsx`
- Extend related tests

- [ ] Add nullable `approvalMethod` or `approval_method` to all four display DTO shapes:
  - dashboard recent reviews in `DashboardDataActive`
  - aggregate dashboard `AggregateReviewItem`
  - `PastReplyRow`
  - admin business detail `ReviewRow`

- [ ] Include `responses.approval_method` in each query/mapping path independently. Do not introduce a single shared DTO as a side effect.

- [ ] Render auto badges only when `approval_method === 'auto_policy'`. Do not infer from status.

- [ ] Keep KPI status groups unchanged. Do not alter digest copy or scheduler behavior.

- [ ] Extend admin business detail response with read-only auto policy diagnostics:
  - current account default and per-location effective policy
  - runtime/provider readiness
  - recent auto approval and kill-switch downgrade audit actions
  - response approval-method badge/field

- [ ] Tests must cover DTO field presence, badge keying on `auto_policy`, KPI unchanged, and admin diagnostics read-only behavior.

- [ ] Run:

```bash
pnpm exec vitest run src/lib/dashboard/__tests__/active-mappers.test.ts src/lib/dashboard/__tests__/aggregate-types.test.ts src/app/'(authenticated)'/dashboard/past-replies/__tests__/PastRepliesClient.test.tsx src/lib/admin/__tests__/business-detail.test.ts
pnpm build
```

### Task 3.5: End-To-End Settings Verification

**Files:**
- Create: `e2e/settings-auto-approval.spec.ts`

- [ ] Add Playwright coverage for the owner settings flow when test DB credentials are available:
  - load settings
  - blocked expansion shows readiness copy
  - contraction/manual save succeeds
  - threshold 1 requires stronger confirmation
  - location override delete can expand or contract based on inherited default

- [ ] Run:

```bash
pnpm exec playwright test e2e/settings-auto-approval.spec.ts --workers=1
```

If the environment lacks `TEST_DATABASE_POOL_URL`, record the skip and rely on route/unit tests for CI coverage.

### PR3 Verification And Rollout

- [ ] Run:

```bash
pnpm exec vitest run src/lib/auto-approval/__tests__/settings-service.test.ts src/lib/admin/impersonation/__tests__/route-guard.test.ts src/app/api/settings/auto-approval/__tests__/route.test.ts src/components/dashboard/settings/__tests__/AutoApprovalPanel.test.tsx src/lib/dashboard/__tests__/active-mappers.test.ts src/lib/dashboard/__tests__/aggregate-types.test.ts src/app/'(authenticated)'/dashboard/past-replies/__tests__/PastRepliesClient.test.tsx src/lib/admin/__tests__/business-detail.test.ts
pnpm ci:tenant-scope
pnpm ci:rls-audit
pnpm ci:static-policy
pnpm build
```

- [ ] Deploy to staging with `AUTO_APPROVAL_ENABLED=false` and `AUTO_APPROVAL_PROVIDER_MODERATION_READY` reflecting Phase 0 validation. Verify GET renders readiness and PATCH contractions work.

- [ ] Enable staging flags only after owner settings, publisher kill switch, and admin visibility pass staging tests. Exercise auto success and kill-switch downgrade in staging before production.

- [ ] Promote to main by PR merge only. Fast-forward `staging` to `main` after production promotion so the long-lived staging branch does not drift.

---

## Spec Coverage Checklist

- Phase 0 covers provider moderation validation before implementation.
- PR1 covers migration 055, RLS/tenant inventory, env helpers, typed lanes/parser, typed outbox helpers, policy helpers, and auto audit helper.
- PR2 covers `review_content_hash` load-context delta, typed `ModerationDecision.providerStatus` gate, final persist-time predicate, origin lanes, auto branch, manual fallback, manual owner attribution, publish helper adoption, publisher kill-switch ordering, and runtime docs change-map.
- PR3 covers route auth decisions, expansion-only writability, route-level impersonation rejection, net-new `isPreviewEnvironment()`, settings UI, admin diagnostics, all four DTO shapes, and no `NEXT_PUBLIC_*` flags.
- §17 tests are distributed across schema, origin lanes, persist auto success, manual fallback matrix, settings, publisher downgrade, manual approval attribution, display/admin/KPI, and static policy verification.

## Branch And PR Sequence

1. `worktree-auto-approval-provider-validation` for Phase 0.
2. `worktree-auto-approval-schema-helpers` for PR1.
3. `worktree-auto-approval-runtime` for PR2.
4. `worktree-auto-approval-settings` for PR3.

Each branch should start from current `main` after the previous PR merges. Do not stack long-lived code branches across migration changes unless the previous branch is merged and local `main` has been fast-forwarded.
