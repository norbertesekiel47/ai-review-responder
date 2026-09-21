# Deviations — #1363 drip and alert email idempotency

Every entry is something the plan did not anticipate. Each carries a resolved
verdict; the `reviewed` transition refuses on an unresolved one.

> **Read D8–D13 first.** D1–D7 were written before the step-7 review wave and
> are kept as the historical record of what was built and why. The wave
> disproved several of their claims — D2's "the probe ALWAYS reads orphan" and
> D1's outbox-scoping rationale in particular — and reversed the design they
> describe. Where an entry below conflicts with D8–D13, D8–D13 is the as-built
> truth.

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
`Cannot find module '@vercel/turbopack/postcss'`. Three independent pieces of
evidence, measured rather than argued:

1. Checked out the then-merge-base `650f625e7` in this worktree and ran
   `pnpm build`: exit 1, with 31 occurrences of the identical error. The break
   predates the first commit on this branch. **Label correction (red team P1):**
   that measurement was taken BEFORE the step-7 rebase, so `650f625e7` was the
   merge-base at the time but is not the current one, which is `10377aa9b`. Red
   team re-measured at HEAD independently: exit 1, 567 Turbopack errors, 33 ×
   the same missing module, none naming a changed file. The conclusion survives;
   only the SHA label was stale.
2. CI run `35542835421` (2026-09-20, branch `fix/1360-tombstone-single-transaction`,
   cut from that same `650f625e7`) reports `build: success`. The build works on
   the Blacksmith runners and fails only on this machine.
3. `git diff --stat` against the merge-base lists four `.ts` files and five docs.
   No frontend component, no `next.config`, no CSS, no `postcss.config.mjs`, no
   `package.json`, no `pnpm-lock.yaml`.

`@vercel/turbopack/postcss` is a turbopack-internal virtual module, not a
lockfile entry, so it cannot be installed. `pnpm install`,
`pnpm install --frozen-lockfile --force` and a check of `@tailwindcss/postcss`
(present) all leave it unchanged. Diagnosing Next 16's turbopack/pnpm resolution
on this Mac is its own investigation touching dependency wiring — outside this
intake's surface and named in its non-goals — so it is NOT attempted here.

**Consequence, stated plainly rather than worked around.** The local gate cannot
reach full green on this machine, and no override was invented to make it read
green: `ci:weakened-checks` exists precisely to catch that move. CI's `build`
job is the authority for this row and must be confirmed on the PR before merge.

**`merge-ledger` — genuinely mine.** Fixed under D5.

**Verdict:** ACCEPT — neither the flake nor the pre-existing build break is
caused by, or fixable within, this branch. Both are stated in the PR description
so a reviewer is not asked to rediscover them.

---

## D8 — The review wave reversed the core design decision

**What happened.** Three of the five axes (Codex adversarial, async/operations,
spec & correctness) independently found that treating Resend's 409 as success
writes a synthetic `external_message_id`, and that `worker/ingress/resend.ts`
correlates bounce, delivered and complained events ONLY on the real Resend id. A
hard bounce on such a send therefore matches no row: `businesses.owner_email_bounced`
is never set and the owner keeps receiving mail at a dead address. Pre-change the
retry's second email carried a correlatable id, so this was a REGRESSION on
exactly the crash path the ticket targets.

The precondition nobody stated up front: a provider idempotency key only replays
the original response when the retry body is IDENTICAL. Any caller of
`createApprovalLink` mints a fresh `randomUUID` per attempt, so the day_7 drip
and the owner nudge were on the 409 path by construction.

**Resolution.** Put to the owner with the trade-offs; owner chose mark-before-send
for those two. day_1, day_30 and the three partner alerts render from stable
inputs, keep the key and lose no email.

**Verdict:** ACCEPT — this is the review wave doing its job. The alternative
(carrying a durable delivery identity to Resend as a tag and reconciling it in
the webhook) changes third-party ingress and is now a non-goal.

---

## D9 — T2 (`revokeMode: 'never'`) fully reverted, and its justification was wrong

**What happened.** Two things landed together. First, with mark-before-send there
is no retry on the two affected sends, so no second `createApprovalLink` call and
no revoke — the sub-fix has no remaining purpose. Second, spec & correctness
showed the justification was false anyway: the orphan probe keys on `response_id`,
and a response sitting in `pending_approval` normally DOES have an
`approval_request` delivery, so the probe does not "always read orphan". The real
exposure was much narrower than the five places I wrote it down claimed.

Async and red team separately disproved the bound I put in the docblock: links are
minted pre-send, so `'never'` would have added one live 48h link PER ATTEMPT, not
one per response.

**Resolution.** `src/lib/approval/create-link.ts` and
`src/lib/approval/__tests__/create-link.test.ts` are byte-identical to `main`.
The approval surface is untouched by this branch, which also removes invariant #5
from the risk surface entirely.

**Verdict:** ACCEPT — removing code beats keeping code whose stated reason is
false.

---

## D10 — The rework introduced a duplicate-send bug, caught by a pre-existing test

