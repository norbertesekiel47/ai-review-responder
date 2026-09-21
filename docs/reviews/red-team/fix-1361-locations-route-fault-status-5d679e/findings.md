# Red team — #1361 owner-gate fault status — ROUND 3 (supersedes rounds 1 and 2)

- **Branch:** `fix/1361-locations-route-fault-status`
- **Mode:** feature · **Risk:** high · **Round:** 3 (owner-authorized, `owner-1361-third-round`)
- **Fork / merge-base:** `cb90d3f5ee1ae7b827da5446792f344703af3d5e` (was `10377aa9b`; the branch was rebased twice for the up-to-date merge requirement)
- **Round-1 head:** `e1db9ecbcb8555d3bb115d61ac800777f2bfedfa`
- **Round-2 head:** `322aeaa5d6e8919767482b73733f21fc805190ff`
- **Round-3 head:** `702d99ceedec4a33e1f3a24dd0c311b8da22170b`
- **Head under test:** `bbb0ba54d60fd4ea3a279f5c86ae06a351b3852b` (same-round continuation, post-rebase)
- **Last pre-rebase verified head:** `1391ab72e5cad42e2aa48cefb0538baff4f00e78`
- **Intake SHA-256:** `b44597b9ed7f653e37528ff204d6271e1b002ece9ddae05045f35f9ffb351fe1`
- **Generated:** 2026-09-21T00:33:10Z
- **Status:** `CLEAR` (14 findings: 0 P0, 0 open P1, 0 open P2, 12 fixed, 2 accepted-risk)

This round is SCOPED by the owner's authorization. `git diff 322aeaa5d..702d99cee`
touches **no production file** — five files, all documentation or this run's own
artifacts — so round 3's target is the CORRECTIONS the orchestrator made to fix
round 2's three P1s, plus the documentation and PR body that carry them. It opens
no front against code unchanged since `322aeaa5d`.

## Budget and hygiene

- **0 mutations applied.** The production surface did not move since round 2 and
  the owner authorization scopes this round to the documentation. Rounds 1 and 2
  killed 13 of 13 scored mutants (7 + 6) between them.
- 10 measurement launches, well inside the 1200 s round budget. No
  `skipped-budget` row.
- Blob identity verified anyway, before and after the pass:
  `git hash-object <path>` equals `git rev-parse HEAD:<path>` for
  `src/lib/approval/http-routes.ts` (`bbe7a7afa4af…`),
  `src/lib/auth/resolve-owner-scope.ts` (`e5cbabece697…`) and
  `src/lib/locations/owner-route.ts` (`9189c8950e79…`).
- Environment: `mutation-runner.mjs env --tmp-home` allowlist plus `dotenv-swap`;
  `REPWORTH_DISABLE_LIVE_DB_SUITES=1` (no validated local database).
  `finalize` restored 0 mutated files and 1 dotenv file; the journal is closed.
- `watchers`: none. `git status --porcelain --untracked-files=no` is empty at the
  end of the pass.
- `prevalidate-plan.py` was NOT used; every doc citation below was hand-checked
  against HEAD `702d99cee` and the command that checked it is named.

## Round-2 verdicts

| Round-2 finding | Verdict | Evidence |
|---|---|---|
| **P1-4** affected-route count 18 -> 20 | **FIXED, and the enumeration is correct** | Counted from the code. 4 + 8 + 8 = 20; every named path resolves to a real `route.ts` with that spelling; no production consumer of any of the three gates is missing; all 20 reach the gate outside every `try`. |
| **P1-5** rule-number collision | **FIXED** | Rule headings in the file are 5, 6, 9, 10, 11, 12, 13, 14, 15 — one each. 15 is the next free number. Rule 13's "Rule 12 filters Apply POST" resolves unambiguously to the Run C rule at line 436. No other cross-reference broke. |
| **P1-6** the rule could not be configured | **FIXED in shape, one facet WRONG** | The four-column table matches Rules 12/13/14 column for column; integration 443670 is the file's standard destination; the 10-in-1-hour threshold and its rationale against Rule 14's 20 are coherent. But the `transaction` facet misdescribes the emitted value — **P1-7**. |
| **P2-4** D5 line citation | **FIXED** | D5 now cites `src/lib/auth/resolve-owner-scope.ts` with no line number. |
| **P2-5** D4's label | **FIXED as to the label** | D4 now names it a directory count and records the corrected sets. A different figure in the same sentence is stale — **P1-8**. |

