# Issue 765 Mechanical Debt Bundle — Implementation Plan

**Goal:** Preserve all current Reply, Review import, tenant-isolation, polling,
compliance, and dashboard-cache behavior while giving the repeated rules named
in issue 765 one authoritative owner.

**Fixed merge base:** `795bb5cb2c2da131a4800fb25138ad3d4b4b8b93`

**Intake:** `docs/superpowers/plans/codex-765-mechanical-debt-intake.json`

**Source decisions:** GitHub issue 765 and
`docs/reviews/PATHFINDER-2026-08-10/03-unified-proposal.md` P3-P4. P4's
DO-NOT-UNIFY register is binding.

## Classification and scope reconciliation

- Size: `standard`. The 12 issue bullets are implemented as seven cohesive
  tracer bullets, and the result is expected to be net-negative or roughly
  churn-neutral.
- Risk: `high`. The edit touches whole-query tenant proofing, PHI screening,
  response-version allocation, and outbox-state classification.
- Surface: `mixed`; DB-touching without schema change.
- Main moved after the 2026-08-10 report. The consumer-less KPI service was
  deleted by #757, so `withTtlCache` now replaces two live cache blocks, not
  four. The two surviving callers still establish a real seam.
- #764 already replaced the one hand-spelled JavaScript in-flight array in
  past-replies draft-status. Issue 765 still owns the three-way
  `classifyOutboxStatus` consolidation and the explicit no-store response
  policy.
- Plan-skeptic round 1 found two source surfaces omitted by the architecture
  report: the tenant-scope allowlist entries owned by the moved version query,
  and the Reviews-list edit route plus its alternate `ReviewActions` editor.
  The user approved the first intake amendment on 2026-08-13; all live
  reply-length consumers and the audit table are now in scope.
- Plan-skeptic round 2 found a duplicate `pnpm build` verification command.
  The intake now leaves the single required build to `verify-gate.sh`, avoiding
  concurrent writes to `.next`; this changes verification scheduling only.

No other issue item is moot on the fixed merge base.

## Module design

Each new module has multiple named callers. There are no strategy interfaces,
registries, adapters, or test-only dependency ports.

| Module/interface | Ownership and callers |
|---|---|
| `mapConcurrencyError(error)` in `edit-reply-errors.ts` | Owns only the `ReviewChangedError` / `ResponseChangedError` to 409 mapping. POST draft, PATCH draft, and publish retain their own transaction order and compose it. |
| `resolveEditReplyRequest(...)` in `edit-reply-request.ts` | Owns feature gate → same-origin → owner scope → response-id validation. PATCH and DELETE compose it directly; `resolveEditReplyContext` composes it before authorization/audit for retry and restore. It does not merge the routes' different body, authorization, or transaction behavior. |
| `MAX_REPLY_LENGTH` in `src/lib/responses/limits.ts` | One 2000-character contract imported by all three Zod schemas and all three client editors. |
| `pendingGenerateExists(db, reviewId)` and `nextResponseVersion(db, reviewId)` in `src/lib/responses/generation-state.ts` | One owner for the generate-response in-flight predicate and per-review monotonic version query. The globally unique `review_id` is the key; the two drifted `business_id` clauses disappear. All callers already prove/lock the review before allocation. |
| `proveReviewOwnership(db, reviewId, accountId)` in `src/lib/responses/review-ownership.ts` | Whole-query tenant proof for Generate and its account-scoped poll route. The query keeps direct top-level review, account, and `archived_at IS NULL` predicates so `ci:tenant-scope` can audit it. Cookie-location tenancy remains separate. |
| `classifyOutboxStatus(status)` in `job-outbox-status.ts` | Pure three-way result: `in_flight`, `completed`, or `terminal`. Callers retain their different completed/terminal mappings. |
| `readJsonSafe<T>`, `REPLY_POLL_INTERVAL_MS`, `REPLY_POLL_TIMEOUT_MS` in `client-helpers.ts` | Shared browser-safe parsing/timing facts only. The two poll loops stay separate. |
| Private `postJson` / `runAction` inside `useEditReplyDraft.ts` | Removes repeated fetch/state scaffolding without publishing a new module interface. Success validators and messages remain action-owned. |
| `screenPhiOrOpenException(...)` in `zernio-ingest-shared.ts` | Owns the repeated likely-PHI screen → warning → transactional deduped exception path used by webhook ingest and Review import. Externally answered reviews continue to bypass this gate and reconcile. |
| Private `junctionReachedSql(db)` / `initialRunJoinSql(db)` in `import-consent.ts` | Own only shared non-tenant predicate fragments (`subscription_activated_at`, active connection, initial run). Every caller keeps `business_id` / `account_id` binds and FROM/JOIN structure visible in its own query. `import-offer-view.ts` imports the initial-run fragment. |
| `withTtlCache(key, ttl, compute, source)` in `redis-cache.ts` | Owns JSON hit parsing, fresh compute, `EX` write, and fail-open read/write behavior while the required caller-owned source preserves `[dashboard/service]` versus `[dashboard/aggregate]` failure attribution. Compute errors still propagate; rejected computations are never cached. |

