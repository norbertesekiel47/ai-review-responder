# Deviations — `fix/1361-locations-route-fault-status`

## D1 — surface amendment: `.claude/reference/arch-review-log.md`

**What the plan did not anticipate.** The `merge-ledger` audit fails any PR that
changes a production file and adds no line to `.claude/reference/arch-review-log.md`.
That file sits outside every tree the locked surface covered, so the gate went
RED on a file the workflow itself mandates.

**Action.** Added `.claude/reference/arch-review-log.md` to
`allowed_edit_surface` in both intake copies. Counted as surface amendment 1 of 2
(`scripts/feature-state.sh incr-amendment`). The rule auto-approves an amendment
only inside an already-covered tree, so this one is reported to the owner rather
than treated as silent.

**Verdict:** ACCEPT — the audit is a required CI check; the alternative is a
branch that cannot pass `lint`. The amendment adds one documentation file and
narrows nothing.

## D2 — `estimated_prod_lines` corrected 8 → 24

**What the plan did not anticipate.** The `reclassify` gate row counts changed
production lines including comments. The two `throw err;` statements are 2 lines;
the two citation comments explaining WHY a server fault must not read as 401 are
19 more. 21 changed lines against an estimate of 8 tripped the 2× trigger.

**Action.** Re-ran step 0 with the real numbers. SIZE stays **small**, RISK stays
**high**, SURFACE stays **backend** — the lane does not change. Estimate
corrected to 24 in both intake copies (24 covers the ledger line from D1).

**Verdict:** ACCEPT — an estimating error, not a scope change. The lane is
unchanged, so no re-plan is owed.

## D3 — the `build` gate row fails on `main`, before this change

**What the plan did not anticipate.** `pnpm build` fails in this worktree with
567 copies of `Error: Cannot find module '@vercel/turbopack/postcss'`, every one
of them in a landing-page CSS import.

**Evidence that it is not this change.** Reverted all four changed files to
`650f625e` (the merge-base, which equals `origin/main`), rebuilt, and got a
byte-identical failure: same 567 errors, same module, same components. Then
restored the committed files. Ruled out as causes: `pnpm install --frozen-lockfile`
reports "Already up to date"; `@next/swc-darwin-arm64@16.3.0` matches the host
(`arm64 darwin`); `postcss`, `tailwindcss` and `@tailwindcss/postcss` are all
installed; clearing `.next` and rebuilding reproduces it exactly.

This change touches two `.ts` files under `src/lib/` and their tests. It imports
no CSS, no component and no PostCSS plugin.

**Action.** Not fixed on this branch. It is a worktree-environment defect on
`main`, in the same class as the known local ESLint react-hooks plugin linking
breakage (2026-09-20 session note: pre-existing on `main`, passes in CI). CI runs
`pnpm build` on a fresh Blacksmith install, which is the authoritative signal.

**Second proof, from CI rather than from this machine.** PR #1389 — the merge
that produced `650f625e`, this branch's merge-base — has a **green `build`
check** (54s, run 35542835421). The same tree that fails here builds in CI. The
defect is this worktree's environment, not the code.

**Verdict:** ACCEPT — out of scope for #1361, with the pre-existence proven twice
rather than asserted: by revert-and-rebuild locally, and by CI's green `build` on
the merge-base. The gate carries this row as a known-RED environmental row; the
PR's own `build` check is the authoritative gate and must be green before merge.

## D4 — one unrelated test timed out under gate load

**What the plan did not anticipate.** Gate round 2's `test` row failed on one
test: `scripts/ci/__tests__/red-team-mutation-runner.test.ts > Operator
same-round continuation safeguards > runs an admitted baseline mutant and
restoration with corroborated report evidence`. It exceeded the 30,000 ms
timeout. The same row PASSED in gate round 1.

**Evidence that it is a load flake, not a defect.** Run alone the test passes in
**19.4 s** against a 30 s budget — a 10.6 s margin that a parallel Turbopack
compile (the RED `build` row, 567 errors) consumes. The suite exercises
`scripts/ci/red-team-mutation-runner`. This change touches `src/lib/locations/`
and `src/lib/approval/` and shares no module, fixture or file with it.

**Action.** Not fixed on this branch. Re-running the gate would very likely clear
it, but the `build` row keeps the gate RED regardless, so a re-run changes no
decision.

**Verdict:** ACCEPT — an unrelated timing flake, reproduced green in isolation.
Both suites this change actually touches pass: `pnpm vitest run
src/lib/locations/__tests__/owner-route.test.ts
src/lib/approval/__tests__/http-routes.test.ts` reports 2 files / 38 tests at
HEAD (it was 37 when this entry was first written, before the round-2 work added
`re-throws a non-Error rejection value unchanged` to the approval suite), plus
166 across the 13 test
FILES under those route directories. That is a directory count, not a
gate-consumer count: three of those files consume no changed gate, and the set
predates D5 so it excludes the eight routes `resolveOwnerScope` fronts. The
round-2 pass measured the correct set at 13 files / 171 tests, and the three
changed helper suites at 51.

