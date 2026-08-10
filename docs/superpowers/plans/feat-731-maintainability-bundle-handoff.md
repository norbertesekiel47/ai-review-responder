# feat-731-maintainability-bundle — handoff

A resumed session bootstraps from this file. It references artefacts by path and
does not restate them. `/feature-resume feat-731-maintainability-bundle`.

## Where we are

**Phase:** `reviewed` (see `.feature/state.json` — authoritative).
**Current step:** 8 (SHIP), RISK = normal lane: push → PR → CI green → merge.

### Post-review status (updated 2026-08-09)

All six tasks committed; gate **GREEN** three times (last: `--review` mode, 27
rows, both changed integration suites RAN not skipped, `promised-tests` 14/14,
`diff-coverage` pass). Review complete at **round 2 of 3** — both axes verified
every accepted finding fixed with no regressions and no new fronts.

Round 1 findings, all ACCEPTED and fixed in `27a57cc2`:
1. **The merged denominator query was a plan regression with a false rationale**
   (found independently by BOTH axes). The `CROSS JOIN LATERAL … EXISTS` is now
   `LEFT JOIN responses p … AND p.status = 'posted'` with
   `COUNT(*) FILTER (WHERE p.review_id IS NULL / IS NOT NULL)`. Two independent
   `EXPLAIN ANALYZE` reproductions confirm a Hash Right Join replacing two
   correlated SubPlans at `loops=20000` — ~81–261× planner cost and ~137× buffer
   accesses. The new comment makes **no planner claim at all**; that unverifiable
   assertion was the root of the finding.
2. **The logging-privacy test had gone vacuous.** Coverage moved to where the log
   now lives (`regen-budget-batch.test.ts`); the un-failable test was deleted.
3. Two stale `NOT EXISTS` comments; a hand-rolled `seedPostedResponse` duplicate;
   plus two accepted appendix items (a stale ADR line citation, a dangling
   referent in the `ReplyFacts` doc block).

**Open decision the owner may want to override — see deviations D9.** The gate's
`reclassify` row WARNs: the test bucket is 490 lines against a 230 estimate
(2.13×). Step 0 was re-run against the real figures (production 323 = 1.62×,
under threshold) and the lane came out **unchanged** — RISK normal, SURFACE
mixed, SIZE normal, 0 surface amendments. Escalation to the RISK=high lane was
declined because that lane's control is a staging ride, and staging exists to
exercise worker/queue/webhook/migration paths, none of which this branch touches.
The estimate was wrong, not the lane.

**Also note (D8):** `origin/main` moved mid-run — PR #747 merged as `3887707d`.
It is merged into this branch, the file sets are wholly disjoint, and the branch
is currently 0 commits behind.
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-731-maintainability-bundle`, branched from `origin/main` @ `352d5c1d`.
**Enforcement:** ARMED (`scripts/arm-check.sh` verified at setup).

## Artefacts

| What | Path |
|---|---|
| Ticket | `gh issue view 731` — **read the pinned comment**, it shrinks the bundle from five items to four |
| Intake contract (arming copy) | `.feature/intake.json` |
| Intake contract (committed audit copy) | `docs/superpowers/plans/feat-731-maintainability-bundle-intake.json` |
| Plan | `docs/superpowers/plans/2026-08-09-731-maintainability-bundle.md` |
| Deviations (2 entries, both pre-triaged ACCEPT) | `docs/superpowers/plans/feat-731-maintainability-bundle-deviations.md` |
| Glossary excerpt | `CONTEXT.md:30-31` — **Reviews list**, **Posted-reply axis**, **Action slot**, **On-demand generation** |
| ADR this bundle amends | `docs/adr/0018-row-state-axes-projection.md` |

## Lane

RISK = **normal** → no staging ride, no plan-review gate, no merge pause. SURFACE
= mixed. `db_touching` = true (SQL reshape + allowlist), **no migration**.
Ship = push, PR to `main`, all CI green (incl. fallow; React Doctor 100/100
because surface is ui), merge.

## Task graph

Task 1 (eval) runs **alone** — it is also the enforcement spot check. Then Tasks
2, 3, 4, 5 fan out **concurrently** (no blocking edges, disjoint file sets).
Task 6 (ADR addendum) blocks on 2, 3, 4.

## Facts already established — do not re-derive

- **Item 4 of the original five is MOOT.** #727 deleted `ReviewRowState` and
  `row_state` outright. Four items, not five.
- **Owner decision (locked):** item 3 **deletes** `peekRegenBudget` rather than
  harmonising the two peeks. Its one caller uses `peekRegenBudgetBatch([id])`.
  Fail-open posture (D-F) preserved; only the swallow's location changes.
- **Owner decision (locked):** `allowed_edit_surface` declares five trees/files,
  not the ticket's literal three — `scripts/ci/tenant-scope-allowlist.ts` and
  `src/lib/shared/dashboard-regen-rate-limit.ts` (+ its test) are mechanically
  forced. Declared at intake, so **no amendment budget is spent**.
- **#740 overlap is benign** — see deviations D1. Region-disjoint in the same
  file and only #731 moves `ALLOWLIST_BASELINE`. No merge-order constraint;
  #731-first recommended. Surface this to the owner when #740 is resumed; it was
  deliberately NOT written into #740's own deviations file.
- **PR #747 is not a collision** — see deviations D2 (branch staleness reads as
  a revert when diffed against `main` instead of its own merge base).
- **Test DB is live and at head:** container `repworth-testdb`, port 5499,
  migration 103 applied. `TEST_DATABASE_POOL_URL` is set at `.env.local:301`
  (line 292 is a commented-out decoy — do not "fix" it).

## Three landmines the harness recon found

Restated here because a resumed session will hit them before it re-reads the plan.

1. `replies-view.test.ts:351` pins the card's **exact 18 keys**. Task 2 must add
   and remove zero.
2. `reviews-list.test.ts:346` asserts `expect(dataQueries).toHaveLength(4)`.
   Task 3's merge makes it **2** — update, don't delete.
3. `fakeSql` dispatches `/AVG\(/i` **before** `/COUNT\(\*\)/i`. The merged query
   matches both, so without a new branch placed first it resolves to
   `[{ avg }]` and silently zeroes both denominators — a green harness lying
   about a broken query.

## Gate

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-731-maintainability-bundle
bash scripts/verify-gate.sh --review     # last run before step 7
```

`TEST_DATABASE_POOL_URL` resolves from `.env.local`; a SKIP row on the changed
integration suites is **not review-ready** for this bundle. `reclassify`
thresholds: 400 production / 460 test lines (2× the 200/230 estimates).

## Open items for later steps

- Step 6 deviations read-back: D1 and D2 already carry ACCEPT verdicts. Any new
  entry from Tasks 1-6 needs its own verdict before review dispatch.
- Step 8 entropy counter: `.claude/reference/arch-review-log.md` stands at **19
  merges, 3.8× over the threshold — a review is overdue.** Remind the owner; do
  not start one.
- Step 8 lab-notes promotion candidate: deviations D2's merge-base lesson.
