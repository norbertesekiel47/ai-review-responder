# Standards & Maintainability Review — feat/competitor-snapshots-538

- **Scope**: `git diff main...HEAD` in worktree `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-competitor-snapshots-538`
- **Mode**: thermo-nuclear-code-quality-review skill + repo standards (`.claude/rules/repworth.md`, `.claude/CLAUDE.md` invariants), deep-module discipline, Fowler smell baseline, CONTEXT.md glossary conformance
- **Reviewed files**: `worker/jobs/RankingTrackingWorker.ts`, `worker/jobs/__tests__/RankingTrackingWorker.test.ts`, `supabase/migrations/084_competitor_snapshots.sql`, `scripts/ci/tenant-tables.ts`, offboarding companions (`src/lib/account-offboarding/purge-verification.ts`, `src/lib/account-offboarding/table-disposition.ts`, `worker/jobs/account-offboarding/purge-helpers.ts`, `worker/jobs/account-offboarding/purge-stages.ts`)
- **Date**: 2026-07-23

## Verdict

**APPROVE with fixes.** No structural regression, no invariant violation, no glossary violation. The change is well-shaped: `resolveLocalPack` is a genuinely deep module, the replace-pack transaction is correct and heavily rationale-commented, tests pin the locked semantics (including the deliberately-excluded `search_location` predicate). Four findings cleared the ≥80% confidence bar; two are worth fixing before merge (a now-false lint-suppression comment and a 20-round-trip insert loop inside the lock-holding transaction).

## Standards conformance summary

| Standard | Result |
|---|---|
| Invariant #15 (explicit DB client params) | PASS — `handleTrackRanking` is a registered job handler (composition root); `sql` singleton import pre-existing and allowed; tx passed as `tx` inside `sql.begin` |
| Invariant #2 (transactional outbox) | PASS — rank upsert + pack replace in one tx; outbox completion only after; tx failure leaves outbox untouched (test-pinned at test.ts:529) |
| No string-literal enums | PASS — `SubscriptionStatus.ACTIVE` used; `'serpapi'` source literal is pre-existing on main, not introduced here |
| No `any` in production code | PASS — SerpAPI response narrowed via inline typed array + `typeof` guards; no casts added |
| JSONB via `jsonb()`/`tx.json()` | N/A — no JSONB writes added; `tracked_keywords` parse site is the pre-existing sanctioned carve-out |
| Comment discipline (why-not-what) | MOSTLY PASS — new comments are rationale-dense and load-bearing (replace-key exclusion, lock ordering); ONE stale pre-existing comment now dangles (finding 1) |
| Glossary (CONTEXT.md verbatim terms) | PASS — "Competitor pack" used verbatim in worker, migration, migrations-log, table-disposition reason; `is_self` column and "is_self row" test language match; no renamed concepts found |
| Migration conventions (new-migration: UUIDv7, retryability, RLS) | PASS — `IF NOT EXISTS` + `DROP POLICY IF EXISTS` (retryable); worker-supplied UUIDv7 PK; RLS owner-select mirrors 035 §2f; registered in tenant-tables, rls-inventory, migrations-log |
| Offboarding registration completeness | PASS — all five registration sites updated consistently (disposition, verification switch + set, purge helper set, purge stage call) |
| 1k-line file rule | PASS — worker 295 lines, test 564 lines |

## Findings (≥80% confidence)

### 1. MEDIUM — Stale, now-false lint-suppression justification comment
`worker/jobs/RankingTrackingWorker.ts:159-161`

```ts
// Pre-existing ranking job handler (14 cyclomatic on main); this PR only added a
// bounded SerpAPI timeout in resolveRankPosition, no new branches here.
// fallow-ignore-next-line complexity
```

Two defects, both introduced *by omission* on this branch:
- It names `resolveRankPosition`, which this branch renamed to `resolveLocalPack` — a dangling cross-reference. repworth.md: "grep the filename to clean every cross-reference — dangling refs and stale ticks are bugs."
- The justification claim ("this PR only added a bounded SerpAPI timeout") described a *previous* PR and is now false: this branch rewrote Steps 6–7 (new tx block, pack loop). A `fallow-ignore` suppression whose stated rationale is untrue is worse than no comment — it teaches the next reader to distrust suppression rationales. Standard: comment discipline (design.md: comments must be "current and non-duplicative"); Fowler: lying comment.

**Fix**: reword to describe current reality, e.g. "Pre-existing handler shape; this branch replaced the single rank upsert with the pack tx (Step 7) — loop adds one branch, resolver branching moved into resolveLocalPack."

### 2. MEDIUM — ~20 sequential awaited INSERTs inside the lock-holding transaction
`worker/jobs/RankingTrackingWorker.ts:279-289`

```ts
for (const entry of pack) {
  await tx`INSERT INTO competitor_snapshots (...) VALUES (...)`;
}
```

The pack (~20 rows) is inserted one statement at a time — ~20 serialized round trips over PgBouncer — inside the same transaction that (deliberately, per the load-bearing comment) holds the `ranking_snapshots` unique-index row lock to serialize concurrent same-key jobs. Every extra round trip extends the lock-hold and tx duration for no benefit. Standards: thermo-nuclear rule 7 (unnecessary sequential orchestration); production.md ("avoid holding locks or expensive connections across slow remote calls"; here the "remote call" is 20 pooled round trips). Postgres.js multi-row insert is already the codebase-canonical dynamic helper (`${tx(rows, ...columns)}` — same helper family used in `src/lib/demos/lifecycle.ts`, `src/app/api/settings/route.ts`):

```ts
if (pack.length > 0) {
  const rows = pack.map((entry) => ({ id: uuidv7(), business_id: businessId, /* … */ }));
  await tx`INSERT INTO competitor_snapshots ${tx(rows)}`;
}
```

