# Run D / Run E parallel-start coordination

## D-E1 — Local Run E starts while Run D observes

**Date:** 2026-09-14 UTC.

The original ticket required D and its documentation closeout to merge before E started. During D's required full-day observation, the owner asked to start E now because D implementation was finished. Root accepted this as authority to overlap local work only.

The worktrees overlap in Operator modules, worker code, tests and documentation. Run C is already shipped and receives no edits. Run D remains at candidate `4b13d96621b156a47dbc4140995f45745bc8114d` on staging for its existing observation window, 2026-09-13T21:46:17Z through no earlier than 2026-09-14T21:46:17Z. Its hourly browser checks and five-minute health sampling continue without a reset or discarded sample.

Run E starts in `codex-owner-operator-run-e` from that committed D candidate, with its own dependency installation and local database `test_ws5`; D uses `test_ws4`. No agent writes across worktrees. E remote migrations, staging deployment, final review gate and merge wait for D and D's closeout. After D lands, root normalizes E onto current main, resolves any D review-fix overlap explicitly, then freezes E's final review fork. No guard or fingerprint is rewritten to pretend the temporary stacked base is main.

**Verdict:** ACCEPT — owner-requested local parallel start; final D-before-E shipping order and the full-day observation remain intact.

## D-E2 — Conservative correction: E is paused

The earlier entry preserves root's initial interpretation, not the current instruction. The owner's wording was “Can we also not start E right now since we already finished implementation of D, right?” Root later sought clarification and, without a reply, adopted the conservative reading at `2026-09-14T06:04Z`: keep E paused until D is fully verified unless the owner says otherwise. Existing local E work is preserved. Its remote migration, deployment, final gate and merge also wait for D's separate documentation closeout. The durable E handoff and D runtime record carry this correction.

**Current coordination:** E remains paused. Do not use D-E1 as authority to resume it during D's observation.

**Verdict:** ACCEPT — root adopts the conservative pause interpretation; this supersedes D-E1's authority to continue local E work during observation without claiming a new owner answer.

## D-DOC1 — Prepare D closeout during the observation

On September 14 the owner asked, “Can you speedup the process for D please.” Root moved documentation preparation into the existing observation interval: record established T3/T4 evidence, correct stale descriptions of deployed timing, prepare the remaining browser recovery checklist and cleanup inputs, and collect the timing/runtime evidence needed for the final decision. This reduces work after the interval without changing the product candidate or marking the 24-hour requirement complete early.

T5 remains active and T6 is active for that documentation preparation. Final measured results, fixture teardown, the final gate, independent review, adversarial verification, feature merge and separate documentation closeout remain required. This does not authorize a new review round, an additional test budget, E work, or a production flag change.

The session refresh's local recorder replacement is recorded separately in `docs/runbooks/evidence/owner-operator-run-d-2026-09-13/observation-recorder-continuation.json`: the original process was confirmed absent, the prior log was preserved, and a new bounded process continued with a 141.063791-second boundary gap and the original end time.

**Verdict:** ACCEPT — the owner's speed-up request permits overlapping documentation preparation; the full-day requirement, review budgets and final shipping order are preserved.

## D-OBS1 — Owner ends the observation early

At17:35Z on September14, the owner instructed: “Hm actually everything looks good so far, you can stop the observability and proceed, go ahead.” Root stopped only the verified local recorder and its paired sleep-prevention process, confirmed both absent, and retained every health segment, UI attempt and database result. The final database capture at17:36:31.857381Z covers19h50m14.857381s and24 completed requests from24 actual submissions; `full_24_hours_elapsed=false` remains explicit. Registered slot20 was not submitted; slots20–24 are cancelled. No shortened interval is relabelled as a full-day pass.

The intake and plan now carry this owner-approved duration amendment. Retain the180-second lease,1200-second predecessor limit and10000-ms recheck delay: the measured sample does not justify reducing their safety margins. The separate recovery fixture may run after the retained final capture, with its time guard pinned to that capture rather than the superseded24-hour end. All tenant, candidate, fixed-ID, transaction, no-provider, and temporary-outbox safeguards remain. This fixture-only adjustment is within the existing evidence surface and implements the owner's instruction to proceed; it does not change product code or verifier budgets.

Final browser recovery proof, fixture cleanup, gates, independent and adversarial reviews, feature merge and separate documentation closeout are still owed. E remains paused until D closeout. The earlier D-DOC1/full-day wording remains historical; this decision supersedes its duration requirement.

**Verdict:** ACCEPT — explicit owner approval changes the duration requirement, with the actual interval and unchanged remaining acceptance work recorded.

## D-REV1 — Recover the final dispatch after reconciliation rollback

Independent async review D-A1 identified a continuation missing from the new coupled exhaustion transaction. If reconciliation aborts after the terminal outbox update, rollback correctly leaves the turn accepted and its outbox dispatching at its final attempt. Existing pending claims and watchdog predicates never take ownership of that pair. The inherited generic omission becomes an additional failure path of D's new transaction.

Root reproduced this by extending the existing rollback integration case: after the injected database failure, age the exact dispatch and run the production watchdog. The original code leaves the pair stuck; the correction terminalizes the exact Operator pair atomically. The existing terminal watchdog query now also includes exhausted `agent_turn` dispatching rows beyond the existing two-minute stale-claim fence, or with no dispatch timestamp. Other topics retain their existing predicates, and no timing or attempt budget changes. The same reconciler preserves live or contended claims as recoverable dispatched work.

The four focused poller/watchdog/worker suites pass **57 tests**, including new live-claim, other-topic, missing-timestamp and contended-completion coverage. The SQL-shape unit assertion was updated for the status-specific fallback error wording; live-DB assertions still prove existing errors are preserved. Root also corrected a pre-existing sibling-proposal test that inferred model order from tied transaction timestamps; it now identifies proposals by their distinct inputs and asserts exact reply order.

The original staging campaign remains evidence for candidate `4b13d96621b156a47dbc4140995f45745bc8114d`. It does not verify this later recovery correction; a scoped deployment check is required before shipping. The observation remains closed. The locked recovery invariant and allowed product paths are unchanged, so this is an accepted review correction, not another plan-review round.

**Verdict:** ACCEPT — restore the promised recoverable-work invariant within the existing D poller and test seams. Follow-up review, final gate and scoped staging verification remain required.

## D-RT1 — Owner-authorized finite second-pass budget

The first adversarial pass discovered226 test identities and traced50 to changed bodies/helpers or D production hunks;176 discovery-only cases were explicitly excluded. It spent the ordinary30 launches on15 green-baseline/semantic-mutation pairs, all killed and restored. The35 remaining cases require at least70 launches, so the ordinary30-launch second-round budget cannot finish the finite inventory.

The owner approved the exact Run D-only proposal with “Go for it,” permitting at most200 supervised local launches in round2 for those remaining cases, D-A1 and its callers, and the verifier safeguards. The verbatim approval, original inventory digest, preserved-history contract and four existing supporting paths are recorded in [second-pass-authorization.md](../../reviews/codex-owner-operator-run-d/second-pass-authorization.md). The nonexistent script mirror named in the draft is omitted rather than created. This is the third explicitly authorized surface amendment; product paths and the observation end are unchanged.

The grant is tied to D's branch, second round, original evidence, exact committed owner approval and a pinned corrected HEAD. Every other budget, isolation and restoration safeguard remains. No third round or accepted-risk disposition is authorized. The first report remains INCOMPLETE_BUDGET until fresh measurements resolve the unmeasured cases.

**Verdict:** ACCEPT — explicit owner approval for the finite next pass and narrowly named verifier support, with prior evidence retained.