## Binding exclusions

Do not consolidate or normalize any of the following:

- businesses row-lock preambles or their transaction ownership;
- Zernio pagination loops or stop conditions;
- Import-offer banner polling with either row-level draft poller;
- account-scoped Generate tenancy with cookie-location past-replies tenancy;
- completed-outbox behavior across import offer and the two draft-status routes;
- the four held-draft non-consumer categories;
- unsubscribe transaction wrappers;
- PgBouncer JSONB parsing outside the existing allowlist;
- response-status SQL literals used for partial-index inference;
- existing log source tags, HTTP payload vocabulary, poll timing, or user copy.

## Tracer 1 — edit-reply request and concurrency seams

**Observable behavior:** All past-replies mutations return the same feature,
CSRF, auth, parameter, tenant, tier, optimistic-concurrency, and HTTP outcomes.

**Public test seam:** route handlers plus `mapConcurrencyError` and
`resolveEditReplyRequest`.

**Characterization/tests:**

- `mapConcurrencyError preserves review_changed details and maps response_changed to 409.`
- `resolveEditReplyRequest preserves feature, same-origin, owner-scope, parameter, and authorization ordering.`
- Existing `draft.test.ts`, `draft-id.test.ts`, and `publish.test.ts` remain the
  route-level contract, including wrong-origin, cross-location, review-changed,
  and response-changed cases.

**Implementation:**

1. Add characterization tests at the shared interfaces.
2. Add `mapConcurrencyError`; replace only the three byte-identical ladders.
3. Split the request half of `resolveEditReplyContext`; compose it from PATCH,
   DELETE, retry, and restore without moving JSON parsing, authorization, or DB
   writes across their current order.
4. Add/import `MAX_REPLY_LENGTH` in all three server schemas (`past-replies`
   POST/PATCH plus Reviews-list edit) and all three client editors
   (`ManualEditor`, `InlineGeneratePanel`, and `ReviewActions`). Extend the
   existing actions and component tests without changing trim semantics.

**Blocking edges:** none. This establishes the route-helper precedent first.

**Completion evidence:** focused shared-helper tests and the three existing
route suites green.

## Tracer 2 — response generation state and tenant proof

**Observable behavior:** Concurrent Generate requests, discarded drafts,
content-change regeneration, imported replies, and restore-original keep the
same conflict and monotonically increasing version outcomes; foreign or
archived reviews remain invisible.

**Public test seam:** injected-SQL helper functions, `onDemandGenerateTx`,
Generate route, and account-scoped draft-status route.

**Characterization/tests:**

- `generation-state helpers detect only in-flight generate_response rows and allocate MAX(version)+1 for the review.`
- `proveReviewOwnership returns a business only for a review in an active location owned by the requesting account.`
- Existing on-demand, process-review, zernio-ingest, draft, restore-original,
  Generate route, and Generate-version integration tests retain their current
  results.

**Implementation:**

1. Add failing helper tests, then implement `generation-state.ts` and
   `review-ownership.ts` with explicit SQL executors.
2. Replace both pending-generate queries.
3. Replace all five `MAX(version)+1` spellings. Callers that embed the MAX in an
   INSERT first call `nextResponseVersion` while holding their existing review
   lock, then bind the returned number.
