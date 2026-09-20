# Deviations — fix/1352-operator-posting-block-context

Entries the plan did not anticipate. Every entry carries a **Verdict:** ACCEPT
or RE-PLAN before the review wave (step 6).

---

## D1 — Surface amendment 1: read-time derivation replaces stored metadata

**When:** step 3, before the plan was written. Rationale corrected after plan
review round 1.

**What the intake assumed.** The Posting block reasons would ride the Proposal's
stored `after` JSONB, mirroring `expansionBlockedBy`. That implied editing
`schema.ts`, `apply.ts`, `restore.ts` and
`worker/jobs/agent-turn/AgentTurnWorker.ts`.

**What the code showed.** Every proposal reader converges on `mapStoredRows`
(`src/lib/agents/operator/proposals.ts:534`), which already takes `db` and
`accountId` and already issues one read. The Posting block can be read there,
once, and reach every reader. Nothing needs to be stored.

**Why the divergence from the `expansionBlockedBy` precedent is correct.**
`expansionBlockedBy` is frozen at preparation because the owner must confirm
against the state the server prepared; Apply then rechecks current readiness
independently (read at `apply.ts:478`, rejection at 479), so the frozen copy is
a record, not the only enforcement. The Posting block line enforces nothing. It is a statement about
account state right now, so it must be read right now.

Round 1 correctly refuted the first version of this rationale, which said a
stale line "would only ever be a false warning". That is wrong in one direction:
a block that appears AFTER preparation would be a MISSING warning, which is the
#1352 defect itself. Read-time derivation avoids both directions. The decision
was right; the reason given for it was not.

**Net surface effect.** NARROWS by 7 entries (`schema.ts`, `apply.ts`,
`restore.ts`, `catalog.ts` and their three test files) and ADDS 2 inside the
already-covered `src/lib/agents/operator/` tree (`reads.ts`,
`__tests__/reads.integration.test.ts`). `worker/` never enters the surface.
Auto-approved under the step 2 amendment rule; counted
(`surfaceAmendments=1`).

**Consequential intake corrections** (not themselves amendments):
`risk_reasons[1]` no longer claims the change touches the Apply write path;
`edge_cases[7]` now states the line clears with the block; and
`existing_patterns_to_follow[3]` points at `policyCardFacts`.

**Verdict:** ACCEPT

---

## D2 — SUPERSEDED: "pending cards come only from `listPendingProposals`"

**When:** step 3. **Refuted:** plan review round 1, finding 1, before any code
was written.

**What D2 originally claimed.** That the Posting block line belonged on
`listPendingProposals` only, and that `listProposalsForTurns` (`reads.ts:341`)
could be left alone because it serves the transcript, which is history.

**Why that was wrong.** "Transcript" does not mean "historical status".
`listProposalsForTurns` (`proposals.ts:568-586`) carries **no status predicate**
— it selects every proposal for the turn ids, pending included.
`TurnBody.tsx:49` renders `ProposalCard` from `turn.proposals`, so the pending
card the owner actually clicks comes through the reader D2 excluded. Implementing the warning only in a function
whose NAME says "pending" would have shipped #1352 unfixed on the real surface
while every promised test passed.

**The replacement decision.** Pending-only remains the right BEHAVIOR, and it is
now expressed as a predicate on the row (`status === PROPOSAL_STATUS.PENDING`)
inside `mapStoredRows`, the single point all four readers converge on. Behavior
unchanged from the intent; mechanism moved from "choose a reader" to "test the
row". A fifth reader cannot forget it.

**Net surface effect.** None. `mapStoredRows` is in `proposals.ts`, already in
the surface. `reads.ts` needs no change after all and stays in the surface
unused.

**Verdict:** ACCEPT (on the replacement decision; the original premise is
recorded here as refuted, with its evidence)

---

## D3 — Intake estimate correction and eight added test titles

**When:** step 3, after plan rounds 1 and 2.

**What.** `estimated_prod_lines` 190 → 240. `estimated_test_lines` 340 → 520.
`tests_to_add` 16 → 24.

**Why.** Round 1 added six titles beyond the intake's sixteen and round 2 added
two more; `getAutoApprovalPostingStatus` and `correctionOwed` joined the
production side. Round 2 finding 3 is the reason the titles are now IN the
intake rather than only in the plan: `scripts/verify-gate.sh:530` matches
`tests_to_add`, so a title that lives only in the plan is unenforced — including
the two that close round 1's production-path counterexample.

