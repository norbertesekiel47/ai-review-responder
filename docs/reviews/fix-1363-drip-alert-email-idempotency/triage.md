# Review wave round 1 — triage verdicts

Fork pinned: merge-base `10377aa9b`, head at review time `1b9fe88de`.
Five axes: spec & correctness, standards & maintainability, async/operations,
Codex adversarial, red team. Full reports alongside this file; red-team sidecar
in `docs/reviews/red-team/fix-1363-drip-alert-email-idempotency-65eabf/`.

Every finding below was re-verified against the code by the orchestrator before
being accepted. Two were rejected on evidence.

## Accepted — functional

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | high | Replay writes a synthetic `external_message_id`; `worker/ingress/resend.ts:229-246` correlates bounce/delivered/complained only on the real Resend id, so hard-bounce suppression silently stops working | FIXED. day_7 + owner nudge moved to mark-before-send, no key. Found by 3 axes independently. D8. |
| F2 | P1 | Completing the outbox row before the send while still rethrowing lets BullMQ retry the job and send a second nudge | FIXED. Owner nudge swallows and logs, as `WeeklySummaryWorker` does. Introduced by the F1 fix; caught by the pre-existing `throws on email send failure` test. D10. |
| F3 | P1 | Replay log lines had no oracle — deleting them left 61 tests green | FIXED. Added `a drip replay logs that the email was already delivered`; mutation-verified. D12. |
| F4 | medium | `revokeMode: 'never'` justification false — the orphan probe keys on `response_id`, and a pending response normally has an `approval_request` delivery | FIXED by reverting T2 entirely. The approval surface is byte-identical to main. D9. |
| F5 | medium | Outbox-scoping rationale false — cooldowns are 3/7/14 **days**, not hours | FIXED in code, not just prose: every key is now domain-scoped, which also covers the poller re-mint path. D11(a). |

## Accepted — documentation

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F6 | medium | "The ten existing callers are unaffected" false — 3 pre-existing keyed callers inherit 409-as-success | CORRECTED in plan + intake. Behaviour change is benign (all three send stable bodies) but was undeclared. D11(c). |
| F7 | low/P1 | "Seven pre-existing keys, all domain-scoped, no helper precedent" false — 13 sites; `NotificationFailoverPoller` uses a per-attempt claim id; `email-dedup.ts` is a named helper | CORRECTED in glossary + plan. D11(b). |
| F8 | low/P1 | "At most one extra live link per response" false — one per *attempt* | MOOT: T2 reverted, the claim no longer exists anywhere. D9. |
| F9 | low | "Every retry path completes in minutes" false — the 24h key window is reachable | CORRECTED in intake `edge_cases`; now stated as a bound on the crash-retry window, not a guarantee. D11(d). |
| F10 | medium/P2 | Observability over-promised — an identical-body replay never reaches 409, so it produces no flag, no log and no row; and the logs do not name the key | CORRECTED. The operator query is now documented as a FLOOR, not a total. D11(e). |
| F11 | P1 | Build evidence labelled `650f625e7`; post-rebase merge-base is `10377aa9b` | CORRECTED in deviations D7. Conclusion unchanged; red team re-measured at HEAD independently. |

## Accepted — filed, not fixed

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F12 | P1 | `AdminExceptionWorker.ts:138-150` — identical send-then-mark defect; guard at `:114` tests a status nothing writes | Verified both claims. Owner chose to file. Recorded as an intake non-goal. D13. |
| F13 | P2 | `worker/ingress/resend.ts:284` — same no-key shape on the hard-bounce admin alert | Filed with F12. Third-party ingress, invariant #6. D13. |
| F14 | P2 | `red-team-mutation-runner.test.ts` has a 16.1s/30s margin and will flake again | Pre-existing, unrelated to this branch. Filed with F12. |

## Rejected

