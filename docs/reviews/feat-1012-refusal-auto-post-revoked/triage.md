# Triage — #1012, the `auto_post_revoked` Refusal write

Review wave, round 1, dispatched in one parallel message against the pinned fork
`06a163f0` and head `7c9bd9cd`, with the review gate green (29 rows, 0 FAIL, 0
WARN) behind it.

| Axis | Report | Findings |
|---|---|---|
| Spec & correctness | `spec-correctness.md` | 5 — 1 MEDIUM, 4 LOW |
| Standards & maintainability (cross-branch) | `standards-cross-branch.md` | 3 touching this branch |
| Red team | `docs/reviews/red-team/feat-1012-refusal-auto-post-revoked-b3e501/` | 1 P0, 3 P2 · 24 planted / 23 killed / 1 equivalent |

**Nothing was rejected.** Everything below is ACCEPT, either fixed on this branch
or carried to a named follow-up.

---

## RT-1 — P0 — the test arithmetic in this branch's own records was impossible

**Claim.** D1 said "13 of 19 titles genuinely red→green" with 7 negative-space.
13 + 7 = 20 against 19 titles. Its per-suite line — "3 RED / 3 pre-existing green
/ 3 of these" — described 9 tests in an 8-test file.

**Verdict: ACCEPT.** Re-derived by counting rather than by argument: 19 promised
titles, 5 in the unit suite and 14 in the live-DB suite; the unit file holds 8
`it` blocks, so 3 are pre-existing. With 7 negative-space titles the answer is
**12 of 19**, and the unit line is 2 RED / 3 pre-existing / 3 negative-space.

**Fixed** in the deviations file and in `.claude/reference/arch-review-log.md`.

**The part worth recording is whose failure it was.** The orchestrator had
verdicted D1 ACCEPT *and praised it for reporting counts "measured rather than
asserted, which is what makes this checkable"* — without checking them.
Endorsing a number without re-deriving it is the same defect as asserting one,
and it is worse from the reviewer than from the writer. The corrected verdict in
the deviations file says so in those words.

**What red team also proved, which is the reason the P0 is only about arithmetic:**
it planted the forbidden defect behind each of the seven negative-space titles —
a Refusal hoisted above its guard, a kill-switch bypass, a gate-reason collapse —
and **every one died.** The titles are live regression pins; only their count was
wrong.

## SC-1 — MEDIUM — the architecture-log row misdescribed its own review history

**Claim.** The row said "three adversarial plan rounds, fourteen findings"; the
plan's appendix documents ONE round, and `plan.md:107` attributed to "round 2"
the seven titles §8 attributes to round 1.

**Verdict: ACCEPT.** The real counts are 8 findings in round 1, 4 in round 2, 0
in round 3. The plan appendices only ever documented round 1 — rounds 2 and 3
were recorded in conversation and in the intake, never in the plan.

**Fixed:** the log row now states the per-round counts explicitly. **This is the
third instance this session of one class — a fact corrected in one artifact and
left stale in another.** The mechanical rule this repository already carries
(grep the fact across every artifact, then RE-GREP after fixing) was applied to
the plans and not to the log rows written afterwards.

## SC-2 — LOW — a rationale comment broke a pre-existing test's line resolution

**Claim.** `auto-policy-downgrade-lock-order.test.ts` resolves each rung of the
lock ladder with `body.indexOf('FROM businesses', anchor)`. The new `account_id`
comment contains that literal twelve lines above the real statement, so
`businessLock` resolved to the COMMENT. The test kept passing while measuring the
wrong line.

**Verdict: ACCEPT**, and it is the sharpest of the LOW findings — a green test
that has silently stopped testing anything is worse than a red one. Verified by
running the test's own resolution logic.

**Fixed:** the comment says "against the same table" instead, and the file now
carries an explicit prohibition on that literal appearing above the statement,
naming the test and why.

## SC-3 — LOW — the staging reconciliation query was stated as a false equality

**Claim.** The intake's `observability` promised `auto_post_revoked` rows would
EQUAL auto-policy revoked audit rows per account. This branch's own integration
suite disproves it: a re-downgrade writes two audit rows and one Refusal, because
`ON CONFLICT DO NOTHING` makes the first write win.

**Verdict: ACCEPT.** An operational check that fires on correct behaviour trains
its reader to ignore it.

**Fixed:** restated as `refusals <= audit rows`, with the reason, and with the
direction that actually indicates a defect named — a refusal count EXCEEDING the
audit count means a Refusal was written for a decision that never happened.

## SC-4 — LOW — a test comment described the wrong kill mechanism

**Claim.** The invariant-#15 case's comment says an independently committed row
"is still on disk at the last assertion". It is not: the caller holds
`businesses … FOR UPDATE` and `refusal_events.business_id` references that row,
so an insert on its own connection needs `FOR KEY SHARE` against a locked row and
BLOCKS until the statement timeout.

**Verdict: ACCEPT.** The test is correct and still goes RED; only its explanation
was wrong, and a wrong explanation is what the next author will reason from.

**Fixed:** the comment now says the mechanism is a lock wait, not a ghost row.

## SC-5 — LOW — the log row was dated tomorrow

**Verdict: ACCEPT.** Corrected to 2026-08-30.

---

## Standards findings touching this branch

**S-A — MEDIUM — `vocabulary.ts`'s "no production caller" header is now false.**
**Verdict: ACCEPT the finding, DEFER the fix.** The file is outside all three
swarm branches' edit surfaces by construction — disjoint surfaces are the premise
of running them in parallel — so no branch can fix it, and #1010's proposed
"whichever lands last" handoff cannot work either. Carried on the orchestrator as
a post-merge item, with the other doc-staleness findings, under one true
sentence: *the ledger now has two writers and its maps have callers.*

**S-B — LOW — `'REFUSAL_LEDGER_ENABLED'` re-spelled as a literal across six test
files** while `write.ts` owns it privately. **Verdict: ACCEPT, DEFER** — the fix
is to export the constant, which is a `src/lib/refusals/**` change and outside
this branch's surface. Same follow-up.

**S-C — LOW — positional bound-value indices in the unit suite couple to
`write.ts`'s column order.** **Verdict: ACCEPT, DEFER.** Real fragility, no
current failure; fixing it well means a named-column assertion helper, which is
new shared scaffolding this branch has no mandate to add.

---

## Red-team P2s

**RT-2 — the "never caught at the call site" invariant has no oracle.** A
call-site `try/catch` survived. **Arbiter ruled it EQUIVALENT** — postgres.js
rethrows the scope error, so `23514` propagates either way and the mutation
changes no observable behaviour. **Verdict: ACCEPT as recorded, no action.** A
mutant that cannot change behaviour is not a gap in the eval.

**RT-3 — same wrong-mechanism comment as SC-4.** Fixed once; both reports point
at the same line.

**RT-4 — the gate-scrape test hard-codes two files and counts two sites in
`applyJudgeGate`, which has no production importer at HEAD.** **Verdict: ACCEPT,
DEFER.** It over-counts against a dead path; harmless today, misleading later.
Noted for #1013, which touches the same publisher surface.
