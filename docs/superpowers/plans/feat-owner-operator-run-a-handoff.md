# Handoff — feat/owner-operator-run-a (Owner Operator v1, Run A: the turn foundation)

Everything a resumed session needs is on disk. Read in this order; never re-read the grilling conversation.

| What | Path |
|---|---|
| Spec of record (map, ticket-seeded) | `docs/roadmap/2026-09-11-owner-operator/README.md` (§2, §3.4, §4, §5, §6.1–6.2, §7, §9, §10, §11, §14) |
| Locked intake (drift detector) | `docs/superpowers/plans/feat-owner-operator-run-a-intake.json` |
| Plan (T0–T8, APPROVED after 3 Codex rounds) | `docs/superpowers/plans/feat-owner-operator-run-a-plan.md` |
| Plan review ledger + Codex thread id | `docs/reviews/feat-owner-operator-run-a/plan-review.md` |
| Glossary (use terms verbatim) | `docs/context/owner-operator.md` (row in `CONTEXT-MAP.md`) |
| Deviations (read-back at step 6) | `docs/superpowers/plans/feat-owner-operator-run-a-deviations.md` |
| Phase / rounds / gate truth | `.feature/state.json`, `.feature/gate-status.json`, `.feature/progress.json` |

## Where the run is

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-a`, branch `feat/owner-operator-run-a`, base `f747cb7b6` (origin/main).
- Phase: **`reviewed`, pending round 3.** Review rounds used: **2 of 3**. Round 1 (three axes + red team) landed its fixes at `eb21f55c2`; round 2 was the verification wave over that commit and raised ten findings, eight of which are applied in the round-2 fix commit (R1–R7, R10) — see the deviations file's round-2 entry for the rejected (R8), the deferred (R9, three standards lows) and the documented (spec-r2 low #2).
- **Red-team round 3 is AUTHORIZED by the owner**, recorded in the sidecar `docs/reviews/red-team/feat-owner-operator-run-a-b83a4f/findings.json` as `auth-round-3-2026-09-11`. It is scoped to the R1–R7/R10 fix hunks; `round-start` reads the authorization from the sidecar, not from this file.
- Gate: **GREEN at the round-2 fix commit.** Re-derive it at current HEAD before quoting it — evidence produced before a subagent returned or a rebase landed is stale.
- **The Codex thread id is dead.** `codex exec resume` refuses `01a0937a-9cf7-7352-9e1f-72bf9fc86368` (`thread/resume: no rollout found`); the plan-review ledger keeps it for provenance only. Any further Codex round on this branch starts cold.
- Model routing (owner instruction): the orchestrator (Fable) reviews every artifact; every subagent that WRITES (code, tests, docs) is dispatched with `model: "opus"`.

## Execution order (step 4)

T0 alone (enforcement spot check: diff `git status --porcelain` against `allowed_edit_surface`) → T1 alone → {T2, T3, T4} in parallel → T5 → T6 → {T7, T8} in parallel. Each task's full text is in the plan; each implementer gets the plan section verbatim, the glossary excerpt, the intake's invariants, and the deviations file's T5 instruction (flag-off helper: outbox CAS first).

Approvals still owed to the owner: `push`, `staging_deploy`, `remote_migration` (120: staging first, then production at promotion, lockstep, introspection-verified), `merge`. Local commits are part of the authorized workflow.

## Decisions locked in the grill (do not reopen)

Same model pair as `reply_generation`, temperature 0.2, 1200 tokens, zod output schema on the seam · lease 180 s, predecessor stall 20 min, wait 10 s · star bands per location `{ total, byStar: {1..5} }` plus an account aggregate · new server-only flag `OWNER_OPERATOR_ENABLED`, default off; flag-on LLM envelope cap 11 → 12 with an ADR 0005 amendment · Run A registers only the four voice operations, the three reads, and `record_unsupported_request`.