| ID | Finding | Reason |
|---|---|---|
| R1 | Standards cited `worker/jobs/AccountOffboardingEmailWorker.ts:314,:427` as pre-existing keyed callers | Path does not exist. `ls` returns no such file. The *substance* was right — the real path is `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts` — so the underlying finding is accepted as F6/F7 with corrected citations, but the cited location is rejected. |
| R2 | Standards: comment:code ratio of 1.9:1 and 2.2:1 is padding; ~20 of 106 added comment lines are restatements | Partially accepted, partially rejected. The two duplicated `revokeMode: 'never'` blocks are gone with T2. The remaining density is deliberate and matches the neighbouring `Drip staleness cap` block in the same handler — and the review wave's own findings are the argument for it: three separate reasoning errors in this change were only catchable because the reasoning was written down where a reviewer could check it. Rejected as a defect; the specific restatements it named were removed. |

## Not triaged

Low-confidence appendix items in each report are recorded but not actioned, per
the wave's confidence filter. One is worth carrying forward and is named in the
spec & correctness appendix: the branch assumes a 409 proves the first request
was *accepted*, which is uncited for the case where the first request itself
errored. With F1 fixed, the only sends that can reach a 409 are stable-body ones
where a replay is rare, so the exposure is much smaller than when it was raised.

---

# Review wave round 2 — verification-only

Round 1 reviewed `1b9fe88de`; round 2 reviewed the fix commit `bb2e468af`. Two
agents: a consolidated fix-verification axis and red-team round 2. Round 2's
red-team sidecar could not be written by the subagent (its Write tool was blocked
for report paths), so the orchestrator materialized it from the returned content.

## The crux question, answered

Both agents were asked independently whether the day_7 mark-before-send can be
re-entered and send twice. **Both say no, with the same evidence:**
`AND sent_at IS NULL` at `OnboardingDripWorker.ts:261` sits OUTSIDE the
parenthesised `OR`, so it is conjunctive with the `claimed_by_outbox_id` arm.
Once the pre-send mark lands, every re-entry path falls to the skip branch before
any build or send. **No P0.**

## Round 1 findings re-verified

F2, F3, F4 and F7 confirmed FIXED. F1 confirmed fixed for the drip but only for
1 of its 2 live log sites — see R2-07.

## Round 2 findings

All 16 are in
`docs/reviews/red-team/fix-1363-drip-alert-email-idempotency-65eabf/findings.json`.
13 fixed, 3 accepted-risk under `AUTH-1363-SIBLINGS`, 0 open. Headlines:

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| R2-01 | P1 | day_7 loses the drip on ANY send error, not just a crash, and records nothing | FIXED — `markOutboxFailed`; the keyed path still rethrows |
| R2-02 | P1 | Nudge swallow left no durable record at all | FIXED — `insertFailedDelivery` |
| R2-03 | P1 | A claim round 1 disproved was re-asserted in NEW code and in the intake | FIXED |
| R2-06 | P1 | `if (bodyVaries)` to `if (true)` survived: the negative half had no oracle | FIXED, mutation re-verified by the orchestrator |
| R2-07 | P1 | Round-1 F1 was closed for only 1 of 2 live log sites | FIXED, both now covered |
| R2-08 | P1 | `AdminExceptionWorker` sibling | ACCEPTED-RISK — filed as #1393 on the owner's decision |

**Why R2-01 was fixed by adding a record rather than by rolling back the mark:**
`EmailSendTimeoutError` fires at 10 s while the orphaned fetch may still reach
Resend, so rolling back `sent_at` would re-send mail the provider already
accepted — the exact duplicate this branch exists to prevent.
`WeeklySummaryWorker` states the same rule at `summary-report-helpers.ts:115-118`.
The loss is real and is now described honestly everywhere; the silence was the
defect.

## Mutation result

All 7 briefed targets were killed on arrival. Three further mutants survived and
are now killed by new tests; the orchestrator independently re-ran two of them
(`if (true)` gives 1 of 25 failing; the partner-alert log gives 1 of 34) and
restored both. `ci:weakened-checks`: zero REVIEW rows in both rounds.

Restoration was clean this round — round 1's `mutate`-instead-of-`finalize`
hazard was not repeated, and the orchestrator verified porcelain and blob OIDs
afterwards.

## Round budget

Round 2 of 3 used. No round 3 is planned: zero open P0 and zero open P1 remain.
