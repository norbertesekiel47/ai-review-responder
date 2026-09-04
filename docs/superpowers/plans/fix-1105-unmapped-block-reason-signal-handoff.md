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

`.feature/state.json` is the authority for every figure below; this section goes
stale and that file does not.

- T1, T2 and T3 are all DONE. Plan review rounds 2, branch review rounds 1,
  surface amendments 2 (the second overrode an abort trigger — deviations D11).
- The step 7 wave ran all four axes and its findings are triaged in
  `docs/reviews/fix-1105-unmapped-block-reason-signal/triage.md`. One P0, fixed.
- **The gate must be re-run.** The round-1 fixes moved HEAD past the SHA the last
  green gate measured, which also makes the red-team sidecar stale by
  construction.

## Next action

Re-run `scripts/verify-gate.sh --review`, then the scoped red-team round 2
against the fix hunks only, then `red-team-status.mjs`, then the `reviewed`
transition. Step 7.5's ORDER is load-bearing: the report commit moves HEAD, so it
happens BEFORE the final gate.

## Local gotcha this run paid for twice

The gate's `test` row sanitizes the database URL out of its environment when
`db_touching` is false, so 96 integration files silently SKIP inside a green
gate. Run the live-DB lane yourself:

    export TEST_DATABASE_POOL_URL="$(grep -m1 '^TEST_DATABASE_POOL_URL=' .env.local | cut -d= -f2-)"
    export DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL"
    pnpm vitest run --project integration

And `codex exec` hangs reading stdin unless you redirect `< /dev/null`. That
killed two dispatches on this run (deviations D12).
