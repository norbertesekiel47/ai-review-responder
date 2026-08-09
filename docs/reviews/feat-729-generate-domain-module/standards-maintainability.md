# Standards & Maintainability Review — feat-729-generate-domain-module

- **Reviewer**: Standards & Maintainability agent (thermo-nuclear-code-quality-review skill)
- **Range**: `git diff main...HEAD`, code files only (docs/ workflow artifacts skipped)
- **Date**: 2026-08-09
- **Code files in scope**:
  - `src/lib/reviews/on-demand-generate.ts` (new, 163 lines)
  - `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts` (250 → 145 lines)
  - `src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts` (mock plumbing only)
  - `src/lib/reviews/__tests__/on-demand-generate.test.ts` (new, 336 lines)
  - `src/lib/shared/response-status-sql.ts` (1-line signature widening)
  - `scripts/ci/tenant-scope-allowlist.ts` (3 entries deleted, baseline 412 → 409)

## Verification evidence (all run in the worktree)

| Check | Result |
|---|---|
| `vitest run` on-demand-generate.test.ts + route.test.ts | 2 files, 25 tests, all pass |
| `vitest run` generate-version.integration.test.ts (live-DB characterization, untouched file) | 1 test, pass |
| `pnpm typecheck` | clean |
| `eslint` on all four changed src files | clean |
| `pnpm ci:tenant-scope` | passed — 409 entries, baseline 409 |
| `pnpm ci:db-imports` | passed (strict) |
| `pnpm ci:outbox-seam` | passed |
| `pnpm ci:outbox-status` | passed |

## Thermo-nuclear structural assessment

**This PR is itself the code-judo move this skill exists to demand.** The Generate
transaction previously lived inline in an HTTP entry point where its only interface
was "the whole route": testable only through HTTP mocks, and carrying 3
tenant-scope allowlist suppressions because the audit could not see the scope. The
extraction:

- deletes complexity rather than rearranging it — 3 CI suppressions removed
  because all four sibling reads became natively `business_id`-scoped at zero cost
  (`businessId` was already resolved and locked);
- fixes a latent defect en passant — the `on_demand_generate_enqueued` log line
  previously fired *pre-commit* inside the tx and could report an enqueue that
  rolled back; it now fires after `sql.begin` resolves, with a comment explaining
  exactly that;
