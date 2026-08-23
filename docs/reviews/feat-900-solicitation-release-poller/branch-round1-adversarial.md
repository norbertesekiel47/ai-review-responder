# Branch round 1 — Adversarial approach review (#900)

**Axis:** the approach, the design choices, the assumptions. Not line-level defects — two sibling
agents own those.
**Base:** `53bb0fcf` · **Branch:** `feat-900-solicitation-release-poller` · **RISK:** high
**Date:** 2026-08-22

**Tool path:** the `codex:adversarial-review` plugin skill ran cleanly on the first attempt —
`codex-companion.mjs adversarial-review --background --base 53bb0fcf`, thread
`01a02af9-5aa8-74f1-8b0c-77a44dc2acf7`, exit 0, verdict `needs-attention` with two `high` findings.
**No `codex:codex-rescue` and no direct `codex exec` fallback was needed.** Codex's two findings are
adopted below (F1, F3) with independent verification against the source; F2, F4, F5 and F6 are my
own. I did not run any test suite, per the concurrency constraint.

**Prior rounds read first:** `plan-round{1,2,3}-codex.md`. None of the six findings below repeats a
finding from those rounds. Two of them (F1, F2) are *compositions* of things the prior rounds fixed
individually and never checked against each other.

---

## Findings

| severity | area | finding |
|---|---|---|
| HIGH | poller lifecycle / cap enforcement | The 45s `withTimeout` frees the single-flight flag without cancelling `runReleaseCycle`, so a slow cycle keeps running detached while the next tick starts a second one — the account and platform caps live in per-cycle in-memory counters, so overlapping cycles bypass them, and the recorded deviation that skipped the overlap test asserts the opposite. |
| HIGH | Judge downgrade × `batch_expired` sweep | A downgrade clears `approved_at` without resetting `built_at`, and P3 latches any `approved_at IS NULL` batch past `built_at + 7d` — so a transient Judge outage can convert an owner-approved batch into a silently cancelled, un-re-approvable one, on the very next tick, with no notification on either step. |
| HIGH | P4 candidate selection | `ORDER BY approved_at ASC LIMIT 50` selects the OLDEST candidates, which are the ones most likely to belong to already-capped accounts; a newly approved batch sorts last and can be starved out of every tick until the 72h sweep cancels it. |
| MEDIUM | module shape (the one-export monolith) | The single-`runReleaseCycle` export forces all five phases to run in every test; that coupling already produced the branch's own "strongest RE-PLAN candidate", resolved by weakening a phase-2 assertion. |
| MEDIUM | tenant-scope registry | The intake's invariant declares ONE allowlisted cross-account read; the branch ships SEVEN, and the allowlist's human-readable ledger comment records only two of them (`383 → 385`) against a constant that moved to `390`. |
| MEDIUM | error isolation | No phase has per-item error isolation, and the module argues both sides of that in its own docstrings: phase 1 refuses to throw on a missing lazy child *because it would abort phases 2–5*, then throws unconditionally two statements earlier, and phase 4 throws in a way that takes the backstop join with it. |

---

## F1 — HIGH — the timeout does not cancel the cycle, so overlapping releasers bypass the caps

**Design decision challenged:** locked decision — *"Caps are enforced in the releaser ONLY. The
single-replica worker serializes them by construction"* (intake invariant; module header lines
44–48; amendment B3). Plus the accepted deviation at
`feat-900-solicitation-release-poller-deviations.md:386` — *"An interval-driven overlap is therefore
unreachable."*

**Why it fails.** The brief asks whether "we would be paged" is adequate cover for a
correctness-critical single-replica assumption. The answer is worse than "inadequate": **the
assumption is already false on ONE replica**, and the replica registry would never fire.

`worker/background/guarded-poll.ts:106-113`:

```ts
inFlight = true;
try {
  await withTimeout(runCycle(logger), timeoutMs, label);
} catch (err) {
  logger.error(onErrorMessage, toError(err));
} finally {
  inFlight = false;   // ← released on TIMEOUT, not on cycle completion
}
```

and the helper's own contract, `guarded-poll.ts:77-82`:

> *"Contract: a timed-out cycle **keeps running detached** (see `withTimeout`). Cycles that hold a
> resource across the deadline must tolerate a late settle; the loops using this helper commit
> per-row/per-tx work (idempotent across ticks) **or only read**, so a late settle is harmless."*

`runReleaseCycle` is the first consumer that does not satisfy that precondition. It is not merely
"idempotent per row" — it holds three **in-memory** capacity counters across the whole cycle
(`platformRemaining`, `accountRemaining`, `budgetRemaining`, `release.ts:822-925`), each seeded by a
`COUNT(*)` read taken once and then decremented locally. A detached cycle carries stale counters; a
fresh cycle re-reads `countPlatformDispatchAttemptsToday` from a database that does not yet reflect
the detached cycle's in-flight transactions. Both then release.

**Reachability.** A tick performs up to five platform-wide scans plus up to `RELEASE_SCAN_LIMIT`
(50) *separate transactions per phase* — phase 1 per-row, phase 2 per-batch, phase 3 per-batch,
phase 5 per-batch — through the #773 admission chokepoint, which explicitly "trades latency for
never wedging". 45 s is not a remote ceiling for that shape; it is a plausible steady state at
modest scale. And once cycles chronically exceed 45 s, **the pile-up is unbounded**: every 60 s tick
spawns another concurrent cycle, because nothing ever tells the flag the previous one is still
alive. N concurrent cycles release 2N rows/minute with no shared counter.

**What the branch tested instead.** The deviation at line 386 reasoned that `CYCLE_TIMEOUT_MS (45s)
< DEFAULT_INTERVAL_MS (60s)` makes "an interval-driven overlap unreachable", deleted the overlap
assertion that had failed, and replaced it with a test that a timed-out cycle *frees the flag and
the loop recovers*. That is the #414 property — it is true, and it is not the property at issue.
Freeing the flag is precisely the mechanism that **creates** the overlap here. The same false
premise is load-bearing again in `getIntervalMs` (`SolicitationReleasePoller.ts:43-55`), which
rejects any configured interval `<= CYCLE_TIMEOUT_MS` on the grounds that "a shorter interval would
let ticks land on an in-flight cycle" — a guard against the wrong failure.

**Blast radius.** Not double-sends: migration 091's `job_outbox_solicitation_send_inflight` index
and the `rendered → queued` CAS both hold per row. The breach is the **volume governors** — the
per-account daily cap and the platform ceiling, i.e. the blast-radius bound on a shared sending
identity that the Send breaker exists to protect. Exceeding it is the reputational failure the whole
send-mode design is built around.

