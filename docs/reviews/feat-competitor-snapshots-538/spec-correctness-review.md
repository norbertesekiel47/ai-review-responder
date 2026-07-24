# Spec & correctness review — feat/competitor-snapshots-538

Reviewer: Claude (spec-and-correctness pass, `git diff main...HEAD` vs
`docs/superpowers/plans/feat-competitor-snapshots-538-intake.json` and
`docs/superpowers/plans/2026-07-23-competitor-snapshots.md`), 2026-07-23.

Already-triaged items NOT re-raised here (per instruction): search_location
excluded from the pack replace key (adversarial-review finding 1, rejected with
rationale); migration IF NOT EXISTS (finding 2, fixed — verified present in
`supabase/migrations/084_competitor_snapshots.sql:23,39`).

Verification evidence gathered during this review:

- `pnpm vitest run worker/jobs/__tests__/RankingTrackingWorker.test.ts` — 30/30 PASS
- `pnpm vitest run src/lib/account-offboarding/__tests__/purge-verification.test.ts src/lib/account-offboarding/__tests__/table-disposition.test.ts` — 15/15 PASS
- `pnpm ci:tenant-scope` — PASS (405 entries, no allowlist growth)
- `pnpm ci:rls-audit` — static PASS (33 tenant tables incl. competitor_snapshots)

---

## 1. Allowed edit surface

Changed files (16) vs `allowed_edit_surface` globs: **all 16 match.**
`.claude/reference/migrations-log.md`, `CONTEXT.md`, `docs/reviews/**` (2),
`docs/security/rls-inventory.md`, `docs/superpowers/plans/**` (4),
`scripts/ci/tenant-tables.ts`, `src/lib/account-offboarding/{purge-verification,table-disposition}.ts`,
`supabase/migrations/084_competitor_snapshots.sql`,
`worker/jobs/RankingTrackingWorker.ts`, `worker/jobs/__tests__/RankingTrackingWorker.test.ts`,
`worker/jobs/account-offboarding/{purge-helpers,purge-stages}.ts`.
`scripts/ci/tenant-scope-allowlist.ts` was allowed but untouched (correct — the
plan explicitly forbids speculative entries). **No violations.**

## 2. Invariants (intake, field by field)

| Invariant | Verdict | Evidence |
|---|---|---|
| Zero marginal SerpAPI calls; checkRateLimit strict unchanged | HONORED | Single `getJson` at `RankingTrackingWorker.ts:116`; budget block `:240-255` byte-identical to main |
| Rank upsert + pack delete + insert in ONE `sql.begin()`; failure fails the job | HONORED | `RankingTrackingWorker.ts:268-290`; failure tests at test `:452-484` assert reject + outbox untouched |
| Replace-pack DELETE by (business_id, keyword, snapshot_date), no per-row upsert key | HONORED | `:275-278`; predicate shape pinned by test `:407-436` (exactly 3 params, no search_location) |
| Full pack persisted, NULLs kept, never dropped | HONORED | `:136-147` map (no filter); NULL test `:398-425` |
| is_self row when own business appears; absent otherwise | HONORED | `:146` place_id match; tests `:370-396` (present) and `:437-451` (absent) |
| Tenant scoping + tenant-tables registration + RLS mirror of 035 §2f | HONORED | DELETE is business_id-scoped; `tenant-tables.ts:23`; policy in 084 `:44-49` textually mirrors 035 `:186-189` (same USING clause, SELECT-only, authenticated) |
| Subscription strict-active guard, outbox contract, 1-keyword cap unchanged | HONORED | `:196-203` (strict ACTIVE), `:293` (completed after loop), `:222` (slice(0,1)) — all unchanged vs main |
| Engine stays google_maps | HONORED | `:104`; no `google_local` anywhere in the diff |
| Offboarding: hard_delete / direct_business_id / must_be_absent, deletable + verified by business | HONORED | `table-disposition.ts:192-198`, `purge-verification.ts:278-279,585`, `purge-helpers.ts:68`, `purge-stages.ts:258` — mirrors ranking_snapshots in all four registries; consistency suites pass |

## 3. Edge cases (intake, field by field)

| Edge case | Verdict |
|---|---|
| Entry lacking place_id → NULL place_id, is_self=false | Handled (`:141,146`) + tested (test `:398-425`, asserts param 7 NULL and param 12 false) |
| Own business absent → pack persisted, no is_self row | Handled (`:149-150`) + tested (test `:437-451`) |
| Budget exhausted → no call, no pack write | Handled — `break` at `:254` precedes Step 6/7; pre-existing test `:230-238` (asserts `getJson` not called; pack write absence follows since the tx block is after the break) |
| Location edit: prior-DAY rows keep old search_location; same-day re-run replaces under new location | Handled by date-scoped DELETE + tested (test `:407-436` asserts predicate shape and that reinserted rows carry the new location) |
| Same-day re-run → atomic replace, no duplicates | Handled + tested (delete-before-insert ordering, test `:426`-ish `:407` block and `:388` ordering test) |
| Empty local_results → DELETE runs, zero inserts | Handled + tested (test `:426-436` clears-pack test) |
| Entry missing position → index+1 fallback per pack row | Handled (`:140`); see appendix A3 on assertion depth |
| Mock mode → synthetic pack through identical tx path | Handled (`:74-101`) + tested (test `:486-499`) |

## 4. tests_to_add (intake, field by field)