4. Replace the four old exact-match tenant-scope allowlist entries for the
   version queries with one reviewed `generation-state.ts` entry and lower
   `ALLOWLIST_BASELINE` by the verified net shrink. Do not add an audit escape
   hatch; the helper entry documents why globally unique `review_id` is the
   ownership key after callers have already proved/locked the review.
5. Replace the two byte-identical account-ownership queries with the whole-query
   helper. Generate uses `sql`; draft-status uses `sqlRead`.
6. Do not apply the ownership helper to cookie-location routes or other query
   variants.

**Blocking edges:** Tracer 1 only for stable route-helper precedent; no file
overlap otherwise.

**Completion evidence:** helper suites, route suites, generation integration
test, `pnpm ci:tenant-scope`, and `pnpm ci:rls-audit` green.

## Tracer 3 — outbox trichotomy and no-store policy

**Observable behavior:** Pending/dispatching/dispatched still mean active work;
completed behavior remains surface-specific; every other status remains
terminal. Past-replies draft polling is explicitly non-cacheable.

**Public test seam:** `classifyOutboxStatus` and both draft-status HTTP handlers.

**Characterization/tests:**

- `classifyOutboxStatus maps every canonical in-flight status, completed, and every other terminal status.`
- `past-replies draft-status responses carry NO_STORE_HEADERS on success and failure paths.`
- Existing moderation-held and tenant-refusal tests remain unchanged.

**Implementation:**

1. Add the pure classifier beside `OUTBOX_IN_FLIGHT_STATUSES`.
2. Use it in import-offer-view and both draft-status routes only for the common
   trichotomy; retain each caller's completed branch.
3. Add `NO_STORE_HEADERS` to every past-replies draft-status response, including
   preflight and catch paths. Do not otherwise normalize headers on sibling
   routes.

**Blocking edges:** Tracer 2 lands ownership first because one draft-status file
is shared.

**Completion evidence:** classifier, import-offer integration, and both
draft-status suites green.

## Tracer 4 — client parsing, timing, and action scaffolding

**Observable behavior:** Both Reply pollers retain 1500ms cadence, 60-second
budget, invalid-JSON handling, cancellation behavior, and all action state
transitions. Textareas retain the 2000-character cap.

**Public test seam:** `useEditReplyDraft` and `useInlineGenerate` via renderHook,
plus their rendered editor components.

**Characterization/tests:** Existing hook suites already exercise each fetch,
timeout, cancellation, success, and error branch. Add only the shared-limit
assertion promised by the intake across all three editors and edit routes; do
not test private `postJson` or `runAction`.

**Implementation:**

1. Add `client-helpers.ts` and replace the two parser/constant copies.
2. Introduce private `postJson` and `runAction` inside `useEditReplyDraft`.
3. Migrate one action at a time, running the hook suite after each coherent
   group. Keep best-effort DELETE behavior and distinct success validators.
4. Do not merge the poll effects or change their different state ownership.

**Blocking edges:** Tracer 1 supplies `MAX_REPLY_LENGTH`; otherwise independent.

**Completion evidence:** both hook suites and editor component suites green;
React Doctor runs after all React edits.

## Tracer 5 — PHI screening compliance path

**Observable behavior:** Unanswered likely-PHI reviews are still skipped and
open one deduplicated operator exception; answered reviews still reconcile;
duplicate exceptions still do not re-notify.

**Public test seam:** `screenPhiOrOpenException` and the two worker entry points.

**Characterization/tests:**

- `screenPhiOrOpenException opens a deduplicated exception and blocks only likely-PHI reviews.`
- Existing worker tests `marks outbox completed and skips processing when target review likely contains PHI`, `counts PHI and malformed reviews as skipped and already-ingested rows as imported`, and `routes answered PHI reviews through reconciliation and counts them imported` stay green.

**Implementation:** Extract only the duplicated screen/open/warn block. Reuse
`openPhiReviewException`; keep external-reply reconciliation and the internal
in-transaction `phiGateAndImportExternalReply` separate because their
transaction ownership differs.

**Blocking edges:** none.

**Completion evidence:** shared Zernio helper plus ingest and backfill worker
suites green.

