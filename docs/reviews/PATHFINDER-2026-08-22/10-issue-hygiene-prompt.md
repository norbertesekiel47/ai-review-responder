# Paste-ready prompt — issue hygiene before #631

Seven tracker items carry text this pass measured as wrong, stale, or already
delivered. Each would send an implementer down a wrong path. All are edits to
GitHub issues; none touches code except item 7.

Verified against `main` after #932–#935 landed, 2026-08-23.

```
Repo: RepWorth. This is tracker hygiene, not a code change. Items 1-6 are
`gh issue edit` / `gh issue close`. Item 7 is one verification.

Do this BEFORE anyone starts #631. Seven open issues carry text that a 2026-08-22
architecture pass measured as wrong, stale, or already shipped. An implementer
picking any of them up today follows a bad instruction.

Evidence for every claim below:
  docs/reviews/PATHFINDER-2026-08-22/07-handoff-reverification.md
  docs/reviews/PATHFINDER-2026-08-22/02-duplication-report.md
Do not re-derive the findings. Verify the two or three lines each edit depends
on, then make the edit.

────────────────────────────────────────────────────────────────────
1. CLOSE #896 — both parts shipped
────────────────────────────────────────────────────────────────────
Part 1 (ci:merge-ledger) landed in #935 (2f386c52). Part 2 (the mutation
sentinel) landed in #934 (e53302d6), in BOTH hook copies.

Verify first:
  grep -n merge-ledger package.json .github/workflows/ci.yml lefthook.yml
  ls scripts/ci/merge-ledger-audit.ts scripts/ci/__tests__/merge-ledger-audit.test.ts
  grep -rn 'mutation-in-progress' .claude/hooks/ .codex/hooks/

Then close with a comment naming both commits.

The issue's two "not in this ticket" items were explicitly out of scope and stay
out: `ci:agent-config` has no self-test, and #877's filed diagnosis is wrong (the
real cause is one shared test-DB container, recorded in lab-notes).

────────────────────────────────────────────────────────────────────
2. RE-SCOPE #895 to FIVE items — (b) is already done
────────────────────────────────────────────────────────────────────
Item (b) — latchHalt's unpinned CAS — was DELIVERED by #920/#900.
src/lib/solicitation/approval.ts:518-524 cites "Issue #895(b)" BY NUMBER and
explains that latchSystemHalt is what makes the line load-bearing. Two tests
exist: approval-system-halt.integration.test.ts:363 and :433. The pass ran the
mutation and both go RED.

Edit the issue:
  - Strike item (b). Note it shipped in #920 and name the two tests.
  - DELETE the line "(b) is the only one that is not cosmetic. If the bundle has
    to shrink, keep (b)." That rationale no longer holds, and it is the only
    argument the issue gives for shipping the bundle at all.
  - Correct item (c): recordSuppression now has FOUR production callers, not two
    — contacts-repo.ts:250, unsubscribe.ts:402, suppressions-service.ts:168,
    resend/solicitation-lane.ts:243. The stale comment is purge-stages.ts:794.
  - Correct item (a)'s line: SolicitationBatchPanel.tsx:375, not :369. Note the
    trigger is now LIVE — platform_halt made HaltReason six members.
  - Correct item (e)'s lines: recordFailure is now solicitation-lane.ts:433, its
    log block :457-463. The four siblings are :357, :389, :417, :429.
  - Add to item (f): the fix must extend the TOKEN guards specifically. The file
    is already read by island-overflow.test.ts and no-yellow-star-colors.test.ts,
    so "add the directory to the design tests" is not the fix.

────────────────────────────────────────────────────────────────────
3. CORRECT #890 — one constant is the wrong shape; three are needed
────────────────────────────────────────────────────────────────────
The issue prescribes ONE constant. The window added a SEVENTH spelling that
answers a THIRD question: worker/jobs/solicitation-send/failed-hook.ts:90
`isTerminalizableArrival` = `status === 'queued' || status === 'sending'`.

Three distinct subsets now live in the lane:
  CANCELLABLE_DELIVERY_STATUSES   'rendered'|'queued'    may an owner cancel it?
  LIVE_DELIVERY_STATUSES          + 'sending'            is anything still live?
  DISPATCHED_ARRIVAL_STATUSES     'queued'|'sending'     what did a dead job leave?

That argues FOR the extraction, not against it. The issue's own anti-pattern
warning ("one constant must not answer three") is an argument against ONE
constant, not against a shared owner. Three NAMED exports make the three
questions distinguishable; six anonymous inline spellings do not.

Also update every line number — approval.ts grew +210:
  :494 -> :569 · :1126 -> :1300 · batch-view.ts:948 -> :957
  :1010-1011 -> :1185 · ApprovalPanel.tsx:973 -> :980 · AskList.tsx:306 unchanged
  isWithdrawableState :939-941 -> :1113-1114 (now ONE line, not three)
  the pins: approval.test.ts:302/:570 -> :303/:605

────────────────────────────────────────────────────────────────────
4. CORRECT #891 — four sites, not five, and it now carries a wire defect
────────────────────────────────────────────────────────────────────
There are FIVE sites in THREE forms. The fifth, release.ts:465
(`result?.status === 'closed'`), is a TALLY, not a receipt — it counts events for
PhaseTally.handled, and already_closed is a race loser. It must NOT adopt the
shared predicate. Say so explicitly in the issue or an implementer will fold it
in and re-create the bug.

Add the defect the issue does not know about. `!== 'not_settled'` is a WRONG
PROXY: 'no_send_parent' !== 'not_settled' is true, so halting an all-withheld
`built` batch makes both halt routes report closed: true while send_closed_at IS
NULL. Reachable — approveBatch:322-325 documents parentless built batches,
haltBatch:675 permits halting `built`, latchHalt:608 passes no failure,
closeBatchIfSettled:392 returns no_send_parent.

So batchDidClose must be a POSITIVE enumeration:
  close.status === 'closed' || 'closed_without_parent' || 'already_closed'
not the negative proxy the issue implies.

Line drift: approval.ts:404 -> :466 · outreach.ts:201/:359 -> :204-222/:372 ·
ApprovalPanel.tsx:562-563 -> :568-569 · :700 -> :705.
The four route line numbers all held.

────────────────────────────────────────────────────────────────────
5. CORRECT #892 — one truth claim is REFUTED; retag it
────────────────────────────────────────────────────────────────────
The issue's stated reason for the `<>` / `IS DISTINCT FROM` asymmetry is FALSE.
It reads only 014_retention_expansion.sql:74 (the ADD COLUMN) and misses
:116-121 of the same file:

  UPDATE businesses SET tracked_keywords = '[]'::jsonb WHERE tracked_keywords IS NULL;
  ALTER TABLE businesses ALTER COLUMN tracked_keywords SET NOT NULL;

No later migration drops it. `tracked_keywords` is NOT NULL, so `<>` cannot go
three-valued and the predicate is SOUND today.

Edit:
  - Delete the "contributes nothing to an OR-chain" argument and the severity claim.
  - Keep the item as a consistency fix: IS DISTINCT FROM reads identically under
    either nullability and survives a future DROP NOT NULL.
  - RETAG from `bug` to `enhancement`.
  - Correct the doc reference: docs/directory.md:1210, not :1176. And the counts
    are 29 columns written / 28 predicates / THREE restored-default checks, not
    "27" and "two".

────────────────────────────────────────────────────────────────────
6. ANNOTATE #893 and #894 — add the new evidence, do not rescope
────────────────────────────────────────────────────────────────────
#893: add a SECOND Part-1 subject. getAdminNotifications
(src/lib/admin/notifications-service.ts:137) is a THREE-element Promise.all —
two sql.unsafe + one tagged template — in the same directory, reached from
admin/notifications/page.tsx:15 and api/admin/notifications/route.ts:32, and in
NEITHER pin. Fan-out of 3 against DB_POOL_MAX = 3. It makes Part 2's "the
enumeration cannot be complete" argument non-hypothetical.
Do NOT upgrade the severity framing — the pin file's own SEAM HONESTY note says
the pipelining effect cannot be reproduced without real Supavisor.

#894: Step 1 has ZERO new adopters; batch-view.ts:395-405 is still the only
instance in src + worker. Add: within Step 1 the single highest-value edit is two
lines at src/lib/dashboard/pending-count.ts:29-30, which states a FALSE reason
for correct scoping. Pull that forward; defer Steps 2-3.
Also note solicitation_send_breaker would NOT fail Step 3's proposed query — it
carries no tenant column at all. That is a gap in the proposed fix.

────────────────────────────────────────────────────────────────────
7. VERIFY ci:merge-ledger actually gates
────────────────────────────────────────────────────────────────────
#932-#935 all merged before or alongside the audit, so it has never gated a real
PR. The NEXT production PR is its first live test.

Run it locally against a synthetic diff both ways: a production change WITHOUT an
arch-log line must FAIL; the same change WITH one must PASS. Confirm the
Dependabot exemption still lets #927 through.

If it does not fire, say so plainly and open a follow-up. An audit that was
merged but does not gate is worse than no audit — it reads as coverage.

────────────────────────────────────────────────────────────────────
THEN #631 IS CLEAR — with one collision to expect
────────────────────────────────────────────────────────────────────
#631 (Autopilot batches, Judge-gated, veto-windowed) will touch
src/lib/solicitation/approval.ts and the batch approve/halt routes.

Backlog item 7 (S1, the send-lane state vocabulary) rewrites exactly those
routes and approval.ts:1185. Either land S1 first, or expect the conflict and
resolve toward S1's shape — batchDidClose as a positive enumeration, and the
three named delivery-status constants.

Nothing else in the backlog collides with #631.
```
