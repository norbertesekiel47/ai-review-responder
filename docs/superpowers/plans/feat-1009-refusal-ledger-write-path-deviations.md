# Deviations — feat/1009-refusal-ledger-write-path

**One entry.** One ACCEPT, zero RE-PLAN.

| # | What | Verdict | One line |
|---|---|---|---|
| D1 | Surface overlap with the parked `feat/refusal-log` worktree | **ACCEPT** | No merge order exists to agree — the branch never merges. It is a read-only harvest source. |

---

## D1 — `src/lib/refusals/**` overlaps the parked `feat/refusal-log` worktree

**When:** step 2, `feature-setup.sh` overlap report, before planning.

`scripts/feature-setup.sh` reported two code-pair collisions:

| Ours | Theirs |
|---|---|
| `src/lib/refusals/**` | `src/lib/refusals/vocabulary.ts` |
| `src/lib/refusals/**` | `src/lib/refusals/read.ts` |

plus one unlisted test-glob overlap.

**Why this needs no merge order.** The overlap check assumes both branches are
heading for `main`. `feat/refusal-log` is not. It is PARKED by owner decision
(2026-08-29), recorded on map #994:

> `feat/refusal-log` is **PARKED, not merged** (owner call, 2026-08-29). It is
> the reference implementation and the harvest source … It will drift against
> `main` — that is accepted.

A merge order is an agreement about which of two branches lands first. Neither
half of that question applies when one branch never lands.

**What this run does with those two files instead.** It reads them through
`git show feat/refusal-log:<path>` and writes nothing to that worktree.

- `vocabulary.ts` is **harvested and corrected**, never copied. Its two closed
  axes are wrong against the schema that actually shipped: six lanes where
  migration 116 admits seven (`policy_gate_held` joined in #1003) and seven
  categories where 116 admits eight (`owner_review_required` coined in #998).
  `RENDER_WITHHOLD_REASONS` is dropped rather than ported — it existed only to
  partition `read.ts`'s timestamp anchor, and #1002 killed `read.ts`.
- `read.ts` **survives nothing**. #1002 ruled there is no backfill, ever, so its
  six `UNION ALL` arms have no second life and the file dies with the projection.

**The surface is not narrowed.** This slice creates `src/lib/refusals/` on
`main` for the first time, and a glob is the honest declaration of a directory
this run owns end to end.

**Verdict:** ACCEPT. Recorded here only. The parked branch's own deviations file
is a closed record of a STOPPED run; appending a merge-order note to it would
require committing to a branch this run must not touch, and would record an
agreement that does not exist.
