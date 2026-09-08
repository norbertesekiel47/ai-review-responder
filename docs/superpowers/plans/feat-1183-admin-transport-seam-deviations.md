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

## D3 — the 22-suite migration shim consumed a one-shot mock twice

The migration spec handed to the parallel subagents made `mockRequireRole` a DOUBLE
consumer: once inside the `resolveDualModeIdentity` shim, once inside the
`loadAppUser` shim. Suites that arm their 403 case with
`mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403))` — on top of
a `beforeEach` `mockResolvedValue(admin)` — had the rejection consumed by the seam
shim; `loadAppUser` then got the default live admin back and the route returned its
SUCCESS status instead of 403.

Found independently by three of the four migration agents (on `resend-invite`,
`zernio-queue` and the batch-1 suites) and fixed two different ways before the
orchestrator standardised on the stronger one: `loadAppUser` reads
`mockRequireRole.mock.results.at(-1)` instead of calling again, so the mock is
invoked exactly ONCE per gate pass — which also preserves the pre-ticket call count
— and a `...Once` control keeps its meaning. All 22 suites now carry that single
shim.

Why it matters beyond this branch: the failure is SILENT in the dangerous direction.
A suite whose "rejects a non-admin" test passes the gate does not error — it runs
the route and asserts the wrong status, so a shim like this can make an
authorization test vacuous while staying green.

Verdict: ACCEPT — the shim is test-only, the defect was caught before the gate, and
every affected suite is green with the unified version. Promote the general lesson
(a mock shim that re-invokes a `...Once`-armed mock silently defeats it) to lab
notes at step 8.

## D4 — `docs/directory/lib-platform.md` had ZERO headroom under its 3,000-word cap

The page measured 2,998 words before this branch, so the two new `src/lib/auth/`
files could not be documented without breaking
`src/__tests__/reference-shape.test.ts`. `docs/agents/context-layout.md` gives three
remedies — split the page, archive the oldest sections, or move the WHY to the page
the pointer already names. The first two need `docs/directory.md` plus a sibling
page, which would have been surface amendment #2 and therefore a hard stop.

Applied the third, confined to the `auth/` section this ticket already edits: each
row was brought to the row shape `.claude/CLAUDE.md` itself prescribes (WHERE + up
to three one-clause traps, WHY delegated to the module docblock, the rule file or
ADR 0025). Nine rows were tightened; no row lost a fact that does not exist verbatim
in the file it now points at. Final: 2,998 words, `ci:directory-map` passing.

Verdict: ACCEPT — the documented remedy, applied to the section under change. Flag
for the orchestrator: the page is again at exactly its cap, so the NEXT ticket
adding a `src/lib/` file under one of its folders (#1185 does not, #1186 may) will
have to split it, and that is a `docs/directory.md` change, not a lib-platform one.