One statement, one round trip, and the loop disappears — strictly simpler code *and* a shorter critical section. Not a correctness bug (behavior converges), which is why this is Medium, not High.

### 3. LOW — 27-line mock-pack synthesis inlined in `resolveLocalPack`
`worker/jobs/RankingTrackingWorker.ts:74-101`

The deep-module question the review was asked: `resolveLocalPack` **does** hide the SerpAPI shape well — the `local_results` field shapes, the position-fallback rule, and the NULL-normalization all stay inside; callers see only `LocalPackResult`. The one blemish is that the mock branch grew from 3 lines (on main) to ~28 lines of fixture-building inside the resolver, so the function now interleaves two concerns (mock synthesis vs. fetch+normalize) and the real path starts a screen below the signature. Standard: design.md special-general decomposition ("isolate special behavior"). **Fix**: extract `synthesizeMockPack(business): LocalPackResult` — the resolver's mock branch returns to two lines and the SerpAPI path becomes the visually dominant flow. Behavior unchanged.

### 4. LOW — Mock-implementation restore skipped on assertion failure
`worker/jobs/__tests__/RankingTrackingWorker.test.ts:529-548`

The tx-callback failure test swaps `mockSql`'s implementation and restores it *after* the assertions (`mockSql.mockImplementation(originalImpl!)` at line 547). `beforeEach` uses `vi.clearAllMocks()`, which clears call history but does **not** reset implementations — so if any `expect` in this test fails, the poisoned implementation (every `competitor_snapshots` INSERT rejects) leaks into the subsequent mock-mode test and cascades a second, misleading failure. Standard: engineering.md ("when tests are flaky… improve the feedback path"); test-isolation hygiene. **Fix**: wrap in `try { … } finally { mockSql.mockImplementation(originalImpl!); }` or restore in an `afterEach` scoped to the describe block.

## Code-judo opportunities considered and rejected

- **Extract the tx block into a `persistLocalPack(tx, …)` helper** — rejected: single caller, the lock-ordering comment is load-bearing exactly where it is, and a helper would be a thin pass-through (design.md: don't extract when inlining is clearer). Finding 2's bulk insert shrinks the block anyway.
- **Derive `rankPosition` at call sites instead of returning it** — rejected: `LocalPackResult` bundling `{ rankPosition, pack }` is the right interface; deriving self-rank from the pack at the call site would leak the `isSelf` scan out of the module.
- **Collapse the six-site tenant-table registration** (tenant-tables, disposition, verification switch, verification set, purge-helper set, purge-stage call) into one registry — a real change-amplification smell (engineering.md trigger), but it is **pre-existing architecture** faithfully followed here, spans far beyond this branch's scope, and the audit scripts exist precisely to catch omissions. Flagged as follow-up, not a branch defect.
- **`DELETE`+`INSERT` vs per-row upsert** — the replace-pack choice is correct and deliberately documented (nullable `place_id` forecloses a per-row unique key); the migration comment and the predicate-pinning test make the invariant durable. No change requested.

## Findings table

| Severity | Location | Finding | Standard |
|---|---|---|---|
| MEDIUM | worker/jobs/RankingTrackingWorker.ts:159-161 | Stale fallow-ignore justification names deleted `resolveRankPosition` and makes a now-false "only added a timeout" claim | repworth.md dangling-refs rule; design.md comment currency |
| MEDIUM | worker/jobs/RankingTrackingWorker.ts:279-289 | ~20 sequential awaited INSERTs inside the lock-holding tx; canonical Postgres.js bulk insert `${tx(rows)}` does it in one statement | thermo rule 7; production.md lock-hold; canonical-helper reuse |
| LOW | worker/jobs/RankingTrackingWorker.ts:74-101 | 27-line inline mock-pack synthesis buries the real resolver path; extract `synthesizeMockPack` | design.md special-general decomposition |
| LOW | worker/jobs/__tests__/RankingTrackingWorker.test.ts:529-548 | Manual mock restore after assertions leaks poisoned `mockSql` impl into later tests on failure (`clearAllMocks` doesn't reset impls) | engineering.md test-feedback reliability |

## Low-confidence appendix (speculative — NOT findings)

- **`rating REAL` (float4) in migration 084**: float4 stores 4.8 as an approximation; `NUMERIC(2,1)` would be exact for Google's one-decimal ratings and cheap at this row count. No read-side comparison exists yet (data is write-only until the Competitor Delta line ships), so no observable defect today. (~60%)
- **`any[]` in new test helpers** (`sqlTextOf(call: any[])`, filter callbacks): repworth.md bans `any`, but the test file's pre-existing harness (`mockSql: any`, main:18) established the pattern and lint passes — the new code continues rather than introduces it. Tightening to `unknown[]` + narrowing would be trivial if the harness is ever cleaned. (~55% that this counts as a branch violation)
- **Positional-index assertions** (`noIdentity[7]`, `unrated[10]` keyed to a comment-documented param map, test.ts:466-479): brittle against column reordering; a small `paramsOf(call)` destructuring helper would self-document. The inline positional map comment mitigates. (~50%)
- **Mock pack nondeterminism** (`Math.random()` ratings/review counts): dev-mock-only, mirrors the pre-existing random rank; deterministic seeds would make MOCK_EXTERNAL_APIS demos reproducible. (~40%)
- **`position` fallback `idx + 1` can collide with an explicit SerpAPI `position` on another row** in pathological mixed responses, producing duplicate `rank_position` values within a pack; harmless under replace-pack (no unique key, read-side sorts) and inherited from the main-branch rank rule. (~40%)