| Promised test | Verdict |
|---|---|
| Happy path: full pack, is_self at matched rank, all fields mapped | PRESENT — test `:370-396` (title/place_id/data_cid/is_self asserted; rating/review_count asserted via the NULL test's positional map) |
| Replace idempotency: second run replaces, no duplicates | PRESENT — delete-before-insert ordering test `:388-406` plus predicate-shape test; unit harness can't literally run twice against state, ordering + predicate is the unit-level contract (plan notes this) |
| Nullability: missing rating/reviews/place_id → NULLs, not dropped | PRESENT — test `:398-425` |
| Own business absent → no is_self row; rank_position NULL on ranking_snapshots | PARTIAL — see Finding F2 |
| Empty local_results → prior pack cleared | PRESENT — test `:426-436` |
| Atomicity: pack failure rejects job, no partial pack | PRESENT — two tests (`begin` rejection `:452-463`; inside-tx insert throw `:465-484`) |
| Mock mode through same path, is_self at mocked rank | PRESENT — test `:486-499` |
| Existing own-rank tests stay green | VERIFIED — all 21 pre-existing tests unchanged and passing (30 total) |
| Offboarding/RLS consistency suites pass with registration | VERIFIED — 15/15 pass; ci:tenant-scope + ci:rls-audit pass |

The branch also adds a 9th test (replace-key shape) beyond the plan's 8 — the
accepted sub-action from adversarial-review finding 1. The deviations file
documents the 7-vs-8 prose mismatch.

## 5. user_visible_behavior

Diff behavior: (a) competitor_snapshots rows written per run — named; (b) mock
mode synthesizes a pack through the same write path — named. The only unnamed
observable change is the worker log line gaining `pack=<n>` / count phrasing
(`:99,152-155`) — logging detail, not user-visible behavior. **No unnamed
behavior.**

## 6. non_goals

No digest code, no named-rival storage/UI, no pagination (page 1 only, no
`start` param), no per-competitor lookups, `data_cid` written at `:286` and read
nowhere (grep: only the worker INSERT references it outside docs), no
`SERPAPI_PREFILL_COST_USD` change, no `google_local`. **Nothing out-of-scope
built.**

## 7. Findings (≥80% confidence)

### F1 — Low — stale fallow-ignore justification comment
`worker/jobs/RankingTrackingWorker.ts:159-161`

The comment above `handleTrackRanking` reads "this PR only added a bounded
SerpAPI timeout in resolveRankPosition, no new branches here." Both halves are
now false on this branch: `resolveRankPosition` no longer exists (renamed
`resolveLocalPack`), and this diff adds the `sql.begin` block plus the
per-entry insert loop to the handler. The `fallow-ignore-next-line complexity`
suppression it justifies is now resting on an inaccurate rationale — the next
person auditing suppressions will be misled about what this handler contains.
Failure scenario: a future complexity audit trusts the comment, concludes the
handler is unchanged since the timeout PR, and skips re-reviewing the new tx
block. Fix is a one-line comment update.

### F2 — Low — promised "rank_position NULL on ranking_snapshots" assertion never made
`worker/jobs/__tests__/RankingTrackingWorker.test.ts:437-451` (new test) and `:328-340` (pre-existing)

Intake tests_to_add: "Own business absent → pack persisted without is_self row;
**rank_position NULL on ranking_snapshots as before**." The new
own-business-absent test asserts only that every pack row has is_self=false; it
never inspects the ranking_snapshots upsert params. The pre-existing "records
NULL rank when business NOT found" test (`:328-340`) asserts only
`markOutboxCompleted` — it would pass even if the refactor regressed
rankPosition to `undefined` or a wrong number. So the NULL-rank half of this
promised test is asserted nowhere. The behavior itself is correct in code
(`:149-150` — no self entry → `rankPosition = null` flows to the upsert at
`:271`), so this is a test-contract gap, not a code bug: the refactor that this
promise was meant to pin (rank derivation moving inside `resolveLocalPack`) is
exactly the code path left unpinned.

## Low-confidence appendix (NOT findings — speculative / below threshold)

- **A1 — inside-tx failure test restores the mock in the test body**
  (`RankingTrackingWorker.test.ts:465-484`). `mockSql.mockImplementation(originalImpl!)`
  runs after the assertions; if an assertion throws, the poisoned
  implementation leaks into later tests (`vi.clearAllMocks()` clears calls,
  not implementations), producing confusing cascade failures. Only manifests
  when the test is already failing; a try/finally or afterEach restore would be
  more robust.
- **A2 — pre-existing vacuous assertion** in "uses SerpAPI position field when
  available" (`:307-311`): `expect(upsertCall || mockMarkOutboxCompleted).toBeTruthy()`
  is always truthy. Pre-existing on main, untouched by this diff — out of scope,
  noted for a future cleanup.
- **A3 — index+1 position fallback for pack rows has no value-level assertion.**
  The intake lists it as an edge case ("handled and/or tested") and it is
  handled (`RankingTrackingWorker.ts:140`); the pre-existing fallback test
  (`:314-326`) asserts only completion, and all new pack tests supply explicit
  `position` values. A pack entry missing `position` never has its stored
  rank_position value pinned by a test.
- **A4 — mock pack uses `Math.random()`** for ratings/review counts. The intake
  says "deterministic-ish", so this is compliant; noting only that repeated
  local runs produce different rival stats for the same date (each run replaces
  the pack, so no accumulation).

## Verdict

Spec-complete against the intake contract: edit surface clean, all 9 invariants
honored, all 9 edge cases handled, 8 of 9 promised test items fully present
(one partial — F2), no unnamed user-visible behavior, no non-goal built. Two
low-severity findings, both trivially fixable; no correctness bugs found in the
migration SQL, worker logic, or offboarding registration.
