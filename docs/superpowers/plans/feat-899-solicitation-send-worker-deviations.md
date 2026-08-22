# Deviations — #899 Solicitation send worker

## STEP 8 CHECKLIST — carry every one of these out of this branch

Collected here so the post-merge sweep has one list. Items 1-3 are follow-up TICKETS, not
edits to this branch. Items 4-6 are edits the step 8 sweep makes on `main`, where this
worktree's edit-surface guard does not apply — so none of them needs a surface amendment.

1. **Relocate the provider-agnostic error vocabulary** out of
   `src/lib/payments/stripe-error-inspect.ts` (see D8). Its header claims "Stripe" ownership and
   "two consumers"; there are now three and the third is solicitation. Mechanical, and it should
   not ride a feature branch.
2. **Per-location place-id readiness check** (see D11). The **Send handoff** already withholds a
   whole location for a missing **Attested postal address**; a missing or non-canonical
   `google_place_id` is the same class of fact and belongs there, not in a per-contact throw.
3. **Re-check `queued`-row recovery in #900.** A flag-off defer (decision 5) leaves the row
   `queued`, and #900's release predicate reads `rendered` — so only the 72h
   `send_window_elapsed` halt reclaims it. Confirm that is intended when #900 is built.
4. **`docs/analytics/events.md` → flip `solicitation_suppressed_at_dispatch`** from
   `**Status:** planned` to `live`, and replace "Owner: #630's dispatch path (not yet built)".
   **This does NOT fail CI** — `ci:analytics-events` only enforces that code events are
   documented and that `live` doc entries exist in code, so a stale `planned` passes. It is a
   registry-accuracy fix, and that registry is the single owner of the event's key and
   properties (it already caught one defect here — see D9).
5. **Lab-notes: the two tenant-column traps** (see D6) — `solicitation_suppressions` has no
   `business_id` and global rows carry no `account_id`; `job_outbox` has no tenant columns at
   all. Both will bite the next author who writes a business-scoped delete by reflex.
6. **Lab-notes: `timeout(1) `is not installed on this machine** (see D5). A command wrapped in
   `timeout N …` exits 127 instantly and can read as a fast clean return — it cost a killed
   review round in this very session.


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

## D8 — `send-retry.ts` imports a constant from `src/lib/payments/`

**When:** Task 5.
**What:** `classifySendFailure` reuses `RETRYABLE_NETWORK_ERROR_CODES`,
`errorStringProperty` and `errorNumberProperty` from
`src/lib/payments/stripe-error-inspect.ts` rather than re-spelling a near-duplicate set.

**Checked before accepting:**
- That file has **zero imports**. It is pure constants plus defensive property readers, so the
  import drags no Stripe SDK, no client and no config into the solicitation send path.
- The eight codes (`ECONNABORTED`, `ECONNREFUSED`, `ECONNRESET`, `EAI_AGAIN`, `ENETDOWN`,
  `ENETRESET`, `ENETUNREACH`, `ETIMEDOUT`) are OS-level socket codes and genuinely
  provider-agnostic — nothing about them is Stripe-specific.
- The repo rule is "no near-duplicate dependencies" and "precedent over invention". Copying
  eight codes into a second set is exactly the drift that file's own header exists to prevent.

**Verdict:** ACCEPT the import.

**Residual debt, deliberately NOT fixed here.** That file's header calls itself "Single owner of
the **Stripe** error-inspection vocabulary" and names "Two consumers". There are now three, and
the third is not Stripe. The honest fix is to rename or relocate the provider-agnostic half.
`src/lib/payments/stripe-error-inspect.ts` is **outside this ticket's edit surface**, and adding
it would be `allowed_edit_surface` amendment **2 of 2**, which trips the step 5 abort criteria
and forces a re-plan. That is a disproportionate price for a comment.

**Follow-up ticket at step 8:** relocate the provider-agnostic error vocabulary
(`RETRYABLE_NETWORK_ERROR_CODES`, `errorStringProperty`, `errorNumberProperty`) to a neutral
home and update its three consumers. Small, mechanical, and it should not ride this branch.

**For the step 7 standards reviewer:** this is a known, triaged decision, not a new finding.

## D9 — the plan invented an analytics event key that was already a registered contract

**When:** Task 2. Caught by the implementer, who followed the plan but flagged the conflict.
**What:** the plan specified `eventKey: solicitation_suppressed_at_dispatch:<outreachId>`
(colon, per dispatch attempt). `docs/analytics/events.md:266-275` had already registered the
event with `solicitation_suppressed_at_dispatch_<ask_id>` (underscore, "one refusal per Ask"),
required properties `source` + `ask_id`, **no** optional properties, and explicit privacy notes.

**Root cause:** the orchestrator guessed a key format instead of reading the registry — a
straight "look up, don't guess" violation, and the registry existed precisely so this ticket
could emit the event without a migration.

