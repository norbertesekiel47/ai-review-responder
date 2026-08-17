# Handoff — #629 owner approval lane

> **SHIPPED 2026-08-17 — this document is now a historical record, not a
> work-list.** PR **#863** merged to `main` as squash `71b1bd88`. Migration 108
> is applied to **both** Supabase projects (staging then production, same day);
> the branch and its worktree are cleaned up; `staging` is re-synced to `main`.
> **Everything under "Next actions — step 8 SHIP" below is DONE** — do not work
> it. What actually happened during promotion, including the traps, is recorded
> in `docs/progresstracking.md` (2026-08-17 entry) and
> `.claude/reference/lab-notes.md` (2026-08-17 — #629 ship). The follow-ups at
> the bottom (#858–#861) are the only live items, and **#858 must be resolved
> before #630**.

A fresh session resumes from this file plus the artifacts it points at. It never
needs the prior transcript. Resume with `/feature-resume feat-629-owner-approval-lane`.

## READ FIRST — this branch uses an ISOLATED test database

Export this before ANY test, gate, or coverage command:

```bash
export TEST_DATABASE_POOL_URL="postgresql://test:test@localhost:5499/test_629"
export DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL"
```

`.env.local` still points at the shared `test_ws4` and is deliberately NOT
edited (outside the intake's `allowed_edit_surface`; amending it for local
config would waste the last amendment). Without the export,
`resolveTestDatabaseUrl()` falls back to `.env.local`, this branch runs against
a **107** schema, and its live-DB suites fail on
`solicitation_outreach_status_reason_consistency` — an error that reads like a
defect in `approval.ts` and is not one.

Why: seven worktrees share one container, only this branch has migration 108,
and `pnpm test:db:setup` rebuilds from the RUNNING branch's migrations. Another
worktree reverted the shared DB twice mid-run. Full account: deviations **D10**.

## Where we are

**Step 8 (SHIP). Everything up to it is DONE.** `phase=reviewed`, gate GREEN at
`e9a673b4`, tree clean, 33/33 promised tests present, `pnpm test` 12,376 passing.

- Steps 1–4 complete: all eight plan tasks landed, each verified independently.
- Step 5 gate: GREEN. One standing `reclassify` **WARN** — see D14; it is
  recorded and owner-decided, not something a re-run clears.
- Step 6: deviations read-back done, all entries triaged (verdict table at the
  top of the deviations file).
- Step 7: **two full review rounds, closed.** Round 1 = three parallel axes
  (spec, standards, adversarial-Codex), 21 findings, all triaged and fixed.
  Round 2 = verification-only per axis: spec and adversarial returned **empty
  tables**, standards found two D13 fixes that had never landed — both since
  fixed and pinned by tests. `branchReviewRounds` = 2.

**Nothing is left but shipping.** Do not re-open review; the cap allows one more
round only if new work is added.

## Artifacts (read in this order)

| What | Path |
|---|---|
| Locked intake contract | `docs/superpowers/plans/feat-629-owner-approval-lane-intake.json` (committed audit copy; `.feature/intake.json` is the arming copy — keep both in step) |
| Implementation plan | `docs/superpowers/plans/2026-08-16-629-owner-approval-lane.md` |
| Deviations **D1–D15** — read the verdict table at the top first | `docs/superpowers/plans/feat-629-owner-approval-lane-deviations.md` |
| Plan review rounds 1–2 | `docs/reviews/feat-629-owner-approval-lane/plan-round{1,2}-codex.md` |
| **Branch review round 1** (spec · standards) | `docs/reviews/feat-629-owner-approval-lane/branch-round1-{spec,standards}.md` |
| **Branch review round 2** (spec · standards · adversarial) | `docs/reviews/feat-629-owner-approval-lane/branch-round2-{spec,standards,adversarial}.md` |
| Blast radius | `docs/reviews/feat-629-owner-approval-lane/blast-radius.md` |
| Spec (#619) | `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` — §10 row "#629", D2/D6a/D9/D10/D11/D22/D23 |
| Binding amendments | `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` — B2, B11 |
| Glossary | `CONTEXT.md` — Batch state, Halt latch, Outreach row, Settled batch, Send batch parent, Requests, Spoilage report |
| Map | issue #617 (migration-queue line updated 2026-08-16: #629 takes 108) |

## Codex sessions

- Plan review round 1 — thread `01a00d4d-2df1-76f2-b081-94ed9caa1468`, verdict `REVISE`, 12 findings, all triaged in the round-1 report.
- Plan review round 2 — verification-only, dispatched in background; transcript at
  `<scratchpad>/codex-plan-round2.jsonl`. A first attempt timed out with no
  output (stdin block); re-dispatched with `< /dev/null`. Both dispatches were
  counted, so `planReviewRounds` reads 3 while only two substantive rounds ran —
  if a third substantive round is ever needed, stop and surface to the owner per
  the workflow's cap.

## Owner decisions locked during grilling (do not re-litigate)

1. Migration **108** widens `solicitation_outreach_status_reason_consistency` to admit `owner_excluded`. #629 is db_touching; the slot was free.
2. Approval requires generation settled (every send Ask has a non-cancelled Outreach row), re-asserted inside the approval transaction.
3. Per-ask **regenerate** surface is deferred to its own ticket — and carries deviations D3 as a binding constraint.
4. The panel lives on `/dashboard/requests`, additive, gated by `SOLICITATION_SEND_ENABLED`.
5. Exclude-all approves and closes the batch (`closeBatchIfSettled` in the approval tx).
6. **Admin halt** surface deferred; `admin_halt` stays a CHECK member with no writer.

## Next actions — step 8 SHIP, RISK = high lane

Re-arm first (`bash scripts/arm-check.sh`), export the two DB vars above, and
confirm `phase=reviewed` with `lastGreenGateSha` == HEAD before touching anything.

1. **Ride staging.** Land the branch on `staging` (push → full stack
   auto-deploys). **Migration 108 applies to the staging Supabase project
   FIRST**, before prod — "applied to prod, not staging" is a bug per CLAUDE.md.
2. **Drop the `LOCAL-ONLY` marker** on 108's entry in
   `.claude/reference/migrations-log.md` as part of promotion, replacing it with
   the *Applied to STAGING …* sentence. **This re-arms
   `migration-immutability-guard.sh` and freezes 108** — after that, any change
   to it needs migration 109. Do not drop the marker before the migration is
   actually applied.
3. **Smoke the touched path on staging.** Note the constraint below about what
   can actually be exercised.
4. **Open the PR to `main`**, confirm every GitHub CI check is green — including
   the advisory `fallow` job, which is NOT a required check but should be read —
   then **PAUSE for explicit owner merge approval.** Apply 108 to prod Supabase
   in lockstep at promotion.
5. **After merge**, work the step-8 post-merge list in feature.md: `git pull
   --ff-only`, re-sync `staging` (a squash merge means `--ff-only` aborts and the
   runbook's answer is `reset --hard` + `--force-with-lease` — never a sync
   merge), `scripts/feature-cleanup.sh` (dry run, then `--apply`), promote the
   durable lessons out of the deviations file into `.claude/reference/lab-notes.md`,
   invoke `document-feature`, do the domain sweep, and bump the entropy counter in
   `.claude/reference/arch-review-log.md`.

### What the staging ride can and cannot prove

**The feature ships inert.** `SOLICITATION_SEND_ENABLED` is unset in every
environment including staging, and the releaser and send worker are #630, so
**nothing sends**. With the flag off, the Requests screen must be byte-identical
to watch-mode today — that is itself the most valuable thing to verify.

Exercising the approval lane end to end requires flipping the flag **in staging**,
which is a `flag-flip` skill decision and was left explicitly **out of scope** by
the owner at the step-7/8 boundary. Confirm the intent before flipping anything.

### Promotion lessons worth carrying (from the deviations file)

- **D10** — this branch uses an isolated `test_629` database. That is local-only
  and irrelevant to staging/prod, but the underlying lesson (seven worktrees, one
  shared test DB, `test:db:setup` rebuilds from the *running* branch) belongs in
  lab-notes at the post-merge promotion step.
- **D14** — the epic-shaped verdict. #630 is at least this size; size it as an
  epic at step 0 and decompose.

## Follow-ups — FILED 2026-08-17 on map #617

- **#858** — `closeBatchIfSettled` case-sensitive `subject_id` compare, all
  callers. #629 fixed only its own two verbs. **Resolve before #630**, whose
  releaser tick is a backstop caller of the same function.
- **#859** — `ci:tenant-scope` subquery blindness; fixing it reverts #629's SQL
  workarounds. May unmask findings elsewhere and move `ALLOWLIST_BASELINE`.
- **#860** — per-ask regenerate surface, carrying **D3** as a binding constraint
  (re-open approval for the ask, or refuse once `approved_at` is set).
- **#861** — pin the load-failure copy so it cannot regress to a write-scoped
  claim.

**Still unfiled:** the admin/support halt surface (`admin_halt`, AAL2-gated) —
carried from the original handoff and never opened.
