# Handoff — refactor/overview-spec-alignment

**Feature:** PR 3 of 3, portal audit remediation. Closes the spec.
**Lane:** RISK=normal · SURFACE=mixed · db_touching=false → step 8 normal lane
(push, PR to `main`, CI green incl. fallow + React Doctor 100/100, merge). No
staging ride.

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-overview-spec-alignment`
(sibling, own `node_modules`). Prefix every Bash call with `cd <worktree-root> &&`.

## Read these, in order — do not reconstruct from any transcript

| What | Path |
|---|---|
| Design of record | `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` **§5** |
| Intake contract (binding; `locked_decisions` resolves trap 3) | `docs/superpowers/plans/refactor-overview-spec-alignment-intake.json` |
| Plan (T1–T5, seam statement, target API) | `docs/superpowers/plans/2026-08-15-overview-spec-alignment.md` |
| Deviations (triage before step 7) | `docs/superpowers/plans/refactor-overview-spec-alignment-deviations.md` |
| Machine phase record | `.feature/state.json` |
| Glossary | `CONTEXT.md` — **At-risk list** is coined in T5 |

## Task graph

```
T1 (eval, RED) ──► T2 (shared module + Businesses data path) ──┬─► T3 (Businesses columns)
                                                               └─► T4 (Overview at-risk)
                                                                     └─► T5 (docs + domain)
```

T3 and T4 are file-disjoint and dispatch in parallel. T1 runs **alone** (first-task
enforcement spot check). T2 does an **import repoint only** in `BusinessesClient.tsx`
— that is what keeps T3/T4 disjoint.

## Standing constraints (violating any is a finding, not a fixup)

1. `buildBusinessSummary` relocates with its `// fallow-ignore-next-line complexity`
   comment byte-for-byte — `ci:fallow:coverage` is a required check.
2. Strictly sequential per #773. No `Promise.all` over `sql`. Suppress React Doctor's
   `server-sequential-independent-await` with the house idiom at
   `src/app/admin/businesses/[id]/page.tsx:32`.
3. Filter (`level !== 'healthy'`) **then** cap at `OVERVIEW_AT_RISK_LIMIT`. Never
   cap-then-filter. Ranking never becomes `ORDER BY … LIMIT`.
4. Overview still reading every business row is §5.1's recorded limitation with a
   named rejected alternative — **not** an oversight to fix.

## Gate

`bash scripts/verify-gate.sh` (`--review` for the last run before step 7).
Extra verification commands from the intake: `pnpm doctor`, and
`pnpm test:coverage && pnpm ci:fallow:coverage`. `pnpm build` runs (SURFACE=ui).
No live-DB suites in scope.

## Status

- [x] Step 0 classify · Step 1 intake locked (3 owner answers) · Step 2 worktree ARMED
- [x] Step 3 plan written, phase `plan_approved`
- [ ] Step 4 execute — **next: dispatch T1**
- [ ] Step 5 gate · Step 6 deviations triage · Step 7 review · Step 8 ship
