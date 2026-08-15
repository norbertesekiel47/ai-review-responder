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
- [x] Step 4 execute — T1, T2, T2b, T3, T4, T5 all committed. First-task enforcement
      spot check PASSED (guard binds for subagent tool calls). T3 ‖ T4 ran in parallel,
      file-disjoint, no collision.
- [x] Step 5 gate — **GREEN**, 24/25 PASS. `reclassify` WARN adjudicated (Finding C:
      churn-vs-net accounting; lane re-confirmed normal). Fallow run serially after the
      gate: dead code 0 · complexity 0 · duplication 1 (warn) — trap 1 clear.
- [x] Step 6 deviations triage — 10 entries, all ACCEPT, none RE-PLAN. Verdict table at
      the top of the deviations file.
- [x] Step 7 review — round 1, two axes. Spec verdict: **faithful implementation, no
      behavioural defect**. 9 findings, 8 ACCEPT / 1 REJECT (A9, reasoning in
      `docs/reviews/<branch>/triage.md`). Fixes applied and mutation-checked in
      `287e1cb5`. Phase `reviewed`. **No round 2** — no finding survived.
- [ ] Step 8 ship — normal lane: push, PR to `main`, CI green, merge. No staging ride.

## Owner decisions on record (do not re-litigate)

1. Trap 3 reading — mapping assertions move verbatim; §5-mandated rewrites logged.
2. At-risk UI — `At risk (N of M)` + `View all →`; EmptyState when N is 0.
3. Module shape — `businesses-list-service.ts` deleted; one `getBusinessSummaries`.
4. Surface amendment 1 of 2 — `HealthBadge` extracted to `src/components/admin/ui/`.
5. `OVERVIEW_AT_RISK_LIMIT` lives in `overview-service.ts`, not `page-sizes.ts` —
   `APP_LEAF_IMPORT_BAN` makes the specified location illegal; owner chose option A.

## Two follow-ups deliberately NOT done here

- **A9**: fold `formatRelative` into `src/components/admin/ui/format.ts` (its declared
  single owner) next time that file is legitimately open. Out of surface here, and a
  2nd amendment would have tripped branch teardown for a 10-line formatter.
- Overview still reads every business row — spec §5.1's recorded limitation with a
  named rejected alternative. **Not an oversight; do not "fix" it.**