## D5 — surface amendment 2: the third catch-all-401 site

**What the plan did not anticipate.** The review wave found a THIRD gate with the
same defect: `resolveOwnerScope` (`src/lib/auth/resolve-owner-scope.ts`)
wrapped any non-`AuthError` as `ScopeError('unauthorized', 401)` and discarded
the original error. Both the spec axis (Medium) and red team (P1) raised it;
red team called the original sweep incomplete. It fronts 5 more owner routes.

**The design question it raised, and how the CODE answered it.** `ScopeError`
carries `statusCode`, which consumers map straight to the HTTP status, so a raw
`throw err` looked like it would break their contract. It does not: all four
consumers already end their catch with a bare `throw error`
(`settings/postal-address/route.ts`, `dashboard/import-offer/route.ts`,
`past-replies/draft-status/route.ts`, and BOTH sites in
`past-replies/_shared/edit-reply-request.ts` — five call sites across four files,
re-counted by the round-2 red-team pass).
The raw re-throw therefore needs no `ScopeError` 500 variant and no `cause`
plumbing — it matches the other two gates exactly.

**Action.** Owner decided to fix it on this branch rather than defer it. Surface
amendment 2 of 2, recorded with a reason. Added
`src/lib/auth/resolve-owner-scope.ts` and its test file. The test that pinned the
401 (`requireRole throws non-AuthError plain Error → wraps as ScopeError 401`)
is REPLACED by two re-throw cases.

**Verdict:** ACCEPT — an owner decision taken with the finding in front of them.
It completes the sweep the issue's framing ("this file") caused us to under-scope.

## D6 — surface amendment 2: the runbook row

