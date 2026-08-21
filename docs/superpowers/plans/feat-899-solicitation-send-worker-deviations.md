# Deviations — #899 Solicitation send worker

Every entry is something the plan did not anticipate. Each carries a triage verdict
(ACCEPT / RE-PLAN) added at step 6, before review.

---

## D1 — `tests_to_add` extended from 23 to 34 titles

**When:** step 3 plan gate, rounds 2 and 3.
**What:** eleven test titles added — six from the orchestrator self-review, four from the
codex round-3 review, one from finding S7.
**Classification:** a `tests_to_add` EXTENSION, recorded as an owner-approved deviations
entry. Per the step 5 abort criteria, only `allowed_edit_surface` changes count toward the
amendment budget; `tests_to_add` retitles and extensions do not.
**Verdict:** ACCEPT.

## D2 — `allowed_edit_surface` amendment #1 (auto-approved)

**When:** step 3 plan gate, finding S7.
**What:** added `src/lib/solicitation/ask-compliance-lint.ts` and
`src/lib/solicitation/ask-generation.ts`.
**Why:** `lintAsk` takes `AskLintInput`, not bytes. Its two value lists are built by
`assembleInterpolation` (`ask-generation.ts:349`), which is not exported AND derives them from
**live** ask/visit data. Calling it at dispatch would re-lint against data that may have
changed since render, breaking the byte-for-byte **Owner approval** contract the Dispatch gate
exists to protect. The fix is a pure `lintInputFromSnapshot` mapper owned by
`ask-compliance-lint.ts`, with `assembleInterpolation` refactored to share it — one owner for
"which stored values feed the lint". This is the second use, so the abstraction is earned.
**Approval:** auto-approved under the step 2 rule (≤2 files inside `src/lib/solicitation/`,
a tree the surface already covers). Both intake copies updated and verified identical.
**Budget:** this is amendment **1 of 2**. A second amendment trips the abort criteria.
**Verdict:** ACCEPT.

## D3 — locked decision 4 revised, and decision 9 added

**When:** step 3 plan gate, codex round-3 finding C1. Escalated to the owner and decided.
**What:** the original decision 4 said a retry on a `sending` row "resumes — re-issue the
provider call with the same idempotency key". That is not implementable. The raw unsubscribe
token exists only in memory (invariant #5), so a fresh process after a crash holds only the
hash and cannot rebuild the same unsubscribe URL. Re-issuing would risk sending a message with
no working opt-out link if the original request never reached Resend.
**Resolution (owner decision):** retry lives INSIDE one handler invocation, with bounded
jittered backoff while the raw token is in scope. A fresh-process re-invocation never re-sends:
it completes the outbox row, leaves the row `sending`, and #900's D12d sweep terminalizes it
`unknown` / `send_indeterminate`.
**Cost accepted:** a process crash mid-send loses that one contact to `unknown` — exactly the
state D12d created for "we do not know whether this was sent".
**Verdict:** ACCEPT. Does not invalidate a locked decision so much as correct one that was
locked on a false premise; the owner re-decided it explicitly.

## D4 — codex finding C5 rejected (B10 / `QUEUE_NAMES`)

**When:** step 3 plan gate, round 3.
**What:** codex read B10 as forbidding `QUEUE_NAMES.SOLICITATION_SEND` in this PR.
**Verdict:** REJECT. B10 assigns the constant and the helper to "#630", written before #630
was decomposed into #899 (consumer) and #900 (producer). A BullMQ worker cannot be registered
without its queue name, and this ticket's scope §1 requires the worker registered here — so the
constant must land in this PR by mechanics. B10's stated argument ("a helper with no caller
turns any later raw insert red") is about the HELPER only, which we defer exactly as B10 asks.
Recorded as amendment B15 point 6 in Task 8.

## D5 — plan-gate review rounds were spent on tooling failures

**When:** step 3.
**What:** all three plan-review rounds were consumed. Round 1 went off-brief and ran
`verify-gate.sh`. Round 2 was killed by the orchestrator on a false stall reading — `timeout`
is not installed on this machine, so the wait windows returned instantly and made a working
process look hung. Round 3 succeeded once the brief carried a pre-extracted context bundle and
a hard no-scripts constraint.
**Durable lesson (promote to lab-notes at step 8):** on this machine `timeout`/`gtimeout` do
not exist; a `timeout N …` wrapper fails with exit 127 and can read as a fast clean return.
Bound waits with the Bash tool's own `timeout` parameter or a Monitor until-loop. Second
lesson: give `codex exec` its artifacts inline as a bundle rather than letting it read large
spec files — it reviews a snapshot, which also means the file can be edited during the review.
**Verdict:** ACCEPT.

## D6 — two tenant-column surprises in the solicitation schema

**When:** Task 0, while writing live-DB teardown.
**What:**
- `solicitation_suppressions` has **no `business_id`**, and a `global`-scope row carries no
  `account_id` either. Cleanup must key on `account_id` and accept that global rows are not
  tenant-scoped at all.
- `job_outbox` has **no tenant columns whatsoever**. Cleanup must reach through
  `payload->>'business_id'`.

**Why it matters beyond teardown:** a later task that copies a business-scoped delete from
another suite will silently strand rows, and a tenant-scoped read written by reflex will not
compile against either table. Both are load-bearing for Tasks 2 and 6.
**Promote at step 8:** yes — this belongs in lab-notes, not only here.
**Verdict:** ACCEPT.

## D7 — 30 of 34 eval titles landed as `it.todo`

**When:** Task 0.
**What:** only the two pure suites (`dispatch-gate`, `send-retry`) carry real assertions. The
other 30 titles are `it.todo`, each with a comment naming its owning task and the exact claim
to assert.
**Implementer's reasoning, accepted:** their assertions turn on which collaborators
`dispatch.ts` calls and in what order, which Tasks 2-6 own. Writing them now would pin internal
seams the plan deliberately left open, and the /feature workflow explicitly sanctions `.todo`
for "slices not yet buildable".
**Risk this creates, and the mitigation:** the gate's `promised-tests` row checks only that a
title EXISTS, so 30 todos would satisfy it while asserting nothing. Two mitigations, both required:
1. Every implementation task's definition of done now includes converting ITS OWN todos to real
   assertions. The orchestrator counts remaining todos after each task and refuses to advance
   while that task's own titles are still `todo`.
2. The final gate run is `scripts/verify-gate.sh --review`, whose `diff-coverage` row enforces
   changed-line coverage at 80% — "wrote code, wrote no test for it" fails mechanically.
**Verdict:** ACCEPT with both mitigations.
