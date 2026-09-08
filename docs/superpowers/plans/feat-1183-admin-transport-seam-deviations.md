# Deviations — #1183 Admin transport seam

Entries the plan did not anticipate. One verdict line per entry (ACCEPT / RE-PLAN)
is added at the step 6 read-back.

## D1 — `scripts/feature-setup.sh` carried in a STALE progress ladder

`bash scripts/feature-setup.sh … --runtime claude` carried a ladder from an earlier,
unrelated run into `.feature/progress.json`: `size=small`, `risk=normal`, and steps
`gate`, `review`, `ready` already marked **done** with 2026-09-08T00:xx timestamps,
before this run had done any of them. `progress.mjs init` re-set the axes
(`standard·high·backend`) but PRESERVED the false done-steps; they had to be reset
explicitly with `progress.mjs step <id> pending`.

Impact: none on enforcement (`.feature/state.json` and `gate-status.json` own gate
truth, not `progress.json`), but the ladder is the run's only per-phase record and a
falsely-green one is misleading evidence.

Verdict: ACCEPT — the ladder was corrected before step 3; the lesson (verify the
ladder after `feature-setup.sh`, `init` merges rather than resets) is promoted to
lab notes at step 8.

## D2 — cookie-path refusal deltas are in the ticket's table, not a plan invention

Two cookie-mode responses change, both because the ticket's refusal contract is
declared "byte-for-byte, **both transports**":

- verified cookie session with no `users` row: 401 `Unauthorized` → 403 `Forbidden`
- cookie AAL read returning `{ currentLevel: null }` with no error: `mfa_required` →
  `mfa_check_failed` (unreachable after a successful `getUser`)

Recorded in the intake `edge_cases` and the plan before implementation, so this is a
locked-intent reading rather than a deviation discovered mid-build. Logged here
because it is the highest-signal behavioural change on the branch.

Verdict: ACCEPT — the ticket's table is the locked contract and it is uniform across
transports.
