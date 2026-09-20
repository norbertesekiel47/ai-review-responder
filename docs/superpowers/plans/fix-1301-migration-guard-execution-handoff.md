# Handoff — fix/1301-migration-guard-execution

A resumed session bootstraps from this file, then the plan, then the deviations
file. It never needs the prior transcript.

## What this run is

#1301 — six migration guard suites pattern-match their migration's SQL text
instead of executing it, and migration 118 has no suite. #1307 RT-4 — CI pins
`postgres:16` while both Supabase projects run 17, so migration 122's
`MAINTAIN` statements never execute in CI.

**#1173 is out of scope.** It is already implemented on the unmerged branch
`fix/batch-e-screens-vs-runtime` (commit `696d4bb2e`). Owner decision.
**#1307 RT-5 is already closed** by commit `08c2b4a0e` on 2026-09-17.

## Artifacts, by path

| What | Path |
|---|---|
| Locked intake (58 titles, 37 surface entries) | `docs/superpowers/plans/fix-1301-migration-guard-execution-intake.json` |
| Plan, 8 tracers | `docs/superpowers/plans/fix-1301-migration-guard-execution-plan.md` |
| Deviations D1–D3, all ACCEPT | `docs/superpowers/plans/fix-1301-migration-guard-execution-deviations.md` |
| Plan review rounds 1–3 | `docs/reviews/fix-1301-migration-guard-execution/plan-review-r{1,2,3}.md` |

## State

- Phase `plan_approved`. Plan rounds 3 of 3 — **the cap is reached**. All three
  returned REVISE; every accepted finding is fixed in the plan, and the owner's
  approval substitutes for APPROVED as the workflow specifies.
- Surface amendments: 1 (auto-approved). Gate fail rounds: 0.
- Base SHA `d79bc765`. Plan artifacts committed as `c85d73443`.
- Codex session `01a0bda7-0982-7773-8164-298827ad35d0`. A branch verification
  round in step 7 resumes this id rather than starting cold; rounds 2 and 3
  cost 53 K and 80 K tokens against round 1's 139 K for exactly that reason.

## Environment — read this before running any test

This worktree does **not** use the shared postgres:16 container.

- `repworth-testdb-pg17` — postgres:17.11, host port **5500**, database
  **`test_1301`**. Provisioned to migrations head with zero `ERROR:`/`FATAL:`
  lines. Migration 122's post-apply MAINTAIN query returns 0.
- This worktree's `.env.local` points there. The previous value is at
  `.env.local.pg16-backup`.
- `repworth-testdb-recovery-20260914` — postgres:16, port 5499, **untouched**.
  It serves seven databases for other worktrees including
  `fix/batch-e-screens-vs-runtime`. Do not stop or remove it. Deviation D2.

## The two facts the design rests on

1. None of the seven migration files carries its own `BEGIN;`/`COMMIT;` — only
   119 does. So all seven run inside an outer transaction.
2. A multi-statement `tx.unsafe()` inside `db.begin()` works on postgres.js
   3.4.9. Measured, not assumed: the degrade dropped two of five indexes, the
   verbatim re-apply restored all five and set `relrowsecurity` true, the
   sentinel rolled back, and the container still read five indexes.

## The one thing not to undo

Every suite carries **two** oracles. Oracle B (degrade, re-apply, diff against
BEFORE) is not sufficient by itself, and collapsing to it would silently gut
this branch. `pnpm test:db:setup` provisions the container **from the migration
under test**, so a weakened migration produces a weakened BEFORE, and
`AFTER == BEFORE` passes. Oracle A — literals pinned in the test, independent
of the file — is what catches that. Plan §3.

## Step 4 progress — 2 of 8 tracers done, six in flight

**T1 — PG17 lanes. DONE.** `ci.yml:282` and `e2e.yml:71` now pin `postgres:17`,
with six current documents moved in step. Two new cases in
`src/__tests__/ci-audit-wiring.test.ts` pin both workflows to the same major
AND to 17 — equality alone would pass if both regressed together. 128 tests
green. The enforcement spot check PASSED, which is what proves the edit-surface
guard binds for subagent tool calls in this harness.

RT-4 is closed with measurement, not argument: `acldefault('r', <owner>)` on
the PG17 container yields eight privileges including `MAINTAIN`, against seven
on 16. The 122 guard suite derives its revoked-rights set from `acldefault`
rather than a spelled list, so that branch is now genuinely asserted. Suite
green, 8 of 8.

**T2 — harness and shared registrations. DONE.** `migration-guard.ts` (549
lines) exports the nine-item contract. 15 tests green, `ci:live-db-suites`
passed with neither new file flagged, all seven `MIGRATION_SHAPE_FILES` entries
present, six `SchemaRequirement` entries added (049 correctly excluded — it
creates no nameable object, the 097/119 situation). No `any`, no silent
catches, no production importer.

**Foundation check. DONE.** `readPublicCatalogue` had no committed test of its
own (deviations D5). One case now asserts all eleven `CataloguedTable` fields
on CONTENT, using `poller_heartbeats` and `flagged_responses`, with
`users.users_self_select` proving the policy renderer. Three mutations proved
it has teeth. **The reader is correct** — no defect found, so the six suites
build on a validated foundation.

**T3–T8 — in flight**, six parallel subagents, disjoint leases:
T3 049 · T4 048 · T5 051 · T6 053 (`opus`) · T7 057 · T8 117+118 (`opus`).

## Rules the fan-out runs under

- **No agent may run `pnpm test:db:setup`.** It drops schema `public`, and six
  agents share one container. T4's brief originally offered it as a way to
  prove oracle A; that was corrected mid-flight by message before the agent
  acted. Every later brief forbids it in its opening lines.
- **No agent may edit `supabase/migrations/`.** Teeth are proven by mutating an
  expected literal in the agent's own test, not by mutating a migration.
- Each agent proves its assertions can fail, and reports the failure message.

## Gate expectation

RED until all six suites exist. `feature-surface` names six files the tracers
are creating right now. All three plan-review rounds recorded that state as
expected rather than as a finding. Run the gate only after every agent has
returned — the subagent barrier exists because a return mid-gate moves HEAD
under the evidence.

## Next step after the fan-out

1. Spec-check every returned diff against its brief. Do not trust reports:
   T1 left two false claims behind and T2's own report disclosed a coverage gap.
2. Re-run the surface spot check.
3. Commit, record the SHA, then `bash scripts/verify-gate.sh --review`.
4. Step 6 deviations read-back: D1–D7 each need a resolved **Verdict:** line.
   All seven are currently ACCEPT.
5. Step 7 wave. RISK = high, so it carries all axes plus the red-team pass.
   The Codex axis RESUMES session `01a0bda7-0982-7773-8164-298827ad35d0`.
