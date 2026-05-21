# Entry-point modularization (Group A) — design

**Date:** 2026-05-05
**Author:** Norbert + Claude
**Scope:** Apply the new `CLAUDE.md` invariant — *"Entry points orchestrate; modules own failure behavior"* — to three Group A files: `worker/index.ts`, `src/app/api/zernio/connect/select-location/route.ts`, `src/app/api/zernio/connect/callback/route.ts`. Pure code-motion + new tests at the seams created by extraction. Group B (`EngagementAlertWorker`, `OnboardingDripWorker`) deferred to a follow-up spec.

---

## Why

A repo-wide audit (top-40 source files by line count) flagged seven Tier-1 modularization candidates. Three of them share the same anti-pattern: a single entry point — a worker boot file or a Next.js route handler — owns long inline failure branches that perform durable side effects (DB writes, Sentry alerts, Redis CAS sequences). Each branch is independently testable but currently nested several layers deep inside an entry point that has zero or thin direct test coverage.

The new `CLAUDE.md` architecture invariant makes this a hard rule: *any error-handling branch over ~30 lines must be extracted behind a named module interface with focused tests*. The three Group A files are the worst current offenders.

This spec prescribes the specific extractions, file paths, function signatures, and test additions needed to bring the three files into compliance.

---

## Architecture & conventions

**Goal.** Each entry point becomes a thin orchestrator: validate → call → map errors → return. Each long failure branch becomes a colocated module with its own test file at the seam.

**Layout convention (colocation, parallel to the recent worker reorg).**

- Worker boot extractions stay in `worker/`: e.g., `worker/sentry.ts`, `worker/jobs/zernio/ingest-failed-hook.ts`, `worker/jobs/publisher/failed-hook.ts`.
- Route extractions go in sibling library folders, one per route: `src/lib/zernio/connect-finalize/` (for `select-location`), `src/lib/zernio/connect-callback/` (for `callback`).
- The existing `src/lib/zernio/connect-state.ts` remains the canonical home for Lua scripts; one currently-inline script consolidates there.

**Dependency convention.** Extracted modules import `sql`, `Sentry`, `zernioClient`, etc. at module scope — same pattern as existing code. The Upstash cache Redis client is acquired via `getCacheRedis()` **inside the function body** to preserve the existing lazy-client pattern (the helper memoises a singleton on first call); module-scope acquisition would change client init timing. **No DI parameters introduced for testability.** Tests use `vi.mock` against the imported modules. Rationale: introducing DI here would diverge from the existing codebase pattern in service of a refactor; YAGNI and consistency win.

**Behavior preservation rule.** Refactor-only PRs. Every Sentry tag, every error message string, every log prefix, every JSON response body, every redirect URL parameter must be byte-equal before and after. Reviewers should be able to read each diff as pure code-motion + a small orchestration glue change. No "while we're here" cleanups; those go in follow-up PRs.

