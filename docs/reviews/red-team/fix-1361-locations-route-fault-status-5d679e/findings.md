# Red team — `fix/1361-locations-route-fault-status`

- **Mode** feature · **Round** 1 · **Risk** high
- **Fork / merge-base** `10377aa9bc8db7be9f7af1fdd2c5418ba81fabe9`
- **HEAD** `e1db9ecbcb8555d3bb115d61ac800777f2bfedfa`
- **Intake** `.feature/intake.json` is absent on this branch (the live copy is
  `.feature/intake.parked.json`; the committed copy is
  `docs/superpowers/plans/fix-1361-locations-route-fault-status-intake.json`), so
  `intake_sha256` is `null`. Risk is taken as `high` from the orchestrator's
  dispatch and from the committed intake's `"risk": "high"`.
- **Status** `OPEN_P1` — 0 mutants survived in scope; three P1s need adjudication.

## 1. Preconditions

| Check | Result |
|---|---|
| Tracked tree clean at HEAD | yes — porcelain showed only the untracked `docs/reviews/fix-1361-.../` review-wave directory |
| Watchers | `mutation-runner watchers` → none |
| Round | `round-start` → round 1 open, 20 min / 400 launches |
| Environment | `mutation-runner env --tmp-home $(mktemp -d)` → allowlist only; `REPWORTH_DISABLE_LIVE_DB_SUITES=1` (no validated local DB) |
| dotenv | `dotenv-swap` swapped 1 file (`.env.local`); restored at finalize, no `.red-team-backup` left |
| Restoration | `finalize` → both files restored; `git hash-object` on each equals `git rev-parse HEAD:<path>` |

**Restoration note (verifier tooling, not this change).** Mutants were chained
onto the same file (mutate over a mutant) rather than restored between each.
`finalize` then processes journal entries forward and aborts on every entry whose
recorded original no longer matches the working blob, restoring exactly one layer
per invocation. Four `finalize` passes were needed to peel the stack. No foreign
content was ever written — every abort reported "nothing touched" — and the final
state is byte-identical to HEAD. Future runs should restore before re-mutating the
same path.

## 2. Inventory and mutation results

### Direction A + B — the changed production hunks and their covering tests

Two behaviour-affecting hunks: `src/lib/locations/owner-route.ts:74` and
`src/lib/approval/http-routes.ts:157`, each replacing a catch-all
`401 Unauthorized` return with `throw err;`.

Green baselines at HEAD: all five covering tests passed individually under the
isolated environment (`assert-one-test` confirmed exactly one executed test per
launch).

| # | Mutant | Target | Test | Outcome |
|---|---|---|---|---|
| 1 | **A** — `throw err;` reverted to the pre-fix `return { ok:false, response: 401 Unauthorized, LOCATION_ROUTE_NO_STORE }` | `owner-route.ts:69-74` | `re-throws when requireRole rejects with a non-AuthError` | **killed** |
| 2 | **A** (same) | `owner-route.ts:69-74` | `re-throws a non-Error rejection value unchanged` | **killed** |
| 3 | **B** — `if (err instanceof AuthError)` → `if (true)` | `owner-route.ts:60` | `re-throws when requireRole rejects with a non-AuthError` | **killed** |
| 4 | **C** — `if (err instanceof AuthError)` → `if (false)` | `owner-route.ts:60` | `maps AuthError to the route response status and message` | **killed** |
| 5 | **E** — `throw err;` reverted to `return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS })` | `http-routes.ts:151-157` | `re-throws a non-AuthError rejection instead of masking it as 401` | **killed** |
| 6 | **F** — guard → `if (true)` | `http-routes.ts:148` | `re-throws a non-AuthError rejection instead of masking it as 401` | **killed** |
| 7 | **G** — guard → `if (false)` | `http-routes.ts:148` | `maps auth failures and owner rows without an account to no-store responses` | **killed** |