**Resolution:** `docs/analytics/events.md` wins; it is the single owner. Corrected in
`src/lib/solicitation/dispatch.ts` (key now keyed on the Ask, `outreach_id` property dropped
because the contract lists no optional properties), in the integration test that pinned the old
key, and in the plan. Re-ran the suite: 8 passed, 15 todo, and the run genuinely hit the
database — `describeWithDb` emits a stderr warning and registers `describe.skip` when the DB is
absent, and neither appeared.

**The grain matters, it is not cosmetic.** Keying on the Ask means neither a BullMQ retry nor a
regenerate re-dispatch inflates the refusal count. Keying on the Outreach row would have made a
regenerate look like a second opt-out.

**Verdict:** ACCEPT the correction. No surface amendment needed — every file touched was already
in surface.

## D10 — `allowed_edit_surface` amendment 2 of 2, with the abort trigger WAIVED by the owner

**When:** after Task 3, which found it. Task 3 correctly refused to fix it — out of its surface.
**What:** Task 2 made `dispatch.ts` a run-spine caller, which
`src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` detects by AST scan. Two of its four
tests failed, so `pnpm test` was red and the step 5 gate could not go green.

**Why it needed the owner.** That file sits outside the surface, and the step 5 abort criteria
count "a 2nd amendment of `allowed_edit_surface`" as a trigger to write a post-mortem, tear the
branch down and restart at step 1. Six tasks of correct, tested work would have been discarded
over a test allowlist.

**Owner decision:** amend and continue; abort trigger explicitly waived. Reasoning accepted: the
abort rule exists to catch a mis-classified lane, and this is not that. It is the mechanical
audit entry EVERY new run-spine caller in this repo must make —
`src/lib/solicitation/{approval,ask-generation,outreach}.ts` all already carry the identical
pair, and this is the fourth solicitation module doing the same thing.

**What changed:** three entries, not the two first estimated — the file also self-pins the
carve-out set in an assertion, so `CALLER_ALLOWLIST`, `NON_REVIEW_SUBJECT_CALLERS` and the
pinning `toEqual` all needed `dispatch.ts`.

**The lock analysis was WRITTEN, not copied.** That file's header explicitly warns that an
earlier entry copied a sibling's premise verbatim and the premise was false, concluding "a lock
analysis resting on an untrue premise is worthless even when its conclusion happens to be
right." So the new entry states dispatch.ts's real order — `job_outbox` row → per-business
advisory lock → `solicitation_batches` row → `solicitation_outreach` row → agent_runs — and
records that its only `businesses` read (`readPostalAddressState`) takes no row lock. It also
carries forward the warning that the two SLOW gate items must stay above tx1, since moving them
inside would hold every one of those locks across a ~10s provider call.

**Budget:** amendments 2 of 2 are now spent. Any further surface need aborts.
**Verdict:** ACCEPT under the owner's waiver. Test now 4/4 green.

## D11 — the review link was never specified, and the obvious source can mint a broken URL

**When:** Task 4, which STOPPED and reported rather than guessing. Correct call.
**What:** every ask body carries exactly one `{{review_link}}` (the lint class
`review_link_placeholder_exactly_once` enforces it), so dispatch must substitute a real URL. No
spec in the solicitation family ever defines it: #622 §7.2 locks only the three footer blocks,
ask-generation §731 assigns "review link content" to #622, and #622 does not deliver it.

**Two non-equivalent candidates, neither authoritative:**
- `businesses.google_maps_url` — the only Google CTA in production today
  (`src/app/r/google/[responseId]/route.ts:91`), but a **view** link, not a write-review link.
- `https://search.google.com/local/writereview?placeid=<id>` — a real write-review deep link,
  named at `src/lib/reviews/url-parser.ts:13` and in the 2026-05-09 review-generation spec, both
  for other purposes.

**The hazard Task 4 found, which the orchestrator had missed:** `google_place_id` is nullable
AND migration 007 shows legacy rows holding **hex CIDs** rather than canonical Place IDs. So the
write-review shape can mint a URL that resolves to nothing — silently, in a real customer's
inbox. CLAUDE.md already carries this as a standing gotcha ("Google Maps URLs use hex CIDs, not
canonical Place IDs").

**Owner ruling:** use the write-review deep link; **throw** when the place id is null OR fails
`isPlaceId` (`url-parser.ts:77` — the existing validator, not a new one). No new withheld reason
(needs a migration), no eighth gate item (B6/B14 lock it at seven). A business reaching the send
lane without a usable place id is an upstream bug; a loud failure names it, a `withheld` row
would bury it.

**Test added (a `tests_to_add` extension, not a surface amendment):**
`throws rather than sending when the business has no canonical Google place id` — covering BOTH
arms, null and hex CID, because the CID arm is the one a future reader will assume is fine.

**Follow-up for step 8:** the right long-term home is a per-location readiness check. The **Send
handoff** already withholds a whole location for a missing **Attested postal address**, and a
missing or non-canonical place id is the same class of fact. File it against the send-handoff
owner rather than growing this ticket.

**Verdict:** ACCEPT.
