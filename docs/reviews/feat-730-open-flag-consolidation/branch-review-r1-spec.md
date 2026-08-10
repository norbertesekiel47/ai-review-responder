# Branch review round 1 — SPEC & CORRECTNESS — `feat-730-open-flag-consolidation`

Reviewer: spec/correctness agent (fresh eyes). Scope: `git diff 76b40b7b..HEAD` (21 commits).
Inputs read in full: intake contract (`docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json`),
triaged deviations (`docs/superpowers/plans/feat-730-open-flag-consolidation-deviations.md`),
blast radius (`docs/reviews/feat-730-open-flag-consolidation/blast-radius.md`).

## Verdict

**PASS.** The diff implements the locked intake faithfully: one composable fragment
`openFlagExistsSql` owned by `src/lib/moderation/held-draft.ts`, all 8 owner-facing
spellings (7 files) migrated, `hasOpenFlag` re-expressed on the fragment with its exact
signature and untouched call sites, the 8 deliberately-distinct consumers byte-untouched,
tenant-scope allowlist regenerated in place at baseline 409, and all 11 promised tests
present verbatim, real, and green (including both live-DB suites against the local
container). One minor finding (test-guard completeness), no blocking findings.

## Field-by-field evidence

### `goal` / non-negotiable shape — PASS

- `openFlagExistsSql(db, ref)` added to `src/lib/moderation/held-draft.ts` (+40/−3): the
  single read-side spelling `EXISTS (SELECT 1 FROM flagged_responses fr WHERE
  fr.response_id = ${ref} AND fr.status = 'open')`, with the divergence comment block
  (four distinct-consumer categories) extending the module's contract header, the
  'open'-is-a-literal partial-index rationale (migration 051), and the reserved-`fr`-alias
  warning.
- All 8 owner-facing spellings compose it — verified per-site in the diff:
  1. `src/app/api/dashboard/past-replies/draft-status/route.ts` (projected, `sqlRead`, ref `responses.id`)
  2. `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` (projected, `sqlRead`, ref `resp.id`)
  3. `src/lib/past-replies/load-replies.ts` (projected inside the draft LATERAL, ref `resp2.id`)
  4. `src/lib/dashboard/service.ts` (filtered inside the resp LATERAL, ref `responses.id`)
  5. `src/lib/dashboard/aggregate-service.ts` (filtered inside the resp LATERAL, ref `responses.id`)
  6. + 7. `src/lib/dashboard/pending-count.ts` — BOTH spellings (per-business + account-grouped), ref `resp.id`
  8. `src/lib/agents/read.ts` `getReviewTimeline` (anti-join → `AND NOT ${openFlagExistsSql(...)}`, ref `resp.id`)
- `hasOpenFlag` body re-expressed as `SELECT 1 AS one WHERE ${openFlagExistsSql(tx,
  tx\`${responseId}::uuid\`)}` — a FROM-less `SELECT … WHERE EXISTS` returning 0 or 1 rows,
  contract-identical to the old `SELECT … FROM … LIMIT 1` (`rows.length > 0` unchanged).
  SQL validity live-verified by promised test #6 against real Postgres.
- Every call site passes the surrounding query's client (`sqlRead` in the two routes, the
  `sql`/`tx` parameter elsewhere) — consistent with the docblock's statusArraySql-style rule
  and invariant #15 (held-draft.ts still imports no DB singleton; `ci:db-imports` passed strict).

### `non_goals` — PASS

Byte-diff of every deliberately-distinct consumer against `76b40b7b` is empty (0 diff lines
each): `src/app/api/admin/flagged/` (whole dir), `src/lib/admin/flagged-service.ts`,
`src/lib/admin/nav-counts-service.ts`, `worker/background/pollers/health-alert/checks.ts`,
`src/lib/account-offboarding/purge-verification.ts`,
`worker/jobs/account-offboarding/purge-stages.ts`,
`src/lib/account-offboarding/table-disposition.ts`,
`worker/jobs/response-generation/persist.ts` (keeps its module-local
`FLAGGED_RESPONSE_STATUS_OPEN`).