**Mutants A and E are byte-exact reversions.** The runner reported
`src/lib/locations/owner-route.ts 9189c8950e79 -> d0a4a3f1e164` and
`src/lib/approval/http-routes.ts bbe7a7afa4af -> 8837aad99ebe`; both mutant OIDs
are the merge-base blob OIDs from the diff headers (`index d0a4a3f1e..9189c8950`
and `index 8837aad99..bbe7a7afa`). The mutant was literally the pre-fix file, and
every covering test went red. **Claimed evidence 1 and 6 hold, and hunt (a) finds
no survivor.**

**Hunt (b) is answered affirmatively for the guard.** Forcing the `AuthError`
branch always-taken (`true`) is caught by the re-throw tests; forcing it
never-taken (`false`) is caught by the AuthError-mapping tests in both suites.

### Out-of-scope probes (recorded, not scored)

| # | Mutant | Target | Result |
|---|---|---|---|
| 8 | **D** — `err instanceof AuthError` → `(err as {name?:string})?.name === 'AuthError'` | `owner-route.ts:60` | survived both tests |
| 9 | **H** — same substitution | `http-routes.ts:148` | survived both tests |

Both mutate a line this diff does not touch (`if (err instanceof AuthError)` is
byte-identical at the merge-base in both files), so they are **excluded from the
in-scope mutant score** — the boundary forbids opening a front against unchanged
code, and the same unpinned property holds for the repo's reference
implementation `requireRoleOr401` (`src/lib/auth/route-helpers.ts:120`). Recorded
as **P2-1** because the measurement is real: no test in either suite distinguishes
`instanceof` from a `name` comparison, and the two differ for any thrown value
whose `name` is `'AuthError'` but which is not an instance (it would be mapped
with `statusCode === undefined`, which `NextResponse.json` renders as **200**).

### Direction B — consuming route suites (excluded, with evidence)

Ten route suites front the changed gates. None enters the mutation score,
because **none exercises the changed branch**: every one of their 401 cases rejects
`requireRole` with an `AuthError` (`add.test.ts:207`, `archive.test.ts:123`,
`promote-primary.test.ts:107`, `reactivate/route.test.ts:161`,
`reviews/__tests__/actions.test.ts:373`), and the timeline and escalations suites
mock `requireDashboardReviewOwner` itself to *return* a 401 `NextResponse`
(`timeline/__tests__/route.test.ts:40-43`,
`escalations/__tests__/routes.test.ts:88`). Mutants A/E therefore cannot reach
them. That is itself the coverage shape the spec-correctness reviewer recorded:
the two helper suites are the ONLY oracle for this change.

## 3. Duty 2 — fragile assertions

None found.

`await expect(...).rejects.toBe(fault)` is **not** a fragile identity assertion —
it is the strictly correct oracle for a contract that says "re-throws the
rejection unchanged". Measured, not argued: mutant A resolves the promise instead
of rejecting it and the assertion fails, so `rejects` carries the "did it throw
at all" half and `toBe` carries the "uncoerced" half. A mutation that re-wrapped
the fault (`throw new Error(String(err))`) would also fail it. **Claimed evidence
6 and hunt (c) find nothing.** The one theoretical looseness — `toBe('redis down')`
cannot distinguish the original primitive from an equal copy — is inherent to
string primitives, not a weakness of the test.

## 4. Duty 3 — docs vs reality, re-resolved at HEAD `e1db9ecb`

`prevalidate-plan.py` was present and was run.

| Claim | Cited as | Resolves at HEAD? |
|---|---|---|
| `requireRoleOr401` re-throws a non-AuthError | `route-helpers.ts:119-124` | **yes** — `catch (err) { if (err instanceof AuthError) {…} throw err; }` |
| The docstring naming this drift as a past bug | `route-helpers.ts:86-110` | **yes** |
| The deliberate `requireAdminWithAal2` asymmetry | `route-helpers.ts:99-106` | **yes** |
| The file's own `assertSameOrigin` re-throw | `owner-route.ts:43-54` | **yes** |
| `onRequestError = Sentry.captureRequestError` | `src/instrumentation.ts:9` | **yes**, exactly line 9 — **claimed evidence 5 holds** |
| The two changed sites | `owner-route.ts:69`, `http-routes.ts:151` | **yes** — both land on the first line of the `#1361` comment inside the changed catch (they cite the hunk, not the symbol declaration; not a finding) |