**What happened.** Completing the outbox row before the send is only half the
pattern. The owner nudge still rethrew on send failure, which fails the BullMQ
job; BullMQ retries on its own clock, the handler re-enters, finds no delivery row
(the cooldown probe's only record), mints fresh approval links and sends a SECOND
nudge — the exact duplicate the reordering exists to prevent.

The pre-existing test `throws on email send failure (BullMQ retries)` failed
immediately and pointed straight at it.

**Resolution.** The nudge swallows and logs, mirroring `WeeklySummaryWorker`'s
`sendSummaryReportEmail`, which does not rethrow for this reason. The drip does
NOT need the same treatment: its dedupe record is `onboarding_drip_log.sent_at`,
written before the send and re-checked at the top of the handler, so a retry exits
on the claim. That asymmetry is commented at both sites. The test was rewritten to
assert the new contract.

**Verdict:** ACCEPT — and worth recording that the existing suite caught a
regression in reworked code, which is the strongest evidence in this run that the
tests are load-bearing rather than decorative.

---

## D11 — Seven documentation claims of mine were false

**What happened.** The wave disproved, in addition to D8 and D9: (a) the
cooldown-based reason for outbox-scoping the nudge and partner alerts — cooldowns
are 3/7/14 **days**, far beyond the 24h key life, so a business-scoped key can
never collide; (b) "the seven pre-existing keys are all domain-scoped, no helper
precedent exists" — there are 13 keyed sites, `NotificationFailoverPoller` already
uses a per-attempt claim id, and `src/lib/account-offboarding/email-dedup.ts` is a
named key-builder helper; (c) "the ten existing callers are unaffected" — three
pre-existing keyed callers inherit the new 409-as-success branch; (d) "every retry
path completes in minutes" — the 24h window is reachable; (e) the observability
promise — an identical-body replay never reaches 409, so the operator query is a
floor, not a total, and the logs do not name the key as claimed.

**Resolution.** All corrected in the intake, the plan, the glossary and the
architecture review log. (a) changed the CODE as well as the prose: every key is
now domain-scoped, which is also strictly stronger because it covers the poller's
re-mint path.

**Verdict:** ACCEPT. The pattern is worth naming: the code survived adversarial
mutation testing almost untouched, while the prose explaining it did not survive
first contact with a reviewer. Confident explanations written alongside code are
the least-verified artifact in a run.

---

## D12 — Red team P1: the replay log line had no oracle

**What happened.** Deleting the `idempotentReplay` destructuring and all four log
lines left 61 tests green. The durable half — the `idempotent-replay:` delivery
row — is written from `messageId` regardless, so it stayed pinned; only the
operator-facing log had nothing asserting it.

**Resolution.** Added `a drip replay logs that the email was already delivered`,
which spies on the logger sink. Verified by mutation: changing the log string
fails that test and only that test.

**Verdict:** ACCEPT.

---

## D13 — Two missed siblings of the same defect, filed not fixed

**What happened.** Red team enumerated other send-then-mark paths.
`worker/jobs/AdminExceptionWorker.ts:138-150` has the identical shape, and its
guard at `:114` tests `exception.status !== 'open'` — a status nothing in `src/`
or `worker/` ever writes, so it can never fire on a retry. I verified both
claims. `worker/ingress/resend.ts:284` carries the same shape on the hard-bounce
admin alert.

**Resolution.** Owner chose to file rather than fix. Both are internal
admin-directed emails, both sit outside this edit surface, and adding them would
be surface amendment #2 on a branch whose review wave has already run. Recorded
as non-goals in the intake.

**Verdict:** ACCEPT.

---

## D14 — Three review rounds, and what they actually cost

**The shape of the run.** Round 1 (5 axes) reversed the core design. Round 2
(2 agents) found that the reversal failed silently on both new paths. Round 3
(owner-authorized, the cap) found that round 2's fix re-opened round 2's own
finding, because I added the durable failure records without the try/catch that
`.claude/rules/worker-layout.md` requires by name.

**Estimate corrected again.** `estimated_test_lines` 320 -> 660. The test churn
roughly doubled across the rounds: each round's findings bought new tests (the
three replay-log oracles, the keyed-drip ordering negative, two failure-record
paths, two best-effort guards), and several existing assertions had to be
strengthened rather than merely updated. Re-classification re-run: `size: small`,
`risk: high`, `surface: backend` — all unchanged for the third time. The lane was
right throughout; my estimates were not.

**Verdict:** ACCEPT.

---

## D15 — The last commit is newer than the pass that justified it

**What happened.** Structural, and worth stating rather than hiding. Each round's
fixes necessarily post-date the round that demanded them, so the red-team sidecar
is stale by one commit at the moment of shipping. Round 3 was authorized
precisely to close that gap for round 2's fixes, and round 3 is the protocol cap
— there is no round 4 to close it for round 3's.

**What stands behind the final commit instead:** two hand-run mutation checks
(removing either new guard fails exactly one test, and it is the test written for
it), 69 green tests across the three affected suites, and a full gate green on
every row but the pre-existing local `build`.

**Resolution.** Not papered over. `red-team-status.mjs` is NOT forced, the
`reviewed` phase is not claimed, and the PR description states the gap in plain
words. I considered editing the sidecar's `head_sha` to match HEAD and rejected
it: that would assert evidence at a commit red team never examined, which is the
exact lie the checker exists to catch.

**Verdict:** ACCEPT — with the caveat carried into the PR rather than resolved.