## The route enumeration, recounted from the code

| Gate | Routes | Verified |
|---|---|---|
| `readOwnerForMultiLocationRoute` (`src/lib/locations/owner-route.ts`) | `/api/locations/{add,archive,promote-primary,reactivate}` | `add` calls it directly; the other three reach it through `readLocationActionRequest`. The two other dirs under `src/app/api/locations` are correctly ABSENT: `display-label` makes no such call, `existing-place-ids` uses `requireOwnerWithAccount`. |
| `requireDashboardReviewOwner` (`src/lib/approval/http-routes.ts`) | the six `/api/dashboard/reviews/[reviewId]/{approve,edit,generate,regenerate,draft-status,timeline}` + the two `/api/dashboard/escalations/[escalationId]/{acknowledge,resolve}` | `runEscalationTransitionRoute` (`src/lib/escalations/http-routes.ts:29`) is the only other production caller, and exactly two routes use it. |
| `resolveOwnerScope` (`src/lib/auth/resolve-owner-scope.ts`) | `/api/settings/postal-address`, `/api/dashboard/import-offer`, `/api/dashboard/past-replies/draft-status` + the five that reach it through `_shared/edit-reply-request.ts` | The five are `past-replies/{publish,draft}`, `past-replies/draft/[responseId]`, `past-replies/[responseId]/{retry,restore-original}` — exactly the consumers of `resolveEditReplyScope`/`Context`/`Request`. |

**Reachability.** In all twenty the gate call sits outside every `try` in the
handler, and `withSameOrigin` (`src/lib/auth/route-helpers.ts:54-65`) re-throws
anything that is not a `SameOriginError`, so the re-thrown fault escapes to
`onRequestError`. The three direct `resolveOwnerScope` consumers
(`postal-address:93`, `import-offer:135`, `draft-status:65`) each end their catch
with a bare re-throw after an `instanceof ScopeError` guard.

## Findings opened this round

### P1-7 — Rule 15's `transaction` filter does not describe the emitted value

`docs/runbooks/beta-launch-alerting.md:504`

The row says to filter on "`transaction` (Next's route path) matching any of the
twenty routes enumerated below". The installed `@sentry/nextjs` 10.55.0
`captureRequestError`
(`node_modules/@sentry/nextjs/build/cjs/common/captureRequestError.js`) does:

    scope.setTransactionName(`${request.method} ${errorContext.routePath}`);

so the event's `transaction` is `POST /api/locations/add`, not
`/api/locations/add`. `beforeSend` -> `scrubSentryEvent` passes it through
unchanged (none of the twenty paths contains `/approve/`, `/u/` or `?`).

**Failure scenario.** An operator follows the row and builds twenty
`transaction equals <path>` conditions. None matches any event. The rule never
fires through a full Postgres pool outage — the exact silence it exists to
remove, and by its own design it has no tag and no constant message to fall back
on.

The dynamic segments are NOT the problem: `routePath` is the bracketed App Router
path, so `[reviewId]`, `[escalationId]` and `[responseId]` appear verbatim in the
transaction and match as written. The fix is one clause — state that the value is
the HTTP method, a space, then the bracketed route path, and name the match
operator to use.

### P1-8 — D4's "37 tests" is 38 at HEAD

`docs/superpowers/plans/fix-1361-locations-route-fault-status-deviations.md:84`

Measured at HEAD under the scrubbed environment: `owner-route.test.ts` +
`http-routes.test.ts` = **2 files, 38 tests, 38 passed**. The "37" was written in
`e1db9ecbc` (round-1 HEAD) and went stale when the round-2 work added
`requireDashboardReviewOwner > re-throws a non-Error rejection value unchanged`
to `http-routes.test.ts` — the round-2 sidecar records that test as "ADDED since
round 1" (`mutant-M5`), and the file went from 20 `it(` at the merge-base to 22
at HEAD.

This is the **same sentence** commit `0197bd4bc` rewrote to fix P1-2/P2-5: the
clause after the comma was corrected to "166 across the 13 test FILES" and the
"37" immediately before it was left untouched. Same defect class as round-1
P1-2, in the same paragraph, surviving the correction pass for it. D7 in this
same file sets the standard the figure violates.

### P1-9 — the PR body's test figure names no measurable set

PR #1391 body, "Tests" section: *"1054 tests pass across the 86 affected suites."*

The repo defines "affected" as `vitest run --changed <since>`
(`package.json` `test:changed`, `lefthook.yml` `test-changed`,
`scripts/verify-gate.sh:376`). Measured at HEAD under the scrubbed environment:

