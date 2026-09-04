# Deviations — fix/1083-ledger-attribution

Entries are things the plan did not anticipate. Each needs a resolved
**Verdict:** ACCEPT or RE-PLAN before the `reviewed` transition will pass.

---

## D1 — Ticket #1083's lane count was one lane out of date

**When**: step 0, classification.

The ticket says one lane attributes and six do not. It was filed 2026-09-02.
PR #1098 (#1079) merged 2026-09-03 and added the `held_draft` arm. At HEAD
`2be0c323` **two lanes attribute and five do not**, across seven call sites.

No scope change follows. The mechanism chosen covers all seven lanes regardless
of how many were already wrapped, and the plan's table records the true state.

**Verdict:** ACCEPT — a stale count in the ticket, corrected in the plan. The
work is unchanged.

---

## D2 — The stale ladder carried into `progress.mjs init`

**When**: step 0, opening the ladder.

`progress.mjs init` in the parent checkout returned a ladder whose `intake` and
`armed` steps were already `done`, timestamped `2026-09-03T10:30:06Z` — the
previous #1079 run. Steps 0 and 1 read as complete before any work existed.

This is open issue #1107 (`feature-setup.sh` carries a stale parent ladder).
Reset with `progress.mjs step intake pending` and `step armed pending`, then
re-closed each at its real boundary. `feature-setup.sh` later initialized the
worktree ladder cleanly from the intake with no parent carry, so the defect is
confined to the parent-checkout `init`.

**Verdict:** ACCEPT — worked around, and the underlying defect already has a
ticket. No change to this branch.

---

## D3 — The plan gate raised the test count from 12 to 16 across three rounds

**When**: step 3, plan gate, round 1.

Codex returned `VERDICT: REVISE` with four findings, all verified against source
and all accepted. Three were missing failing tests; one was a stale line
citation. The full table is in the plan's review appendix.

The material one is **F2**: `writeRefusalEvents` materializes its `rows` before
the INSERT, and `input.occurredAt.toISOString()` inside that map throws on a
type-valid `new Date(NaN)`. A guard around the statement alone would leave a
writer-side failure unattributed — this ticket's own defect, one layer in. The
guard now starts at the row map.

*(Citations here were originally `write.ts:904/925/922`, which resolved at the
fork and were stale at HEAD by the time the review wave read them — red team
P1. Rewritten to name symbols, for the same reason the handoff was.)*

Round 2 confirmed F1–F3 addressed and raised three residual items, the material
one being that the new "do not hoist `uuidv7()`" instruction had **no test** —
the same defect class as F2, since prose no test enforces is not a rule. A
sixteenth test closes it. Round 3 returned `VERDICT: APPROVED` with no
fix-introduced defects.

`tests_to_add` 12 → 16. `estimated_test_lines` 350 → 450.
`allowed_edit_surface` **unchanged across all three rounds**, so this is a
deviations entry and not a surface amendment; the amendment counter is
untouched.

**Verdict:** ACCEPT — the plan is stronger and the surface did not move.

---

## D4 — The set arm's `extra` key for the distinct sources was unspecified

**When**: step 4, integrating T1.

The plan said the set-arm capture carries "`row_count` and the distinct
sources" without naming the key. T1 could not pin what the plan had not named,
so it asserted the sources key-agnostically — a weaker test than the rest of
the eval.

Named on integration: **`refusal_lanes`**, the same sorted comma-joined string
as the `refusal_lane` tag, justified by a claim that a Sentry tag value
truncates at 200 characters while `extra` does not.

**THAT JUSTIFICATION WAS FALSE, AND ROUND 1 KILLED IT FROM THREE DIRECTIONS.**
All seven lanes sorted and comma-joined is **108 characters**. The truncation it
guarded against is arithmetically unreachable, so the field was pure duplication
of a tag that is strictly better than `extra` for the purpose — tags are
filterable in Sentry, `extra` is not. Spec, standards and red team each found it
independently. It is worth naming what went wrong: a plausible-sounding reason
that nobody checked with arithmetic, propagated into a LOCKED `CONTEXT.md`
entry, a production docblock, a test comment and the plan before anyone
multiplied seven strings.

