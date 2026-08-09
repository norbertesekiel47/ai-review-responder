# Spec & correctness review — feat-729-generate-domain-module

Reviewer: spec & correctness agent · Date: 2026-08-09
Scope: `git diff main...HEAD`, code files only (docs/superpowers + docs/reviews skimmed
for context, not reviewed as prose).

Inputs read verbatim: `.feature/intake.json`, plan
`docs/superpowers/plans/feat-729-generate-domain-module.md` (locked sections),
`docs/superpowers/plans/feat-729-generate-domain-module-deviations.md`,
`docs/reviews/feat-729-generate-domain-module/blast-radius.md`, old route
(`git show main:src/app/api/dashboard/reviews/[reviewId]/generate/route.ts`), and every
changed code file.

Changed code files (5):

- `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts` (slimmed to composition root)
- `src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts` (D3 mock plumbing only)
- `src/lib/reviews/on-demand-generate.ts` (new module)
- `src/lib/reviews/__tests__/on-demand-generate.test.ts` (new T1 suite)
- `src/lib/shared/response-status-sql.ts` (A1 one-line parameter widening)
- `scripts/ci/tenant-scope-allowlist.ts` (T3: 3 entries deleted, baseline 412 → 409)

## 1. Old route vs new module — line-by-line delta audit

Method: side-by-side of the old tx body against `onDemandGenerateTx` +
the new route's mapping. Every statement accounted for. Exactly the four declared
deltas were found; **no undeclared semantic delta**.

