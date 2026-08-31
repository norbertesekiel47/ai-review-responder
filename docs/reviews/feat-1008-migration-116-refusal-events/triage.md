# Review triage — round 1

Branch `feat/1008-migration-116-refusal-events`, reviewed at HEAD `f005ded8`
(fork point `5ab6bfee`). Gate was GREEN 30/30 when the round was dispatched.

Full reports: `spec-correctness.md`, `standards.md`, `blast-radius.md` in this
directory. This file is the verdict record, so a resumed session inherits
triage state without re-reading them.

## Coverage

| Axis | Dispatched | Outcome |
|---|---|---|
| Spec & correctness | yes | 2 findings (1 MAJOR, 1 MINOR) |
| Standards & maintainability | yes | 6 findings (2 MEDIUM, 4 LOW) |
| Adversarial approach (RISK=high) | yes | **KILLED, not completed** — see below |

**The adversarial approach axis did not report.** Codex ran ~25 minutes and
produced zero output; the owner directed killing it and proceeding. Two earlier
codex rounds in this run took 45 and 40+ minutes, so this is a tooling
throughput problem rather than a signal about the diff.

**What that costs, stated rather than glossed:** the design-level challenges in
`scratchpad/adversarial-brief.md` went unanswered — record-vs-derive, the
slice boundary, whether business policy belongs in CHECK constraints, whether
`all_refusal_codes` should have been `NOT NULL DEFAULT '{}'` / JSONB / a child
table, and the ship order. Partial mitigation, and it is genuinely partial:
those questions were each adjudicated during grilling and across three
plan-review rounds, and the two axes that did report found no design-level
objection. A reviewer who wants that axis should run it against the merged
commit.

## Verdicts — 8 findings, 8 ACCEPT, 0 REJECT

| # | Sev | From | Finding | Verdict | Fix |
|---|---|---|---|---|---|
| 1 | **MAJOR** | spec | Title 12's only NULL-member case (`['different', NULL]`, winner absent) is rejected by C5's outer `IS TRUE` alone, so `array_position(..., NULL) IS NULL` is pinned by nothing — delete it and all 22 tests stay green while `['winner', NULL]` inserts | **ACCEPT** | Added the winner-PRESENT case. **Re-proved by mutation**: a TEMP table carrying C5 minus `array_position` REJECTS the old row and ACCEPTS the new one, so the new case is precisely the one that pins the clause |
| 2 | MINOR | spec | The disposition `reason` claims no cascade reaches this table "unlike every other `hard_delete` row here" — false; `review_escalations`, `contact_csv_uploads` and `agent_outcomes` are also no-cascade `hard_delete` rows | **ACCEPT** | Reworded to cite those three as precedent rather than contrast. The false clause invited a reader to treat their explicit DELETEs as redundant |
| 3 | MEDIUM | standards | `expect(createdAt).toMatch(/retention/i)` passes on the exact negation of the comment it guards, so the title's word "only" cannot fail — and nothing else guards the one-clock rule | **ACCEPT** | Both timestamp assertions now match polarised phrases (`/NOT a retention candidate/i`, `/deletes on occurred_at and on nothing else/i`) |
| 4 | MEDIUM | standards | `insertRefusal` and `insertRefusalIgnoringConflict` duplicate all 11 columns, differing by one `ON CONFLICT` line | **ACCEPT** | Collapsed to one `insertRefusalRow` writer taking the conflict clause as a composed fragment. The `ON CONFLICT` predicate stays spelled INLINE at its caller — a byte-for-byte claim is only meaningful if the bytes sit next to the assertion depending on them |
| 5 | LOW | standards | `hasDefault: true` does not pin `DEFAULT NOW()`; a constant stays green and destroys the skew diagnostic ADR 0023 rests on | **ACCEPT** | Added `expect(createdAt?.column_default).toMatch(/^now\(\)$/i)` |
| 6 | LOW | standards | `relforcerowsecurity` selected and typed, never asserted | **ACCEPT** | Asserted `false`, with the reason: workers reach this table through the RLS-bypassing `postgres` role, so FORCE would lock out its only writers |
| 7 | LOW | standards | `CONTEXT.md` defines **Refusal source** as "lane plus verbatim code", but the identically-named column holds only the lane | **ACCEPT** | The term now says it spans two columns and names both. A #1009 writer built from the term's name alone would have selected half of it |
| 8 | LOW | standards | `arch-review-log.md` says "the eleven writers #1010–#1013", contradicting the migration header's "the other ten" | **ACCEPT** | Corrected. One authoritative owner per fact |

## Cleared with evidence, not assertion

The spec reviewer applied the migration into a rolled-back probe schema and
deparsed it: twelve columns, five named CHECKs, three enum CHECKs, three
indexes plus pkey, `relrowsecurity` true with zero policies — byte-equivalent
to the locked DDL. C5 sound across all eight combinations; C1–C4 free of NULL
fall-through. Both purge arms account-scoped, with tests that fail a
business-joined implementation (two tenants × located + account-wide rows).
Ordering claims checked against `deployment-guide.md` §II.5 and
`PurgeWorker.ts:71-127`. Six load-bearing doc claims verified true.

The standards reviewer measured rather than opined: migration 116 is 53%
comment lines against 111's 52% and 114's 54% — house style, and per unit of
schema the least commented of the three. The 1094-line suite runs 58
lines/case against precedent 114's 125. Fourteen substantive doc claims
verified true, including a literal count of the 22 `AutoApprovalBlockReason`
members.

It also flagged CHECK C3 in the other direction: the biconditional moves
invariant #9's defect class out of convention and into Postgres.

## The pattern worth carrying forward

Two of the eight findings, including the MAJOR, are the same defect: **a test
that reads as coverage and cannot fail.** Finding 1 pinned a migration clause
with a row that a mutant already rejects; finding 3 guarded a rule with a regex
matching its own negation. Eval-first authoring did not prevent either — both
were written alongside the thing they were meant to constrain, which is exactly
when the assertion and the implementation agree by construction. Mutation is
what caught one and would have caught the other. Queued for the red-team step
and for lab-notes promotion at step 8.