`refusal_lanes` is **removed**. The set-arm `extra` is now
`{ row_count, account_id, account_count }` — see D10, which folds in the
adversarial axis's separate finding that the set arm carried no tenant identity
at all.

**Verdict:** ACCEPT — the gap was real, the first fix for it was wrong, and the
correction is recorded rather than quietly rewritten.

---

## D5 — Two of the sixteen eval titles pass before implementation

**When**: step 4, T1.

The plan's Done-when says "sixteen new failing assertions". The run shows
**fourteen failing, two passing**, and both passes are correct:

- `commits the response persist when the policy gate resolver would throw and
  the kill switch is off` is #1079's containment invariant. The plan itself
  requires it to pass **both before and after** — it is a regression pin, not a
  red test.
- `attributes a policy gate vocabulary fault without also attributing a write
  fault` passes because the surviving wrapper already reports that fault
  identically before and after T4. It pins that the wrapper's `extra` stays
  `{response_id}` rather than becoming the writer's five-key payload.

The double-attribution risk T4 introduces is caught by `raises exactly one
capture for a policy gate write failure`, which asserts the surviving capture
carries the **writer's** payload. A bare count of one would not have failed —
"delete the writer guard, keep the wrapper" also produces one — so the eval
asserts the shape, not the count.

**Verdict:** ACCEPT — the plan's own Done-when wording was imprecise, not the
eval. Fourteen is the correct number of red tests.

---

## D6 — The reclassify trigger fired on reindentation, not on scope

**When**: step 4, after T2/T3.

`verify-gate.sh` raised
`RECLASSIFY: production 367 > 2x estimated_prod_lines (180)`.

| Measure | Added | Removed | Total |
|---|---|---|---|
| Raw `git diff --numstat` | 253 | 114 | **367** |
| `git diff -w` (whitespace ignored) | 159 | 20 | **179** |

The 188-line gap is entirely reindentation: T2 and T3 wrap two long tagged SQL
templates in `try` blocks, so every line of both templates shifts two spaces and
`git diff` counts each as changed-and-re-added. The substance is 179 lines
against an estimate of 180.

**Final numbers, at the green gate (HEAD `330b938e`)** — the row read 496 once
T4 and the doc rows landed:

| File | Raw | `-w` |
|---|---|---|
| `src/lib/refusals/write.ts` | 367 | 179 |
| `worker/jobs/response-generation/persist.ts` | 123 | 95 |
| **Code total** | **490** | **274** |

274 against a 180 estimate is **1.52×**, comfortably under the 2× trigger. The
remaining six of the reported 496 are four single-line doc rows in `CONTEXT.md`,
`docs/directory.md` and `.claude/reference/arch-review-log.md`, which the row's
exclusion list does not cover because it excludes only
`docs/superpowers/plans/**` and `docs/reviews/**`.

**After the review round (HEAD `6a382d1a`), the row reads 577** and the code
buckets are:

| File | Raw | `-w` |
|---|---|---|
| `src/lib/refusals/write.ts` | 404 | 216 |
| `worker/jobs/response-generation/persist.ts` | 133 | 105 |
| `src/lib/refusals/vocabulary.ts` | 7 | 7 |
| **Code total** | **544** | **328** |

328 against 180 is **1.82×** — still under the trigger, but it climbed from 1.52×
and that movement is real rather than reindentation: the `fault` tag, the two
payload redesigns and the corrected docblocks all landed in production files.
**A third round of comparable size would genuinely cross 2×, and that would be a
true signal rather than noise.** Recording the trajectory, not just the number,
because the trigger fires on a level and the useful information here is the
slope.

No re-classification is warranted, and the estimate was accurate. The row is not
wrong — it measures raw changed lines, which is the right default for a scope
trigger — it simply cannot distinguish a reindent from new logic. Worth noting
beside open issue #1114, which is the same row misclassifying a different input.

