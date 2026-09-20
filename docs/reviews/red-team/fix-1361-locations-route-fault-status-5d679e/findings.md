# Red team — #1361 owner-gate fault status — ROUND 2 (supersedes round 1)

- **Branch:** `fix/1361-locations-route-fault-status`
- **Mode:** feature · **Risk:** high · **Round:** 2
- **Fork / merge-base:** `10377aa9bc8db7be9f7af1fdd2c5418ba81fabe9`
- **Round-1 head:** `e1db9ecbcb8555d3bb115d61ac800777f2bfedfa`
- **Head under test:** `322aeaa5d6e8919767482b73733f21fc805190ff`
- **Generated:** 2026-09-20T23:40:38Z
- **Status:** `OPEN_P1` (11 findings: 0 P0, 3 open P1, 4 open P2, 4 fixed)

This round is SCOPED. It verifies round 1's three P1s and two P2s, red-teams the
production code round 1 never saw (`src/lib/auth/resolve-owner-scope.ts`), and
audits the doc and runbook hunks added since `e1db9ecbc`. It opens no front
against code unchanged since that SHA; the one measurement that touched a
directly affected caller is recorded as P2 and as an `excluded` inventory row,
not scored as a survivor.

## Budget and hygiene

- 17 launches, **15 s** of 1200 s round budget. No `skipped-budget` row.
- Mutants were applied **one layer at a time**: every `mutate` was followed by
  `finalize` before the next `mutate` on that path, and each restore was
  verified by `git hash-object <path>` against `git rev-parse HEAD:<path>`
  before the path was touched again. All four verified equal
  (`resolve-owner-scope.ts` e5cbabece697…, `http-routes.ts` bbe7a7afa4af…,
  `owner-route.ts` 9189c8950e79…, `edit-reply-request.ts` 495e542210109cb…).
- Environment: `mutation-runner.mjs env --tmp-home` allowlist plus
  `dotenv-swap` for every mutation phase; `REPWORTH_DISABLE_LIVE_DB_SUITES=1`
  (no validated local database). Re-swapped after each `finalize`, and the
  final `finalize` left `.env.local` restored with no backup.
- `watchers`: none. `git status --porcelain --untracked-files=no` is empty at
  the end of the pass.
- `prevalidate-plan.py` was NOT used; every doc citation below was hand-checked
  against HEAD `322aeaa5d` and the command that checked it is quoted.

## Round-1 verdicts

| Round-1 finding | Verdict | Evidence |
|---|---|---|
| **P1-1** `resolveOwnerScope` catch-all 401 | **FIXED** | 4 killed mutants + 5 consumer catch sites read |
| **P1-2** D4's "187 across 12 suites" | **FIXED** (number) | 166/13 reproduces exactly; label residue → P2-5 |
| **P1-3** no alerting-runbook row | **FIXED** (row exists) | Rule at `beta-launch-alerting.md:497`; two new defects in it → P1-5, P1-6 |
| **P2-1** `instanceof` vs `name` | open, **not worsened** | mutant M6 survived — identical to round 1, positive arm untouched |
| **P2-2** "signs the owner out" | **FIXED** | withdrawn in intake, test comment and arch-review-log |

## Duty 1 — mutation

Six mutants, all **killed**. Three `excluded` measurements recorded for
completeness.

| Mutant | File:line | Test | Outcome |
|---|---|---|---|
| M1 — revert fix to `throw new ScopeError('unauthorized', 401)` | `resolve-owner-scope.ts:113` | re-throws a non-AuthError rejection … | killed |
| M1 | `resolve-owner-scope.ts:113` | re-throws a non-Error rejection value unchanged | killed |
| M3 — `if (err instanceof AuthError)` → `if (true)` | `resolve-owner-scope.ts:103` | re-throws a non-AuthError rejection … | killed |
| M3 | `resolve-owner-scope.ts:103` | re-throws a non-Error rejection value unchanged | killed |
| M4 — guard → `if (false)` | `resolve-owner-scope.ts:103` | requireRole throws AuthError → throws ScopeError … | killed |
| M5 — revert to pre-fix 401 return | `http-routes.ts:156` | **(new test)** re-throws a non-Error rejection value unchanged | killed |
| M6 — guard → `name === 'AuthError'` | `resolve-owner-scope.ts:103` | both AuthError and re-throw tests | excluded — survived, unchanged line |
| M7 — both consumer `throw err` → catch-all 401 | `edit-reply-request.ts:82,189` | whole `past-replies` directory (123 tests) | excluded — survived, unchanged line → P2-3 |