| Set | Files | Tests |
|---|---|---|
| `--changed origin/main` | 26 | 368 |
| `--changed 10377aa9b` (merge-base) | 26 | 368 |
| `src/lib/{approval,auth,locations}` | 48 | 582 |
| `src/app/api/{dashboard,locations,settings}` | 51 | 595 |
| the above minus `src/lib/auth` | 84 | 961 |
| routes + all three lib dirs | 99 | 1177 |
| `src/app/api` + all three lib dirs | 194 | 2230 |
| **claimed** | **86** | **1054** |

The gate's own artifact `.feature/logs/test.log` records the full suite at 1206
files / 16687 tests; no `.feature` log records 86 files or 1054 tests.

I **cannot prove the number false** — a path set between the 84/961 and 99/1177
measurements could produce it. That is precisely the defect: the claim names no
set, so it is unfalsifiable and unreproducible in the durable record a reviewer
reads. This branch has already had two findings of exactly this class (round-1
P1-2, round-2 P2-5), and D7 sets the standard that a figure must name the set it
was measured over. Remedy: name the exact command, or replace the figure with one
recorded in `.feature/logs/`.

## PR #1391 body — claims verified TRUE

| Claim | Verdict |
|---|---|
| "Routes covered — 20", 4 / 8 / 8 | TRUE — recounted from code |
| "30 lines of production code across 3 files" | TRUE — `git numstat` 7+1, 8+1, 6+7 = 30 |
| "0 of 13 scored mutants survived across both rounds" | TRUE — round-1 sidecar `counts.killed` 7, round-2 6 |
| "zero remaining sites … three Zernio routes plus `connect/_shared/finalize/authorize.ts`" | TRUE — independent sweep found 8 `instanceof AuthError` sites; the four Zernio ones answer 500 via `zernioRouteErrorResponse` or re-throw |
| "Rule 15" | TRUE |
| "Red team raised 6 P1s. All 6 are fixed" | TRUE as of round 2's list |
| Both accepted-risk P2s and their authorization | TRUE — match the sidecar verbatim |
| "1054 tests pass across the 86 affected suites" | **NOT VERIFIED — P1-9** |

## Sidecar self-audit

- Round-2 counts recompute exactly from the rows as written: 12 inventory rows
  (6 `killed`, 6 `excluded`), 11 findings (9 `fixed`, 2 `accepted-risk`, 0 open),
  `status: CLEAR` by the stated precedence.
- Every `arbiter_reasoning` note on **P1-4, P1-5, P1-6, P2-4, P2-5** describes a
  change that genuinely landed. Each was re-resolved against the file it names,
  not against the note. **No disposition claims a fix that did not land.**
- **Provenance untampered.** `head_sha` was `322aeaa5d` (the round-2 HEAD) and
  `intake_sha256` was `null`, exactly as the `owner-1361-third-round`
  authorization states they were deliberately left. The only edits to those
  fields in branch history are the legitimate round-1 -> round-2 update in
  `1d89ba41b`. Both authorizations are preserved in this round's sidecar.

## Duty 4 — sibling sweep, re-run at HEAD

`rg 'instanceof AuthError'` over `src/` and `worker/` excluding tests returns
eight sites: the three fixed gates, the reference `requireRoleOr401`
(`route-helpers.ts:120`), and four Zernio sites (`connect/start:68`,
`connect/cancel:76`, `disconnect:70`, `connect/_shared/finalize/authorize.ts:69`).
The first three fall through to `errorToResponse` = `zernioRouteErrorResponse`
(`src/app/api/zernio/_shared/error-response.ts:15-27`), which reports via
`reportCaughtError` and answers 500; `authorize.ts` re-throws unchanged.
**Zero remaining catch-all-401 siblings** — a sound search that found nothing.

## Authorizations

Rendered from `findings.json`.

- **`owner-1361-p2-accepted-risk`** (2026-09-20) — P2-1, P2-3. Owner authorized
  accepting both P2 findings as risk, asked directly with each finding, its
  failure scenario and the cost of fixing it in front of them. Both lines are
  byte-identical at merge-base `10377aa9b`; closing either needs a THIRD surface
  amendment, past the two the abort criteria allow. Both to be filed as follow-up
  issues at step 8.