**Verdict:** ACCEPT — measured, not waved away. The trigger is a WARN, the
substance is on estimate, and step 0 is not re-run.

---

## D7 — A baseline gate was run while a subagent was in flight, and it raced

**When**: step 4, between T1 and T2/T3.

The Stop hook blocked the session for stale gate evidence while the T2/T3
subagent was working. `git status --porcelain` showed a CLEAN tree, so the gate
looked safe to run against HEAD. It was not: the agent wrote `write.ts` during
the roughly two-minute run, and the reclassify row read a tree that already
carried the edit. The 367 in D6 is exactly `253 + 114` from a file the gate was
never meant to see.

The `execution-lanes.md` subagent barrier says not to do this, and the reason it
gives is the narrower one — a subagent returning mid-gate moves HEAD. Subagents
here commit nothing, so HEAD could not move, and that made the rule look
inapplicable. **The working tree moves too, and that is enough to corrupt a
row.** A clean `git status` is a snapshot, not a lease.

No bad evidence survived: `--baseline` does not advance the phase and writes no
fingerprint, so nothing downstream consumed it. The correct move was to wait for
the agent and gate afterwards.

**Verdict:** ACCEPT — no artifact was poisoned, and the lesson is durable.
Promote to lab-notes at step 8: *the subagent barrier is about the working tree,
not only HEAD; a clean porcelain does not make a mid-flight gate safe.*

---

## D8 — Two more stale docblock sentences, outside the wrapper the plan named

**When**: step 4, T4.

The plan named two sentences in `withLedgerAttribution`'s own docblock that go
stale when the wrapper narrows. T4 found two more, in
`recordPolicyGateRefusal`'s docblock — a different function:

- Bullet 4's zero-window argument asserted that `withLedgerAttribution` and
  `writeRefusalEvent` "each run synchronously to their first `await`". The
  wrapper now has no `await` at all.
- Bullet 5 said the recordability guard "now lives INSIDE
  `withLedgerAttribution`". It now sits on the wrapper's return value, outside
  it.

Both corrected inside the lease. Neither is a behaviour change; both are
sentences that would have contradicted the code in the same file.

The generalisable point: this repo's docblocks cite each other across function
boundaries, so narrowing a function invalidates prose in its *callers* as well
as its own. A grep for the symbol name is the cheap check, and the plan did not
call for one.

**Verdict:** ACCEPT — caught and fixed in scope. Promote the grep habit to
lab-notes at step 8 alongside D7.

---

## D9 — Two gate rounds lost to unrelated suites timing out under machine load

**When**: step 5, gate rounds 1 and 2.

Two consecutive `--review` gates went RED on a `test` row, each on a
**different** suite, neither in this branch's edit surface:

| Round | Suite | Failure |
|---|---|---|
| 1 | `scripts/ci/__tests__/live-db-suites-audit.test.ts` | `Test timed out in 5000ms` |
| 2 | `src/lib/locations/__tests__/review-qr.test.ts` | `Test timed out in 5000ms` |

Neither was an assertion failure. Both pass in isolation — 43/43 in 776 ms and
17/17 in 836 ms respectively.

**The same failure class twice is the anti-thrash trigger, so the class was
diagnosed rather than the instances patched.** Machine load average was
**21.97**, with `mediaanalysisd` at 212% CPU. Under vitest's 5000 ms default,
any repository-reading suite loses the race; which suite loses is arbitrary,
which is why two rounds named two different files. The third run, on the
identical commit, went GREEN — same code, same SHA, different load.

Nothing was fixed and nothing needed fixing. Recorded because a reader of
`.feature/state.json` will otherwise see `gateFailRounds=2` and reasonably
assume this branch failed its gate twice on its own merits. It did not.

Round 1 also carried a real failure alongside the flake — `merge-ledger`,
because `.claude/reference/arch-review-log.md` had no added line. That audit
reads `git diff mergeBase..HEAD`, so writing the row was not enough; it had to
be committed. Genuine miss, genuinely fixed.