**Test-seam rule.** Each PR adds new unit tests **only for branches that have no direct test today**. Concretely: 7 new branch-test files plus one route-orchestration scaffold (PR #2's `route.test.ts`) — 8 new test files total across the 3 PRs, enumerated in the per-PR sections. Existing tests are not duplicated.

---

## PR #1 — `worker/index.ts` (607 lines → ~320 lines)

### Current state

- Lines 1–37: Sentry import + `scrubObject` recursive helper + `Sentry.init({...})` + `export { Sentry }`.
- Lines 41–470: BullMQ worker registry, with two inline `*.on('failed', ...)` handlers totalling ~250 lines of DB-writing failure logic:
  - `ingestZernioReviewWorker.on('failed', ...)` — lines 160–277, three `instanceof` branches (`ZernioIngestReviewNotFoundError`, `ZernioIngestPaginationCapExhaustedError`, `ZernioIngestUnparseableLocationError`) plus a generic fall-through.
  - `publisherWorker.on('failed', ...)` — lines 291–427, four branches (`ZernioReplyVerificationIndeterminateError`, `ZernioTransientError` without context, `ZernioTransientError` with context, generic), wrapped in a top-level try/catch with a last-resort handler-crash branch.
- Lines 492–607: Fastify boot, `main()`, `shutdown()`, signal handlers.

### 1A. Sentry boot → `worker/sentry.ts`

| Before | After |
|---|---|
| Lines 1–37 of `worker/index.ts`: Sentry import, `scrubObject` recursive helper, `Sentry.init({...})` call, `export { Sentry }` | New file `worker/sentry.ts` containing the same code unchanged, including `export { Sentry }`. `worker/index.ts` replaces its top-of-file `import * as Sentry from '@sentry/node'` with `import { Sentry } from './sentry';` (line 2, after `import './env';`). |

**Public surface:** `export { Sentry }`. `worker/index.ts` consumes this binding for the lifecycle breadcrumb loop at the existing `worker/index.ts:474`–`485` block (`Sentry.addBreadcrumb` calls). Making the dependency between the two files explicit prevents future contributors from re-importing `@sentry/node` directly and bypassing the configured scrubber.
**New tests:** none. The scrubber is pure and trivial; not under-tested in a meaningful way.
**Lines saved from `worker/index.ts`:** ~35.

### 1B. Ingest failed-hook → `worker/jobs/zernio/ingest-failed-hook.ts`

| Before | After |
|---|---|
| Lines 160–277 of `worker/index.ts`: the entire `ingestZernioReviewWorker.on('failed', async (job, err) => { ... })` body | New file. `worker/index.ts` becomes: `ingestZernioReviewWorker.on('failed', handleIngestFailed);` |

**Public surface:**

```ts
export async function handleIngestFailed(
  job: Job<IngestZernioReviewPayload> | undefined,
  err: unknown,
): Promise<void>;
```

**Private file-scope helpers** (one per error class, signatures byte-derived from current branch bodies):

```ts
async function handleReviewNotFound(
  err: ZernioIngestReviewNotFoundError,
  outboxId: string,
  attempt: number | undefined,
): Promise<void>;

async function handlePaginationCapExhausted(
  err: ZernioIngestPaginationCapExhaustedError,
  outboxId: string,
  attempt: number | undefined,
): Promise<void>;

async function handleUnparseableLocation(
  err: ZernioIngestUnparseableLocationError,
  outboxId: string,
  attempt: number | undefined,
): Promise<void>;
```

**New tests:** `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts`. Covers all three branches end-to-end:

- `INSERT INTO review_exceptions` payload shape (provider, provider_review_id, account/location ids, pages_walked, reviews_seen, retries_exhausted_at) and the `ON CONFLICT (business_id, type, (payload->>'provider_review_id')) WHERE status = 'open' AND review_id IS NULL DO NOTHING` idempotency.
- `markOutboxFailed` is called with the right reason string per branch (`zernio_review_not_found_after_retries`, `zernio_pagination_cap_exhausted`, `zernio_unparseable_review_name`).
- The `notify_admin_review_exception` outbox row is enqueued **only** in the unparseable branch and **only** when the exception INSERT returns a row (idempotent on duplicate).
- `Sentry.captureMessage('zernio_pagination_cap_exhausted', ...)` fires with the expected tags/extras.
- Generic fall-through: `markOutboxFailed(outboxId, errMessage, attempt)` is called.

**Lines saved from `worker/index.ts`:** ~117.

### 1C. Publisher failed-hook → `worker/jobs/publisher/failed-hook.ts`

| Before | After |
|---|---|
| Lines 291–427 of `worker/index.ts`: the entire `publisherWorker.on('failed', async (job, err) => { ... })` body | New file. `worker/index.ts` becomes: `publisherWorker.on('failed', handlePublisherFailed);` |

**Public surface:**

```ts
export async function handlePublisherFailed(
  job: Job<PublishResponsePayload> | undefined,
  err: unknown,
): Promise<void>;
```

**Private file-scope helpers:**

```ts
async function handleVerificationIndeterminate(
  err: ZernioReplyVerificationIndeterminateError,
  outboxId: string,
  attempt: number | undefined,
): Promise<void>;

async function handleTransientWithContext(
  err: PublisherTransientWithContext,
  payload: PublishResponsePayload,
  outboxId: string,
  attempt: number | undefined,
): Promise<void>;

async function handleBareTransient(
  err: ZernioTransientError,
  payload: PublishResponsePayload,
  outboxId: string,
  attempt: number | undefined,
): Promise<void>;

async function handleUnknownExhausted(
  err: unknown,
  outboxId: string,
  attempt: number | undefined,
): Promise<void>;
```

The outer try/catch (current lines 297–426), the `let outboxId` / `let outboxAttempt` accumulator, and the last-resort handler-crash branch stay in `handlePublisherFailed` — those are orchestration, not branch behavior.

**New tests:** `worker/jobs/publisher/__tests__/failed-hook.test.ts`. Covers:

- `handleVerificationIndeterminate`: the full `sql.begin` tx — `UPDATE responses` to `failed`, `INSERT INTO review_exceptions` with type `zernio_reply_verification_indeterminate` (idempotent ON CONFLICT), `INSERT INTO job_outbox` for `notify_admin_review_exception`, then `markOutboxCompleted`. Branch where `UPDATE responses` returns 0 rows (already terminal) — assert no exception/outbox INSERT runs.
- `handleBareTransient`: bare `ZernioTransientError` without `PublisherTransientWithContext` wrap. Asserts the defensive `console.error` log, `Sentry.captureException` with tags `{ worker: 'publisher', kind: 'unwrapped_transient' }`, and `markOutboxFailed(outboxId, 'unwrapped_transient_no_context: ' + reason, attempt)`. **This branch has zero coverage today.**
- `handleTransientWithContext` success: `applyTransientExhaustionFallback` called with `{ response_id, business_id, correlation_id, account_id, location_id }`, then `markOutboxFailed(outboxId, 'zernio_transient_max_attempts', attempt)`.
- `handleTransientWithContext` fallback-failed: fallback throws → `console.error` log, `Sentry.captureException` with tags `{ worker: 'publisher', kind: 'transient_exhaustion_fallback' }`, `markOutboxFailed` called with `'zernio_transient_max_attempts_fallback_failed: ' + reason`.
- `handleUnknownExhausted`: generic error → `markOutboxFailed(outboxId, errMessage, attempt)`.
- Last-resort handler-crash branch: forced throw inside the outer try → assert `console.error`, `Sentry.captureException` with tags `{ worker: 'publisher', kind: 'on_failed_handler_crash' }`, and best-effort `markOutboxFailed` call (with `'on_failed_crash: ' + reason`) — even when that itself throws.

**Lines saved from `worker/index.ts`:** ~136.

### After PR #1

`worker/index.ts` ends at ~320 lines: imports + Worker constructor calls + `workersByQueue` map + the breadcrumb loop + `main()` + `shutdown()` + signal handlers. Pure registration and lifecycle. No DB writes, no `instanceof` cascades.

**New tests this PR:** 2 files, covering ~10 branches that have zero direct test coverage today.

---

## PR #2 — `select-location/route.ts` (581 lines → ~290 lines)

### Current state

Single `POST` handler with nine numbered steps in comments. Three steps dominate:

- **Step 4–6** (lines 122–174, ~52 lines): cookie read, locations blob load, JSON.parse fallback, scope verifies (userId, businessId, locationId membership).
- **Step 8c** (lines 282–374, ~93 lines): outcome-unknown sequence — Redis CAS to `finalize_unknown` (with 7-day TTL), `INSERT INTO zernio_finalize_incidents` (idempotent on 23505), Sentry alert, controlled `throw`.
- **Step 8d–e** (lines 377–510, ~135 lines): DB tx (INSERT zernio_connections + drain outbox + backfill predicate + conditional backfill outbox) plus catch with post-accountId orphan recovery (deleteAccount + clear pending + 23505→409 mapping).

New folder: `src/lib/zernio/connect-finalize/`.

### 2A. Session validation → `src/lib/zernio/connect-finalize/validate-session.ts`

| Before | After |
|---|---|
| Lines 122–174 of route.ts: `readConnectSessionCookie`, Redis `locationsKey` GET + JSON.parse with the `connect_session_expired` fallback, scope verifies | New file. Route calls `await validateSession(req, user, locationId)` and dispatches on the result. |

**Public surface:**

```ts
export type ValidateSessionResult =
  | { ok: true; sessionId: string; stored: ConnectLocationsBlob }
  | {
      ok: false;
      status: 401 | 403 | 410 | 400;
      code:
        | 'connect_session_missing'
        | 'connect_session_expired'
        | 'user_mismatch'
        | 'business_mismatch'
        | 'invalid_location_id';
    };

export async function validateSession(
  req: NextRequest,
  user: Pick<AppUser, 'id' | 'businessId'>,
  locationId: string,
): Promise<ValidateSessionResult>;
```

The caller has already returned 403 on `!user.businessId` before calling `validateSession`, so `user.businessId` is non-null at this seam. `Pick<AppUser, 'id' | 'businessId'>` keeps the dependency surface narrow without hard-coding the field set.

The `ok: false` shape lets the caller map `status + code` to a `NextResponse.json(...)` in one line. Discriminated-union return is intentional — keeps the seam test-friendly without throwing for non-error control flow.

**New tests:** `src/lib/zernio/connect-finalize/__tests__/validate-session.test.ts`. This is a security-sensitive seam (signed-cookie read, Redis blob parse, scope checks) and deserves direct coverage. Covers:

- Missing cookie (`readConnectSessionCookie` returns null) → `{ ok: false, status: 401, code: 'connect_session_missing' }`.
- Redis returns null for `locationsKey` → `{ ok: false, status: 410, code: 'connect_session_expired' }`.
- Redis returns malformed JSON → `{ ok: false, status: 410, code: 'connect_session_expired' }` (note: same code as expired — anti-enumeration).
- Stored userId mismatch → `{ ok: false, status: 403, code: 'user_mismatch' }`.
- Stored businessId mismatch → `{ ok: false, status: 403, code: 'business_mismatch' }`.
- `locationId` not in `stored.locations` → `{ ok: false, status: 400, code: 'invalid_location_id' }`.
- Happy path → `{ ok: true, sessionId, stored }`, asserting the returned `stored` is the parsed blob.

**Lines saved:** ~52.

### 2B. Outcome-unknown sequence → `src/lib/zernio/connect-finalize/handle-outcome-unknown.ts`

| Before | After |
|---|---|
| Lines 282–374 of route.ts: the entire `// OUTCOME UNKNOWN` block | Route calls `await handleOutcomeUnknown({ ... })` inside the `else` branch of the outcome-known check. The `throw` lives inside the helper. |

**Public surface:**

```ts
export interface OutcomeUnknownArgs {
  businessId: string;
  profileId: string;
  flowId: string;
  underlyingError: unknown;
}

/** Throws ZernioRouteError(409, 'finalize_unknown_admin_required') after
 *  best-effort durable record + Redis marker bump. Never returns normally. */
export async function handleOutcomeUnknown(args: OutcomeUnknownArgs): Promise<never>;
```

**New tests:** `src/lib/zernio/connect-finalize/__tests__/handle-outcome-unknown.test.ts`. Covers:

- Redis CAS success (`'OK'`) + DB INSERT success → throws `ZernioRouteError(409, 'finalize_unknown_admin_required')`. Assert Sentry alert `zernio_finalize_unknown` fires with `incidentPersisted: true, redisMarkedUnknown: true`.
- Redis CAS returns non-OK → Sentry capture `zernio_finalize_unknown_redis_cas_failed` with the lua_result extra; still throws; alert reports `redisMarkedUnknown: false`.
- DB INSERT returns 23505 → no Sentry capture for the DB path (idempotent); still throws; alert reports `incidentPersisted: true`.
- DB INSERT returns other error code → Sentry capture `zernio_finalize_unknown_db_insert_failed`; still throws; alert reports `incidentPersisted: false`.
- Redis throws → Sentry capture `zernio_finalize_unknown_no_record` at level fatal; still throws; alert reports `redisMarkedUnknown: false`.

Today: zero coverage (no `select-location` tests at all).

**Lines saved:** ~93.

### 2C. Persist + post-accountId recovery → `src/lib/zernio/connect-finalize/persist-connection.ts`

| Before | After |
|---|---|
| Lines 377–510 of route.ts: the `sql.begin(async tx => { ... })` block + the `catch (dbErr)` orphan recovery | Route calls `await persistConnection({ ... })`. |

**Public surface:**

```ts
export interface PersistConnectionArgs {
  stored: ConnectLocationsBlob;  // includes businessId, flowId, profileId, userId
  locationId: string;
  accountId: string;
}

/** On success: connection row + drain outbox + (conditional) backfill outbox written.
 *  On 23505: best-effort orphan cleanup (deleteAccount + clear pending), then
 *    throws ZernioRouteError(409, 'already_connected_by_parallel_flow').
 *  On other DB errors: best-effort orphan cleanup, then re-throws the original. */
export async function persistConnection(args: PersistConnectionArgs): Promise<void>;
```

The new connection id is generated inside the module via `uuidv7()` and used only for the `INSERT zernio_connections` row and the `needs_backfill` predicate's `id != ${newConnectionId}` clause. No caller currently needs the value, so the surface stays narrow. If a future caller needs it (e.g., for logging), promote the return type then; YAGNI now.

The orphan-cleanup logic stays inside this module — it's the post-accountId recovery, intrinsically tied to the persist failure. Keeping them together preserves the invariant that "if persist throws, the orphan is already chased."

**New tests:** `src/lib/zernio/connect-finalize/__tests__/persist-connection.test.ts`. Covers:

- Happy path (insert + drain enqueue, backfill predicate true → backfill outbox enqueued with `subscription_tier`, `subscription_activated_at` ISO string, `correlation_id`).
- Happy path with backfill predicate false (existing connection completed backfill → no backfill enqueue).
- Happy path with `subscription_activated_at` NULL → warning logged, no backfill enqueue (defensive branch — unreachable in production but covered for regression safety).
- 23505 → `zernioClient.deleteAccount(accountId)` called (best-effort), `luaDeletePendingByFlowIdAnyStatus` called (best-effort), Sentry breadcrumb on cleanup failure, then `ZernioRouteError(409, 'already_connected_by_parallel_flow')` thrown.
- Generic DB error → orphan cleanup runs, then original error re-thrown.

Today: zero coverage.

**Lines saved:** ~135.

### 2D. Route test scaffolding (new file, no extraction)

`src/app/api/zernio/connect/select-location/__tests__/route.test.ts` — a minimal route-level integration test covering the orchestration shell after extractions are in place. Goals:

- 503 when `ZERNIO_PUBLISHING_ENABLED !== 'true'`.
- 403 on CSRF failure (orchestrator stops before cookie read).
- 401/403 on auth failure (orchestrator stops before locations load).
- 409 on finalize-lock contention (no Zernio call made).
- 200 happy path (mocks delegate to extracted modules; we assert the lock is released via `luaTokenCAS` and the cookie is cleared via `clearConnectSessionCookie`).

Not exhaustive — the extracted module tests carry the branch coverage. This file exists to lock the route's outer contract so 2A/2B/2C can be refactored further later without losing the route's observable behavior.

### After PR #2

`select-location/route.ts` ends at ~290 lines. The POST handler reads top-to-bottom: feature flag → CSRF → auth → body parse → `validateSession` → acquire finalize lock → pending CAS to finalizing → call Zernio → on outcome-known revert | on outcome-unknown call `handleOutcomeUnknown` | on success call `persistConnection` → clear pending + locations blob + cookie → 200 → release lock in `finally`. The shape of the spec's nine numbered steps is preserved in comments; the implementations of three of those steps now live one click away.

**New tests this PR:** 4 files, covering ~19 previously-uncovered branches.

---

## PR #3 — `callback/route.ts` (470 lines → ~360 lines)

### Current state

- Lines 41–154: file-level helpers (`connectTokenFromState`, `stateFromProfileId`, `cleanupOrphanedProfileBestEffort`, `cleanupMissingTokenState`). **These stay where they are** — they are already extracted.
- Lines 34–39: `luaCASDelByValue` Lua script, currently inline.
- Lines 195–261: OAuth-denial cleanup block inside the `if (oauthError) { if (stateParam) { ... } }` branch (~67 lines).
- Lines 416–463: listLocations failure cleanup block inside the outer `catch (cbErr) { ... }` (~48 lines).
- Lines 183–464: the `GET` handler itself.

New folder: `src/lib/zernio/connect-callback/`.

### 3A. OAuth-denial cleanup → `src/lib/zernio/connect-callback/oauth-denial-cleanup.ts`

| Before | After |
|---|---|
| Lines 205–261 of route.ts: the `if (stateParam) { ... }` body inside `if (oauthError)` — GETDEL state, JSON.parse stored, GET pending, parse pending, CAS-delete pending via `luaDeletePendingByFlowIdAnyStatus` if marker matches, `deleteProfile`, `del profileStateKey` | Route calls `await cleanupAfterOAuthDenial(stateParam)` inside the `if (stateParam)` guard, then redirects with `oauth_denied`. |

**Public surface:**

```ts
/** Best-effort cleanup of all owned state after the user denied OAuth on
 *  Google's side. Atomically claims connect_state (single-use), CAS-deletes
 *  the matching pending marker via luaDeletePendingByFlowIdAnyStatus (only
 *  if it still belongs to this flow), best-effort deleteProfile, drops
 *  profileStateKey. Every step is independently catch-wrapped — never throws. */
export async function cleanupAfterOAuthDenial(state: string): Promise<void>;
```

**New tests:** `src/lib/zernio/connect-callback/__tests__/oauth-denial-cleanup.test.ts`. Covers:

- State missing in Redis (GETDEL returns null) → no-op past the early-return.
- State present + matching pending (parsed pending's `state === stateParam` and `profileId === stored.profileId`) → full cleanup runs end to end: `luaDeletePendingByFlowIdAnyStatus` called, `zernioClient.deleteProfile` called, `del profileStateKey` called.
- State present + foreign pending (different state or profileId) → CAS-delete skipped; `deleteProfile` and `profileStateKey` cleanup still run.
- State present + malformed pending JSON → CAS-delete skipped; `deleteProfile` and `profileStateKey` cleanup still run.
- Malformed state JSON → no-op past parse.
- Redis error on GETDEL → caught (`console.error` reported), function returns without throwing.
- `zernioClient.deleteProfile` error → caught (`console.error` reported), function returns without throwing.

Today: zero coverage.

**Lines saved:** ~57.

### 3B. listLocations failure cleanup → `src/lib/zernio/connect-callback/post-list-failure-cleanup.ts`

| Before | After |
|---|---|
| Lines 416–463 of route.ts: the `catch (cbErr) { ... }` block of the listLocations try | Route calls `await cleanupAfterListLocationsFailure({ stored, state })` then redirects with `zernio_listlocations_failed`. |

**Public surface:**

```ts
export interface PostListFailureArgs {
  state: string;
  stored: ConnectStateBlob;  // includes profileId, businessId
}

/** Best-effort cleanup after listLocations failed mid-flow. CAS-deletes the
 *  pending marker only if it's still byte-equal to the value we already
 *  validated (a parallel "cancel & restart" could have overwritten it; we
 *  must not orphan that newer flow). Always best-effort deletes the Zernio
 *  profile (created for this flow in /start). Never throws. */
export async function cleanupAfterListLocationsFailure(args: PostListFailureArgs): Promise<void>;
```

**New tests:** `src/lib/zernio/connect-callback/__tests__/post-list-failure-cleanup.test.ts`. Covers:

- Marker still byte-equal (parsed pending's `state === args.state` and `profileId === args.stored.profileId`) → `luaCASDelByValue` evaluation fires; `deleteProfile` called.
- Marker overwritten by parallel flow (different bytes) → CAS-delete skipped; `deleteProfile` still called.
- Marker missing (`pending_get` returns null) → no CAS attempt; `deleteProfile` still called.
- Malformed pending JSON → CAS-delete skipped; `deleteProfile` still called; no throw.
- Redis error on `pending_get` → caught; `deleteProfile` still attempted.
- Lua eval error → caught (`.catch(() => {})`); `deleteProfile` still attempted.

Today: zero coverage for these specific failure-mode branches.

**Lines saved:** ~48.

### 3C. Lua script consolidation → `src/lib/zernio/connect-state.ts`

`luaCASDelByValue` (currently inline at lines 34–39 of route.ts) moves to the existing `connect-state.ts` module that already houses every other Lua script for the connect flow (`luaCASToFinalizing`, `luaCASRevertToOauth`, `luaCASToFinalizeUnknown`, `luaDeletePendingByFlowIdAnyStatus`, `luaTokenCAS`). One canonical home for these scripts. `post-list-failure-cleanup.ts` imports it from there.

Pure code-motion, no test impact.

**Lines saved:** ~6.

### After PR #3

`callback/route.ts` ends at ~360 lines. Note this is still over 300 — and that's intentional. The remaining body of the `GET` handler is the actual orchestration: feature flag, parse query params, OAuth-denied dispatch, atomic state claim, pending verification, re-auth, Zernio listLocations call, round-11 second pending re-check, blob stash + cookie + redirect. Each of those steps is genuinely a separate orchestration concern; no single one is over the 30-line threshold the architecture invariant flags. Trying to compress further would create shallow modules and hurt locality, exactly the failure mode this spec exists to prevent.

**New tests this PR:** 2 files, covering ~12 previously-uncovered cleanup-branch scenarios.

---

## Sequencing & merge gates

PRs ship in strict order: **#1 → #2 → #3**. Each PR must be merged to `main` before the next branches off, so each builds on the previous PR's code.

| PR | Branch name | Depends on | Why this order |
|---|---|---|---|
| #1 `worker/index.ts` | `refactor/worker-index-failure-extraction` | `main` | No user traffic touches this code path. Lowest blast radius. Validates the extraction conventions before they touch production routes. |
| #2 `select-location/route.ts` | `refactor/select-location-extraction` | PR #1 merged | Production-hot but well-bounded. Convention is now proven. |
| #3 `callback/route.ts` | `refactor/callback-extraction` | PR #2 merged | Production-hot, OAuth-critical. Goes last so any convention learnings from #2 land first. |

---

## Rollback plan

Each PR is **pure code motion + 2–4 new test files + a small orchestration glue change**. Rollback is `git revert <PR-merge-sha>`. Because the extracted modules are imported from one entry point each, revert is mechanical and complete. No data migration, no env var changes, no dual-write windows.

If a regression slips past tests:

- **PR #1 regression** surfaces in BullMQ failed-hook events — visible in Sentry breadcrumbs (the breadcrumb wiring at `worker/index.ts:475-485` stays in place).
- **PR #2 regression** surfaces in the Zernio connect funnel — visible in the existing `zernio_finalize_incidents` table and in the `zernio_finalize_unknown` Sentry alerts that the extracted module preserves byte-equal.
- **PR #3 regression** surfaces in the OAuth callback funnel — visible via 302 redirects to `/dashboard/connect?error=...` and orphaned `zernio_profiles` (a manual reconciliation pattern ops already runs).

---

## Per-PR success criteria

A PR is mergeable when:

1. **Behavior preservation.** Every Sentry tag, error message string, log prefix, JSON response body, and redirect URL parameter is byte-equal pre/post. Reviewer can read each diff as code-motion + a thin glue change.
2. **Line-count target hit** — expected post-refactor sizes: `worker/index.ts` ~320 lines, `select-location/route.ts` ~290 lines, `callback/route.ts` ~360 lines. Hard target: each file ≤ 380 lines after its PR. Missing the target reopens this spec rather than silently widening the band.
3. **New test files exist and pass** — the eight new test files listed in the per-PR sections. Each new test asserts the DB writes / Sentry payloads / outbox enqueues that the extracted branch performs.
4. **No new dependencies.** No new packages added; no DI scaffolding introduced.
5. **Existing tests still pass.** `pnpm test` and `pnpm lint` clean.
6. **Worker boot smoke test** (PR #1 only) — confirm all background loops + workers start from new paths. Same smoke test the worker reorg used yesterday (start `pnpm worker`, assert all 10 background loops + 16 BullMQ workers initialize, send SIGTERM, assert clean shutdown).
7. **CLAUDE.md invariant check.** Reviewer confirms no extracted module owns inline durable side effects in branches > 30 lines (the recursion guard).

---

## Total scope

**8 new source files**

| PR | File |
|---|---|
| #1 | `worker/sentry.ts` |
| #1 | `worker/jobs/zernio/ingest-failed-hook.ts` |
| #1 | `worker/jobs/publisher/failed-hook.ts` |
| #2 | `src/lib/zernio/connect-finalize/validate-session.ts` |
| #2 | `src/lib/zernio/connect-finalize/handle-outcome-unknown.ts` |
| #2 | `src/lib/zernio/connect-finalize/persist-connection.ts` |
| #3 | `src/lib/zernio/connect-callback/oauth-denial-cleanup.ts` |
| #3 | `src/lib/zernio/connect-callback/post-list-failure-cleanup.ts` |

**8 new test files** (7 branch tests + 1 route-orchestration scaffold)

| PR | File | Kind |
|---|---|---|
| #1 | `worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts` | branch |
| #1 | `worker/jobs/publisher/__tests__/failed-hook.test.ts` | branch |
| #2 | `src/lib/zernio/connect-finalize/__tests__/validate-session.test.ts` | branch |
| #2 | `src/lib/zernio/connect-finalize/__tests__/handle-outcome-unknown.test.ts` | branch |
| #2 | `src/lib/zernio/connect-finalize/__tests__/persist-connection.test.ts` | branch |
| #2 | `src/app/api/zernio/connect/select-location/__tests__/route.test.ts` | route scaffold |
| #3 | `src/lib/zernio/connect-callback/__tests__/oauth-denial-cleanup.test.ts` | branch |
| #3 | `src/lib/zernio/connect-callback/__tests__/post-list-failure-cleanup.test.ts` | branch |

**4 modified files**

- `worker/index.ts`
- `src/app/api/zernio/connect/select-location/route.ts`
- `src/app/api/zernio/connect/callback/route.ts`
- `src/lib/zernio/connect-state.ts` (absorbs `luaCASDelByValue`)

**Estimated diff:** ~920 lines moved, ~600 lines of new test code, net source-line delta near zero.

---

## Explicitly NOT in scope

Deferred by either an earlier user decision in this brainstorming session, or by YAGNI:

- **Group B** (`EngagementAlertWorker`, `OnboardingDripWorker`) — separate spec after Group A's interfaces shake out. The two workers have natural per-stage seams (`handleOwnerNudge`/`handlePartnerAlert`/`handleSatisfactionAlert` and `buildDay1`/`buildDay7`/`buildDay30`) but the right shape depends on what each stage actually shares. Splitting them in this spec risked the parameter-bag anti-pattern.
- **Tier 2** modularization (`ResponsePublisherWorker`, `publisher-error-handlers.ts`, `admin-onboarding-service.ts`, `zernio/client.ts`, `responses/generator.ts`, `business-detail-service.ts`, marketing pages) — visit when next touching each file.
- **Internal renames or variable cleanups** inside extracted blocks. Pure code-motion only.
- **DI refactors** for testability. Module-level imports remain the convention.
- **Observability changes.** Same Sentry tags, same log lines, same metrics.
- **Documentation updates** beyond the directory map in `docs/directory.md`. CLAUDE.md already carries the architecture invariant.
