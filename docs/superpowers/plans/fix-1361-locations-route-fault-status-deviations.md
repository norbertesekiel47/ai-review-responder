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
Both suites this change actually touches pass: 37 tests across
`owner-route.test.ts` and `http-routes.test.ts`, plus 166 across the 13
consuming route suites.

## D5 — surface amendment 2: the third catch-all-401 site

**What the plan did not anticipate.** The review wave found a THIRD gate with the
same defect: `resolveOwnerScope` (`src/lib/auth/resolve-owner-scope.ts:106`)
wrapped any non-`AuthError` as `ScopeError('unauthorized', 401)` and discarded
the original error. Both the spec axis (Medium) and red team (P1) raised it;
red team called the original sweep incomplete. It fronts 5 more owner routes.

**The design question it raised, and how the CODE answered it.** `ScopeError`
carries `statusCode`, which consumers map straight to the HTTP status, so a raw
`throw err` looked like it would break their contract. It does not: all four
consumers already end their catch with a bare `throw error`
(`settings/postal-address/route.ts:93`, `dashboard/import-offer/route.ts`,
`past-replies/draft-status/route.ts:65`, `past-replies/_shared/edit-reply-request.ts:82`).
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

**What the plan did not anticipate.** The change makes 18 owner routes newly
emit an operator-actionable 5xx through `onRequestError`, with no entry in
`docs/runbooks/beta-launch-alerting.md`. Red team raised it as P1 and named the
precedent: Rule 10 (#1192) shipped its runbook row with the change that created
the same `onRequestError` signal.

**Action.** Added Rule 12, defined by ROUTE rather than by message — there is no
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