**Verdict:** ACCEPT — one real defect fixed, two environmental flakes
identified and not chased. The gate was green at `330b938e` with a fingerprint
current **as of that commit**.

**Correction (red team P2).** The sentence above originally read "the gate is
green at `330b938e` with a current fingerprint", present tense, and by the time
the review wave ran that was false: two docs-only commits had moved HEAD to
`c94277bf` and the fingerprint's `headSha` was two behind. The claim was true
when written and became stale without anyone rewriting it, which is the whole
reason gate evidence is keyed to a SHA rather than to a phase. Tense fixed and
the SHA named; the final gate at step 7.5 is what re-establishes it.

---

## D10 — The review wave rewrote both `extra` payloads and added a `fault` tag

**When**: step 7, round 1 triage.

Four independent axes converged on the same surface. Twenty-five findings; the
consolidated table is in `docs/reviews/fix-1083-ledger-attribution/`. The
structural ones:

**The set arm's `extra` was wrong in four ways at once.** Red team's two P0s:
adding `refusal_codes: inputs.map(r => r.refusalCode).join(',')` **survived every
suite, 146/146 green including both live-DB suites** — so nothing held the
payload closed and gate prose could ride a Sentry event against the intake's own
invariant; and `refusal_lanes` was asserted only on a single-lane fixture, so
degrading it to `inputs[0].refusalSource` also survived. The adversarial axis
found no tenant, batch or run identity at all. Spec and standards found the
`refusal_lanes` rationale arithmetically false (D4).

Resolution — one redesign answering all four:

| Arm | Before | After |
|---|---|---|
| single-row | `{ refusal_source, subject_type, subject_id, account_id, business_id }` | `{ subject_type, subject_id, account_id, business_id }` |
| set | `{ row_count, refusal_lanes }` | `{ row_count, account_id, account_count }` |

`refusal_source`/`refusal_lanes` are gone because the **tag** already carries the
lane and a tag is filterable where `extra` is not. `account_id` is the single
distinct value or `null`; `account_count` the distinct count. Both bounded —
never a joined list of up to 5,000 ids. The writer genuinely cannot see the batch
or the run, so the adversarial axis's ask for those is answered with the account
rather than by widening the interface, which is the design this whole branch
exists to protect. **The eval now asserts an exact sorted key list on both arms**,
which is what actually kills the P0: presence assertions do not hold a payload
closed.

**The tags could not distinguish the two fault classes.** Standards and red team
both found that on `policy_gate_held` the write fault and the vocabulary fault
carried byte-identical tag sets, separated only by `extra` — which a Sentry
alert rule cannot filter on. That comes close to defeating the ticket's purpose.
Both captures now carry `fault=ledger_write` / `fault=ledger_vocabulary`,
following this module's own `fault=unmapped_block_reason` convention and the
rule `beta-launch-alerting.md` states. Two intake titles changed (16 → 17).

**Surface amendment #1, owner-approved.** `docs/runbooks/beta-launch-alerting.md`
said three `error`-level `subsystem:refusal_ledger` emitters and named
`withLedgerAttribution` as the attribution source. There are four and it is not.
Three axes flagged it, red team as P1. `src/lib/refusals/vocabulary.ts` joined in
the same amendment under the auto-approve rule (two files inside a tree the
surface already covers) — its docblock still said "write.ts's **uncaught**
INSERT".

**Stale citations, six sites.** The handoff's four `write.ts` line numbers all
resolved at the fork and were stale at HEAD, three of them landing in the *other*
write arm; `write.test.ts` cited `:61` for an import this same commit moved to
`:73`; `docs/directory.md` claimed `uuidv7()` is interpolated inside *both*
templates, which is false for the set arm, where it sits in the `rows` map and is
protected by the moved guard instead — two different mechanisms, and collapsing
them is how the weaker one gets broken later. Three docblocks in
`refusal-write.integration.test.ts` still named the removed wrapper, **inside a
file already in the lease**, which is D8's own grep lesson written down and then
not applied.