| Old tx statement | New location | Delta? |
|---|---|---|
| `SELECT id FROM reviews … FOR UPDATE` (id + business_id) | module L51-55, first statement | none (whitespace only) |
| in-tx 404 `NextResponse` | union `review_not_found` → route 404, **no NO_STORE** | declared (4); bytes preserved |
| `assertWritableSubscriptionForBusiness(businessId, tx)` | module L67 | none |
| writable refusal → `{error}`, `writable.status`, NO_STORE | union `not_writable {status: 402\|403, error}` → route mapping keeps NO_STORE | declared (4); helper's refusal type is exactly `{ status: 402 \| 403; error: string }` (`writable-subscription.ts`), so the union's narrowing is lossless |
| posted read (`review_id` + `status='posted'`) | module L79-85 | declared (1): `AND business_id = ${businessId}::uuid` added |
| non-terminal read (`statusArraySql(sql, …)`, `ORDER BY version DESC LIMIT 1`) | module L90-96 | declared (1) + (3): gains business_id; fragment now built on `tx` |
| orphan read (already business-scoped, `posting_error LIKE prefix%`) | module L118-125 | none (comment updated only) |
| `job_outbox` in-flight read | module L130-136 | none — literal `('pending', 'dispatching', 'dispatched')` byte-for-byte, members AND order; `aggregate_id = ${reviewId}` uncast, as before; `ci:outbox-status` green |
| `COALESCE(MAX(version), 0) + 1` | module L144-149 | declared (1): gains business_id; `?? 1` fallback preserved |
| `uuidv7()` + `enqueueGenerateResponse(tx, {outboxId, reviewId, businessId, version, originLane: ON_DEMAND_GENERATE, suppressNotification: true})` | module L152-160 | none — payload field-for-field identical; helper (not raw INSERT) preserved, same tx (invariant #2) |
| `on_demand_generate_enqueued` log inside tx | route L124-130, after `sql.begin` resolves | declared (2): post-commit; same logger prefix `[OnDemandGenerate]`, same 5 fields in same order |
| 200 `{ outbox_id, version }` | route L132-135 | none — no NO_STORE, as before |
| `catch` → `reportCaughtError('reviews/generate', err, {accountId, businessId, reviewId})` + 500 NO_STORE | route L136-142 | none |

Pre-tx section (route): auth → C3 rate limit → `await params` → ownership proof SQL →
pre-tx 404 (WITH NO_STORE) → `assertWritableSubscriptionForAccount` (WITH NO_STORE) →
budget peek → `sql.begin`. Order and bytes identical to main, including the rate limit
firing before `await params`.

**Commit/rollback semantics per early return**: unchanged. In the old code the tx
callback resolved a `NextResponse` on every guard refusal, so `sql.begin` committed
(a read-only no-op commit) on every non-throw path and rolled back only on throw. The
new callback resolves a union value on every guard refusal — same commit-on-resolve,
rollback-on-throw behavior. A throw inside the module (e.g. from
`enqueueGenerateResponse`) still rolls back and lands in the route's `catch` → 500.
The only ordering shift is the declared log-line move: a (practically impossible)
throw in the logger would now happen post-commit rather than rolling the tx back —
this is the declared delta (2), recorded in the intake's observability field.

**Error strings**: `review_not_found`, `already_answered`, `draft_already_exists`,
`orphan_recovery_pending`, `regenerate_in_progress`, `internal_error` — all preserved
verbatim. **Status codes**: 404/402-403-passthrough/409×4/200/500 — preserved.
**NO_STORE asymmetry**: preserved exactly per the locked route mapping table
(pre-tx 404 WITH, in-tx 404 WITHOUT, both writable refusals WITH, 409s and 200
WITHOUT, 500 WITH). The route even carries a comment pinning the in-tx-404
asymmetry as deliberate.

## 2. Intake contract, field by field

| Intake field | Verdict | Evidence |
|---|---|---|
| goal | MET | tx body extracted to `src/lib/reviews/on-demand-generate.ts`; route is composition root |
| non_goals: no Generate-specific auto-approval guard | MET | module adds no lane/approval predicate; only the existing pinned enqueue |
| non_goals: no stale-content-race fix | MET | no freshness code; ADR 0017 commit is docs-only |
| non_goals: no regenerate / past-replies changes | MET | only shared-file change is the type-only A1 widening; all 4 sibling importers pass `sql` (assignable to the union), zero behavior change |
| non_goals: no schema/migration/flag | MET | diff contains none |
| non_goals: HTTP contract byte-for-byte | MET | §1 above |
| user_visible_behavior: none | MET | §1 above |
| invariant #2 | MET | enqueue via helper on the same tx as the FOR UPDATE lock, final statement (test title 8 asserts it) |
| invariant #3 | MET | `originLane: ON_DEMAND_GENERATE` + `suppressNotification: true` both present; the full #678 do-not-delete comment block moved intact to the module header (L12-20) |
| invariant #12 | MET | route: parse/auth/rate-limit/ownership/pre-checks/`sql.begin`/mapping only — no guard logic remains in it |
| invariant #15 | MET | module imports only `type { TransactionSql }` from `postgres` and never `@/lib/db/server`; `pnpm ci:db-imports` strict passes |
| invariant #8 (3 reads gain business_id; allowlist 412→409) | MET | posted/non-terminal/MAX(version) all scoped; exactly 3 entries deleted; `ALLOWLIST_BASELINE = 409`; `pnpm ci:tenant-scope` → `entries: 409 (baseline: 409)`. Note: the tenant-scope audit's `SCANNED_ROOTS = ['src', 'worker']`, so the moved queries in `src/lib/reviews/` remain in audit scope — the "no new entries needed" proof is real, not vacuous |
| TOCTOU re-assert inside locked tx | MET | module L67, after the lock, before any sibling read (test title 2 asserts lock-first + same tx instance) |
| edge_cases (7) | MET | each maps to a union variant + route mapping identical to old behavior; version allocation is MAX-derived over all sibling rows — but see appendix A2 for the business_id scoping nuance, which is the declared delta (1), not a new one |
| existing_patterns_to_follow | MET | typed result union (writable-subscription shape); module sits beside `process-review.ts` / `import-consent.ts`; both characterization suites green (route.test.ts D3-only edit; integration suite untouched — `git diff` empty for it) |
| allowed_edit_surface | MET | all 10 changed files within surface (`pnpm ci:feature-surface` passes; CONTEXT.md allowed-but-unchanged is fine — nothing mandated an edit) |
| tests_to_add (9) | MET | §4 below — all 9 titles verbatim, each asserts its claim |
| verification_commands | MET | `vitest run generate-version.integration` → 1 passed (the suite's single `it`, live DB awake) |
| estimated lines / dependencies_added: [] | MET | no new deps in diff |
| rollback_plan | MET | no migration/flag/data-shape change in diff |
| observability (log moved post-commit; Sentry path) | MET | §1 rows for both |
| open_questions: [] | n/a | — |

## 3. Deviations file — each ACCEPTed entry actually implemented

- **D1** (merge order with feat-719): mirror entry exists —
  `RepWorth-worktrees/feat-719-drip-dropped-column/docs/superpowers/plans/feat-719-drip-dropped-column-deviations.md`
  D14 records "#729 lands first", the 412→409 move, and "must NOT open its PR ahead of #729". Implemented as described.
- **D2** (dual-spelling surface): `.feature/intake.json` `allowed_edit_surface` carries BOTH
  `src/app/api/dashboard/reviews/\[reviewId\]/generate/**` (bash hook) and the unescaped
  spelling (TS audit); both intake copies byte-identical (`diff` clean);
  `pnpm ci:feature-surface` passes with the route files changed — proving the audit-side
  spelling matches. Implemented as described.
- **A1** (widen `statusArraySql`): exactly one line —
  `db: postgres.Sql | postgres.TransactionSql` — same union shape as `SubscriptionSql`
  in `writable-subscription.ts` (the named precedent). `pnpm typecheck` clean, its unit
  suite passes, and all 4 pre-existing callers pass `sql` (assignable). Implemented as described.
- **D3** (route.test.ts txMock fragment pass-through): the only edit to the suite is the
  `strings.join('?') === '?::text[]'` fragment-recognition branch returning without
  consuming the rowset queue — mock plumbing exactly as described; zero assertion
  changes (full diff inspected). Suite passes (14 tests).

## 4. tests_to_add — titles verbatim and assertions match claims

All 9 intake titles appear character-for-character in
`src/lib/reviews/__tests__/on-demand-generate.test.ts`. Assertion strength check:

1. *locks … before any sibling read / review_not_found* — asserts the FOR-UPDATE reviews
   read is the FIRST captured tx call, exactly 1 call total, no `FROM responses` text, and
   the writable mock uncalled. Ordering claim genuinely proven (mock consumes queue in call order).
2. *re-asserts business-scoped writable gate / refusal unchanged* — asserts call args
   `(BUSINESS_ID, txTag)` (business-scoped AND same tx instance), lock ran first, and the
   exact `{status, error}` pass-through under `not_writable`; short-circuit proven (1 tx call, 0 inserts).
3. *already_answered* — asserts result + the `status = 'posted'` predicate text + no enqueue.
4. *draft_already_exists newest id/status* — asserts the `{response_id, status}` shape AND
   `ORDER BY version DESC` in the SQL text ("newest" is genuinely asserted, not just titled).
5. *orphan prefix* — asserts the bound value is `${POST_AFTER_DELETE_FAILED_PREFIX}%` from
   the constant, not a re-typed literal.
6. *regenerate_in_progress* — asserts the byte-for-byte
   `'pending', 'dispatching', 'dispatched'` text (members and order) plus topic + aggregate binds.
7. *COALESCE version, never hardcodes 1* — seeds next_version=42 and asserts result,
   payload, and the `COALESCE(MAX(version), 0) + 1` text.
8. *enqueue lane + suppressNotification in same tx* — runs the REAL
   `enqueueGenerateResponse`, asserts `origin_lane === 'on_demand_generate'` with an
   anti-vacuity constant check, `!== LIVE_INGEST_NEW`, `suppress_notification === true`,
   topic from `QUEUE_NAMES`, outboxId returned AND bound into the INSERT, and the INSERT
   as the final statement on the same tx instance.
9. *every sibling read business-scoped* — filters the 4 `FROM responses` reads, asserts
   each contains both column names in text AND both IDs in bound values.

No title asserts something weaker than it claims.

## 5. Blast radius

- `route.ts` "79 importers" in blast-radius.md are an artifact of the heuristic
  import-text search (route files have no real importers; those are unrelated test files
  matching shared import text). No real caller; Next.js binds the export, and
  `export const POST = withSameOrigin()(generateFirstDraft)` + `dynamic = 'force-dynamic'`
  are preserved.
- `src/lib/shared/response-status-sql.ts` — 6 importers checked: the 4 past-replies /
  draft-status routes all call `statusArraySql(sql, …)`; `Sql` is assignable to the
  widened union, call-signature resolution typechecks (repo `pnpm typecheck` clean), and
  the emitted fragment is byte-identical. Its own unit suite passes. The new module is
  the only caller passing a `TransactionSql`.
- Audit scripts: `tenant-scope-audit` (green at 409, and its scan roots include the new
  module's location), `feature-surface-audit` (green with the D2 dual spelling),
  plus `outbox-status`, `outbox-seam`, `db-imports`, `response-status`, `static-policy`,
  `live-db-suites` — all green.

## 6. Verification evidence (all run in this worktree)

| Command | Result |
|---|---|
| `vitest run on-demand-generate.test.ts + route.test.ts` | 2 files, 25 tests passed |
| `vitest run generate-version.integration` | 1 passed (live DB) |
| `vitest run response-status-sql.test.ts` | 2 passed |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm ci:tenant-scope` | passed — entries 409 (baseline 409) |
| `pnpm ci:outbox-status` / `ci:outbox-seam` / `ci:db-imports` | passed |
| `pnpm ci:feature-surface` / `ci:response-status` / `ci:static-policy` / `ci:live-db-suites` | passed |

## 7. Findings (>=80% confidence)

### F1 — LOW · `scripts/ci/tenant-scope-allowlist.ts:51-65` · stale baseline-history comment

The baseline-history comment block documents every prior shrink
(420→418, 418→414, 414→412) but was not extended for this ticket's 412→409, and its
final entry still describes the three Generate-door entries as present tense — "three
for the new Generate door … the in-tx reads key on `review_id` alone" — which is now
false twice over (the entries are deleted; the reads are business-scoped). Violates the
working rule "when deleting … grep the filename to clean every cross-reference in the
same change" (the deleted entries' description at lines 59-64 is exactly such a
cross-reference). Concrete failure scenario: per deviation D1, feat-719 must rebase and
"recompute its baseline" against this file — an engineer reconciling counts from the
history block finds it ends at 412 while the constant reads 409, an unexplained 3-entry
gap at precisely the coordination point D1 exists to de-risk. Comment-only; no runtime
or audit behavior affected (`ci:tenant-scope` keys on the constant, which is correct).

## 8. Low-confidence appendix (NOT findings)

- **A1 (informational)** — In the old code the non-terminal read's `text[]` fragment was
  built on the `sql` singleton while the query executed on `tx`; the new code builds it
  on `tx`. Declared delta (3). Postgres.js fragments are client-agnostic to compose, and
  both the old (main) and new code pass the same live-DB characterization suite, so this
  is confirmed byte-identical at the protocol level — recorded only because it is the
  one delta whose equivalence rests on a library property rather than visible bytes.
- **A2 (accepted by intake, worth stating plainly)** — scoping `MAX(version)` by
  `business_id` means a hypothetical `responses` row for this review under a DIFFERENT
  business_id would no longer raise the allocated version (and would no longer trigger
  `already_answered`/`draft_already_exists`). Such a row cannot exist under the data
  model (responses inherit the review's business), and this is exactly declared
  delta (1) / intake invariant #8 — listed here only so a future reader knows it was
  considered, not missed.
- **A3 (theoretical)** — the log line now emits post-commit inside the route's `try`; a
  throw from the logger would surface as a 500 to the client for a request whose enqueue
  COMMITTED (old code would have rolled back). `createWorkerLogger().log` is a JSON
  console writer that does not throw in practice, and the post-commit move is the
  declared, intake-recorded delta (2); its truthfulness rationale (never report an
  enqueue that rolled back) is the winning trade.

## Verdict

**VERDICT: APPROVED** — the diff implements the intake contract field-by-field; the only
semantic deltas found are the four declared ones; all nine tests exist verbatim and
assert their claims; all four deviations were implemented as described; every relevant
audit, suite, typecheck, and lint pass in this worktree. F1 is a comment-hygiene fix
that can ride along in any follow-up touching the allowlist (feat-719 will touch it
next by agreement).

---
ORCHESTRATOR TRIAGE (round 1): LOW scripts/ci/tenant-scope-allowlist.ts:59-64 stale baseline narrative — ACCEPTED, fixed by appending the `412 → 409 (#729)` history step explaining the deletion (comment-only). No other findings.