**What would settle it.** Either a durable cross-cycle lease (a DB-backed advisory lock taken for
the cycle, released on completion), or moving capacity reservation into each release transaction so
it is atomic rather than in-memory. A test that lets a cycle time out, continue, and overlap the
next tick — the one the deviation removed.

---

## F2 — HIGH — a Judge blip can silently and irreversibly cancel an approved batch

**Design decision challenged:** two decisions the plan made independently and never composed —
locked decision 4 (*"A Judge downgrade writes a spine step and a Sentry warning. No owner
notification"*) and the `batch_expired` sweep (P3, amendment B7). Round 1 finding 2 moved the Judge
split to last *because a downgrade is destructive*; round 1 finding 7 hardened the downgrade CAS
against a concurrent halt. **Neither round asked what happens to the batch after the downgrade
succeeds.**

**The chain, verified end to end:**

1. `downgradeApproval` (`release.ts:1094-1141`) sets `approved_at`, `approval_method`,
   `approved_by_user_id`, `veto_deadline_at` to NULL. It does **not** touch `built_at`.
2. `deriveBatchState` (`outreach.ts:103-115`): with `approved_at` now NULL, state falls through to
   `now >= built_at + BATCH_APPROVAL_WINDOW_DAYS ? 'expired' : 'built'`.
3. `approveBatch` (`approval.ts:280-286`) refuses anything but `state === 'built'` — the comment is
   explicit: *"`expired` lands here: past built_at + 7 days neither lane may approve (D2)."* So an
   `expired` downgraded batch **cannot be re-approved by the owner**.
4. P3 (`selectExpiredBatches`, `release.ts:706-731`) selects exactly `approved_at IS NULL AND
   built_at <= NOW() - 7 days AND halted_at IS NULL AND send_closed_at IS NULL AND EXISTS (send
   parent)`. A downgraded batch matches all five — it necessarily has a send parent, because
   `approveBatch` refuses `no_send_parent`. On the **next tick**, phase 3 latches `batch_expired`,
   `latchSystemHalt` cancels every live Outreach row, and `closeBatchIfSettled` terminalizes the
   parent `cancelled`.
5. Neither step notifies the owner. The downgrade is silent by locked decision 4; the system halt is
   actor-less by design (`halted_by IS NULL`).

**The stated behavior is therefore false for this class.** The intake promises: *"A Judge outage
before the first release returns the batch to owner review: … the batch reappears as approvable in
the Requests panel."* For any batch already past `built_at + 7d` it reappears as **`expired`**, is
un-approvable, and is destroyed on the next tick.

**Reachability.** The Judge split fires only for a batch that passed the flag, the breaker, the
platform ceiling, the account cap and the subscription check and still has capacity — so the exposure
window is "approved, veto deadline passed, first release not yet made". That window is short by
default but is *stretched by every governor the design deliberately ships*: an exhausted account cap
holds the first release until the next UTC day (up to 24 h); an open Send breaker holds it for as
long as the breaker is open (the intake explicitly accepts multi-day breaker openness); a lapsed
subscription holds it indefinitely inside the 72 h window; a `SOLICITATION_SEND_ENABLED` flag-off
holds it for the duration of the flag-off. Any of those, plus an approval landing in the last stretch
of the 7-day approval window, plus a Judge probe failing at the moment capacity returns, and an
owner-approved batch is destroyed with no record the owner can see.

**Why it is an approach finding, not a defect.** No single line is wrong. The composition is: #900
introduces both the **only writer that clears `approved_at`** and the **only sweep that punishes a
cleared `approved_at`**, and the plan's self-review table lists them in different rows (D18 → Task 3;
B7 → Task 5) with nothing connecting them. The cheapest fixes are all design choices, not patches:
stamp a `downgraded_at` and exclude recently-downgraded batches from P3; or extend the approval
window on downgrade; or make the downgrade conditional on the batch remaining approvable; or — the
one the plan already declined — notify the owner.

---

## F3 — HIGH — `approved_at ASC LIMIT 50` starves the newest batches behind the capped oldest ones

*(Codex finding 2, independently verified and sharpened.)*