**What the plan did not anticipate.** The change makes 20 owner routes newly
emit an operator-actionable 5xx through `onRequestError`, with no entry in
`docs/runbooks/beta-launch-alerting.md`. Red team raised it as P1 and named the
precedent: Rule 10 (#1192) shipped its runbook row with the change that created
the same `onRequestError` signal.

**Action.** Added Rule 15, defined by ROUTE rather than by message — there is no
wrapper class and no constant text to filter on, because the rejection propagates
unchanged. It tells the operator to read the Postgres pool and the admission
chokepoint before the auth path, and states explicitly that "fixing" the gate
back to 401 is the #1361 defect. Runbook requirement only; no Sentry rule was
installed.

**Verdict:** ACCEPT — the operational half of this change, shipped with it rather
than left open.

## D7 — three factual errors in this branch's own artifacts

Found by the review wave, in documents this run wrote. Each is corrected, not
merely noted.

1. **Wrong line citations.** The ledger entry cited `owner-route.ts:69` and
   `http-routes.ts:151` — the PRE-change line numbers. At HEAD `:69` is `return {`
   and `:151` is the first line of the new comment; the functions are at `:26`
   and `:141`. The entry now cites paths only, which cannot rot.
2. **Wrong diff size.** The entry said "24 lines". The measured production diff
   was 21 at that point (24 was the intake ESTIMATE, which included the ledger
   line itself). It now says 30, measured across all three files.
3. **Wrong test count.** D4 said "187 across the 12 consuming route suites".
   Re-measured: 166 across 13 files. The 187 came from a four-path vitest run
   that also included `src/lib/escalations` and reported 8 skips, mislabelled as
   the route suites.

**A fourth correction, to a CLAIM rather than a number.** The intake, a test
comment and the PR body all said the 401 "let the client sign the owner out".
Both Codex and red team measured it: no client of these routes branches on 401,
and there is no global interceptor or sign-out chain. Misleading "session
expired" messaging existed; an auto sign-out did not. The claim is withdrawn in
all four places rather than softened silently.

**Verdict:** ACCEPT — all four corrected at the source. The lesson belongs in the
lab notes at step 8: a figure copied from a vitest run with a different file set
is not evidence for the set you name in prose.

## D8 — round-2 red team found three P1s in the runbook row itself

Round 2 ran at HEAD `322aeaa5d`, scoped to the fix hunks. **0 of 6 scored
mutants survived.** All three round-1 P1s verified genuinely fixed, and the
duty-4 sweep at HEAD found **zero remaining catch-all-401 siblings** — the four
other `instanceof AuthError` sites (three Zernio routes plus
`connect/_shared/finalize/authorize.ts`) already fall through to
`zernioRouteErrorResponse`, which reports and answers 500. The sweep is complete.

All three new P1s were defects in the runbook row written for D6, not in code.
Each is fixed, not waived.

1. **Wrong route count.** The row said "Affected routes — 18". The measured
   count is **20**: 4 behind `readOwnerForMultiLocationRoute`, 8 behind
   `requireDashboardReviewOwner`, and **8** behind `resolveOwnerScope` — I had
   counted the five `past-replies` edit routes that reach it through
   `_shared/edit-reply-request.ts` as one. This mattered more than an ordinary
   number: Rule 15 is defined by its ROUTES and nothing else, so the list IS the
   filter, and a missing route is an outage the rule silently does not cover.
   The row now enumerates all twenty by gate and says that plainly.
2. **Rule number collision.** The row was numbered "Rule 12". A **Rule 12 —
   Operator retained-veto invariant failure (Run C)** already exists earlier in
   the same file, and Rule 13's prose ("Rule 12 filters Apply POST") was
   unambiguous before and would have resolved to either. Renumbered to **15**,
   the next free number after 14.
3. **The rule could not be configured.** It argued for "a frequency, not every
   event" and supplied no number, no rule name, no level, no window, no throttle
   and no destination — the only rule in the file with neither a table row nor a
   table, while its own Scope paragraph told the operator to "read the saved rule
   and destination back". It now carries the standard four-column row:
   `owner-gate-server-fault → discord`, `error` with default stack grouping, 10
   events in 1 hour counted ACROSS the route filter, 60-minute action throttle,
   integration 443670. The threshold is lower than Rule 14's 20 because these are
   owner-initiated mutation routes with far lower volume, and the row says so.

**Two P2s accepted without further widening.**
- `edit-reply-request.ts:82` and `:189` — nothing pins the consumer-layer
  re-throw that the `resolveOwnerScope` fix's rationale rests on. Replacing both
  with a catch-all 401 reintroduces the #1361 defect one layer up on five routes
  and leaves 123/123 past-replies tests green. Graded P2 by the pass because
  both lines are byte-identical at the merge-base — pre-existing untested
  behaviour, not something this change introduced. Covering it means a third
  surface amendment on a branch that has already taken the two the abort
  criteria allow. **Follow-up, not this branch.**
- D5's `resolve-owner-scope.ts:106` citation pointed at a comment after the fix
  landed — the exact rot D7 sets the "cite paths only" standard against, two
  sections later in this same file. Corrected to a path.

**Verdict:** ACCEPT — every P1 fixed at the source, both P2s adjudicated with a
stated reason. The lesson for step 8: a rule defined by an enumeration has no
fallback filter, so the enumeration is load-bearing and must be counted, not
estimated.

## D9 — round 3 found three more P1s, and all three were mine again

Round 3 ran at HEAD `702d99cee` under the owner's explicit third-round
authorization, aimed at the DOCUMENTATION rather than the code: rounds 1 and 2
had killed 13 of 13 scored mutants, while round 2's three P1s were all defects
in prose this run wrote. That aim was correct. Round 3 found three more, all
mine, none in code.

1. **P1-7 — the runbook rule would never have fired.** Rule 15 told the operator
   to filter on `transaction` "(Next's route path)". `Sentry.captureRequestError`
   sets it to `` `${request.method} ${routePath}` `` — verified in the installed
   `@sentry/nextjs` at `build/cjs/common/captureRequestError.js:20`. The value is
   `POST /api/locations/add`, not `/api/locations/add`. An operator building
   twenty equals-filters from the enumeration would match nothing, and the rule
   would stay silent through a full pool outage — the exact silence it exists to
   remove, with no tag or message fallback by its own design. The row now states
   the method-space-path shape, gives a worked example, and says to use a
   CONTAINS match, never equals. **This is the worst defect this branch
   produced**, and it was in the fix for a previous finding.
2. **P1-8 — a stale figure INSIDE the sentence that a previous fix corrected.**
   D4 said "37 tests". Measured at HEAD: 38. The round-2 work added
   `re-throws a non-Error rejection value unchanged` to the approval suite.
   Commit `0197bd4bc` rewrote the clause after the comma to fix P1-2/P2-5 and
   left the `37` immediately before it untouched. Same defect class, same
   paragraph, surviving the correction pass for it.
3. **P1-9 — an unfalsifiable figure in the PR body.** "1054 tests pass across the
   86 affected suites" names no measurable set. This repo defines "affected" as
   `vitest run --changed <since>` (package.json `test:changed`, `lefthook.yml`,
   `scripts/verify-gate.sh`), which gives 26 files / 368 tests. Round 3 measured
   six candidate reconstructions and none matched. It could not prove the number
   false — which IS the defect: a figure that names no set cannot be checked.
   The PR body now names the exact command.

**The pattern, stated plainly because it is the lesson.** Three rounds produced
three findings of one class: `187 across the 12 consuming route suites`
(round 1), `166` with the wrong label (round 2), `37` and `1054/86` (round 3).
Every one came from quoting a figure produced by an ad-hoc `vitest` invocation
and then describing the file set in prose that did not match what was run. D7
set the standard after the first; it was violated twice more.

**The rule this run should have followed from the start:** never write a
measurement without the command that produces it, in the same sentence. A number
whose command is not stated is not evidence, and the reviewer who tries to check
it will find a different one.

**Verdict:** ACCEPT — all three fixed at the source. The third round the owner
authorized paid for itself: the P1-7 defect would have shipped a runbook rule
that could not fire, and no code-focused review would have caught it.
