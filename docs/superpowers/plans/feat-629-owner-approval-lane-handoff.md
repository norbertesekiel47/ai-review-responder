# Handoff — #629 owner approval lane

A fresh session resumes from this file plus the artifacts it points at. It never
needs the prior transcript. Resume with `/feature-resume feat-629-owner-approval-lane`.

## Where we are

Step 3 (PLAN) — plan written and revised once; codex verification round in flight.
Machine state: `.feature/state.json` (`phase`, `planReviewRounds`).

## Artifacts (read in this order)

| What | Path |
|---|---|
| Locked intake contract | `docs/superpowers/plans/feat-629-owner-approval-lane-intake.json` (committed audit copy; `.feature/intake.json` is the arming copy — keep both in step) |
| Implementation plan | `docs/superpowers/plans/2026-08-16-629-owner-approval-lane.md` |
| Deviations (D1–D3) | `docs/superpowers/plans/feat-629-owner-approval-lane-deviations.md` |
| Plan review round 1 | `docs/reviews/feat-629-owner-approval-lane/plan-round1-codex.md` |
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

## Next actions

1. Read the round-2 verdict. On `APPROVED`, `bash scripts/feature-state.sh set-phase plan_approved`, then step 4.
2. Step 4: `set-phase executing`, then dispatch per-task subagents. **Task 1 runs alone** (first-task enforcement spot check: diff `git status --porcelain` against `allowed_edit_surface`). Task 2 alone (migration). Then Tasks 3 and 5 may run concurrently; 4 follows 3 (same file); then 6, 7, 8.
3. Step 5 gate: `scripts/verify-gate.sh`, `--review` on the last run. Export `TEST_DATABASE_POOL_URL` **and** `DATABASE_POOL_URL` first or the live-DB rows SKIP.
4. Step 8 lane: **RISK = high** → staging ride first, migration 108 to staging Supabase before prod, PR to `main`, pause for owner merge approval.

## Two follow-up tickets to file on map #617 after merge

- Per-ask regenerate surface (route + 3/day budget UI) — must satisfy deviations D3.
- Admin/support halt surface (`admin_halt`, AAL2-gated).
