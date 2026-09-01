# Handoff — feat/1013-refusal-policy-gate-held

**Written 2026-08-31** at the step 3→4 boundary. **CLOSED 2026-09-01** when the
sweep finished — read § POST-MERGE at the bottom FIRST for what it left behind.

This document REFERENCES the artifacts by path. It never restates them. A
resumed session bootstraps from: this file → intake → plan → deviations →
review findings. **It never needs the prior transcript.**

> ## ✅ STATUS: MERGED AND SWEPT — one task deferred, one not run
>
> #1013 merged to `main` as `9d26c5a3` (PR #1055, squash, 2026-09-01 04:53Z).
> Phase `shipped`. Local gate GREEN at the branch tip, CI was 10/10. The
> step-8 sweep ran as `chore/1013-post-merge-sweep` (PR #1060).
>
> **Do NOT re-run steps 0-7, and do not re-run the sweep.** Two items are
> genuinely open and both are named in § POST-MERGE: realigning `staging`
> (deferred behind a live §4.8 drill) and the `document-feature` pass (never
> authorized). Everything else above that heading is historical context.
>
> The branch and its worktree were removed at cleanup. This file is the record.

---

## Where everything is

| Artifact | Path |
|---|---|
| Worktree root | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1013-refusal-policy-gate-held` |
| Branch | `feat/1013-refusal-policy-gate-held` |
| Intake (committed) | `docs/superpowers/plans/feat-1013-refusal-policy-gate-held-intake.json` |
| Intake (arming copy) | `.feature/intake.json` — kept byte-identical to the above |
| Plan | `docs/superpowers/plans/feat-1013-refusal-policy-gate-held-plan.md` |
| Deviations | `docs/superpowers/plans/feat-1013-refusal-policy-gate-held-deviations.md` |
| Machine state | `.feature/state.json` · `.feature/progress.json` · `.feature/gate-status.json` |
| Codex brief (round 1) | `.feature/plan-brief-1013.md` — gitignored, 2107 lines, self-contained |
| Glossary | `CONTEXT.md` § "Refusal ledger — locked 2026-08-29, map #994" |
| Design of record | ticket #1013, map #994, rulings #995 #997 #998 #1001 #1002 #1003 |

---

## Two operational facts a resumed session MUST carry

### 1. The test database is `test_1013`, and it is NOT in `.env.local`

`.env.local` still reads `test_ws4`, which is shared with the parked
`feat-refusal-log` and `staging-ride` worktrees. It was deliberately NOT edited:
the edit-surface guard blocked it, correctly — local config is not part of this
change and must not enter the intake contract.

`src/lib/shared/__tests__/helpers/live-db-lock.ts:61` reads
`process.env.TEST_DATABASE_POOL_URL` BEFORE the `.env.local` disk fallback, so an
exported variable wins. **Every gate and test command on this branch must carry
the export:**

```bash
export TEST_DATABASE_POOL_URL="postgresql://test:test@localhost:5499/test_1013"
export DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL"
```

`test_1013` was created and provisioned to migrations head
(`116_refusal_events.sql`, `test_meta.provision` marker written) on 2026-08-31.
Re-run `pnpm test:db:setup` with the export if a migration lands.

### 2. The codex plan round-1 session id

```
01a059b8-2b34-7131-b1cc-d44ba9f3847f
```

A plan VERIFICATION round (rounds 2–3) must RESUME it, never start cold:

```bash
codex exec resume -o <out-file> 01a059b8-2b34-7131-b1cc-d44ba9f3847f "<delta>"
```

`codex exec resume` accepts only `-c`, `-m`, `-o`, `--json` and the
`--last`/`--all`/`--ephemeral` family. It does **NOT** accept `-s` or `-C`; it
inherits the original session's sandbox (`read-only`) and cwd. Two dispatches
were lost to that flag error before it was pinned down.

The first dispatch was also killed mid-reasoning at 21:33:19 with no error and no
final message. Resuming recovered its ~1.25 M cached input tokens rather than
paying to rebuild them.

---

## State at this boundary

* **Phase:** `plan_approved` is NOT yet set. Round 1 was in flight when this was
  written. Do not start step 4 until the verdict is recorded in the plan's
  §7 review appendix.
* **Plan review rounds:** 1 counted. Contract snapshot recorded
  (`planContractSha256=ad9c2008ad3b`).
* **Surface amendments:** 1 of the 2 the abort budget allows (deviation D2).
* **Tracers:** 6 registered, 0 done.
* **Gate:** one `--baseline` run on the unmodified tree. 22 rows PASS, 1 FAIL.

### The baseline gate's single FAIL is expected and self-resolving

`feature-surface` fails on exactly two `allowed_edit_surface` entries that match
no file yet:

```
worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts
worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts
```

T1 creates both, and the row goes green. `ci:feature-surface` requires every
entry to match a real file **by push time**, not before. Do not "fix" it by
narrowing the surface.

---

## Findings made during planning that step 4 must honour

### `persist.test.ts`'s fake transaction is STATEMENT-ORDER-SENSITIVE

`queuePersistRows` (`worker/jobs/response-generation/__tests__/persist.test.ts`,
~line 110) pushes fake result rows onto `txQueue` in the exact order
`persist.ts` issues statements. T3 and T5 each add one
`INSERT INTO refusal_events`, so the helper needs a matching `txQueue.push([])`
in each branch or **every existing test using it breaks**. This is helper
surgery, not merely new cases.

### The integration suite must seed `autopilot`, not the default

`seedTenantAccount` (`src/lib/shared/__tests__/live-db-tenant.ts:52`) defaults
`subscriptionTier: 'copilot'`. On Copilot, `autopilot_tier_required` fires — and
it is a **veto** member, so it suppresses every `policy_gate_held` row. A suite
that takes the default proves nothing and looks green.

### `vocabulary.test.ts` already has the helpers T1 needs

* `unionMembers(relativePath, typeName)` (line 187) parses a bare TS union out of
  its owning module as text.
* `WORKER_TYPES_MODULE` is already declared (line 50).
* `expectLaneMap(map, members, label)` (line 124) asserts keys-are-exactly-members
  and every non-null value is in `REFUSAL_CATEGORIES`.

So the exhaustiveness test is
`expectLaneMap(POLICY_GATE_HELD_REFUSAL_CATEGORIES, unionMembers(WORKER_TYPES_MODULE, 'AutoApprovalBlockReason'), …)`
plus the partition assertion against `AUTO_APPROVAL_BLOCK_PRECEDENCE`. That the
test file ALREADY reads `worker-types.ts` for other unions is independent
confirmation that deviation D2's declaration move is the right shape.

### Migration 116's C5 is stricter than the plan's prose

Verified at `supabase/migrations/116_refusal_events.sql:162-171`. Besides
non-empty and winner-membership, it also rejects a NULL element
(`array_position(all_refusal_codes, NULL) IS NULL`). The planned tuple type
`readonly [AutoApprovalBlockReason, ...AutoApprovalBlockReason[]]` satisfies all
three. C1, C2, C3 and C4 read exactly as the plan describes.

### The live-DB suite must declare its schema requirement INLINE

`src/lib/shared/__tests__/helpers/schema-ready.ts` is outside this branch's
`allowed_edit_surface`. `src/lib/refusals/__tests__/write.integration.test.ts:68`
declares `MIGRATION_116_REFUSAL_EVENTS` locally for exactly that reason. Copy
that shape.

---

## The one thing most likely to be got wrong

`persistResponseAndNotify` guards the spine step on `activeRun && !held`. The ledger write
inherits **`!held` only**. Inheriting `!activeRun` silently drops rows from the
highest-volume lane for every legacy pre-spine review (#997 resolution 1).
Test title 18 is the regression pin, and
`persist.test.ts`'s run-spine describe already has the sole `findActiveReviewRun.mockResolvedValue(null)`
precedent to build it on.

---

# POST-MERGE — CLOSED 2026-09-01

**The sweep is done.** It ran as `chore/1013-post-merge-sweep` (PR #1060), and
this section is now a record rather than a work list. One task is deferred, one
finding is new, and both are named below. Everything above this heading is
historical context for #1013 itself.

## What happened to each task

| # | Task | Outcome |
|---|---|---|
| 1 | Realign `staging` | **DEFERRED — not done.** See the blocker below. |
| 2 | Merge counter | Done. 3 → **9**; six merges had been lost, not one. |
| 3 | Worktree cleanup | Done. Four merged worktrees removed; `test_1013` dropped. |
| 4 | Comment on #1014 | Done — the Coverage-start constraint, with the correction. |
| 5 | Promote **D8** | Done. Wave rule 4 in `execution-lanes.md`. |
| 6 | Promote **D9** | Done. `lab-notes.md`, 2026-09-01 section. |
| 7a | Fix **D10** | Done, and proved by measurement. Regression test included. |
| 7b | `equivalent` outcome | Done. Seven tests; four mutants planted and killed. |
| 8 | `document-feature` sweep | **NOT RUN.** Out of the sweep's authorized scope. |

## 🚧 The blocker MOVED, and the new one is different in kind

The original blocker — uncommitted `/feature` risk-gate work in the parent
checkout — **resolved itself**. It merged to `main` as `cec1f290` (PR #1058) on
2026-09-01: the red-team sidecar requirement is now scoped by the intake's
signed-off `risk`, with `risk: normal` recording a mechanical `WAIVED`. Nothing
was lost and nothing needed absorbing.

**The blocker that replaced it is concurrency.** While this sweep ran, a second
live session was working in the parent checkout — committing, switching
branches, and pulling `main` (three reflog events inside one minute, and a live
`until railway status …` poll loop). That session was mid-**§4.8 drill** with
the staging worker stopped.

Two consequences, both load-bearing:

1. **Task 1 was deferred, not skipped.** A `reset --hard` plus
   `--force-with-lease` to `staging` auto-deploys the full staging stack and
   would have destroyed a running drill. `staging` is still diverged —
   `origin/staging` at `5358bd82`, 25 ahead of and 2 behind `main`, so
   `--ff-only` aborts and the runbook's reset path is the answer. **Do this
   once §4.8 finishes**, per `deployment-guide.md` § Re-sync staging. Never
   substitute a sync merge.
2. **The sweep ran in its own sibling worktree.** Two sessions in one working
   tree collide. Check `git reflog` and `ps` for a live session before editing
   the parent checkout, exactly as this run did.

## Two facts that will confuse you if you do not have them

**The standing `INCOMPLETE_ORACLE` on this branch is now FIXABLE, and was not
retro-fixed.** `equivalent` exists as of PR #1060, so the class of mutant that
forced D11's override has an honest label. #1013's own sidecar was NOT relabelled
— editing a shipped review record to improve its verdict is the defect class this
effort caught repeatedly. D11 stands as written.

**The staging ride was PARTIAL and that is recorded, not an oversight.** It
proved deployment and schema only. `policy_gate_held` needs
`AUTO_APPROVAL_ENABLED`, which would skip two positions in the ordered go-live;
`held_draft` had no moderation-flagged draft to observe, because staging has
zero `flagged_responses` rows, ever. Deviation **D12**. The lane's real-ingest
proof is owed by the go-live flip — and that same fact is now the open question
on **#1014**, because merge ordering alone does not make its Coverage start
honest.

## Housekeeping

* **Staging secrets were exposed twice in session transcripts** (Railway
  variable listings). The owner intends to rotate. Do not list all Railway
  variables — filter to the keys you need. **Still open.**
* Test DB `test_1013` was dropped at cleanup.
* Codex plan-review session id `01a059b8-2b34-7131-b1cc-d44ba9f3847f` — no
  longer needed; the plan is closed.
