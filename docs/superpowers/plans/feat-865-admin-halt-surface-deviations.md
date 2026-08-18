# feat-865-admin-halt-surface — deviations

Entries the plan did not anticipate. Each gets a one-line ACCEPT / RE-PLAN
verdict at step 6 (deviations read-back) before any review agent sees this file.

---

## D1 — Surface overlap with `feat-860-ask-regeneration-surface` (step 2, owner-agreed)

`scripts/feature-setup.sh` reported two code-pair overlaps with the armed
worktree `feat-860-ask-regeneration-surface`:

- `src/lib/solicitation/approval.ts` — theirs `src/lib/solicitation/*`
- `src/lib/solicitation/batch-view.ts` — theirs `src/lib/solicitation/*`

(plus one test-glob overlap, not itemised by the script).

**What #860 actually changes in those two files**, read from its branch diff
against the shared base `f28451ee`:

| File | #860's change | Touches anything #865 needs? |
|---|---|---|
| `approval.ts` (+208) | file header comment, one added import, then a **pure append** of `RequestAskRegenerationInput` / `RequestAskRegenerationResult` / `requestAskRegeneration` after `haltBatch` | **No.** `haltBatch`, `lockBatchForAction`, `canonicalBatchId`, `ownerHaltReason` and `OwnerHaltReason` are all unmodified. |
| `batch-view.ts` (+105) | extends `SendLaneView` with regeneration fields, modifies `readSendLane` | **No.** `readLatestBatch`'s signature, `HaltReason` and `BatchView` are unmodified. |

So the collision is **mechanical, not semantic**: a shared file-header comment
and a shared append point at the end of each file.

**State of the two branches at the time of the decision.** #860 is
`phase: gate_green`, `branchReviewRounds: 1` with its triage verdicts committed,
10 commits, based on `f28451ee`. #865 was at zero commits on the same base.

**Agreed merge order (owner decision, step 2): #860 merges FIRST; #865
implements in parallel and rebases onto `main` before opening its PR.**

Rejected alternatives, and why:

- *Serialise completely (hold #865 until #860 lands).* Zero conflict risk, but
  idles this run behind another branch's merge and CI cycle to avoid two
  mechanical conflicts.
- *Narrow #865's surface by dropping `batch-view.ts`.* Would push the admin
  batch projection into a new `src/lib/admin/` module, against "default is no
  new file" — the projection belongs in the send-lane read model that already
  owns `BatchView`, `SendLaneView` and `HaltReason`.

**Obligation this creates for #865:** rebase onto `main` after #860 lands, then
re-run the full verify gate (`scripts/verify-gate.sh --review`) on the rebased
tree before review round 1 is treated as valid. A rebase that only resolves the
two mechanical conflicts still changes the tree the reviewers read.

The counterpart note is recorded as **sibling-worktree evidence**, not as a file
in this tree (round-1 finding 13). Absolute path:

```
/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-860-ask-regeneration-surface/docs/superpowers/plans/feat-860-ask-regeneration-surface-deviations.md
```

§ "Surface overlap with feat-865". It is unresolvable from THIS review root by
construction — it lives on the other branch — so a reviewer working only in this
worktree cannot follow it. Once #860 merges, the citation becomes moot.

> **Correction (round 3).** Revision 2 of this entry said the note was left
> **uncommitted** in the sibling worktree to protect that branch's
> `lastGreenGateSha == headSha` record. That was true when written and is now
> **false**: #860's own session folded it in at `db89a700` ("docs(860):
> directory rows follow the LaneRefresh fix; fold in feat-865 overlap note"),
> which is exactly what the note asked its owner to do. That branch is now at
> `156b3457`, still `phase: gate_green` with `lastGreenGateSha == headSha`, so
> the concern the original wording expressed never materialised. Verified by
> reading the sibling worktree's git state directly, not taken on the reviewer's
> word.

**Verdict:** _(pending step 6 read-back)_

---

## D2 — intake revised after plan review round 1 (NOT a surface amendment)

`docs/reviews/feat-865-admin-halt-surface/plan-round1-codex.md` returned
`VERDICT: REVISE` with 14 findings; 12 accepted, 2 rejected (reasoning in the
plan's §6). The intake changed in three ways. **Both copies were rewritten and
verified byte-identical**, and `scripts/arm-check.sh` re-confirmed ARMED.

| Field | Before | After |
|---|---|---|
| `tests_to_add` | 16 titles | **30 titles** |
| `estimated_prod_lines` | 380 | **420** |
| `estimated_test_lines` | 700 | **1400** |
| `non_goals` | 8 | 9 (added the `haltBatch` pending-hole carve-out) |
| `invariants` | 11 | 12 (added the `built_at IS NULL` never-latched rule) |
| `edge_cases` | 11 | 15 |
| `user_visible_behavior` | 7 | 7 (two sharpened) |
| `existing_patterns_to_follow` | 7 | 9 |
| **`allowed_edit_surface`** | **9 globs** | **9 globs — UNCHANGED** |

**This spends NO amendment.** `/feature`'s abort criteria count
`allowed_edit_surface` amendments only; `tests_to_add` retitles and other
intake-field corrections are deviations-file entries by design (the #643
lesson — that run nearly hit teardown over two test renames). The surface is
byte-for-byte what step 2 armed, so the amendment budget is still **0 of 2**.

The test-line estimate tripled because round 1 established that the original
eval could pass while the feature was materially wrong: it had no test for a
second spine step, for settlement ownership, for audit ordering or rollback, for
type/export widening, for the browser-serialization rule, or for a functioning
UI. Estimating tests at 1:1 with production is precisely the failure the
separate-bucket estimate exists to catch, so the estimate was raised to the
honest number rather than left to trip step 5's `reclassify` row.

**Two findings were rejected rather than absorbed** — a standing meta-test for
`.todo` markers, and a flag-availability test aimed at a module that never reads
the flag (reframed onto the route). Both rejections are recorded in the plan's
§6 with reasoning, per `receiving-code-review`.

> **Correction (round 2).** The meta-test rejection originally leaned on
> `diff-coverage` as the mechanical backstop. **That support was false for a
> test-only commit**: `scripts/diff-coverage.ts:62-65` excludes
> `__tests__|\.test\.`, and `104-106` exits PASS when no production line
> changed. Verified directly, not taken on the reviewer's word. The rejection
> stands on its own reasoning — a permanent test about test syntax rots — but
> the plan now requires explicit **30 passed / 0 skipped / 0 todo** evidence at
> the final gate instead of an imagined automatic one. Lesson worth promoting at
> step 8: *diff-coverage gates the branch's production lines, never the eval
> commit.*

**One finding produced a deliberate non-fix.** `haltBatch` carries the identical
`pending`-batch hole that D11 refuses for the admin arm. Fixing the owner arm
would change user-visible behaviour this intake does not name, so it is carved
out in `non_goals` and scheduled as a follow-up ticket at step 8. See the plan's
§7 — it must not die in this file.

**Verdict:** _(pending step 6 read-back)_