**Design decision challenged:** P4's ordering and bounding — `ORDER BY b.approved_at ASC LIMIT
${scanLimit}` (`release.ts:947-969`), justified as *"the oldest approval leads, so a lost join is
never starved behind a newer batch"* — combined with the intake's edge case *"A tick that hits the
per-tick release budget leaves the remaining due rows for the next tick; **no row is skipped
permanently**."*

**Why it fails.** The scan bounds candidates *before* any per-account gate runs. An account at its
daily cap is skipped with `continue` (`release.ts:882-887`) but **its batches remain candidates for
the full 72 h send window** — P4 has no arm that excludes a capped account, and cannot have one,
because the cap is evaluated per account after the scan.

Now note which batches the ordering favours. `approved_at ASC` selects the *oldest* approvals. Those
are exactly the batches whose accounts have had the most time to exhaust a 10/day cap. A batch
approved five minutes ago sorts **last**. So the steady state, once roughly `scanLimit` batches are
in flight platform-wide, is: the 50 oldest candidates are drawn from accounts already capped for the
remainder of the UTC day, every tick re-selects the same 50, every tick withholds all 50 at
`account_cap`, and a freshly approved batch is never examined at all. It is not released, it accrues
no `sending_started_at`, and 72 h later phase 2 latches it `send_window_elapsed` and cancels it.

That is `no row is skipped permanently` failing in the strongest possible way: the row is skipped
until it is destroyed.

**Reachability.** Fifty concurrent approved batches platform-wide is a modest number — one
multi-location account with 50 locations reaches it alone, and so do 25 accounts with two batches
each. It requires no failure of any component; the caps working exactly as designed produce it.

**What would settle it.** Cursor- or round-robin-based candidate selection across accounts, or
overfetching and continuing to scan until capacity is used or candidates are exhausted. The
"oldest-first" rationale in the docstring is about lost joins, which is phase 5's concern (`P5` has
its own ordering) — it does not require phase 4 to order the same way.

---

## F4 — MEDIUM — the one-export monolith already cost the branch a weakened assertion

**Design decision challenged:** the header's own argument — *"Deliberately the module's ONLY export
beyond its vocabulary: the phase order is a domain rule, so a caller that could run the phases
separately could run them wrongly. The phases' predicates are disjoint, which is what makes each one
testable through this single interface by seeding only its own state."* (`release.ts:157-162`).

**The argument is weaker than it reads, on both halves.**

*The protection is against a hypothetical nobody can commit.* There is exactly one production caller
(`SolicitationReleasePoller.ts`), it is a composition root registered in `worker/index.ts`, and
invariant #15 already fixes where the singleton may be imported. Exporting `sweepUnknownOutreach`
for a test does not let production run the phases wrongly; it lets a *test* run one phase. The
module has already conceded that callers may supply knobs — `ReleaseCycleOptions` exposes
`perTickBudget` and `scanLimit` purely for testability. It declines the one knob that would actually
decouple the phases while accepting two that do not.

*The cost is not hypothetical — it has already been paid.* From this branch's own deviations file,
the entry the step-6 read-back names **"the strongest RE-PLAN candidate on the branch, because
editing a test to match code is the classic failure mode"**:

> `Task 6 — the unknown sweep reaches a sending row the send-window sweep's own fixture expected it
> to leave alone`

That is precisely the failure the "disjoint predicates" claim says cannot happen: a phase-2 test's
fixture was contaminated by phase 1, because there is no way to run phase 2 alone. The resolution
was to weaken the phase-2 assertion. The read-back's defence is sound as far as it goes (the
invariant retains a direct test in `approval-system-halt.integration.test.ts`, which calls the latch
alone) — but note *why* that direct test is trustworthy: because it bypasses `runReleaseCycle`
entirely. The escape hatch the module refuses to export is the same one the strongest test already
had to reach around.

**Consequence, stated concretely:** every one of the 39 promised tests must arrange state that
avoids tripping four phases it is not testing, against a 1,806-line integration suite. That is the
real cost of the shape, and the branch has one recorded instance of it producing a weakened
assertion rather than a fixed one. What the alternative would have cost: two or three additional
non-public exports (or an `phases?` option) and a paragraph in the header saying the poller must call
`runReleaseCycle` and nothing else.

---

## F5 — MEDIUM — "one allowlisted cross-account read" shipped as seven, and the ledger records two

**Design decision challenged:** the intake's invariant — *"Invariant #8 — every read and write is
scoped by `account_id` and `business_id`. `countPlatformDispatchAttemptsToday` is **the one**
allowlisted cross-account read."*

**What shipped.** Seven new `tenantScopeAllowlist` entries, one for every predicate in the module:
P4 (×2 tables), P2, P3 (×2 tables), P1, P5. `ALLOWLIST_BASELINE` moves `383 → 390`. Every single
query the release lane issues is platform-wide. Each entry's `reason` is unusually well argued — I
am not disputing the individual justifications, several of which are genuinely forced (a
platform-wide unwedger cannot be handed a tenant id). The finding is that **the intake stated the
scope of this exemption as "one" and the branch delivered seven without that count ever being
re-declared**, which is the same class of root cause the branch already recorded for its four
surface amendments ("the intake declared one of four governance registries").

**And the ledger is now wrong.** The human-readable audit trail above `ALLOWLIST_BASELINE` gained
exactly one bullet:

```
//   - 2026-08-22 (383 → 385): #900's release-candidate scan …
export const ALLOWLIST_BASELINE = 390;
```

The comment describes a `+2` for P4 only; the constant records `+7`. Five of the seven new
cross-account exemptions have no ledger entry at all. The deviations file shows the increments
landing one task at a time (`386 → 388`, `388 → 389`), so this is drift, not a typo — but the ledger
comment is precisely the artefact a future reader consults to learn *why* the baseline is what it
is, and it now misstates both the delta and its cause. Fixing it is a comment edit; noticing it is
the point, because a tenant-scope baseline whose ledger has silently decoupled from its value is a
governance registry that has stopped functioning.

---

## F6 — MEDIUM — no per-item error isolation, and the module argues both sides of it

**Design decision challenged:** the "assert, do not branch" rule as applied inside a five-phase
platform-wide loop.

`runReleaseCycle` (`release.ts:186-191`) awaits the five phases in sequence with no `try/catch`
anywhere, and each phase's per-item loop awaits `sql.begin(...)` bare. So **any** throw in phase *N*
aborts phases *N+1…5* for the whole platform, every tick, for as long as the offending row exists.

The module knows this. `findRunningLazyChild`'s docstring (`release.ts:492-497`) makes exactly this
argument to justify returning `null` instead of throwing:

> *"a throw here would abort the tick before phases 2 and 3 ever ran, letting one anomalous row hold
> every other account's wedged batch shut."*

Two statements earlier, in the same function's caller, the opposite decision is taken
(`release.ts:439-445`):

```ts
if (locked === undefined) {
  throw new Error(`sweepUnknownOutreach: batch ${row.batch_id} not found …`);
}
```

That throw is in **phase 1** — the earliest phase — so a single Outreach row whose tenant triple
disagrees with its batch's silently disables the `send_window_elapsed` sweep, the `batch_expired`
sweep, the release phase and the backstop join, platform-wide, forever. The same shape recurs in
phase 4: `releaseOutreachRow`'s deliberate `throw` when `enqueueSolicitationSend` returns `null`
(`release.ts:1210-1214`) kills the backstop join for that tick, and the offending row is re-selected
by `selectRenderedOutreach` on every subsequent tick, so the failure is permanent rather than
transient. `latchSystemHalt` throwing for one batch in phase 2 takes phases 3–5 with it.

**On reachability:** I cannot prove either throw is reachable — the batch-not-found case depends on
whether `solicitation_outreach`'s FK to `solicitation_batches` is composite over the tenant triple,
and the outbox case depends on there being no path that returns a `queued` row to `rendered`. I am
not claiming they are reachable. **The finding is the structure**, which is certain: the module
adopted "assert, do not branch" from a codebase where the blast radius of an assertion is one job,
and applied it inside a loop where the blast radius is every phase after it for every account. The
one place it noticed this, it made the opposite call and wrote down why. The inconsistency is the
signal.

**What would settle it:** wrap each phase's per-item body in a bounded catch that logs, alerts and
continues to the next item — the same log-and-swallow discipline CLAUDE.md already mandates for
best-effort work after a worker's primary side effect — and let a poisoned item fail one item rather
than one platform. Or, at minimum, `try/catch` each of the five phase calls in `runReleaseCycle` so
that a phase failure never suppresses the phases after it.

---

## On the questions I was asked but am not filing findings for

**Q2 — is a per-tick budget of 2 an acceptable substitute for §7.1 priority-yielding?** Acceptable
as scope, mislabelled as mechanism. It is not a yield; it is a fixed-rate throttle that cannot see
transactional pressure, so it neither defers under load nor uses headroom when idle. The intake
declares the gap in `non_goals` and Task 10 opens the follow-up, so it is not *silent* — my
objection is only that `RELEASE_PER_TICK_BUDGET`'s docstring calls it "the drip's pacing lever … the
scheduling act available to it", which reads as a design position rather than a placeholder. Not a
finding; noted in the appendix.

**Q3 — is the governor order right or merely faithfully copied?** I attacked it and it holds. The
Judge-last position is not just quoted — it is *derivable* from the fact that a downgrade is the only
destructive write among the six gates, and the plan derives it correctly. Breaker-first is right
(cheapest and broadest). Platform-before-account is right (a global bound cannot be checked after a
local one without letting the local one authorise a global overrun). Cap-before-subscription is the
only arguable one and its only consequence is which reason gets reported for an account that fails
both — B6 settles it and the cost of being wrong is an operator chasing the wrong dial, which the
code comment already says. **The order is right. What is wrong is what happens *after* the Judge gate
fires** — see F2.

**Q4 — is the flag-gates-phase-4-only reasoning correct?** Yes, and I could not break it. A
flag-off with the sweeps gated would strand `queued` rows behind migration 091's
`solicitation_batches_one_active_send_per_business` index, which is #915's wedge exactly. Two
consequences that were priced correctly and one that was not: the intake explicitly accepts that
expiry keeps running under an open breaker (B14, accepted), and correctly notes that the sweeps must
run under a flag-off. The unpriced one is F2's — with the flag ON, the Judge downgrade becomes
reachable, and *that* is the interaction nobody costed.

**Q6 — is the three-state `unknown` model right, and does everything downstream handle it?** The
model is right. The downstream story is **not what the code says it is.** `release.ts:427-433` and
`worker/jobs/solicitation-send/failed-hook.ts:24-27` both justify `unknown` on the grounds that *"the
restraint policy's `over_contacted` check reads prior sends"*. It does not. `over_contacted`
(`restraint-policy.ts:400-415`) reads `candidate.priorBatch`, which the batch builder populates from
`solicitation_asks.status = 'send'` (`batch-builder.ts:501-514`) — the **ask decision**, written at
build time, never touched by `delivery_status`. Writing `failed` instead of `unknown` on the Outreach
row would therefore have **no effect at all** on over-contact. The protection the comment claims is
real, but it comes from a different table and would survive the "lie" the comment forbids.

Why I am not filing it as a finding: the *behaviour* is correct and conservative either way, and the
justification is inherited from #899, not authored here. But it is a load-bearing rationale recorded
in two production files that does not describe the code, and it is the kind of thing that gets
"simplified" later by someone who checks whether the claim is true. A natural future refinement to
`over_contacted` — keying on actual sends rather than ask decisions, which is arguably more correct —
would silently remove the protection while both comments still assert it. Worth a one-line correction
at both sites.

Relatedly, the intake's invariant *"A row already `sending` is never re-gated and never re-sent. The
`unknown` sweep is the only writer that may terminalize it"* is false as written:
`worker/jobs/solicitation-send/failed-hook.ts:72-77` writes the same
`unknown`/`send_indeterminate` pair for a row that arrives `sending`. The two writers take
**different lock primitives** — the hook takes `acquireSolicitationBatchLock` (advisory), the sweep
takes `FOR UPDATE OF b` (row) — so they do not mutually exclude. In practice the `delivery_status =
'sending'` CAS makes only one win the row, `completeRun` is guarded by `status = 'running'`, and
`closeBatchIfSettled` is idempotent, so I could not construct a concrete harm. It belongs in the
intake's wording, not in the findings table.

---

## Low-confidence appendix

Speculative or unproven; deliberately kept out of the table.

**A1 — the per-tick budget silently becomes the real platform ceiling above 2,880/day.**
`RELEASE_PER_TICK_BUDGET = 2` at a 60 s cadence caps platform output at 2,880 rows/day. Any
`SOLICITATION_PLATFORM_DAILY_CAP` above that is dead config — an operator ramping the dial past 2,880
would see no change and no warning. Today's default is `0`, and the ramp table in
`docs/runbooks/solicitation-sending-domain.md` §5 presumably stays well below it, so this is
currently unreachable. Worth a sentence in the env-vars row.

**A2 — the account daily cap does not scale with location count.** `readAccountDailySendCap` reads
`auto_approval_policies` with `location_id IS NULL` and `countAccountDispatchAttemptsToday` counts by
`account_id` alone, so a 20-location account gets the same 10 sends/day as a 1-location account.
Combined with `BATCH_CAP = 25` per batch and a 72 h send window, most of a large multi-location
account's asks would expire uncontacted. I did not file this because **no automatic batch-build
cadence exists yet** — batches are built on demand — so the over-generation that would make this bite
is not currently produced by anything. It becomes real the moment a build scheduler lands, and it is
the amplifier behind F3.

**A3 — the backstop's re-scan is 50 transactions per tick, most of them `not_settled`.** ~72,000
transactions/day through the #773 admission gate for a mechanism that exists to catch a rare lost
join. The re-scan rationale (`release.ts:196-215`) is correct and I could not fault it — replaying
touched ids genuinely cannot reach the batch it exists for. But the cost is real and it is also the
largest single contributor to the cycle duration that makes F1 reachable. A cheaper predicate (e.g.
an `EXISTS` proving no live Outreach rows remain, at the scan) would cut it, at the cost of spelling
the settled condition twice — which D11 forbids. Genuine tension, no recommendation.

**A4 — `withheldByReason` reports the first gate, so a capped *and* unsubscribed account reports
`account_cap`.** The code comment says the order exists so "the operator chases the right dial", but
B6's order means a subscription problem is invisible behind a cap. Observability preference, not a
correctness issue; B6 settles the order regardless.

**A5 — `RELEASE_SCAN_LIMIT = 50` is reused as both the per-phase batch scan bound and
`selectRenderedOutreach`'s per-batch row bound** (`release.ts:900`). One number governing two
unrelated quantities; tuning either moves both. Cosmetic today.

---

## On the "things you are told"

**Recorded decision 1 — proceed as one PR at 2.1× the estimate.** I was asked to say if I think that
was the wrong call. **I think it was.** Not because 1,754 lines is unmanageable, but because of what
the three plan rounds and the deviations file show about *where* the risk in this branch actually
lives. The three plan rounds found thirteen findings, twelve accepted; every one of them was
scoped to a single decision — one predicate, one CAS, one test title. Both of my HIGH findings
(F1, F2) and Codex's (F3) are **compositions across decisions that were each individually reviewed
and individually correct**: a timeout contract meeting an in-memory counter; a downgrade meeting a
sweep; an ordering meeting a cap. That is the characteristic failure mode of a change large enough
that no single review pass holds all of it at once, and it is exactly what stacked PRs buy you — the
`latchSystemHalt` arm, the typed helper and the poller shell are genuinely separable from the
five-phase cycle, and reviewing the cycle against an already-landed latch is a materially smaller
reading task than reviewing both together.

The counter-argument is real and I want it recorded fairly: the phases are interdependent by design,
splitting them would have shipped a poller that could wedge locations between PRs, and the branch's
own controls (39 tests, three plan rounds, a 31-entry deviations file read end to end) are
substantially stronger than a typical PR's. That is why this is an opinion and not a finding.

**Recorded decision 3 — the outer `NOT EXISTS` belt in P1 is deliberately unpinned.** I attacked
this and accept it. The docstring's claim is verifiable by inspection: the correctness guard is the
same clause repeated inside `terminalizeWedgedOutreach`'s CAS, which has its own test; the outer
clause is a scan-bounding arm whose deletion leaves the suite green *by design*. A test here would
assert scan composition, not behaviour. No objection.

**Recorded decisions 2 and 4** — four amendments on a budget of two, and the flag staying OFF — I
have no approach-level objection to either. F5 above is about the *count of cross-account
exemptions*, which is a different registry from the amendment budget and was not part of that
accounting.

---

# TRIAGE — round 1, 2026-08-22 (orchestrator)

Every finding was verified against source before a verdict. Agent confidence was
not treated as evidence.

- **HIGH #1 detached cycle / cap overrun — ACCEPTED, RE-GRADED TO MEDIUM, FIX (doc).** The mechanism is real and confirmed at `worker/background/guarded-poll.ts:80` ("a timed-out cycle keeps running detached") with `inFlight = false` in the `finally`. But the blast radius is far smaller than HIGH implies: BOTH counters are re-read from the database per cycle (`release.ts:804`, `:863`) and count COMMITTED `queued_at` rows, so an overlapping cycle sees everything the detached one committed. The overrun is bounded by the detached cycle's selected-but-uncommitted rows — at most its remaining per-tick budget of 2 — and a cycle that hung past 45s is by definition not committing. **What IS wrong is the intake invariant's wording** ("the single-replica worker serializes them by construction") and the Task 0 deviation's claim that interval-driven overlap is unreachable; that reasoning is inverted, since a deadline BELOW the interval guarantees the flag is free at the next tick. Both corrected; no structural change at review time.
- **HIGH #2 Judge downgrade × `batch_expired` — ACCEPTED, FIX.** Verified: `downgradeApproval` clears `approved_at`/`approval_method`/`approved_by_user_id` and leaves `built_at`; P3 matches `approved_at IS NULL AND built_at <= NOW() - 7 days`. This contradicts the intake's `user_visible_behavior`: "the batch **reappears as approvable** in the Requests panel." Past the approval window it does not — **Batch state** forbids approving it and P3 cancels it instead, with no owner notification (a declared non-goal). Reachable whenever release is blocked (breaker, cap, flag) long enough for `built_at` to cross 7 days before the first release.
- **HIGH #3 P4 starvation — ACCEPTED, FIX.** Independently found by the spec agent. Contradicts the locked edge case "A tick that hits the per-tick release budget leaves the remaining due rows for the next tick; **no row is skipped permanently**."
- **MEDIUM module shape — REJECTED.** The standards agent owns this axis, examined the same file directly, and declined to flag it with reasoning (652 code lines vs 496 comment, narrow interface, no seam with a second caller). This finding asserts the opposite without naming the seam that should have been extracted or the second caller that would use it. Where two agents disagree, the one that owns the axis and gave the better argument wins.
- **MEDIUM tenant-scope ledger — ACCEPTED, FIX.** Also found by the standards agent. Orchestrator's own error: the P2 entry was added without a ledger bullet and every later task copied that pattern.
- **MEDIUM error isolation — ACCEPTED, FIX.** The standards agent's version is sharper and is the one being actioned.

---

# ROUND 2 VERIFICATION

**Axis:** adversarial approach. **Scope:** verification only — the five accepted findings, and
whether the fixes introduced anything new. The rejected module-shape finding is not revisited.
**Fix commits:** `cabeff32`, `1bd27676`. **Diff read:** `git diff a23d8afd..HEAD` in full
(`release.ts` 444 lines, `approval.ts` 20, the allowlist, the two test files, the deviations file,
the intake, CONTEXT.md, env-vars.md).
**Tests:** not executed — two sibling agents share the machine and the test database. Gate evidence
is the orchestrator's `verify-gate.sh --review` GREEN at `1bd27676`, 28 rows.

## Verdicts

| finding | fixed? | evidence |
|---|---|---|
| **HIGH — Judge downgrade × `batch_expired`** | **PARTIAL** | The triaged case is closed and closed correctly. Residual: the guard is a scan-time boolean and the CAS does not re-assert it, so a downgrade taken shortly *before* the window shuts produces the identical outcome. See V1. |
| **HIGH — P4 starvation** | **YES** | The safety argument survives attack from four directions; the counting basis is byte-identical to the enforced gate; the cost profile does not change class. See V2. |
| **MEDIUM — detached-cycle cap overrun (re-grade)** | **YES (re-grade upheld)** | Both counters are cycle-local and DB-seeded; `budgetRemaining` is the only unconditional decrement and each release is its own transaction, so no path lets one cycle's uncommitted work exceed the per-tick budget. See V3. |
| **MEDIUM — tenant-scope ledger** | **YES** | Four new ledger bullets (`385→386`, `386→388`, `388→389`, `389→390`) reconcile the comment with `ALLOWLIST_BASELINE = 390`. The new CTE is a second `solicitation_outreach` occurrence inside one statement and shares the P4 entry; the reason string names it explicitly. Baseline does not move. |
| **MEDIUM — error isolation** | **YES** | All four sweeps via `isolateItem`, the release phase via a per-account `try`/`recordItemFailure` with the boundary-crossing reason stated. No `undefined`-conflation at any call site. The approach question is answered in V4 — it got *louder*, not quieter. |
| **NEW — the capped-account exclusion is silent** | *new, LOW* | A fully cap-bound platform is now byte-identical to an idle one in the cycle report. See N1. |
| **NEW — `isolateItem`'s scan carve-out names a sink that does not exist** | *new, LOW/MEDIUM* | `guarded-poll` catches every scan throw and `logger.error` has no Sentry hook, so the failures that suppress whole phases are now the only ones with no Sentry sink. See N2. |

---

## V1 — Judge hold: the hole is narrowed, not closed

**What the fix does, verified.** `applyJudgeSplit` (`release.ts:1250-1256`) now returns `'held'` when
`batch.sending_started_at !== null || !batch.approval_window_open`. `approval_window_open` is
projected by P4 as `b.built_at > NOW() - make_interval(days => ${BATCH_APPROVAL_WINDOW_DAYS})`
(`release.ts:1142-1144`) — DB clock, so #520 does not apply. A hold takes no lock and writes nothing;
the new integration case asserts exactly that (`expect(await readBatch(batch.batchId)).toEqual(before)`
plus zero `approval_downgraded` steps).

**What it opens — checked and clean.** A held batch keeps `approved_at`, so:

- P3 cannot see it. `selectExpiredBatches` requires `b.approved_at IS NULL` (`release.ts:1157`), and
  the docstring says so ("keeps P3 disjoint from P2").
- P2 *will* take it. `selectSendWindowElapsedBatches` requires only `approved_at IS NOT NULL AND
  approved_at <= NOW() - 72h AND halted_at IS NULL AND send_closed_at IS NULL` — no
  `sending_started_at` arm — so a batch that never started dripping is still swept
  (`release.ts:762-770`). **There is no batch that holds forever.**
- The terminal state is the right one. `send_window_elapsed` is honest: the halt-reason vocabulary
  has five members and none of them is judge-shaped, and what actually ran out for a batch held
  across a multi-day Judge outage *is* the 72h send window. Inventing a sixth reason for it would be
  a worse answer than reusing the true one.
- Recovery still works. `selectReleaseCandidates` does not require `approval_window_open` — it only
  *projects* it — so a batch past its approval window releases normally the moment the Judge is
  healthy again. The window governs only the destructive branch, which is exactly right.

**The residual, which is why this is PARTIAL.** `approval_window_open` is evaluated once, at scan
time, and `downgradeApproval`'s CAS (`release.ts:1327-1338`) re-asserts `approved_at IS NOT NULL`,
`sending_started_at IS NULL`, `halted_at IS NULL`, `send_closed_at IS NULL` — and **not the approval
window**. So the guard answers "is the window open *now*", never "will it still be open long enough
for the owner to act". A downgrade taken at `built_at + 6d23h` produces, step for step, the chain
round 1 filed:

1. downgrade clears the four approval columns, leaves `built_at`;
2. one hour later `deriveBatchState` reads `expired` and `approveBatch` refuses it (D2);
3. P3 matches all five arms — it necessarily has a send parent — and latches `batch_expired`;
4. neither step notifies the owner.

Round 1's own reachability paragraph named this slice: *"an approval landing in the last stretch of
the 7-day approval window."* That slice is not a corner. For an owner who approves late — say at
`built_at + 6d20h` — the *entire* pre-first-release exposure window is inside the last four hours of
the approval window, so every downgrade that batch can suffer lands on the destructive side of the
new boundary. The fix moves the failure from "certain for the past-window class" to "certain for the
about-to-close class", and the about-to-close class is the tail of the same distribution that made
the finding reachable in the first place.

I am not asking for a redesign. The honest options are one line each: refuse the downgrade unless
some minimum window remains (`built_at > NOW() - (7d - grace)`), or re-assert the window arm inside
the CAS and treat the loser as a hold, or — the one the plan already declined — notify.

**Second-order, and cheap to fix.** The intake was updated for the caps invariant in this same
commit but not for this behaviour. `user_visible_behavior[6]` still reads *"A Judge outage before the
first release returns the batch to owner review: … the batch reappears as approvable in the Requests
panel"* unconditionally, and `[7]` still scopes holding to *"mid-drip"*. The hold set has grown a
second member and neither line says so. Round 1 filed this exact sentence as evidence; the code moved
and the sentence did not.

---

## V2 — P4 starvation: the safety argument survives, attacked four ways

**The argument.** `capped_accounts` excludes any account with `COUNT(*) >= DEFAULT_DAILY_SEND_CAP_ACCOUNT`
(10) queued today; `resolveAccountDailySendCap` is `LEAST(configured, 10)`; therefore the resolved cap
is never above 10, therefore an excluded account would have been `continue`d by the TypeScript gate
anyway, therefore the arm can only under-exclude.

I attacked it on four fronts and it holds on all four.

1. **Can the resolver ever exceed 10?** No. `send-caps.ts:24-27`: `null → 10`, otherwise
   `Math.min(configured, 10)`. Both branches are `≤ 10`. The schema CHECK admits 1..50 and this
   resolver is what makes 50 harmless — the arm rides on the same fact.
2. **Can the counting bases disagree?** No. The CTE's `WHERE queued_at >= date_trunc('day', NOW() AT
   TIME ZONE 'UTC') AT TIME ZONE 'UTC'` is character-for-character `countAccountDispatchAttemptsToday`'s
   (`send-caps.ts:73`), trailing conversion included — the one that #898's review found is
   load-bearing rather than redundant. There is no drift to exploit, and a drift would weaken a bound,
   not invert it.
3. **Under-exclusion direction.** An account that lowered its own dial (cap 3, five sends today) has
   `count = 5 < 10`, so it stays a candidate and is `continue`d at the gate exactly as before —
   costing one scan slot, which is the pre-existing behaviour and not a regression. Over-exclusion,
   which would starve an account that could still send, is unreachable while (1) holds.
4. **Cost profile at scale.** Not a new class. The CTE aggregates the same relation under the same
   predicate as `countPlatformDispatchAttemptsToday`, which already runs once per tick in the same
   phase; migration 091:423 provides `(account_id, queued_at)`, so it is an index-only scan plus a
   HashAggregate, and a CTE with an aggregate is materialized once per statement. The change roughly
   doubles one existing per-tick aggregate. It does not introduce an unindexed path.

**The new fairness question — is a capped account now invisible until the day rolls?** Yes, and that
is the correct outcome, not a new problem: the pre-fix behaviour was identical (`continue` on every
tick, release nothing) minus the scan slot it wasted on everyone else. What *is* new is that the
account also disappears from the report — filed separately as N1.

**One coupling I am not filing but am recording.** The arm and `resolveAccountDailySendCap` are two
owners of "is this account capped", joined only by a docstring paragraph and locked decision #619
D20 ("the dial moves toward restraint only"). If the clamp is ever raised above
`DEFAULT_DAILY_SEND_CAP_ACCOUNT` — an enterprise account allowed 25/day — the arm silently flips from
under- to **over**-excluding, and re-creates precisely the starvation it was added to fix, for the
highest-cap accounts on the platform. No test pins the coupling; the docstring is the whole guard.
It is protected by a locked decision today, which is why it is an appendix item and not a finding.

---

## V3 — the detached-cycle re-grade holds

The re-grade rests on two claims. Both verified in source.

- **Both figures are cycle-local and DB-seeded.** `platformRemaining = platformCap -
  (await countPlatformDispatchAttemptsToday(sql))` is a `let` inside `runReleasePhase`
  (`release.ts:940`); `accountRemaining = cap - (await countAccountDispatchAttemptsToday(sql,
  accountId))` is a `let` inside the per-account body (`release.ts:1006`). Neither is module state,
  and both read `queued_at`, which `releaseOutreachRow` stamps inside the same transaction as the
  `rendered → queued` CAS. A concurrent cycle therefore sees everything a detached cycle has
  committed.
- **No path exceeds the per-tick budget.** `budgetRemaining` starts at `perTickBudget`
  (`RELEASE_PER_TICK_BUDGET = 2`; the poller passes no `ReleaseCycleOptions`, so 2 is what production
  gets) and is decremented on every single release alongside the other two — it is the only
  unconditional decrement, and exhausting it sets `stopPhase` at all three checkpoints. Each release
  is its own `sql.begin`, so at most **one** row is uncommitted at any instant, and at most
  `budgetRemaining` further rows can ever be released by that cycle. The overrun a detached cycle can
  cause is `min(stale headroom, budgetRemaining) ≤ 2`. **The bound is right, and this is a
  documentation error rather than a defect.**

One imprecision in the corrected wording, recorded rather than filed: both the intake invariant and
the module header state the bound for *a* detached cycle. Under a sustained pile-up — cycle duration
chronically above the 60s interval, so k cycles are alive at once — the worst case is `k ×` the
remaining per-tick budget, and it lands as a one-time overshoot per account at the instant it crosses
its cap (after which both the TypeScript gate and, now, the `capped_accounts` arm exclude it for the
rest of the day). A "per detached cycle" qualifier would make the sentence exactly true.

---

## V4 — error isolation: the right response, and it got louder rather than quieter

**Shape verified.** `isolateItem` wraps the per-item body in the four sweeps
(`unknown_sweep`, `send_window_sweep`, `batch_expired_sweep`, `backstop_join`), each passing the
tenant triple plus the row id as Sentry `extra` and the phase as a **tag**. The release phase uses a
bare `try` with `recordItemFailure` because its body carries `continue`/`break` targeting two
enclosing loops — a genuine constraint, correctly stated in the comment rather than worked around.
Every call site handles the new `undefined` correctly: `result?.status === 'closed' | 'latched'`,
and `if (moved !== true) continue` — no falsy conflation anywhere.

**The approach question — does per-item isolation convert a loud failure into a quiet one?** No; it
is the other direction, and I checked the pre-fix path to be sure. Before this commit, an item throw
propagated to `createGuardedPoll`, which caught it and called `logger.error(onErrorMessage, ...)`
(`worker/background/guarded-poll.ts:106-113`) — and `createWorkerLogger`'s `error` is a plain JSON
line with **no Sentry hook** (`src/lib/shared/logger.ts:115`). So the old behaviour was: one log
line per tick, no Sentry issue, and every later phase suppressed. The new behaviour is: one Sentry
`captureException` at `warning` per failure with the ids attached, one error log line per failure,
a counter on the report, and the later phases still run. Strictly more signal.

**Is `itemFailures` enough to notice a phase failing every item?** Adequate, with one gap worth
naming. It is on the tick line the poller logs unconditionally
(`SolicitationReleasePoller.ts`: `logger.log('Release cycle complete', { ...report })`), so
`itemFailures: 50` is visible every 60s, and each distinct failure mode raises its own Sentry issue
grouped by the error rather than by the message. What does not exist is a **saturation** signal —
nothing distinguishes one failed item from every failed item, there is no threshold, and
`HealthAlertPoller` has no arm for it. Given that a fully-poisoned phase also shows as its own
counter reading zero on the same line, I do not think that rises to a finding; it is the appendix
item below.

---

## N1 — NEW (LOW): the capped-account exclusion drops candidates with no counter

**Design decision:** move the cap check from the loop (where it recorded `withheldByReason.account_cap`)
into the scan (where nothing records anything). The new test asserts the consequence directly:
`expect(report.withheldByReason.account_cap).toBeUndefined()`, commented *"there is nothing to
withhold."*

**Concrete consequence.** After the exclusion, `account_cap` is reachable only for an account whose
*configured* cap is below 10 with today's count between that cap and 9, or for an account that
exhausts `accountRemaining` mid-tick — which requires `accountRemaining ≤ 2`, the per-tick budget.
The dominant population, an account at the default 10/day, can no longer produce the counter at all.
So a tick in which every account with due rows is cap-bound reports `released: 0`, no
`releasePhaseStoppedBy`, and an empty `withheldByReason` — **byte-identical to a tick with no due
work**. That is precisely the distinction `withheldByReason` was built to draw; `runReleasePhase`'s
own docstring says an operator reading a withhold count "is being told 'some rows could not, and here
is which dial'", and `logBudgetExhausted` justifies its warn level as letting "the staging ramp tell
'paced' from 'capped'". Capped is now the state with no reading. It also contradicts the convention
`RELEASE_SCAN_LIMIT`'s docstring states for the whole module — *"Bounds the tick, and every phase logs
what it dropped"* (`release.ts:181`) — since P4's new drop arm is the one that logs nothing.

**Cost of fixing:** one projection. Either fold the excluded-account count into
`withheldByReason.account_cap` from the same statement, or give it its own report field
(`scanExcludedCapped`) so the two remain distinguishable. No structural change.

**Not filed as HIGH or MEDIUM** because nothing downstream consumes the field — I grepped `docs/`
and no runbook reads `withheldByReason`, so no written procedure breaks. It is a self-inflicted blind
spot in the lane's own instrumentation, on the eve of a staging ramp.

---

## N2 — NEW (LOW/MEDIUM): the scan carve-out's stated fallback does not exist

**The new claim,** in `isolateItem`'s docstring (`release.ts` ~197), introduced by `cabeff32`:

> *"It does NOT wrap a phase's SCAN. A scan that throws is a database-wide failure with no item to
> blame, and the crash-net (`worker/index.ts`) is where that belongs."*

**It never reaches the crash-net.** `createGuardedPoll` catches everything `runReleaseCycle` throws
and never rethrows — `catch (err) { logger.error(onErrorMessage, toError(err)); }`
(`worker/background/guarded-poll.ts:106-113`) — and `start()` adds a second `.catch(logUnhandledPollError)`
behind it. So a scan throw is never an `unhandledRejection` and `worker/index.ts`'s
`isCrashNetRecoverableDbError` classifier never sees it. And `logger.error` writes one JSON line and
nothing else (`src/lib/shared/logger.ts:115` — the logger has no Sentry hook at all).

**Why this matters more after the fix than before it.** The containment behaviour is pre-existing and
unchanged; what is new is the rationale, and the asymmetry the fix created. As of this commit:

- an **item** failure — blast radius one row — raises a Sentry issue, an error log line and a report
  counter;
- a **scan**, `readSendBreaker` or `groupByAccount` failure — blast radius *every phase after it*,
  on every tick, for as long as the condition persists, including P5's backstop join — raises **no
  Sentry event at all** and appears only as one log line per tick, with no counter.

The failure class that can actually wedge the lane is now the only one with no alerting sink, and the
comment tells the next reader that case is covered by a mechanism that will not see it. This is the
same shape round 1 filed twice and the orchestrator accepted twice: a load-bearing rationale that does
not describe the code (F1's inverted deviation reasoning; F6's contradictory docstrings).

**Reachability is not theoretical.** `selectReleaseCandidates` is now the second full-relation
aggregate in that path (V2.4); PgBouncer's `statement_timeout` is the standing hazard this repo
already documents. A `selectReleaseCandidates` that starts timing out silently disables the backstop
join platform-wide — and P5 is the mechanism that exists to close batches nothing else will close.

**Cheap fix, two halves.** Correct the sentence to say where a scan throw actually lands
(`guarded-poll`'s catch, one log line, no Sentry). Then either accept that explicitly, or wrap the
five phase calls in `runReleaseCycle` in a per-phase catch that records to the report and to Sentry —
which is the "at minimum" half of round 1's F6 remedy that the fix did not take, and which would also
stop `readSendBreaker`'s deliberate halt-signal throw from taking P5 with it.

---

## Round 2 appendix — untriaged

Not findings. Recorded so they are not rediscovered.

**U1 — the `capped_accounts` arm and `resolveAccountDailySendCap` are two owners of one predicate.**
Safe only while `LEAST(configured, DEFAULT_DAILY_SEND_CAP_ACCOUNT)` holds. Raise the clamp for one
enterprise account and the arm flips from under- to over-excluding and re-creates the starvation it
fixed. Guarded by locked decision #619 D20 and by a docstring, by nothing executable.

**U2 — the corrected overrun bound is per detached cycle, not per platform.** With k concurrent
cycles the worst case is `k ×` the remaining per-tick budget. A three-word qualifier in the intake
invariant and the module header would close it.

**U3 — no saturation signal on `itemFailures`.** Nothing distinguishes one failed item from every
failed item; no threshold, no `HealthAlertPoller` arm. Each failure does raise its own Sentry issue,
so this is a convenience gap rather than a blind spot.

**U4 — the release phase's isolation context carries `account_id` only.** Every other phase passes
the full tenant triple plus the row id. The account is the correct isolation *unit*, but the Sentry
`extra` cannot name the poisoned batch or outreach row; an operator has to read the error message to
find it. One extra field on the two places the loop knows a `batch.id` would close it.

**U5 — a throwing `isJudgeHealthy` is now re-probed per account.** The memoized `judgeAvailable()`
caches only a *resolved* value, so under the new per-account catch a throwing probe is retried once
per account instead of once per tick. Harmless — the phase releases nothing either way, and the
"never ask twice and get two answers mid-drip" property depends on successful probes, which still
memoize.

**U6 — `downgradeApproval`'s trailing comment still reads "the batch simply reappears as
approvable."** True at that call site now, because the caller guarantees the window is open — but it
is the sentence V1's residual makes conditional, and it is one of the two places a future reader
will check.

## ROUND 2 TRIAGE (orchestrator, 2026-08-22)

This round attacked the orchestrator's own re-grade, which is what it was asked to do.

- **The MEDIUM re-grade — UPHELD.** Both counters are cycle-local `let`s seeded by a fresh `COUNT(*)` over committed `queued_at`; each release is its own `sql.begin`, so at most one row is uncommitted at any instant and no path exceeds the per-tick budget. The re-grade from HIGH to MEDIUM was correct and the fix being documentation-only was correct.
- **Error isolation — verified LOUDER, not quieter.** The approach question was answered rather than assumed: pre-fix an item throw produced one `guarded-poll` log line and NO Sentry, because `logger.error` has no Sentry hook; post-fix each failure raises a Sentry issue plus a counter on the tick line.
- **N2 `isolateItem` names a Sentry sink that does not exist — ACCEPT, FIX, and it is the branch's FOURTH false-rationale finding.** The docstring says an unisolated scan throw belongs to "the crash-net (`worker/index.ts`)". It does not: `createGuardedPoll` catches and never rethrows, and `logger.error` has no Sentry hook. So scan, `readSendBreaker` and `groupByAccount` failures — which suppress every later phase including P5's backstop join, on every tick — have NO Sentry sink, while the comment tells the next reader they are covered. Same class as the `latchSystemHalt` lock docstring and the two overlap claims. A pattern worth naming: on this branch, a load-bearing rationale in a comment has been wrong four times.
- **Judge fix PARTIAL — ACCEPT, FIX.** `approval_window_open` is a scan-time boolean and `downgradeApproval`'s CAS never re-asserts it, so a downgrade taken shortly before the window shuts reproduces round 1's chain exactly. The CAS must re-assert the window.
- **P4 starvation — YES**, safety argument attacked four ways and held.