`prevalidate-plan.py docs/superpowers/plans/fix-1361-….md` → **PASS** (4 citations,
0 unresolved). Deviations doc → **PASS**. `.claude/reference/arch-review-log.md`
reports 9 unresolved citations and 3 stale commits, but **every one belongs to an
older entry** (`judge/failed-hook.ts`, `csv-ingest/failed-hook.ts`,
`BusinessDetailClient.tsx`, `carousel.css`, `pricing/page.tsx`,
`operator/turns/route.ts`, `settings/auto-approval/route.ts`, `CONTEXT.md`,
`ProblemSection.tsx`) — none appears in the paragraph this diff adds.
Pre-existing, out of scope, not reported as a finding.

**Claimed evidence 4 verified and reproduced.** `npx vitest run
src/lib/locations/__tests__/owner-route.test.ts
src/lib/approval/__tests__/http-routes.test.ts` → **2 files, 37 tests, all pass**;
`npx vitest run src/app/api/locations src/app/api/dashboard/reviews
src/app/api/dashboard/escalations` → **13 files, 166 tests, all pass**.
37 + 166 = **203**. The "203 tests" claim is TRUE.

**But the committed deviations doc states a different, non-reproducing number** —
see **P1-2**.

**Claimed evidence 2 holds by construction.** The diff does not touch either
`AuthError` branch: both still build `{ error: err.message }` at `err.statusCode`
with `LOCATION_ROUTE_NO_STORE` / `NO_STORE_HEADERS`. Mutants C and G prove those
branches are asserted.

## 5. Duty 4 — missed sibling cases

**Patterns searched** (scope `src/` + `worker/`, excluding `**/__tests__/**`):

1. `rg "instanceof AuthError" -A 6` — every discrimination site on the auth-refusal class.
2. `rg --pcre2 "catch\s*\((\w+)?\)?[^\n]*\{" -A 8 … | rg 401` — every `401` inside the first 8 lines of a catch block.
3. `rg "errorToResponse"` and its definition, to classify the Zernio family.

**Result — seven catch sites, one of them a genuine third instance of the defect.**

| Site | Non-`AuthError` behaviour | Verdict |
|---|---|---|
| `src/lib/auth/route-helpers.ts:123` | `throw err` | reference implementation |
| `src/lib/locations/owner-route.ts:74` | `throw err` | fixed here |
| `src/lib/approval/http-routes.ts:157` | `throw err` | fixed here |
| `src/app/api/zernio/connect/_shared/finalize/authorize.ts:75` | `throw err` | clean |
| `src/app/api/zernio/connect/{start,cancel}/route.ts`, `src/app/api/zernio/disconnect/route.ts` | `errorToResponse(err)` → `zernioRouteErrorResponse` (`internal_error` 5xx) | clean |
| **`src/lib/auth/resolve-owner-scope.ts:106`** | **`throw new ScopeError('unauthorized', 401)`** | **P1-1 — the identical drift, left open** |

## 6. Duty 5 — operational completeness

**Client-side handlers — no gap.** Every browser caller of the twelve routes reads
an error body defensively and falls back to a generic message with the status:
`postLocationAction` (`LocationsPanel.tsx:22`), `handlePromote`
(`LocationsPanel.tsx:375`), `postDashboardAction` (`ReviewActions.tsx:47`) and
`readJsonSafe` (`useInlineGenerate.ts:124,180,205`) all use
`.json().catch(() => ({}))` or equivalent, so a bodyless 500 degrades to
"Archive failed" / "Posting failed (500)." rather than an unhandled throw.
**No client of these twelve routes keys on 401 at all** — the 401 branches in
`RequestsClient.tsx:627,699`, `approval-client.tsx:224` and
`PlanPickerClient.tsx:51` belong to the solicitation, token-approval and checkout
flows. See **P2-2**.