- leaves the route a genuine composition root (auth → rate limit → ownership proof
  → writable pre-check → budget peek → `sql.begin` → result→HTTP switch): no
  business logic remains (invariant #12 satisfied).

No further dramatic simplification is visible. The six-case switch in the route is
the honest cost of the seam — two cases carry distinct payloads
(`not_writable` status/error, `draft_already_exists` existing row), so a
table-driven mapping would obscure more than it saves. No file approaches 1k lines
(the only >1k file touched, `tenant-scope-allowlist.ts`, *shrank*). No new
conditionals were bolted onto unrelated flows; the diff is a net deletion of
branching from the route.

## Repo-specific standards audit

### Deep-module discipline (`codebase-design`) — PASS

- **Interface**: exactly two exports — `onDemandGenerateTx(tx, { reviewId, businessId })`
  and its result type `OnDemandGenerateResult`. No config params, no options bag,
  no re-exports of moved constants.
- **Implementation hidden**: lock ordering, TOCTOU re-check, three sibling
  exclusions, orphan semantics, D-B version allocation, and the atomic outbox
  enqueue all sit behind one call.
- **No HTTP concerns leaked**, with one deliberate, plan-locked nuance: the
  `not_writable` arm carries `status: 402 | 403`. This is a verbatim pass-through
  of `WritableSubscriptionResult` (`src/lib/shared/writable-subscription.ts:19-21`),
  which already speaks that vocabulary; re-mapping error→status in the route would
  have created a second spelling of a mapping that has one owner. Accepted.
- **The `tx: TransactionSql` parameter is structurally enforcing**: in Postgres.js
  types, `Sql` and `TransactionSql` are sibling interfaces (both extend `ISql`),
  so the singleton is *not assignable* — "callers MUST run this inside
  `sql.begin`" is a type-level fact, not just a comment.
- Invariant #15: the module imports only `type { TransactionSql }` from
  `postgres`, never `@/lib/db/server`; `ci:db-imports` strict passes.

### Comment discipline — one finding (F1 below), otherwise PASS

- The invariant #3 / #2 header block (origin-lane primary structural exclusion,
  `suppressNotification` belt-and-braces, the #678 do-not-delete note) moved to
  the module header **byte-for-byte** — verified against `git show main`.
- Every per-guard comment moved with its guard. The orphan-guard comment was
  *correctly rewritten*, not left stale: it previously said "the three sibling
  reads key on review_id alone and are allowlisted as tenant-root lookups"; it now
  says "like every sibling read in this transaction — all four are natively
  business-scoped at zero cost", which matches the code.
- The route's replacement header accurately names what stayed and what moved,
  and the `review_not_found` case documents the preserved NO_STORE-headers
  asymmetry instead of silently normalizing it.
- **The one miss is in `scripts/ci/tenant-scope-allowlist.ts`** — see F1.

### Glossary fidelity (CONTEXT.md → "On-demand generation") — PASS

- Module header names the concept exactly: "the 'On-demand generation' door,
  CONTEXT.md glossary". No renamed concepts, no invented jargon
  (`onDemandGenerateTx` composes the glossary term + the tx-suffix house
  convention).
- `origin_lane='on_demand_generate'` vocabulary intact; the test suite pins the
  constant's *value* (`GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE === 'on_demand_generate'`)
  so the assertion cannot pass vacuously.
- Error vocabulary (`already_answered`, `draft_already_exists`,
  `orphan_recovery_pending`, `regenerate_in_progress`) reused verbatim as the
  union's discriminants — the module's failure vocabulary IS the door's existing
  HTTP vocabulary, which keeps the route mapping mechanical.

### Constants / literals / `any` — PASS

- No `any` anywhere in the diff (test mocks use `unknown` + narrowing).
- `QUEUE_NAMES.GENERATE_RESPONSE`, `NON_TERMINAL_STATUSES`,
  `GENERATE_RESPONSE_ORIGIN_LANE`, `POST_AFTER_DELETE_FAILED_PREFIX` all imported
  from their authoritative modules.
- The `job_outbox` in-flight literal `('pending', 'dispatching', 'dispatched')`
  is the *sanctioned* byte-for-byte re-spelling (invariant #2; `ci:outbox-status`
  verifies members and order — ran, passed).
- `status = 'posted'` / `status = 'failed'` inside SQL template text is the
  established house pattern for SQL literals (same spelling in
  `load-replies.ts`, `judge-store.ts`, `edit-existing.ts`, and the pre-move
  route); moved verbatim, not a new front.
- `statusArraySql` widening to `postgres.Sql | postgres.TransactionSql` is
  *necessary*, not churn: `TransactionSql` is not assignable to `Sql` (sibling
  interfaces), so the locked `statusArraySql(tx, …)` call required it. Matches
  the named precedent (`SubscriptionSql` in `writable-subscription.ts:23`) and
  the helper's own doc comment ("the caller's `sql`/`tx` client"). Recorded as
  counted amendment A1.

### Test quality — PASS

- The 9 module tests assert **behaviour**: exact discriminated-union results
  (`toEqual` on whole objects), captured SQL text for load-bearing properties
  (lock-first ordering, `ORDER BY version DESC`, the in-flight status contract,
  `business_id` present in all four sibling reads), and the real
  `enqueueGenerateResponse` INSERT payload (helper deliberately unmocked, so the
  captured row carries the actual `origin_lane` / `suppress_notification`
  spellings). SQL-text assertions here are contract pins (concurrency ordering,
  audit-relevant scoping, the byte-for-byte outbox status set), not
  implementation trivia.
- Mock shape is consistent with the named precedent
  (`route.test.ts`): vi.hoisted captured-template tx tag, `tx.json`
  pass-through, module-path mock of `@/lib/shared/writable-subscription`. The
  suite extends the precedent only where its own assertions demand it (capturing
  joined SQL text per call).
- The `route.test.ts` edit is **pure mock plumbing**, exactly as deviations D3
  records: the txMock learns to return the `?::text[]` fragment without
  consuming a seeded rowset. Zero assertion changes — the characterization eval
  stands, and all 16 of its tests still pass.

### Fowler smell baseline (changed files only) — PASS

- No divergent change, no shotgun surgery introduced, no feature envy (the
  module owns every datum it touches), no data clumps beyond the two-field args
  object, no speculative generality (single caller, but the seam is demanded by
  invariants #12/#15 and the audit-suppression deletion — justification recorded
  in the plan's anti-slop note). The route's switch is a mechanical
  boundary-translation, not a smell.

## Findings (≥80% confidence)

### F1 — Stale baseline-history comment in the tenant-scope allowlist (Medium)

`scripts/ci/tenant-scope-allowlist.ts:38-65`. The running narrative above
`ALLOWLIST_BASELINE` documents every baseline change per its own convention
("420 → 418 → 414 (#677)…", "414 → 412 (#678)…"). This PR moved the constant
412 → 409 **without appending a `412 → 409 (#729)` step**, so:

1. the narrative's endpoint (412) now contradicts the constant on the next line
   (409); and
2. the retained #678 paragraph still describes the three Generate-door entries
   as present — "three for the new Generate door
   (`api/dashboard/reviews/[reviewId]/generate/route.ts`) … the in-tx reads key
   on `review_id` alone" — which is now false twice over: the entries were
   deleted by this PR, and the in-tx reads (relocated to
   `src/lib/reviews/on-demand-generate.ts`) are all natively
   `business_id`-scoped.

This is precisely the stale-claim class this review was asked to hunt, in the
governance file whose narrative the audit's own docstring calls "explicit,
reviewable" evidence for every bump. Standard violated: comment discipline /
working rule "grep the filename to clean every cross-reference in the same
change".

**Fix (comment-only, ~5 lines)**: append a `412 → 409 (#729)` step noting the
three Generate-door entries came out because #729 extracted the transaction to
`src/lib/reviews/on-demand-generate.ts` and scoped all four sibling reads
natively by `business_id`; optionally mark the #678 paragraph's "key on
`review_id` alone" clause as superseded at #729.

## Appendix — low-confidence observations (not in the findings table)

- **A-1 (test typing)**: `on-demand-generate.test.ts` erases the module's real
  types via `(await import('../on-demand-generate')) as unknown as { onDemandGenerateTx: OnDemandGenerateFn }`
  where `OnDemandGenerateFn` returns `Promise<Record<string, unknown>>`. This
  mirrors the named precedent (`route.test.ts` does `mod.POST as unknown as RouteHandler`)
  and served the RED-first commit ordering, but now that T2 landed in the same
  PR the cast discards the compiler's view of the suite↔module contract; a
  future signature drift is caught only via `route.ts`'s typed call site. A
  follow-up could import `OnDemandGenerateResult` and confine the cast to the
  `txTag` argument. Consistency with the house pattern keeps this below the
  confidence bar.
- **A-2 (mock asymmetry)**: `route.test.ts`'s txMock is `async`, so its
  `?::text[]` fragment is returned Promise-wrapped, while the module suite's
  `txTag` returns it synchronously (closer to Postgres.js reality, where a
  fragment is a lazily-executed query object). No assertion observes the
  difference; noting only so a future reader doesn't "fix" one to match the
  other without checking.
- **A-3 (redundant assertion)**: `expect(result.version).not.toBe(1)`
  immediately after `expect(result.version).toBe(42)` is tautological; the
  paired `toBe(42)` already carries the D-B property.
- **A-4 (union spelling)**: `statusArraySql`'s widened parameter inlines
  `postgres.Sql | postgres.TransactionSql` while ~13 domain modules each declare
  a local `type SqlExecutor` alias for the same union. A single canonical alias
  would be a codebase-wide cleanup, not something this PR regressed; the inline
  spelling on a one-signature file is fine.

## Verdict

The extraction is exemplary — it is the structural move this skill's checklist
exists to push for, executed with byte-level comment fidelity, a locked
interface honored exactly, every relevant CI audit green, and a latent
pre-commit-logging defect fixed along the way. The single defect is a stale
governing comment in the tenant-scope allowlist introduced by this PR's own
baseline bump — a five-minute, comment-only fix, but a genuine violation of the
repo's same-change cross-reference rule in a CI-governance file, so it should
land before merge.

VERDICT: REVISE (single comment-only fix — F1; everything else approved as-is)

---
ORCHESTRATOR TRIAGE (round 1): F1 (Medium, same substance as spec axis's LOW) — ACCEPTED, fixed by appending the `412 → 409 (#729)` step to the baseline history; the #678 paragraph is retained as historical narrative ("Replaced by six" was true at that time), with the new step recording the deletion and the native business-scoping. Round 2 is a single combined verification agent since both axes' tables contain the identical finding.