M5's mutant blob OID `8837aad99ebe` is the merge-base blob OID round 1 recorded
for `http-routes.ts`, so the mutant is the pre-fix file byte-for-byte.

**No assertion class was lost** when the old 401 test was replaced. The deleted
test asserted three things: `ScopeError` class, message `unauthorized`, status
401. Class + message + status are still asserted for the AuthError arm
(`resolve-owner-scope.test.ts:124-133`) and for `no_business`
(`:159-171`, `:248`), and mutant M4 proves the AuthError arm is live rather than
vestigial. `rejects.toBe(boom)` is strictly stronger than the deleted
`toMatchObject` for the branch it replaced: it pins error IDENTITY, which is
precisely what the old code discarded.

## The raw re-throw is safe for every consumer — verified, not taken on trust

The fix's justification is "all four consumers already end their catch with a
bare `throw error`". Checked at HEAD; there are FIVE call sites across those
four files, and every one matches:

| File:line | Shape |
|---|---|
| `src/app/api/settings/postal-address/route.ts:90-93` | `if (error instanceof ScopeError) return jsonResponse(…); throw error;` |
| `src/app/api/dashboard/import-offer/route.ts:129-135` | `if (err instanceof ScopeError) return {ok:false,…}; throw err;` |
| `src/app/api/dashboard/past-replies/draft-status/route.ts:59-65` | same shape |
| `src/app/api/dashboard/past-replies/_shared/edit-reply-request.ts:76-82` | same shape |
| `src/app/api/dashboard/past-replies/_shared/edit-reply-request.ts:183-189` | same shape |

None swallows, none returns 200, none reads `.statusCode` off an unguarded
error. Three further checks:

1. **No route handler wraps the preamble in a swallowing `try`.** All 20 route
   files call their gate/preamble helper OUTSIDE the handler's own `try`
   (`import-offer/route.ts:140,160`; `past-replies/{draft,publish}/route.ts:69,73`;
   `past-replies/draft/[responseId]/route.ts:62,154`;
   `past-replies/[responseId]/{retry,restore-original}/route.ts:56,58`), and the
   only wrapper in the chain, `withSameOrigin` (`route-helpers.ts:54-64`),
   re-throws anything that is not a `SameOriginError`.
2. **The contract is not newly widened.** `resolveOwnerScope` could already
   throw a raw non-`ScopeError` before this change — lines 143 and 148 re-throw
   `Promise.allSettled` rejection reasons — so consumers were already obliged to
   handle it.
3. **`ScopeError` is constructed or caught in exactly 6 files** (`rg ScopeError
   src/ worker/`): the owner module, the four consumers above, and two test
   files. Nothing else is affected by the change.

## Duty 3 — docs vs reality at `322aeaa5d`

Resolved by hand. Correct, each re-checked at HEAD:

- `src/instrumentation.ts:9` — `export const onRequestError = Sentry.captureRequestError` ✓
- `src/lib/db/admission.ts` exists ✓
- the three gate symbols and their files ✓
- Rule 12's `safety-review-failed-closed` cross-reference resolves to Rule 14 at
  line 460, which is genuinely ABOVE it ✓
- "30 lines across three files" — `git diff --numstat 10377aa9b..322aeaa5d` over
  the three production files is 21 added + 9 removed = **30** ✓
- the Rule 10 precedent for shipping a runbook REQUIREMENT with no Sentry rule
  installed, and for carrying no §1/§1a checklist entry, both hold ✓