**Claimed evidence 3 verified, and widened.** No direct caller wraps either gate in
a `try` — in all ten route files and `runEscalationTransitionRoute` the gate call
precedes the file's first `try` line. The HOF wrapper is also clean:
`withSameOrigin()` (`route-helpers.ts:54-65`) try/catches **only**
`assertSameOrigin` and then `return handler(req, ...args)` outside the try, so a
handler rejection propagates. Seven of the twelve export through it.

**Alerting — the missing half.** See **P1-3**.

## 7. Findings

### P1-1 — a third catch-all-401 site was left open

`src/lib/auth/resolve-owner-scope.ts:106`

```ts
} catch (err) {
  if (err instanceof AuthError) {
    throw new ScopeError(err.message, err.statusCode);
  }
  throw new ScopeError('unauthorized', 401);   // ← any server fault, as 401
}
```

Structurally identical to the two sites this change fixed: a non-`AuthError`
rejection from `requireRole` — a Postgres outage inside `loadAppUser`, a Supabase
transport failure — is relabelled `unauthorized` at 401. Every consumer maps
`ScopeError.statusCode` straight onto the response status:
`edit-reply-request.ts:79` and `:186`, `import-offer/route.ts:132`,
`past-replies/draft-status/route.ts:60-63`, `settings/postal-address/route.ts:91`.

**Failure scenario.** The pooler drops under load. The owner's
`/api/dashboard/past-replies/draft-status` poll, the edit-reply POST, the
import-offer GET/POST and the postal-address GET/POST all answer **401
`{"error":"unauthorized"}`** with a no-store header — exactly the masking #1361
exists to remove — and, being caught-and-returned rather than thrown, the fault
never reaches `onRequestError` and Sentry stays silent. The fix lands on 12 routes
and leaves ~6 more with the defect.

The intake's `non_goals` forbid touching other auth gates on this branch, so the
proportionate dispositions are **rejected-with-a-follow-up-issue** or
**accepted-risk**; the arbiter decides. What is not sound is closing #1361 while
the arch-review-log records "the approval gate carried the identical defect and
was found by grep, so both landed together rather than leaving a known twin open"
with no mention that a third twin exists.

### P1-2 — the deviations doc's test count does not reproduce

`docs/superpowers/plans/fix-1361-locations-route-fault-status-deviations.md:85-87`

> "Both suites this change actually touches pass: 37 tests across
> `owner-route.test.ts` and `http-routes.test.ts`, plus **187** across the 12
> consuming route suites."

37 reproduces exactly. **187 does not**, under any grouping tried at HEAD:

| Set | Files | Tests |
|---|---|---|
| The three route directories (`api/locations`, `api/dashboard/reviews`, `api/dashboard/escalations`) | 13 | **166** |
| The ten strictly-consuming suites | 10 | **157** |
| Ten consuming + `generate-version.integration` + `lib/escalations/transitions` + `locations/display-label` | 13 | 171 |

166 + 37 = **203**, which is the number reported to the reviewer and which this
pass confirms. The doc's 187 implies a total of 224 — it contradicts the same
run's own headline figure by 21 tests. Green CI does not make a documented count
true; the fix is a one-line correction to 166 (and to "13 suites", since
`escalations/__tests__/route.test.ts` covers the LIST route, which is not a
consumer of either gate).

### P1-3 — a newly emitted operator-actionable signal with no runbook row

`src/lib/locations/owner-route.ts:74`, `src/lib/approval/http-routes.ts:157`,
against `docs/runbooks/beta-launch-alerting.md`

The change's entire purpose is to make a class of fault *visible*: a DB/Redis
outage behind `requireRole` now escapes twelve owner-facing routes and is captured
by `onRequestError` (`src/instrumentation.ts:9`). That is a new
operator-actionable terminal failure path the diff adds. Duty 5's rule is that an
emitted signal with no rule row is a P1, and
`docs/runbooks/beta-launch-alerting.md` carries **no row, no filter, and no triage
entry** for it — `rg "1361|locations/add|owner-route|requireDashboardReviewOwner"`
over the runbook returns nothing.