## Tracer 6 — Import consent SQL fragments

**Observable behavior:** Import offers and initial imports still require the
same junction, tenant, archive, consent, and completed-initial-run facts;
reactivation runs remain invisible to the one-time Import offer.

**Public test seam:** `createImportOffer`, `enqueueInitialImport`, and
`readImportOfferView`, including their live-Postgres integration tests.

**Characterization/test:**

- `createImportOffer and enqueueInitialImport compose the shared junction and initial-run SQL predicates.`

**Implementation:**

1. Add private lazy Postgres.js fragments for only the shared non-tenant
   conditions.
2. Compose them in the two import-consent queries and import the initial-run
   fragment in import-offer-view.
3. Keep every ID bind, table introduction, lock, and transaction in the caller.
4. Run tenant-scope immediately; if the audit cannot see a required predicate,
   reject the fragment shape rather than adding an allowlist entry.

**Blocking edges:** Tracer 3 first because import-offer-view is shared.

**Completion evidence:** import-consent and import-offer integration suites,
lock-order source test, tenant-scope, and RLS audit green.

## Tracer 7 — fail-open TTL cache

**Observable behavior:** Location and aggregate dashboard cache hits bypass
compute, misses compute and cache for 45 seconds, Redis failures serve fresh
data with their existing path-specific log prefixes, and compute failures
propagate uncached.

**Public test seam:** `withTtlCache`, `getActiveDashboardData`, and
`getAggregateDashboardData`.

**Characterization/tests:**

- `withTtlCache preserves hit, miss, read-failure, write-failure, and compute-failure behavior.`
- Existing service cache and aggregate-service suites retain exact keys, TTL,
  JSON round-trip, degraded payload, and BusinessNotFoundError behavior.

**Implementation:**

1. Add the generic helper in `redis-cache.ts` and test it with the existing
   mocked Redis interface.
2. Replace the two remaining dashboard cache blocks.
3. Require the caller's existing log source and characterize
   `[dashboard/service]` versus `[dashboard/aggregate]` for both read and write
   failures.
4. Keep key builders and 45-second constants domain-local; the helper owns
   mechanism, not key, attribution, or freshness policy.

**Blocking edges:** none.

**Completion evidence:** helper and both dashboard cache suites green.

## Execution order and anti-thrash

1. Tracer 1 establishes route-helper and shared-limit precedent.
2. Tracer 2, then Tracer 3 (shared draft-status surface).
3. Tracer 4.
4. Tracer 5.
5. Tracer 6 (after Tracer 3's import-offer edit).
6. Tracer 7.
7. Run focused suites, React Doctor, tenant/RLS audits, then the verified gate.

Root Codex owns all edits. No implementation delegation is planned because the
two most tempting parallel groups share import-offer and route test files, and
the net benefit does not justify edit-lease coordination. Independent judgment
is used for the required plan skeptic and final reviews only.

After the same failure class twice, stop patching and invoke the
`diagnosing-bugs` discipline. Stop and re-plan if production/test churn exceeds
twice the intake estimate, a second surface amendment is needed, or a deviation
invalidates a locked behavior.

## Verification

Focused verification commands come from the intake. Before review, run:

```bash
bash .agents/skills/feature/scripts/verified-gate.sh --review
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
```

The repository gate includes the required build. Because DB query text changes,
`pnpm ci:tenant-scope` and `pnpm ci:rls-audit` run explicitly before the wrapper.
No migration or remote operation is permitted.

## Review axes

After the review gate is green, dispatch independent read-only reviews from the
fixed merge base:

1. spec/correctness;
2. standards/maintainability;
3. combined security/authorization + database/tenancy + async/operations risk
   review, limited to the intake's three risk reasons.

The root reproduces every finding, records `ACCEPT` or `REJECT`, applies only
accepted fixes, reruns the verified gate after edits, and transitions to
`reviewed` only with a fresh fingerprint.

## Rollback and observability

Rollback is a revert of the issue-765 refactor. There is no schema, data,
dependency, flag, or external-contract rollback. Existing HTTP bodies,
`reportCaughtError` sources, worker warning/Sentry events, PHI exception rows,
outbox state, and cache behavior tests remain the signals for drift.