- **`owner-1361-third-round`** (2026-09-20) — verification scope, no finding
  accepted. Owner authorized a THIRD ROUND, answered "Go for round 3 yes",
  because round 2's three P1s were all documentation defects written by this run
  and because fixing them made the round-2 sidecar stale by construction.

### One schema repair to the committed grant (recorded, not silent)

As committed in `702d99cee`, `owner-1361-third-round` carried
`finding_ids: []`. `red-team-status.mjs` rejects an empty `finding_ids` on every
authorization except the pinned Run C fourth-round grant, so the sidecar could
not validate at all. The grant's verbatim `text` is UNTOUCHED; its `finding_ids`
are now linked to the three round-2 findings its own text names — P1-4, P1-5,
P1-6 — which is the linkage the schema asks for and changes no substance. Both
authorizations are preserved.

## Checker result

`node .agents/skills/feature/scripts/red-team-status.mjs` — FAILED with exactly
four issues, all of them the intended consequence of this round's findings:
`status is OPEN_P1`, plus one high-risk adjudication block each for P1-7, P1-8
and P1-9. Schema, counts, derived status, `head_sha`, `intake_sha256`, the
round-3 authorization and the unmoved-tree check all pass.

---

## Same-round continuation — HEAD `1391ab72e`, all three round-3 fixes verified

Not a fourth round: no new front, no new mutation inventory. One commit moved.
`git diff 702d99cee..1391ab72e -- src worker` is **empty**, and no test file
changed; the commit touches four files, all documentation or this run's own
artifacts.

| Fix | Verdict | Evidence re-derived at `1391ab72e` |
|---|---|---|
| **P1-7** Rule 15 `transaction` facet | **LANDED** | The row now states the emitted value is `` `${request.method} ${routePath}` ``, cites `captureRequestError.js:20` (verified — `setTransactionName` really is line 20), gives the worked example `POST /api/dashboard/reviews/[reviewId]/approve` against the bare path (`approve` really is a POST route), and directs a CONTAINS/ends-with match, never equals, with the consequence spelled out. |
| **P1-8** D4's test figure | **LANDED** | D4 names the command and reports 2 files / 38 tests at HEAD, and records that it read 37 when written. Re-measured: **2 files, 38 tests, 38 passed.** |
| **P1-9** PR body's test figure | **LANDED** | "1054 tests / 86 affected suites" is gone. Replacement names `pnpm vitest run --changed 10377aa9b` and reports 26 files / 368 tests — re-measured **identically** (358 passed + 10 skipped under this pass's DB-less environment, 0 failed). Every other figure in the replacement also re-measured exact: helper suites **2 / 38**, `resolve-owner-scope.test.ts` **13**, numstat **21 added / 9 removed**. No new unverifiable figure. |

### The contains-match hazard, tested exhaustively

A CONTAINS match could fire on the wrong route if one enumerated path were a
substring of another. Checked against **all 142 `route.ts` paths under
`src/app/api`**:

- Every one of the twenty enumerated paths is a real route on disk.
- Exactly **one** enumerated path is a substring of another real route:
  `/api/dashboard/past-replies/draft`, which also matches
  `…/draft-status` and `…/draft/[responseId]`.
- **Both of those are already inside the enumerated twenty.** Over-match onto
  the other 122 API routes: **none**.
- So the union of twenty contains-conditions is exactly the twenty routes. No
  double-count either: an event-count threshold counts EVENTS, not matching
  conditions, and overlapping conditions in an `any` set pass an event once.
- `…/generate` is *not* a substring of `…/regenerate` at full-path granularity
  (`]/generate` vs `]/regenerate`), so those two do not collide.
- Ends-with is tighter still and is also correct for all twenty.

### Sidecar audit of the orchestrator's edit

- `arbiter_reasoning` on **P1-7, P1-8 and P1-9** each describes a change that
  genuinely landed; every sub-claim was re-resolved against the file it names.
  **Nothing overclaims.**
- Counts recompute: 11 inventory rows (all `excluded`), 14 findings — 12 `fixed`,
  2 `accepted-risk`, 0 open. `status: CLEAR` follows the precedence.
- **`intake_sha256` untouched** (`b44597b9…`), and the commit did not touch
  `.feature/intake.json` — the hash still matches the file on disk.
- Both authorizations preserved, including the `owner-1361-third-round`
  `finding_ids` linkage (P1-4, P1-5, P1-6) repaired earlier in this pass.
- `head_sha` refreshed to `1391ab72e5cad42e2aa48cefb0538baff4f00e78`;
  `round` stays 3.

