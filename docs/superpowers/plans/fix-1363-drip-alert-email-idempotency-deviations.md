# Deviations — #1363 drip and alert email idempotency

Every entry is something the plan did not anticipate. Each carries a resolved
verdict; the `reviewed` transition refuses on an unresolved one.

---

## D1 — The chosen key scope under-fixed the defect the issue names

**What happened.** During grilling I recommended scoping every key to the outbox
row id, and the owner signed that off. Checking the code afterwards showed seven
existing Resend keys in this repo are all `<template>:<domain identity>`, and
more importantly that the drip's stale-claim takeover
(`worker/jobs/OnboardingDripWorker.ts:227-236`) admits a SECOND outbox row onto a
claim still carrying `sent_at IS NULL`. Two rows carry two ids, so an
outbox-scoped key cannot dedupe the exact path the issue quotes.

**Resolution.** Raised to the owner with both pieces of evidence and reversed for
one of the three sites: the drip is domain-scoped
(`onboarding_drip_<drip_type>:<business_id>`), the nudge and partner alerts stay
outbox-scoped because they recur on a cooldown and have no domain identity. The
mixed shape is documented at each call site and in the **Send idempotency key**
glossary entry.

**Verdict:** ACCEPT — the correction happened before any code was written, and
the resulting design closes the defect the issue actually names.

---

## D2 — Repair A alone made the owner strictly worse off on two sites

**What happened.** Not in the issue and not in my first read. `createApprovalLink`
mints a fresh `randomUUID()` per call, so the Day 7 drip and owner nudge bodies
differ every attempt, which makes Resend's 409 their NORMAL retry path. Worse,
`revokeMode: 'orphaned_only'` probes `notification_deliveries` by `response_id`
and two link-carrying template names; both senders record a delivery with a NULL
`response_id` and a template on neither list, so the probe ALWAYS reads "orphan"
and the retry revoked the link the owner had already received. While a duplicate
email was being sent that was survivable — the owner got a working replacement
link. Suppressing the duplicate would have left them holding only a dead link.

**Resolution.** Raised to the owner as a scope question. Owner chose to fix it in
this run. Added `revokeMode: 'never'` and passed it from the two sites. Bounded
by the existing 48-hour link TTL; regenerate still revokes everything.

**Verdict:** ACCEPT — the idempotency fix is not correct without it, so this is
in scope rather than adjacent work.

---

## D3 — The replay path needed no worker change beyond logging

**What happened.** The plan assumed T3 and T4 would need explicit replay
handling. The first RED run showed the replay tests passing before any worker
edit: both handlers already record whatever `messageId` they receive and complete
the outbox row unconditionally, so a replay was already handled correctly.

**Resolution.** Kept the tests as behaviour pins — they are what stops a future
refactor from "optimising away" the delivery write on a replay, which would leave
the drip claim open and (for the nudge) destroy the cooldown record. Added only
the log line.

**Verdict:** ACCEPT — fewer production lines than planned, and the tests earn
their place as regression pins rather than as drivers.

---

## D4 — `revokeMode: 'never'` needed no new branch

**What happened.** The plan predicted this and it held: `shouldRevoke` starts
`revokeMode === 'always'` and the second test is an explicit
`revokeMode === 'orphaned_only'`, so `'never'` falls through both. T2's RED
signal came from `pnpm typecheck`, not from vitest — the runtime already behaved
correctly and only the union rejected the literal.

**Resolution.** Shipped as a union widening plus tests that lock the runtime
behaviour, with a comment warning that rewriting the second test as
`revokeMode !== 'always'` would silently make `'never'` revoke.

**Verdict:** ACCEPT.

---

## D5 — Surface amendment #1: `.claude/reference/arch-review-log.md`

**What happened.** `ci:merge-ledger` fails any PR that changes production files
without adding a line to the architecture review log. The intake's edit surface
did not include it, because CLAUDE.md describes that log as a step-8 after-merge
chore. The audit wants the line in the PR itself.

**Resolution.** Surface amendment, counted. It adds one file, outside a tree the
surface already covers, so it is recorded here rather than treated as free.

**Verdict:** ACCEPT — required by a CI audit, not discretionary.

---

## D6 — Estimate breach: 163 production lines against an estimated 70

**What happened.** The gate's `reclassify` row fired: changed production lines are
163 against `estimated_prod_lines: 70`, over the 2x trigger.

**Analysis.** Executable churn is small. The four TypeScript files carry 155
changed lines and the four doc files carry 8. The large majority of those 155 are
comments — this codebase's house style records WHY at the call site (see the
existing `Drip staleness cap` block in the same handler), and three of the
decisions here are ones a future reader would otherwise reverse: why the drip key
is domain-scoped while its neighbours are outbox-scoped, why two of Resend's
three idempotency codes still throw, and why `'never'` must not be rewritten as
`!== 'always'`.

**Re-classification (step 0 re-run with real numbers).** `size: small`,
`risk: high`, `surface: backend` — all three unchanged. The estimate was wrong;
the lane was not. Nothing about the re-run changes the workflow this branch
follows.

**Resolution.** Corrected `estimated_prod_lines` to 165 in both intake copies and
recorded the breach here rather than deleting comments to fit a number I guessed
before reading the call sites.

**Verdict:** ACCEPT — estimate corrected, lane confirmed unchanged.

---

## D7 — Two gate rows fail for reasons outside this branch

**What happened.** The `--review` gate returned RED on three rows. Only one was
mine.

**`test` — flake, not a failure.**
`scripts/ci/__tests__/red-team-mutation-runner.test.ts > runs an admitted
baseline mutant and restoration with corroborated report evidence` timed out at
30000ms inside the full parallel run with coverage. Re-run in isolation: 250
passed, 0 failed. It exercises the red-team tooling and touches none of the four
files this branch changes.

**`build` — pre-existing on `main`, local only.** `Turbopack build failed`,
`Cannot find module '@vercel/turbopack/postcss'`. Verified empirically rather
than argued: checked out the merge-base `650f625e7` in this worktree, ran
`pnpm build`, exit 1 with 31 occurrences of the identical error. `pnpm install`
reports "Already up to date". This branch changes no frontend, config, CSS or
dependency file — `git diff --stat` against the merge-base lists only four `.ts`
files and four docs. CI builds `main` as a required check, so the break is local
environment drift.

**`merge-ledger` — genuinely mine.** Fixed under D5.

**Verdict:** ACCEPT — neither the flake nor the pre-existing build break is
caused by, or fixable within, this branch. Both are stated in the PR description
so a reviewer is not asked to rediscover them.