Wrong:

- **"eighteen consuming routes" / "Affected routes — 18"** — the measured count
  is **20** (see P1-4). Appears at `beta-launch-alerting.md:515`,
  `arch-review-log.md:37` (twice) and deviations D6.
- **`resolve-owner-scope.ts:106`** in deviations D5 — at HEAD that line is a
  comment (see P2-4).
- **"the 13 consuming route suites"** — the number is right, the label is not
  (see P2-5).

## Duty 4 — sibling sweep, re-run at HEAD

`rg 'instanceof AuthError' -A 8` over `src/` and `worker/`, excluding
`__tests__`. Seven sites: the three fixed gates, the reference
`requireRoleOr401` (`route-helpers.ts:120`, already the correct contract), and
four Zernio routes — `connect/start`, `connect/cancel`, `disconnect`, and
`connect/_shared/finalize/authorize.ts`. All four Zernio sites fall through to
`zernioRouteErrorResponse` (`src/app/api/zernio/_shared/error-response.ts`),
which reports through `reportCaughtError` and answers **500 `internal_error`**,
or re-throw. **Zero remaining catch-all-401 siblings** — a sound search that
found nothing. The class is closed.

## Duty 5 — operational completeness

The rule row exists and is largely right, but three of the six facets are
missing and the rule number collides. See P1-5 and P1-6.

## Findings

| ID | Severity | At | Disposition | Finding |
|---|---|---|---|---|
| P1-1 | P1 | `src/lib/auth/resolve-owner-scope.ts:113` | **fixed** | third catch-all-401 site — now `throw err;`, 4 mutants killed |
| P1-2 | P1 | deviations `:86` | **fixed** | test count now reproduces exactly (166 / 13 files) |
| P1-3 | P1 | `beta-launch-alerting.md:497` | **fixed** | alerting rule row now exists |
| P1-4 | P1 | `beta-launch-alerting.md:515` | open | affected-route count is 18 in three docs; measured 20 |
| P1-5 | P1 | `beta-launch-alerting.md:497` | open | duplicate "Rule 12" — collides with the Run C rule at `:436`, and Rule 13 cites "Rule 12" at `:454` |
| P1-6 | P1 | `beta-launch-alerting.md:521` | open | the rule has no name, level, threshold value, window, throttle or destination — it cannot be built |
| P2-1 | P2 | `src/lib/auth/resolve-owner-scope.ts:103` | open | `instanceof` vs `name` unpinned — measured, NOT worsened by this diff |
| P2-2 | P2 | `owner-route.test.ts:160` | **fixed** | "signs the owner out" withdrawn in all three checkable places |
| P2-3 | P2 | `edit-reply-request.ts:82` | open | the consumer-layer re-throw the fix depends on is unpinned (M7 survived, 123/123 green) |
| P2-4 | P2 | deviations `:90` | open | D5 cites `resolve-owner-scope.ts:106`, which is a comment at HEAD |
| P2-5 | P2 | deviations `:86` | open | "13 consuming route suites" — 3 of the 13 consume nothing; 8 newly-consuming routes are outside the set |

Full reasoning for each finding is in `findings.json`; it is the authoritative
copy and this table is rendered from it.

## Authorizations

None.

## Operational note — not a finding

`.feature/intake.json` was renamed to `.feature/intake.parked.json` at 16:35
during this pass (it was present at 16:31 when `round-start` ran; nothing in the
red-team tooling performs that rename). `red-team-status.mjs` consequently fails
with `feature mode requires .feature/intake.json as the locked contract` and
`cannot derive risk`, independently of this sidecar's contents. The orchestrator
must restore the intake before the `reviewed` transition can pass, and this
sidecar records `intake_sha256: null` because the file is absent.

## Appendix — untriaged, outside this round's scope

Nothing was found against code unchanged since `e1db9ecbc` other than the two
measurements already recorded above as P2-1 and P2-3, both of which are
deliberately graded P2 because their lines are byte-identical at the merge-base.