**Failure scenario.** Supabase's pooler degrades. Sentry fills with untagged
`Error` events from seven distinct route stacks (default exception-stack grouping,
no `subsystem` tag, no custom fingerprint), the on-call has no rule to route them
and no runbook row saying what they are or what to check first — the precise gap
Rule 10 (`beta-launch-alerting.md:472-495`) was written to close for the
`ADMIN_APP_URL` fault, which is the same `onRequestError` shape.

The proportionate remedy is small and matches the existing precedent: a **Rule 12
runbook requirement** naming the emitted identity (an uncaught exception escaping
these route handlers), the filter (source project/environment, no invented tags),
the grouping caveat (stack-based grouping splits by call site — do not promise one
issue), and the operator's first move (check Supabase/Upstash health before the
code). Rule 10's own closing sentence — "This is a runbook requirement only: no
Sentry rule … was installed" — is the template; no Sentry rule needs to exist for
this to be discharged.

### P2-1 — `instanceof AuthError` vs a `name` comparison is unpinned

`src/lib/locations/owner-route.ts:60`, `src/lib/approval/http-routes.ts:148`

Mutants D and H (above) survived all four AuthError/re-throw tests. Out of the
mutation score because the line is unchanged by this diff and the property is
shared with `requireRoleOr401`, but recorded so the next pass does not re-measure
it: a thrown value with `name === 'AuthError'` and no `statusCode` would render as
a **200** response under the name-comparison variant. No test would notice.

### P2-2 — the "signs the owner out" motivation is unsupported

`docs/superpowers/plans/fix-1361-locations-route-fault-status-intake.json`
(`user_visible_behavior[2]`) and
`src/lib/locations/__tests__/owner-route.test.ts:158`

> "The browser no longer reads a server fault as a logged-out session, so it no
> longer signs the owner out." / "…and let the client sign the owner out."

No client of the twelve routes keys on 401 (§6). There is no global fetch
interceptor and `src/proxy.ts` does not act on an API route's status. Every
`signOut()` call in the repo is an explicit user action or a login-flow guard
(`AccountMenu.tsx:61`, `AdminIdentity.tsx:25`, `useLoginSubmit.ts:88-113`,
`FinishSignupClient.tsx:75`). The 401→5xx change is still right for the reasons
the arch-log gives (Sentry visibility, an honest status); the sign-out benefit as
written cannot be observed, and a later reader who tries to verify it will not be
able to. A one-clause correction in the test comment is enough.

## 8. Authorizations

None. No finding is accepted-risk on this pass.

## 9. Claimed-evidence scorecard

| # | Claim | Verdict |
|---|---|---|
| 1 | Both gates re-throw a non-AuthError; a server fault surfaces as 5xx | **holds** — mutants A/E (byte-exact pre-fix reversions) killed by four tests |
| 2 | AuthError 401/403 responses byte-identical, no-store included | **holds** — branch untouched by the diff; mutants C/G prove it is asserted |
| 3 | No caller wraps either gate in a try, across 12 routes | **holds, and widened** — `withSameOrigin()` also does not catch handler rejections |
| 4 | 203 tests pass across the two helper suites and the consuming route suites | **holds, reproduced** (37 + 166); but the deviations doc's own 187/224 contradicts it — **P1-2** |
| 5 | `onRequestError` at `src/instrumentation.ts:9` captures the escaped error | **holds** — resolves at exactly line 9 |
| 6 | The replaced test's three replacements are strictly stronger | **holds** — the deleted case pinned the defect; all three replacements kill the reversion |
| a | Mutation: revert each `throw err;` | **0 survivors** |
| b | Mutation: tamper with the `instanceof AuthError` guard | `true`/`false` both **killed**; a `name` comparison survives (**P2-1**, unchanged line) |
| c | Fragile `rejects.toBe(fault)`? | **no** — measured, it is the correct oracle |
| d | A third catch-all-401 site? | **yes — `resolve-owner-scope.ts:106` (P1-1)**; the sweep was incomplete |
| e | Doc citations re-resolved | all six of this diff's citations **resolve**; the arch-log's 9 unresolved are older entries |
| f | Operational completeness | clients are safe; **no alerting row for the new signal (P1-3)** |
