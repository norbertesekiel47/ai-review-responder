# fix/1105 — handoff

A resumed session bootstraps from this file. It references artifacts BY PATH and
restates none of them. Never read the grilling transcript; read the files.

## Where things are

| Artifact | Path |
|---|---|
| Issue | GitHub #1105 |
| Intake (committed audit copy) | `docs/superpowers/plans/fix-1105-unmapped-block-reason-signal-intake.json` |
| Intake (arming copy) | `.feature/intake.json` — kept byte-identical to the above |
| Plan, decisions D1-D5, invariants, tasks T1-T3, review appendix | `docs/superpowers/plans/fix-1105-unmapped-block-reason-signal.md` |
| Deviations | `docs/superpowers/plans/fix-1105-unmapped-block-reason-signal-deviations.md` |
| Machine state | `.feature/state.json` |
| Ladder | `.feature/progress.json` |

## Classification

`small` · `high` · `backend` · `db_touching: false`.

RISK is high because the call site is in `worker/` inside the response-persist
transaction on the auto-approval path. The lane consequences: implement in the
orchestrator session with NO subagent dispatch, run the step 7 review wave
including the red-team pass, and ship via staging before `main`.

## Glossary terms used verbatim

**Refusal**, **Refusal category**, **Refusal source**, **Restraint tab** — all
LOCKED in `CONTEXT.md` § "Refusal ledger". ADR
`docs/adr/0023-refusal-log-owner-safe-projection.md`. This branch coins no new
term and sharpens none, so `CONTEXT.md` needs no edit. Re-check that at step 8's
domain sweep rather than trusting this line.

## Codex sessions

| Round | Session id | Verdict |
|---|---|---|
| Plan round 1 (cold, full) | `01a069d3-87db-7aa0-bcb8-b2f63e9769e6` | REVISE — 11 findings, all accepted |
| Plan round 2 (RESUMED from round 1) | same session | REVISE — 3 corrections, all applied |

A branch-review Codex axis in step 7 opens its OWN cold session. Only a
verification round resumes. Round 1's first dispatch died with no session,
because piping `codex exec --json` into `tail` buffers everything and the
process was killed before it flushed. Redirect to a file and use
`-o <last-message-file>` instead.

## State at handoff

- Phase `plan_approved`, HEAD `cf7d7554`, plan review rounds 2, surface
  amendments 0.
- Gate: GREEN at baseline only. That run was docs-only, so the test, build,
  promised-tests and diff-coverage rows were SKIPPED. It is not review evidence.
- Nothing implemented. T1, T2 and T3 are all open.

## Next action

T1 — author all 18 tests failing, before any implementation. The plan's T1
carries each title, its fixture and the defect it kills. Seven of them exist
only because plan review found the original eleven could all pass on a wrong
implementation; each is tagged `[R1-n]`.
