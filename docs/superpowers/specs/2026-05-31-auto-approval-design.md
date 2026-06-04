# Auto-Approval Policy - Design Spec

- **Date:** 2026-05-31
- **Status:** Draft, readiness-audited through 2026-06-03 (synced to `main` @2c81bec3; §14 reconciled against PR #221's `writable-subscription.ts`, AGENTS.md references removed); **not implemented**. This document is now the implementation source of truth for the auto-approval plan. The CLAUDE.md no-auto-posting invariants remain authoritative until the implementation PR lands and updates them in the same change.
- **Owner:** Norbert Esekiel
- **Origin:** Potential-client survey: owners want to choose which review responses can be fully automated (draft -> approval decision -> Google post) and which require manual owner approval.

## 1. Problem

Today every generated response requires explicit owner approval before it posts to Google. Some owners want routine first-time reviews to be handled automatically by policy, while sensitive or non-routine cases stay manual.

The feature must add an owner-configured auto-approval decision without weakening the existing guarantees around moderation, billing, tenant scope, approval tokens, and transactional outbox delivery.

## 2. Goals / Non-Goals

**Goals**
- Account default policy with optional per-location overrides.
- Star-rating threshold only: manual, 5-star only, 4-5, 3-5, 2-5, or all rated reviews.
- Auto-approval only for first-time new live-ingest reviews.
- Runtime auto decision is based on current state at response persistence time.
- Settings writes are server-authoritative, audited, tenant-safe, same-origin protected, and expansion-gated.
- Auto-approved rows use the normal publisher path, with an emergency kill switch that can revoke unposted auto approvals.

**Non-goals (v1)**
- Sentiment, keywords, language, length, reviewer, campaign, or per-rating map rules.
- Auto-editing or auto-regeneration before posting.
- Backfill/import/historical auto-posting.
- Manual regenerate-and-auto-post.
- Auto-specific weekly/monthly digest copy or scheduler behavior.
- New KPI semantics. Auto responses count as handled/responded exactly like owner-approved responses.
- Runtime policy caching in Redis or memory.
- Admin mutation controls.
- Retroactively re-evaluating an existing response row after it exists.

**Policy effective time.** Policy is resolved once at **response persistence time**, inside `persistResponseAndNotify`, and never re-evaluated after the response row exists. A policy change can affect jobs that are queued or mid-generation but not yet persisted. That is deliberate: it avoids carrying stale policy snapshots, and the final decision uses current state.

## 3. Locked Decisions

1. **No new status.** Auto approval reuses `responses.status='approved'`.
2. **Nullable approval attribution.** Add `responses.approval_method text NULL CHECK (approval_method IN ('owner','auto_policy'))`. Pending/manual-fallback/external/ambiguous rows can be `NULL`.
3. **Only first-time new live ingest can auto.** `origin_lane='live_ingest_new'` is the only auto-eligible lane. `live_ingest_update`, `backfill`, `regenerate`, unknown, or missing lane are manual.
4. **Final auto decision lives in `persistResponseAndNotify`.** `load-context.ts` keeps the generator subscription gate and idempotency check. It may load draft context, but it does not make the final policy/subscription/publisher decision.
5. **Current state is re-read inside the persist transaction.** Runtime uses current review hash/star, current policy, current account state, current location/account relationship, active location, active Zernio connection, current runtime flags, and current provider-moderation state.
6. **Provider moderation is mandatory for auto.** Auto requires provider moderation enabled and a per-draft clean marker. Regex-only or provider-error drafts fall back to manual.
7. **Runtime kill switch is separate.** `AUTO_APPROVAL_ENABLED` is the auto-posting switch. It is independent from `OPENAI_MODERATION_ENABLED` and provider validation.
8. **Settings expansion is gated; contractions are always allowed.** Owners/admins must be able to disable or reduce automation even during incidents or billing problems.
9. **No durable audit for manual fallback.** Manual fallback is not an approval decision. It gets normal response state + notification only.

## 4. Runtime Predicate

Auto approval is subordinate to every existing guarantee. The final predicate is evaluated after generation and moderation, inside the response-persistence transaction, after `recordModerationAndHold` has returned `held`.

```
auto =
  // ── Independent gates: each can independently flip the decision — this is the real contract ──
     policyEligibleNow                                       // current effective threshold non-null AND current star meets it
  && origin_lane === 'live_ingest_new'                       // only first-time new live reviews
  && loadedReviewContentHash IS NOT NULL
  && currentReviewContentHash IS NOT NULL
  && loadedReviewContentHash === currentReviewContentHash    // review text/star unchanged since generation
  && currentStarRating IS NOT NULL                           // NOT implied by hash-match (computeContentHash hashes "null|text")
  && providerModerationClean(moderation)
  && !moderation.flagged
  && !held
  && canPublishForAccount(currentAccountState)               // = existing checkSubscription({workerType:'publisher'}) — NOT a new helper (§14)
  && activeLocationNow                                       // also backstopped by the publisher's archived_at terminal gate
  && activeZernioConnectionNow                               // distinct product rule: no auto-post after a disconnect -> reconnect (§8)
  && autoApprovalRuntimeEnabled()
  // ── Defensive cross-checks: implied by `live_ingest_new` TODAY, kept fail-closed against a future mislabeled producer ──
  && responseVersion === 1                                   // Branch A enqueues version 1
  && suppressNotification === false                          // the live-ingest path never suppresses
  && providerModerationEnabled()                             // already inside providerModerationClean(); kept as a named gate for the distinct `provider_moderation_disabled` log reason (§15)
```

`policyEligibleNow` means the current effective threshold is non-null and the current `reviews.star_rating` meets it.

The predicate is grouped on purpose. The **independent gates** are the real contract — each can independently flip the decision. The **defensive cross-checks** (`responseVersion === 1`, `suppressNotification === false`, `providerModerationEnabled()`) are implied by `origin_lane === 'live_ingest_new'` / `providerModerationClean` *today* and are kept deliberately, not deleted: they fail closed if a future producer mislabels a lane, and `providerModerationEnabled()` stays a named gate so §15 can log `provider_moderation_disabled` distinctly from `provider_moderation_error`. The 2026-06-02 trim pass removed **no** safety gate; the two-group layout exists only to cut reader-load by separating the load-bearing gates from the belt-and-suspenders ones.

`providerModerationClean` is intentionally precise:

```ts
function providerModerationClean(m: ModerationDecision): boolean {
  return process.env.OPENAI_MODERATION_ENABLED === 'true'
    && m.categories.openai_moderation === 'clean'
    && m.flagged === false;
}
```

The OpenAI marker is a tri-state implementation detail: `'clean'`, `'error'`, or absent. A provider flag does not set `'flagged'`; it sets `flagged=true` and high severity. Missing marker, provider error, provider disabled, or any local/provider flag all fail auto. High-severity flags still hold and suppress notification under the existing moderation invariant. Medium/low flags fall back to manual.

**Current-code note.** `ModerationDecision.categories` is typed `Record<string, unknown>` (`src/lib/moderation/output-filter.ts`); `moderateResponse` writes `{ openai_moderation: 'clean' }` on the clean path and `{ openai_moderation: 'error' }` on provider error, but on a provider flag it writes `openai_categories` instead — so `openai_moderation` is **absent** and `flagged=true`. `providerModerationClean` therefore reads `categories.openai_moderation` through an explicit narrow; it does not assume a typed field, and the absent-marker case correctly fails auto via the `=== 'clean'` check.

**Normal non-eligibility cases** inside the transaction degrade to manual: no policy, disabled policy, bad lane, version > 1, stale/null review hash, rating below threshold, provider not clean, runtime disabled, publisher denied, no active connection, archived location, or suppress flag.

**SQL/schema/connection errors** during the in-transaction current-state lookup do **not** become "manual" inside the same transaction. In Postgres, a failed statement aborts the transaction. The job should fail/retry rather than risk partial state or pretend TypeScript can recover an aborted transaction.

## 5. Origin Lanes

`GenerateResponsePayload` gains a producer-facing required field:

```ts
origin_lane:
  | 'live_ingest_new'
  | 'live_ingest_update'
  | 'backfill'
  | 'regenerate'
```

The worker boundary parser is permissive for deploy safety: legacy missing field and unknown values parse successfully but resolve non-auto. Unknown non-empty values log a sanitized warning once per job. Missing old-job lane fails closed quietly. Extra keys are not strict-rejected.

Producer expectations:

| Producer | Lane |
| --- | --- |
| `processReview` first-time new review from live ingestion | `live_ingest_new` |
| `processReview` reviewer content update / supersede-regenerate path | `live_ingest_update` |
| Zernio backfill/import | `backfill` |
| Past Replies regenerate, token/session/callback supersede-regenerate, admin flagged redraft | `regenerate` |

Only `live_ingest_new` can auto. This avoids surprising owners when a changed review thread, manual regenerate, held-draft redraft, or historical import causes a new draft.

Add a small typed `enqueueGenerateResponse` helper so producers cannot hand-roll lane strings. The helper does not add new dedupe. It can live beside `enqueuePublishResponse` in a shared typed job-outbox helper module; document that publish has an in-flight conflict guard and generate does not.

`suppress_notification` remains in the job payload. It controls whether manual fallback sends owner notification for lanes such as backfill. It is not provenance. Auto requires both eligible lane and `suppress_notification=false`.

## 6. Policy Model

One nullable threshold:

| Intent | `auto_approve_min_star` | Meaning |
| --- | --- | --- |
| Off/manual | `NULL` | No automatic approval |
| 5-star only | `5` | Auto if current star rating is 5 |
| 4-5 | `4` | Auto if current star rating is 4 or 5 |
| 3-5 | `3` | Auto if current star rating is 3, 4, or 5 |
| 2-5 | `2` | Auto if current star rating is 2, 3, 4, or 5 |
| All rated | `1` | Auto for every rated review that passes all other gates |

Resolution for account `A`, location `L`:

1. If a per-location row exists for `(A, L)`, use it, including `NULL`.
2. Else if an account-default row exists for `(A, location_id IS NULL)`, use it, including `NULL`.
3. Else manual/no policy.

Account scope:
- Deleting the account default and setting it to `NULL` both mean manual at account scope.
- `clear_account_default` deletes only the account-default row. It must not delete or rewrite location overrides.
- UI should prefer an explicit `NULL` account-default row once the owner has configured the feature because it records "Auto-approval off."
- `clear_account_default` may exist for cleanup/admin use; audit distinguishes it from explicit manual.

Location scope:
- `NULL` location row means explicit manual override.
- Deleting the location row means inherit the account default.
- Deleting a `NULL` override under an auto account default is an expansion and must be gated.
- Creating/enabling/expanding a location override requires an active location (`archived_at IS NULL`). Deleting an existing override or setting it to manual can be allowed for archived locations if the row belongs to the account, because that is cleanup/contraction.

New or reactivated active locations inherit the account default immediately. Do not auto-create `NULL` manual overrides for new locations. Add-location flow should not mutate auto policy; it may show the inherited state and link to settings.

Unrated/null-star reviews remain manual. UI labels should say "All rated" rather than implying unrated reviews auto-post.

## 7. Data Model

Migration 055 should include:

**Policy table**

```sql
CREATE TABLE auto_approval_policies (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  location_id uuid NULL,
  auto_approve_min_star smallint NULL
    CHECK (auto_approve_min_star IS NULL OR auto_approve_min_star BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Use the repo's current UUIDv7 migration convention for `id` values rather than introducing a new ID style.

Add a composite referential guard, not route validation alone:

```sql
ALTER TABLE businesses
  ADD CONSTRAINT businesses_id_account_id_key UNIQUE (id, account_id);

ALTER TABLE auto_approval_policies
  ADD CONSTRAINT auto_approval_policies_location_account_fk
  FOREIGN KEY (location_id, account_id)
  REFERENCES businesses(id, account_id)
  ON DELETE CASCADE;
```

Do not use `MATCH FULL`; default `MATCH SIMPLE` allows `(NULL, account_id)` account-default rows. A separate standalone `location_id -> businesses(id)` FK is unnecessary if the composite FK cascades correctly.

Partial unique indexes:

```sql
CREATE UNIQUE INDEX auto_approval_policies_one_account_default
  ON auto_approval_policies(account_id)
  WHERE location_id IS NULL;

CREATE UNIQUE INDEX auto_approval_policies_one_location_override
  ON auto_approval_policies(account_id, location_id)
  WHERE location_id IS NOT NULL;
```

Postgres allows multiple `NULL` values in ordinary unique constraints, so `UNIQUE(account_id, location_id)` is insufficient. Any `ON CONFLICT` must match the partial-index predicate byte-for-byte.

RLS posture:
- Enable RLS.
- Add no authenticated owner SELECT/INSERT/UPDATE/DELETE policies in v1.
- Revoke direct authenticated DML if needed.
- Owner settings read/write goes through server routes using session-derived account scope.
- Add the table to tenant/RLS inventories, but do not add broad tenant-scope allowlists.

**Responses approval attribution**

```sql
ALTER TABLE responses
  ADD COLUMN approval_method text NULL;

ALTER TABLE responses
  ADD CONSTRAINT responses_approval_method_check
  CHECK (approval_method IS NULL OR approval_method IN ('owner', 'auto_policy'));
```

Do not make it `NOT NULL DEFAULT 'owner'`. If the column means "how this response was approved," then pending rows have not been approved and externally ingested Google replies were not approved through RepWorth.

Backfill conservatively:
- `approved`, `edited`, `awaiting_owner_connect` -> `owner`.
- `posted` -> `owner` only when an `approval_audit_log` row exists for that response.
- `posted` with no approval audit stays `NULL` because it may be externally ingested.
- Leave pending, superseded, failed, and ambiguous rows `NULL` unless there is explicit approval evidence.

Do not add status-based DB constraints on `approval_method` in v1; enforce transitions in code and tests.

**Approval audit auth method**

Migration 014 restricts `approval_audit_log.auth_method` to `token` and `owner_session`. Amend that CHECK to include `auto_policy`. Keep the existing default. Auto code must explicitly set `auth_method='auto_policy'`.

Do not add extra policy-history columns or confirmation columns in v1. `account_audit_log` owns settings actors and confirmations; `approval_audit_log.metadata` owns compact per-response auto decision facts.

Maintain `updated_at` explicitly in route/upsert SQL; do not add a trigger for this feature.

## 8. Runtime Flow

**Generator load**
- `load-context.ts` keeps the existing generator subscription gate and response `(review_id, version)` idempotency check.
- It must be **extended** to carry `review_content_hash` from the review row into the loaded context for draft freshness — the load-context SELECT does **not** read this column today (`worker/jobs/response-generation/load-context.ts` currently loads only `id, reviewer_name, star_rating, review_text, review_date, detected_language`). It still does not finalize auto eligibility.
- Existing Redis generation cache key remains `gen:{reviewId}:v{responseVersion}`. Do not include `review_content_hash` in the cache key for v1.

**Persistence**

Inside `persistResponseAndNotify`:

1. Insert the response as `pending_approval`, `approval_method=NULL`, and `original_draft_text=response_text`.
2. Link `api_costs`.
3. Record moderation metadata and high-severity hold in the same transaction.
4. Re-read current review/business/account/policy/location/connection state inside the same transaction.
5. Evaluate the final runtime predicate.
6. If auto:
   - Update the just-inserted row to `status='approved'`.
   - Set `approval_method='auto_policy'`.
   - Set `approved_text=response_text`.
   - Set `approved_at=NOW()`.
   - Write one `approval_audit_log` row.
   - Enqueue `publish_response` through the shared helper in the same transaction, preserving the generation `correlation_id`.
   - Do not enqueue `send_notification`.
7. If manual fallback:
   - Keep `status='pending_approval'`.
   - Keep `approval_method=NULL`.
   - Enqueue `send_notification` unless `held` or `suppress_notification=true`.

The step-4 re-reads (review/business/account/policy/location/connection) add ~5 indexed lookups inside the persist transaction. They are local indexed reads with **no remote calls**, so the extra transaction time under PgBouncer transaction-pooling is an accepted cost; the alternative (deciding from the load-time snapshot) was rejected because it can post against stale state. Note `activeLocationNow` is **also** backstopped by the publisher's existing `archived_at` terminal gate, so it is belt-and-suspenders rather than the sole guard. It is **not** a free transaction-trimming lever, though: dropping it changes behavior — an archived-location review would shift from **manual fallback** (`pending_approval`, with the existing notification handling) to **approved-then-publisher-terminal/no-op**, which moves owner-notification and approval-audit expectations and breaks the §17 archived-location fallback test. Treat any removal as a product/behavior change requiring test updates, not a perf tweak. `activeZernioConnectionNow` is **not** redundant either: it encodes the distinct product rule below.

Auto requires an active Zernio connection at persist time. If no active connection exists, fall back to manual rather than creating an approved row that later posts automatically after reconnect.

Auto requires `businesses.archived_at IS NULL` at persist time. Archived locations fall back to manual; the existing NotificationWorker owns actual notification skips for archived locations.

**Manual approval transitions**

All manual paths that transition or insert approved/edited rows must set `approval_method='owner'` atomically:
- token approve/edit
- session approve/edit
- callback approve
- Past Replies publish/retry/restore-original paths

They should set `approved_text`, `approved_at`, owner approval audit snapshot, publish outbox, and clear stale `posting_error` in the same transaction. Add tests that these paths cannot move a row to `approved`/`edited` without `approval_method='owner'`.

Auto-posted rows can still be edited or corrected later. The replacement owner-driven response gets `approval_method='owner'`; the original historical row remains `auto_policy`.

External ingested replies are terminal evidence, not auto candidates. Zernio ingestion that inserts/preserves a posted external reply must not generate an auto approval around it.

## 9. Publish Outbox Helper

Create `enqueuePublishResponse(tx, { responseId, businessId, correlationId? })` and move all single-row publish producers onto it:
- token approve/edit
- session approve/edit
- callback approve
- Past Replies publish
- Past Replies retry
- Past Replies restore-original
- auto branch

The helper payload remains identifiers only: `response_id`, `business_id`, optional `correlation_id`. Do not include `approval_method`; publisher loads current state from the DB. Preserve the existing publish in-flight conflict guard matching `idx_jo_publish_response_inflight`. `DrainOwnerConnectWorker` can keep its bulk set-based form, using the same conflict predicate.

If helper insertion hits an existing in-flight publish outbox row, that is an idempotency retry case. The response can remain approved if the durable follow-up already exists. Tests should assert retries do not duplicate response/audit rows through the existing `(review_id, version)` idempotency path.

## 10. Publisher Kill Switch Downgrade

Publisher must re-check the auto runtime switch before any external publish/delete call for auto-policy rows.

Add nullable `approval_method` to `loadPublishResponseContext`. Immediately after the publishable-state gate, before subscription, connection lookup, Zernio review lookup, edit-publish, or post calls:

```ts
if (response.approval_method === 'auto_policy' && !autoApprovalRuntimeEnabled()) {
  await downgradeAutoApprovedResponseForManualReview(...);
  return;
}
```

The downgrade helper runs one transaction:

```sql
UPDATE responses
SET status = 'pending_approval',
    approval_method = NULL,
    approved_at = NULL,
    approved_text = NULL,
    posting_error = 'auto_policy_revoked_by_kill_switch',
    updated_at = NOW()
WHERE id = $responseId
  AND business_id = $businessId
  AND status IN ('approved', 'edited', 'awaiting_owner_connect')
  AND approval_method = 'auto_policy'
RETURNING ...
```

If no row returns, mark the triggering publish outbox completed and do nothing else.

If a row returns:
- Keep `response_text` unchanged.
- Write a separate approval audit action `auto_policy_revoked_by_kill_switch` with `auth_method='auto_policy'`, no token/user actor, and metadata including `outbox_id`, optional attempt, runtime flag state, and no text.
- Enqueue normal `send_notification` regardless of any old suppression metadata.
- Preserve the publish job `correlation_id` into the `send_notification` payload when present.
- Mark the triggering `publish_response` outbox completed in the same transaction.

This applies to unposted `approved`, `edited`, and `awaiting_owner_connect` auto-policy rows. `NULL` and `owner` rows keep current publisher behavior. Owner notification copy stays normal; admin/support visibility comes from `posting_error` and the downgrade audit. Manual owner approval after downgrade must clear stale posting error and set `approval_method='owner'`.

**Accepted burst behavior.** Flipping `AUTO_APPROVAL_ENABLED=false` while many auto rows are in-flight downgrades each one (one transaction + one `send_notification` apiece), so an emergency stop can produce a notification burst. This is the safe direction — every affected reply returns to human review — and is accepted as the expected cost of the kill switch, not a bug.

## 11. Notification, Audit, Analytics, And DTOs

**Successful auto**
- No approval link.
- No `send_notification`.
- No per-review FYI notification.
- Normal publish path posts `approved_text`.
- Publish success evidence remains `responses.status='posted'`, `posted_at`, and publisher telemetry. Do not write a second approval audit row for posting.

**Manual fallback**
- Normal `send_notification` path when not held/suppressed.
- Existing channel failure behavior applies.
- No approval audit row solely for fallback.

**Approval audit for auto**

Add `insertAuditLogAutoPolicy(tx, ...)` beside the token/session helpers. It writes:
- `action='auto_approved_by_policy'`
- `auth_method='auto_policy'`
- `token_hash=NULL`
- `device_cookie_hash=NULL`
- `actor_user_id=NULL`
- `ip_address=NULL`
- `response_text_at_approval=approved_text`

Metadata should include compact resolved facts:
- `policy_source`: `location_override` or `account_default`
- optional `policy_id`
- `resolved_min_star`
- current `star_rating`
- `origin_lane`
- `response_version`
- `review_content_hash_matched: true`
- provider moderation marker
- publisher subscription allowed/reason
- active connection result
- active location result
- runtime/provider flag states
- `correlation_id`

Do not store raw review hash values, generated text, review text, full policy JSON, or extra response columns for resolved policy inputs.

Settings mutations use `account_audit_log` via `writeAccountAuditLog(input, tx)`, not `approval_audit_log`.

No new analytics events in v1. The analytics taxonomy has DB CHECK implications and is not necessary for launch. No new `api_costs` policy metadata; moderation/cost data stays as-is.

Owner/admin response DTOs should carry nullable `approval_method` wherever response rows are shaped for display: dashboard recent reviews, aggregate dashboard recent reviews, Past Replies list/cards, and admin business detail response rows. Render auto badges only where useful, and key badges on `approval_method === 'auto_policy'`, not status.

There is **no single shared response DTO** — these are four distinct per-surface shapes (recent-reviews + aggregate items in `src/lib/dashboard/types.ts`, `PastReplyCard`'s `PastReplyRow`, and `ReviewRow` in `src/lib/admin/business-detail-types.ts`), so the field must be added to each independently. The publisher's `PublishResponseContext` (§10) is a fifth, internal carrier of `approval_method`.

Admin visibility is read-only in v1:
- current account default and per-location effective policy on admin business detail
- derived runtime/provider readiness state for the environment
- recent auto approval audit decisions and kill-switch downgrade actions
- response `approval_method` badge/field

No auto-specific digest copy or scheduler behavior in v1. Future summaries can query `approval_method='auto_policy'`.

## 12. Settings API And UI

Use one combined owner route:

- `GET /api/settings/auto-approval`
- `PATCH /api/settings/auto-approval`

Owner routes derive account scope from the authenticated session. Do not accept `accountId` in body/query. For location operations, accept `locationId` and validate it belongs to the session account. Use `locationId` in API shape, not `businessId`.

`GET`:
- authenticated
- no-store/dynamic
- may be read-only under impersonation if useful
- returns account default, each active location override, effective threshold, inherited/manual/override state, and readiness block
- returns derived booleans/reasons, not raw env names or values

Readiness block:

```ts
{
  runtimeEnabled: boolean,
  providerModerationEnabled: boolean,
  providerModerationValidated: boolean,
  accountWritable: boolean,
  canExpand: boolean,
  blockReasons: Array<
    | 'auto_approval_disabled'
    | 'provider_moderation_disabled'
    | 'provider_moderation_not_validated'
    | 'subscription_not_writable'
    | 'preview_environment'
    | 'impersonation_not_allowed'
  >
}
```

Avoid exposing raw subscription status unless an existing settings API already does. UI maps stable reason codes to copy.

`PATCH`:
- owner auth
- same-origin helper (`withSameOrigin` or equivalent)
- reject active admin impersonation sessions; do not allowlist this mutation for impersonation in v1. **Net-new at the route layer:** existing `/api/settings/*` routes wire only `withSameOrigin` + `requireWritableOwner` and trust the auth session — impersonation is enforced today at the page wrapper (`src/lib/admin/impersonation/view.ts`), not in the settings API. This route must add an explicit impersonation check rather than copy an existing route-level one.
- one explicit operation enum:
  - `set_account_default`
  - `set_account_manual`
  - `clear_account_default`
  - `set_location_override`
  - `set_location_manual`
  - `delete_location_override`
- returns refreshed effective policy state and readiness block

No separate DELETE route. Deleting an override can expand by inheriting an auto account default, so it must go through the same effective-exposure calculation as every other mutation.

Policy mutation transaction:
1. `SELECT ... FOR UPDATE` the `accounts` row to serialize per account. This **must** run inside `sql.begin()`: under Supabase PgBouncer transaction pooling, a `FOR UPDATE` outside an explicit transaction drops the row lock the instant the SELECT returns (documented gotcha), so the entire mutation is one `sql.begin()` block.
2. Read before row/effective state and active inheriting locations.
3. Validate location account relationship and active location requirements for expansions/active edits.
4. Compute before exposure rank.
5. Apply mutation.
6. Read/derive after state.
7. Compute after exposure rank and expansion.
8. Enforce expansion gates/confirmation.
9. Write `account_audit_log` with `writeAccountAuditLog(input, tx)`.
10. Return refreshed state.

Exposure rank:

```ts
NULL = 0
5 = 1
4 = 2
3 = 3
2 = 4
1 = 5
```

`afterRank > beforeRank` is expansion. Compare effective before policy to effective after policy, not only the row value. Account-default writes are bulk/future-effective changes: default `NULL -> 4`, `4 -> 3`, and `NULL -> 1` are expansions even if current active inheriting-location count is zero, because future/new/reactivated locations inherit the default. Audit should record `affectedActiveLocationCount` for current active locations without overrides.

Expansion requires:
- `autoApprovalRuntimeEnabled() === true`
- `providerModerationEnabled() === true`
- `providerModerationValidated() === true`
- account writable (`active` or past-due-within-grace, matching account writability semantics)
- not preview environment
- non-impersonated owner session
- required confirmation level

Contractions/disables bypass these gates and confirmation. Cancelled, blocked, or pending-payment accounts can turn automation off or make it more conservative; they cannot expand it.

Missing required confirmation returns `400 Bad Request`:

```json
{ "error": "auto_approval_confirmation_required", "confirmationLevel": "standard" }
```

For resulting effective threshold `1`, require:

```json
{ "error": "auto_approval_confirmation_required", "confirmationLevel": "all_ratings" }
```

Operational/account readiness blocks return `409 Conflict`:

```json
{ "error": "auto_approval_expansion_blocked", "blockReasons": ["auto_approval_disabled"] }
```

Use one request field:

```ts
confirmationLevel?: 'standard' | 'all_ratings'
```

For any expansion require at least `standard`; for resulting threshold `1`, require `all_ratings`. Store submitted and required confirmation levels in `account_audit_log.payload`. Ignore confirmation fields for contractions/disables.

Audit payload should include operation, scope, old/new row values, old/new effective threshold, exposure ranks, expansion boolean, required/submitted confirmation level, readiness state, affected inheriting active location count, and active/future-default notes where relevant. Use top-level `ip`, `userAgent`, `requestId`, and `actorUserId` fields supported by `writeAccountAuditLog`; do not duplicate them in payload JSON.

UI:
- Do not hide controls when runtime is disabled; show current state and allow contractions/disables.
- Disable expansion controls with server-provided reason codes.
- No optimistic update before PATCH succeeds.
- Use semantic labels: Off/manual, 5-star only, 4-5, 3-5, 2-5, All rated.
- Copy must say responses will post to Google automatically without owner review for matching rated reviews that pass safety checks and active connection checks.
- For `1`, require stronger confirmation copy because every rated review, including negative reviews, can auto-post if all runtime gates pass.
- Server confirmation is product friction, not the primary runtime safety invariant; the runtime gates remain authoritative for whether a draft actually posts. It is nonetheless **enforced server-side in v1**, not left to client copy: validating the confirmation *level* (`standard` vs `all_ratings`) in the PATCH route is cheap defense-in-depth against an API or client bug that accidentally submits an expansion (e.g. a silent `all_ratings` jump). The runtime gates would not catch that, because it is a malformed-*intent* error, not an unsafe post. So the route rejects an expansion whose submitted confirmation level is below the required one.

## 13. Server Flags And Environments

Server-only env/config values:

- `AUTO_APPROVAL_ENABLED`
- `AUTO_APPROVAL_PROVIDER_MODERATION_READY`
- existing `OPENAI_MODERATION_ENABLED`

Each defaults false unless exactly `'true'`. Do not add `NEXT_PUBLIC_*` companions. Settings GET exposes derived booleans, not env names/values.

Helpers:

```ts
autoApprovalRuntimeEnabled()
providerModerationEnabled()
providerModerationValidated()
```

Keep helpers small and single-purpose. Runtime predicate composes them explicitly. This leaves room for future per-account rollout without touching every call site, but v1 is environment-wide only. Do not add rollout tables or percentage rollout.

Preview environments block settings expansion with reason `preview_environment` because previews are UI-only. Detect preview in the settings route with a server helper using `VERCEL_ENV === 'preview'`; local missing `VERCEL_ENV` is not preview. (No such preview-detection helper exists today — add a small `isPreviewEnvironment()` returning `process.env.VERCEL_ENV === 'preview'`.) Railway worker runtime obeys explicit flags only and has no implicit non-prod gate.

Boot should not fail when these env values are missing. Add them as recognized optional server booleans if the project has an env registry/startup assertion module. Tests should assert missing/invalid values do not enable auto.

`AUTO_APPROVAL_PROVIDER_MODERATION_READY` gates settings expansion only. Runtime uses `AUTO_APPROVAL_ENABLED`, `OPENAI_MODERATION_ENABLED`, and the per-draft clean marker. If ops wants to stop runtime auto, flip `AUTO_APPROVAL_ENABLED=false`.

## 14. Subscription Helpers — reuse what PR #221 already landed

**Do not add new subscription helpers.** PR #221 ("unify the role-auth gate family") consolidated these gates after this spec was first drafted. The auto-approval feature must reuse them, not introduce `canGenerateForAccount` / `canPublishForAccount` / `canExpandAutoApprovalPolicy` wrappers — those would be exactly the near-duplicate the project rules forbid ("never add a near-duplicate"; "reject thin wrappers").

Map each decision point to the existing symbol:

| Decision point | Reuse |
| --- | --- |
| Generator pre-gen gate (already in load context) | `checkSubscription({ workerType: 'generator', ... })` — `src/lib/shared/subscription-guard.ts` |
| Runtime auto's "would the publisher accept this?" gate at persist time (the `canPublishForAccount(...)` label in the §4 predicate) | `checkSubscription({ workerType: 'publisher', status, pastDueAt, accountFlags, now })` — same module, called with the persist-time re-read account state |
| Settings-expansion writability | `assertWritableSubscriptionForAccount(accountId, tx)` — `src/lib/shared/writable-subscription.ts`; owner routes already gate through `requireWritableOwner(request)` — `src/lib/auth/route-helpers.ts` |

`checkSubscription` is a pure function over `{ status, pastDueAt, accountFlags, workerType, now }`, so the persist-time auto predicate calls it directly with current-state reads — no wrapper needed. Reusing these symbols (rather than re-deriving status strings) is what keeps `pending_payment`, grace-period, cancelled, and future account states from drifting. The only genuinely new gate this feature adds is the auto-approval runtime/provider/confirmation logic itself (§4, §13), which **composes** the above — it never re-implements subscription semantics.

## 15. Logging

When a draft would otherwise auto but a runtime prerequisite blocks it, emit a sanitized structured log with a low-cardinality reason, such as:

- `auto_approval_disabled`
- `provider_moderation_disabled`
- `provider_moderation_error`
- `review_content_changed_before_persist`
- `publisher_subscription_denied`
- `active_zernio_connection_missing`

No review text, response text, raw hashes, tokens, or secrets. No durable approval audit for these fallback logs.

## 16. Implementation Split

Recommended PR split after provider-moderation Phase 0:

1. Schema/helper hardening: migration 055, env helpers, subscription helpers, audit helpers, typed job-outbox helpers, lane helper.
2. Runtime path behind disabled flag: origin lanes, persist predicate/current-state reads, auto branch, publisher kill-switch downgrade, manual approval attribution, tests. Runtime remains off by default.
3. Settings UI/API and admin/DTO visibility: owner route, effective exposure gates, UI, admin read-only diagnostics, static policy audit updates.

No intermediate state should allow runtime auto-posting before settings and runtime gates are in place.

**Sequencing principle (tracer bullet).** Land PR 2 (the runtime path) behind the disabled flag and let it bake end-to-end — lanes -> persist-time decision -> publisher kill-switch — before building PR 3. PR 3 (the settings exposure-rank / expansion / confirmation state machine) is the heaviest and least safety-critical surface, and is the explicit trim/defer candidate. Proving the auto-posting machinery against Google with a flag-gated runtime first keeps the riskiest change reviewable on its own, before the UI complexity stacks on top.

## 17. Test Plan

Schema/migration:
- partial unique index for account default
- partial unique index for location override
- `businesses(id, account_id)` unique target
- composite FK `(location_id, account_id) -> businesses(id, account_id)`
- nullable `location_id` permits account defaults
- RLS enabled and no authenticated table policies/grants
- `responses.approval_method` nullable with allowed-value CHECK
- `approval_audit_log.auth_method` accepts `auto_policy`
- conservative `approval_method` backfill behavior, including external posted rows staying `NULL`

Origin lanes:
- every `generate_response` producer uses the helper and exact lane
- `live_ingest_new` only eligible
- `live_ingest_update`, `backfill`, `regenerate`, unknown, and missing lane manual
- boundary parser does not strict-reject old jobs or extra keys
- targeted static audit that TypeScript producers include `origin_lane`

Persist auto success:
- current policy/star/hash/subscription/location/connection re-read inside persist
- status `approved`
- `approval_method='auto_policy'`
- `approved_text=response_text`
- `response_text_at_approval` matches approved text
- one auto approval audit row with compact metadata
- publish outbox enqueued in same transaction
- no approval link and no send notification

Manual fallback matrix:
- bad lane
- `version > 1`
- `suppress_notification=true`
- hash mismatch
- null loaded/current hash
- rating below threshold
- no policy/disabled policy
- provider disabled
- provider error
- provider flagged
- local medium/low flag
- runtime disabled
- publisher subscription denied
- no active Zernio connection
- archived location

Each non-held fallback asserts `status='pending_approval'`, `approval_method IS NULL`, normal notification behavior, and no publish outbox. Held moderation asserts no owner notification.

Settings:
- account default expansion across inheriting active locations
- account default future-effective expansion even with zero active locations
- contractions/disables allowed while runtime/provider/account readiness blocked
- location override delete can expand or contract based on effective before/after
- confirmation required for expansions
- `all_ratings` confirmation required only for expanding to effective threshold `1`
- `400` for missing confirmation
- `409` for readiness/account blocks
- account row locked and policy/audit atomic
- same-origin rejection on PATCH
- impersonated session rejected on PATCH
- no `accountId` accepted from body/query
- cross-account location rejected
- GET no-store derived state

Publisher downgrade:
- auto-policy approved row downgraded when runtime disabled before external call
- `awaiting_owner_connect` auto-policy row downgraded
- guarded zero-row update completes outbox without notification/audit
- duplicate/retry does not spam notifications
- downgrade clears `approved_text`, `approved_at`, `approval_method`
- downgrade keeps `response_text` and sets internal `posting_error`
- downgrade audit written
- send_notification enqueued regardless of old suppression metadata
- owner approval after downgrade sets `approval_method='owner'` and clears stale posting error

Manual approval attribution:
- token approve/edit
- session approve/edit
- callback approve
- Past Replies publish/retry/restore-original
- no transition to `approved`/`edited` through these paths without `approval_method='owner'`

Display/admin/KPI:
- owner/admin DTOs include nullable `approval_method`
- badges key only on `auto_policy`
- KPI status groups unchanged
- no digest copy/scheduler changes

Static/policy:
- no `NEXT_PUBLIC_AUTO_APPROVAL_*`
- no runtime policy Redis/in-memory cache
- no browser Supabase reads/writes to `auto_approval_policies`

## 18. Documentation Change Map

Apply with the implementation PR, not before:

- Update the CLAUDE.md no-auto-posting invariant (there is no AGENTS.md in this repo — `.claude/CLAUDE.md` is the only invariant file): posting requires an approval decision, either explicit owner approval or owner-configured auto policy; auto cannot bypass moderation/provider clean/runtime/publisher/connection/location gates.
- Update moderation invariant: high-severity holds override auto; auto also requires provider clean and zero flags.
- Update subscription invariant: auto uses publisher semantics at persist and publisher runtime.
- Add policy invariant: account default + location override, threshold-only, current-state persist-time decision, only `live_ingest_new`, `version=1`, no suppression, active connection, active location, no cache.
- Add/update project skill `auto-approval-policy`.
- Update `approval-security` skill so it no longer assumes every post is human-approved, while preserving token security for manual paths.

## 19. Next Step

Run the writing-plans skill against this spec to produce the implementation plan. Keep Phase 0 provider moderation validation separate, then implement in the split above. Anything touching worker, migration, webhook/publisher, or billing rides staging first, then lands on main by PR.