Corrects this entry's own earlier claim of "five additions"; the count was six
after round 1 and is eight now.

Not a surface amendment — no path changed for this entry. Both figures stay
inside the step 5 reclassification trigger of 2× the original estimate.

**Verdict:** ACCEPT

---

## D4 — Surface amendment 2: `posting-status.ts` joins the comment sweep

**When:** step 3, after plan round 2 finding 4. Reason recorded with
`incr-amendment --reason`; `surfaceAmendments=2`.

**What.** `src/lib/auto-approval/posting-status.ts` joins
`allowed_edit_surface` for T6 item 5.

**Why.** T2 makes readiness stop folding in `autopilotPurchasable()`. Two
production comments assert the old behavior: `settings.ts:1213-1218` (already in
surface) and `posting-status.ts:27-32` (was not). Fixing one and leaving the
other makes two adjacent files contradict each other about the same rule — the
exact failure mode this issue exists to fix, one layer down.

Comment-only, pre-implementation, one file inside the already-covered
`src/lib/auto-approval/` tree.

**Note on the abort criteria.** Step 5 lists "a 2nd surface amendment" among the
triggers for tearing the branch down. That rule targets runaway scope during
IMPLEMENTATION. This amendment predates the first line of code, adds no
behavior, and was raised by the plan review the process exists to run. Recorded
and surfaced to the owner rather than actioned as an abort. If a THIRD amendment
arrives, the criteria apply without argument.

**Verdict:** ACCEPT

---

## D5 — Surface amendment 3: four Snapshot fixture sites

**When:** step 4, after T2 and T3 returned. Owner waived the step 5 abort gate
explicitly on 2026-09-20. Recorded with `incr-amendment --reason`;
`surfaceAmendments=3`.

**What.** Four paths joined `allowed_edit_surface`:

- `src/lib/agents/operator/__tests__/model-call.test.ts`
- `src/lib/agents/operator/__tests__/render.test.ts`
- `src/lib/agents/operator/__tests__/policy-apply.integration.test.ts`
- `tests/llm-eval/structured-runner.ts`

**Why.** T3 made `posting` a REQUIRED field on the shared `Snapshot` interface,
so every literal that constructs a `Snapshot` must supply it. Three of the four
need one added key. The fourth, `policy-apply.integration.test.ts:354`, asserts
`readinessBlockReasons` containing `autopilot_unavailable`, which ADR 0034
deliberately removes for a paused-sale Autopilot account.

Zero production files. All four are test fixtures or test assertions.

**Why this was not an abort.** Step 5's abort criteria name "a 2nd surface
amendment" as a trigger. The owner was shown the trigger, the evidence and three
options, and chose to amend and continue. The stated reasoning: these are
mechanical consequences of two already-locked decisions rather than scope
growth; the design has not moved since plan revision 2 and survived two
adversarial review rounds; and the other abort trigger is not close — the diff
measured 182 production and 398 test lines against estimates of 240 and 520.

**What the intake got wrong, for the postmortem record.** The surface
enumerated the files that IMPLEMENT the change but not the files that CONSTRUCT
the type it changes. Any future run that adds a required field to a shared type
should enumerate its fixture sites at intake time — `rg` for the type name in
test files before declaring the surface.

**Verdict:** ACCEPT

---

## D6 — T3 shipped a docblock that T2 made false

**When:** step 4, found during the T3 spec check.

**What.** `projectPostingBlock`'s docblock in
`src/lib/agents/operator/context.ts` says readiness' `autopilot_unavailable`
"folds in `autopilotPurchasable()`, which the runtime never reads". T2 removed
exactly that behaviour in the same execution phase.

**Why it happened.** T2 and T3 ran in parallel against disjoint file sets. T3's
brief quoted the pre-T2 reality because both briefs were written before either
landed. The parallel dispatch was still correct — the files never collided — but
a shared FACT changed under one of them.

**Resolution.** T6's docs sweep already owns "correct every claim that readiness
folds in `autopilotPurchasable()`" (plan T6 item 5). `context.ts` is added to
that item's sites, alongside `posting-status.ts:27-32`, `settings.ts` and the
glossary. `context.ts` is already in the surface, so this needs no amendment.

**Lesson for the lab notes at step 8.** Parallel tracers may share a FACT even
when they share no FILE. A brief written before a concurrent task lands can
quote a reality that expires mid-flight.

**Verdict:** ACCEPT