**Rejected, with the owner's decision recorded.** The adversarial axis asked for
a latch or cap on `captureLedgerWriteFault`, arguing from this module's two
existing latches. Rejected 2026-09-04: those latches exist to stop unbounded
issue-GROUP scattering, because their keys are distinct codes. This signal cannot
scatter — one exception shape, seven bounded lanes — so Sentry groups it into a
single issue with a count, and a latch on an error-level write fault would hide
whether it is still happening, which is the opposite of what an operator needs
mid-incident. Listed in the PR under rejected findings.

**Verdict:** ACCEPT — the wave found real defects in the payload design and the
tag set, both fixed; one finding rejected with reasoning; one surface amendment
taken with sign-off.

---

## D11 — Red-team round 2: both P0s dead, four doc-truth defects, one of them mine twice over

**When**: step 7.5, red-team round 2 (the round cap; there is no round 3).

**Both P0s confirmed dead**, by re-applying round 1's own surviving mutation
verbatim rather than by inspection. The closed-key assertion is exact in both
directions — an added key fails and a removed key fails — and the
`refusal_lanes` degradation class is gone with the field. All six other round-1
findings verified fixed.

Four defects the fixes introduced or left half-done. All doc-truth, all fixed:

| ID | Sev | Finding |
|---|---|---|
| RT-3 (half) | P1 | The runbook's **"no dedicated rule" register** still said four signals; at HEAD it is six. |
| RT2-2 | P1 | `docs/directory.md`'s `persist.ts` row still claimed a `lane` parameter that was deleted, and a "five-key `extra`" that is now four. |
| RT2-3 | P1 | The handoff still said sixteen titles split twelve/four; it is seventeen split twelve/five. |
| RT2-4 | P2 | `write.ts:891` stale in the plan — it now lands inside the set arm's INSERT column list. |

**RT-3 is the one worth sitting with.** That register's own text reads: *"The
count was 'two' and the two new signals were not listed when they shipped; red
team caught the omission, which is the same class of defect this whole register
exists to prevent."* This branch corrected the runbook's PROSE — four emitters
became six — and left the register at four. The same commit fixed one half of
the omission and created the other half, and red team caught it a second time,
the same way. The register is now at six and carries a note saying the count has
been wrong twice: anyone adding a `subsystem:refusal_ledger` or `fault:` emitter
must grep for the COUNT, not only for the emitter's name.

**RT2-4 was the visible tip of a much larger problem.** Red team named one stale
citation. A sweep resolving *every* `file:line` in the branch's docs against HEAD
found **sixteen**, all in the plan — each landing on a real line and none on the
thing it names, which reads as correct and is therefore worse than a dangling
reference. They are left in place under a header note rather than rewritten: the
plan records what was planned and its citations were true when made. The handoff
— the doc a resumed session actually reads — was already converted to symbols.
The lesson is the sweep, not the four fixes: **finding stale citations one at a
time is how you miss fifteen.**

**One operational finding from the pass itself**, worth promoting to lab-notes:
*do not restore a red-team mutation by re-invoking `mutate` with HEAD content.*
That appends a journal entry whose `original` is the previous mutant, so
`finalize` correctly re-plants an intermediate mutant. The finalizer's
foreign-content abort behaved exactly as designed and never overwrote content it
had not written; the last two entries were resolved by hand with
`git checkout -- <named paths>`. Restoration verified by blob oid against HEAD,
not by porcelain alone.

Status at the cap is `OPEN_P1` in the sidecar as round 2 wrote it. All four are
fixed in this commit; dispositions updated and re-verified, with no round behind
them — so the verification is recorded here and in `findings.md` rather than
asserted by a third pass that the protocol does not allow.

**Verdict:** ACCEPT — the P0s are dead, the four residual defects are fixed, and
the citation sweep found and contained a defect class the round only sampled.