- No higher-level read helpers: held-draft.ts exports exactly `HeldForReviewError`
  (pre-existing), `openFlagExistsSql`, `hasOpenFlag`.
- No boolean parameter on the fragment: signature is `(db, ref)` only.
- No CONTEXT.md change (not in `--name-status`); the divergence note lives on the owner module.
- `worker/jobs/publisher/held-flag-gate.ts` and every other `hasOpenFlag` call site
  (`src/lib/approval/http-routes.ts`, the three past-replies publish/draft routes) — 0 diff lines.

### `user_visible_behavior` ("None") — PASS

Every rewrite is a spelling swap of an identical predicate:

- The two draft-status routes and the load-replies LATERAL stay **projected**
  (`… AS held`), byte-equivalent EXISTS semantics (only the subquery alias changed `f`→`fr`).
- service/aggregate-service/pending-count stay **filtered** (`AND NOT EXISTS`), placement
  inside the LATERAL body before `ORDER BY version DESC LIMIT 1` unchanged (pinned by
  tests #10 + the aggregate mirror).
- `getReviewTimeline`: null-filtered anti-join (`LEFT JOIN … AND fr.status = 'open' …
  AND fr.id IS NULL`) → `NOT EXISTS` is row-set-equivalent for this shape (anti-join
  keeps exactly the rows with no matching flag row; NOT EXISTS is the same set; the
  migration-051 partial unique index additionally guarantees no join-fanout existed to
  begin with). The filter still applies to the candidate set BEFORE `ORDER BY version
  DESC LIMIT 1` — live-verified by the newest-unheld-fallback test (#7).
- Both live-DB integration suites pass (13 tests), including the fast-check property
  (#5) asserting projected-held and BOTH filtered spellings agree across every
  migration-051 flag-status combination, with cross-business bleed checks.

### `invariants` — all 5 PASS

1. **Invariant #4 as structure**: projected sites remain SELECTed-not-filtered (D9) —
   route tests assert `idle` + no text leak for a held row; load-replies integration
   asserts `row_action: 'none'`, `reply_state: 'posted'`, and the held text absent from
   the serialized view. Filtered sites keep excluding.
2. **`hasOpenFlag` exact signature**: `(tx: TxClient, responseId: string):
   Promise<boolean>` unchanged; in-tx post-FOR-UPDATE contract text retained; all 5 call
   sites 0-diff.
3. **Read-side `'open'` only in the fragment**: `rg "'open'"` over the 7 migrated prod
   files after the branch → zero hits; the only remaining `flagged_responses` mentions
   are prose comments (no `FROM`/JOIN spellings). Promised test #11 enforces the FROM
   form mechanically (see finding F1 for its one blind spot).
4. **Tenant scoping / allowlist**: `pnpm ci:tenant-scope` → "passed — entries: 409
   (baseline: 409)". Exactly the six intake-named snippets regenerated in place
   (~327, ~1285, ~1509, ~1516, ~1530, ~1537 → diff hunks at 326/1284/1508/1529); no
   entry added or removed; `ALLOWLIST_BASELINE = 409` untouched; pending-count has no
   entry and gained none. `pnpm ci:rls-audit` static gate passed.
5. **Distinct consumers keep their spellings**: verified byte-untouched (above); the
   divergence rationale now documented on the owner module.

### `edge_cases` — PASS

- Anti-join rewrite: equivalence argued above + two dedicated live tests (#4, #7).
- pending-count TWO spellings: both migrated (diff shows both hunks); both live-verified (#8).
- Three ref contexts: qualified column refs (`resp.id`, `resp2.id`, `responses.id`) in
  LATERAL/correlated contexts + `tx\`${responseId}::uuid\`` bound-parameter fragment;
  the UUID-parameter path executes against live Postgres (#6). No caller passes an
  `fr`-qualified ref (reserved-alias hazard documented).
- Allowlist: six entries, in place, same PR — feat-719 gate-block trap avoided;
  no pending-count entry added.
- Stale D6 "#680 item" comments: rewritten in all three files; `rg "#680"` over them → zero hits.
- 7 files / 8 inline spellings: matches the migrated set exactly (past-replies
  draft-status route included).

### `allowed_edit_surface` — PASS

`pnpm ci:feature-surface` → "passed (29 changed file(s) within the declared surface)".
The committed intake carries both owner-ratified amendments (`*` respelling of the
`[reviewId]` entries; the two blast-radius test files
`src/app/api/dashboard/reviews/__tests__/actions.test.ts` +
`src/app/api/dashboard/__tests__/route.test.ts`). All non-docs changed files fall inside
the amended surface; the 7 `docs/` files are the always-allowed docs paths. No
`supabase/migrations/` changes.

Note: the deviations log says amendments were applied to "both copies" of the intake; only
one copy exists inside this worktree (the committed
`feat-730-open-flag-consolidation-intake.json`, which the merge-time audit reads and which
is amended correctly). The second copy is presumably harness state outside the worktree —
not verifiable here, and the merge-gating copy is the committed one.

### `tests_to_add` — PASS (11/11 verbatim, real, green)

| # | Title | Location | Status |
|---|---|---|---|
| 1 | openFlagExistsSql spells the correlated open-flag EXISTS once… | `src/lib/moderation/__tests__/held-draft.test.ts:59` | real, passing |
| 2 | hasOpenFlag keeps its contract… | `held-draft.test.ts:50` | real, passing |
| 3 | a held draft still projects draft_held true… | `src/lib/past-replies/__tests__/load-replies.integration.test.ts:326` | live-DB, passing |
| 4 | getReviewTimeline excludes… includes once closed | `src/lib/agents/__tests__/read.integration.test.ts:327` | live-DB, passing |
| 5 | property: projected held and filtered visibility agree… | `load-replies.integration.test.ts:338` | fast-check on isolated business, passing |
| 6 | hasOpenFlag executes the UUID-parameter fragment against live Postgres | `load-replies.integration.test.ts:390` | live-DB, passing |
| 7 | getReviewTimeline falls back to the newest unheld response… | `read.integration.test.ts:386` | live-DB, passing |
| 8 | per-business and account-grouped pending counts exclude… | `load-replies.integration.test.ts:401` | live-DB, passing |
| 9 | each draft-status awaited query projects held from its correctly correlated response alias | both route suites (`draft-status.test.ts:551`, `[reviewId]/…/route.test.ts:261`) | real, passing |
| 10 | the response LATERALs keep held-filtering inside the LATERAL… | `service.feed-projection.test.ts:91` (+ aggregate mirror) | real, passing |
| 11 | all eight owner-facing reads compose openFlagExistsSql… | `held-draft.test.ts:70` | real, passing — see F1 |

No `.todo` stubs anywhere in the touched suites (the branch's own no-todo scan at
`held-draft.test.ts:93` enforces this and passes). Verification runs executed here:
unit suites (4 files, 27 tests; 7 route/dashboard files, 143 tests) and the intake's
verification command with `TEST_DATABASE_POOL_URL` exported (2 files, 13 tests) — all
green. `pnpm typecheck` clean. `ci:static-policy`, `ci:live-db-suites`, `ci:db-imports`
also green.

Caveat observed while running: in this worktree the two live-DB suites silently SKIP
under a bare `pnpm vitest run` ("TEST_DATABASE_POOL_URL unset") even though `.env.local`
line 301 defines it — the documented `.env.local` disk fallback did not fire here; the
suites only ran with the variable exported. Pre-existing harness behavior, not a branch
defect, but worth knowing when re-verifying.

### `estimated_prod_lines` (±140) / `estimated_test_lines` (±450) — within tolerance

Excluding `docs/`:

- **Prod bucket** (7 migrated files + held-draft.ts + allowlist): +70/−52, total churn
  ≈122, net +18 — comfortably within ±140, and matches the intake's shape
  (held-draft +~40 incl. comment block; swaps net-negative; 6 snippet lines regenerated).
- **Test bucket** (13 test files): +690/−96, net ≈ +594 vs ±450 — **1.5× on added lines,
  1.3× net**. Above estimate but below the >2× flag threshold; the overshoot is the
  triaged mock-ledger repairs (T4/T7 amendments, 5 suites) already settled in the
  deviations log.

### `rollback_plan` — still accurate

No migration, no flag, no schema touch in the diff (zero `supabase/migrations/` changes);
read-query text only. Revert-the-squash-merge remains a complete rollback.

### `observability` — still accurate

No new runtime signal in the diff. The stated pre-merge guards all ran green in this
review: both live-DB integration suites, the D9 projected assertions, `ci:tenant-scope`,
`ci:rls-audit` (static; live half skipped without the env var, as in CI).

### Deviations file vs code — consistent

- T4/T7 fragment-aware doubles: present exactly as described in
  `actions.test.ts` / dashboard `route.test.ts` / past-replies `publish|draft|draft-id`
  suites (fragment builds return inert `{fragmentText}` objects and do not consume the
  result ledger).
- T5 "harness already fragment-aware": `worker/__tests__/helpers/mock-sql.ts` is
  unmodified on this branch, and the T5 pins assert the flattened form — matches.
- T5 "~261 pin strengthened in place": `aggregate-queries.test.ts` diff only ADDS
  `AND NOT EXISTS` + `fr.response_id = resp.id` assertions; nothing deleted.
- T7 locked-regex reword: the `.todo` regex in `held-draft.test.ts:109` is byte-identical
  to the plan's locked literal (plan line 688).

## Findings (≥80% confidence)

| # | Severity | Location | Finding |
|---|---|---|---|
| F1 | MINOR | `src/lib/moderation/__tests__/held-draft.test.ts:89` | The title-#11 inline-spelling scan matches only `/FROM\s+flagged_responses/i`, so the **anti-join spelling** (`LEFT JOIN flagged_responses fr ON … AND fr.status = 'open' … fr.id IS NULL`) — the exact form `src/lib/agents/read.ts` used until this branch — is invisible to it. Concrete failure scenario: a future second query added to a listed file (e.g. a timeline variant in `read.ts`) re-inlines the predicate as a LEFT JOIN; the invocation-count floor stays satisfied by the existing fragment call (`>= 1`), the FROM-regex doesn't match JOIN form, and test #11 stays green while its title's claim ("no owner-facing inline spelling remains") is false. One-line fix: extend the regex to `/(?:FROM|JOIN)\s+flagged_responses/i`. Distinct from — and compatible with — the already-triaged enumerative-scan fast-follow note (that note covers NEW files; this covers a JOIN-form regression in a LISTED file). Non-blocking. |

## Low-confidence appendix (NOT findings — speculative observations)

- `held-draft.test.ts:68` (`expect(exists.values).toContain(ref)`): `mkTx`'s tagged
  template returns a bare `Promise`, so `ref` is a Promise rather than a fragment-shaped
  object; the identity assertion still works, but the double diverges from the real
  Postgres.js return shape more than the route suites' `{fragmentText}` doubles do.
  Cosmetic at most.
- The live-DB env-var fallback not firing in this sibling worktree (see tests section)
  may be worth a lab-notes cross-check if it also affects `pnpm test:integration`'s
  hard gate here — I did not chase the resolver.
- The `statusArraySql(sql, …)`-inside-`sqlRead` client mismatch in the `[reviewId]`
  draft-status route is pre-existing and already logged as an owner hygiene item in the
  deviations file — noting only that this review confirms it is still present and still
  behavior-neutral.

## Triage verdicts (orchestrator, round 1)

- MINOR title-#11 scan misses the JOIN form — **ACCEPT, fixed** in commit
  203a3b9d via the new additive owner-tree sweep test (matches
  `(?:FROM|JOIN)\s+flagged_responses` over comment-stripped production
  sources in the four owner-facing trees); the locked title-#11 body itself
  is untouched.