### One observation, not a finding

The PR body's "26 files / 368 tests, **all passing**" holds where
`TEST_DATABASE_POOL_URL` is set (CI, and the gate's own full-suite log records
zero failures). Under this pass's scrubbed, DB-less environment two of those
files (10 tests) SKIP rather than pass — the counts still reproduce exactly and
nothing fails, so the figure is sound; the "all passing" qualifier is
environment-dependent, which is worth knowing but is not a defect.

---

## Same-round continuation — HEAD `bbb0ba54d`, verified across two rebases

The branch was rebased twice to satisfy the up-to-date merge requirement:
`10377aa9b` → `e737d7de9` (#1378 + its doc sweep) → `cb90d3f5e` (#1397). Every
SHA was rewritten. The pre-rebase SHAs quoted earlier in this report
(`322aeaa5d`, `702d99cee`, `1391ab72e`) remain resolvable objects, so that
evidence trail is still checkable.

| Item | Verdict | Evidence |
|---|---|---|
| **a** byte-identity vs `1391ab72e` | **HOLDS** | All three production files, all three test files, `src/instrumentation.ts`, the deviations plan, the plan and the intake: **IDENTICAL**. Two reviewed docs differ, both **purely additive, zero lines removed**. `.feature/intake.json` unchanged (`b44597b9…`). |
| **b** Rule 15 through #1397 | **HOLDS — prediction confirmed** | #1397 inserted +20/-0 at line 978, ~480 lines below Rule 15. The 63-line Rule 15 block hashes to the same `sha256:899c8f7bbb0dd043` at `1391ab72e` and at HEAD — **byte-identical, `transaction` clause included**. Rule headings 5, 6, 9, 10, 11, 12, 13, 14, 15 — **no duplicate**. #1397's block appears exactly once; **0 lines of main's runbook missing from HEAD**. |
| **c** arch-review-log | **HOLDS** | +1/-0 vs `1391ab72e`. The #1361 entry appears **exactly once** and is **sha-identical**; #1378's row exactly once; #1397 added no ledger row (it did not touch the file). Line counts reconcile: `cb90d3f5e` 2103 + 2 = HEAD 2105. **0 lines removed** vs the new merge-base. |
| **d** duty-4 re-sweep | **HOLDS** | Exactly **8** `instanceof AuthError` sites, same files and lines as round 3. #1397's docs-only claim **verified, not trusted**: every path in `cb90d3f5e` is under `docs/`, and `git diff e737d7de9 cb90d3f5e -- src worker` is empty. No new gate, no new catch-all-401. |
| **e** PR figures at the new fork | **HOLDS** | `pnpm vitest run --changed $(git merge-base origin/main HEAD)` → substitution resolves to `cb90d3f5e` → **26 files / 368 tests**, exactly as printed. Helper suites **2 / 38**; `resolve-owner-scope.test.ts` **13**; numstat **21 added / 9 removed** (30). Enumeration unchanged: 1/6/4 gate-consumer files, 142 `route.ts` under `src/app/api`. "Zero remaining catch-all-401 sites" still true. |

### The stale-citation defect and its rebase-proof repair

The first repair of P1-9 hardcoded `--changed 10377aa9b`. The rebase onto
`e737d7de9` made that command report **39 files / 581 tests** — 10377aa9b was no
longer the fork point, so the set swept in #1378's files. The figure beside it
stayed 26 / 368, reopening P1-9's exact failure mode one level down. The
command-substitution form now in the body cannot go stale, and it survived the
second rebase unchanged. P1-9's `arbiter_reasoning` has been updated to quote it.

The body also now discloses the DB-gated skip nuance this pass raised: two of the
26 files (10 tests) run where `TEST_DATABASE_POOL_URL` is set and skip without
it, with the counts reproducing either way.

### Housekeeping

The stray 0-byte untracked file `discord` is gone, and nothing in the tree
depends on a file of that name — the only two matches are a
`getChannel('discord')` negative-test string literal. `git status --porcelain` is
empty apart from this run's own two artifacts.

`fork_sha` and `merge_base_sha` were moved from `10377aa9b` to `cb90d3f5e` so the
sidecar's claimed review base is the branch's **actual** fork point. Leaving them
at `10377aa9b` would have passed the checker (it is still an ancestor) while
claiming a review scope that now contains #1378's and #1397's work, which this
pass did not review. `round` stays 3; `intake_sha256` untouched; both
authorizations and all 14 dispositions preserved unchanged.
