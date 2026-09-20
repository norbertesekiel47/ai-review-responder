# Handoff — fix/1301-migration-guard-execution

A resumed session bootstraps from this file, then the triage record, then the
plan. It never needs the prior transcript.

**Resume with:** `/feature-resume fix/1301-migration-guard-execution`

---

## Where the run stopped

**Step 7.5.** Review wave round 1 was adverse on all four axes; the owner chose
to FIX rather than ship with named gaps. All seven fix workstreams have landed,
the gate is green, and red-team round 2 has run and is CLEAR. What remains is
the `reviewed` transition, then the draft PR.

| Axis (round 1) | Verdict | Now |
|---|---|---|
| Standards & maintainability | do-not-approve (2 HIGH) | every accepted finding fixed |
| Spec & correctness | 8 findings | fixed; the one unverified claim is disproved (below) |
| Red team | OPEN_P0 | round 2 **CLEAR** |
| Adversarial approach (Codex) | REVISE | the P1 is fixed; see D15 |

## State on disk

- Phase `gate_green`. Branch review round 1 counted. Red-team round 2 spent.
- Gate GREEN at `476145667` — 45 of 45 rows, full `test` row included.
- Red-team sidecar: `docs/reviews/red-team/fix-1301-migration-guard-execution-80b308/`,
  round 2, status CLEAR, every round-1 finding disposed `fixed`.
- Surface amendments: 2, the second owner-waived (deviations D4). **A third
  still has no waiver behind it and returns to the abort criteria.**
- Deviations D1–D16, all ACCEPT.

## Environment — read before running anything

- Container `repworth-testdb-pg17`, PostgreSQL **17.11**, host port **5500**,
  database **`test_1301`**, at migrations head. `.env.local` points there and
  is 322 lines; verify that before assuming otherwise.
- **NEVER run `pnpm test:db:setup`** while any agent is running: it drops
  schema `public`.
- **NEVER touch `repworth-testdb-recovery-20260914`** (postgres:16, port 5499).
  It serves seven databases for other worktrees.
- Run the gate with `MAX_PARALLEL=2 VITEST_WORKERS=3`. At default fan-out it
  oversubscribes the machine and two unrelated load-sensitive suites time out.

## What the fix pass changed, by workstream

1. **The P0 (RT-1/F-A).** `weakened-checks-reasons.md` said "What no longer has
   a guard anywhere: Nothing". Replaced with the measured list. 048's column
   inventory, `notNullColumns` set and primary key are pinned as oracle A;
   off-target row writes are named and closed by workstream 2.
2. **The four catalogue blind spots.** `readPublicCatalogue` now reads VIEWS
   and materialized views with their ACLs, `pg_default_acl`, and a per-relation
   `rowDigest`. Each proven live against the mutation that used to survive.
3. **The rollback licence.** `readLeakSentinel` fingerprints the relation set
   and `pg_default_acl` OUTSIDE the transaction; `withRolledBackTransaction`
   compares before and after. The text pre-check was REJECTED — see D15.
4. **One shape for the vacuity guard.** All seven "moves no other table" cases
   now prove the degrade landed.
5. **One owner per helper.** `deriveTablePrivileges`, `clientGrantNames`,
   `CLIENT_ROLES`, `deriveColumnPrivileges` and `schemaOnly` live in the
   harness. S-5, S-6, S-7, S-11, S-12 folded in.
6. **Self-confirming assertions retired.** RT-7, RT-11, RT-12, RT-13, RT-14,
   RT-17.
7. **Documentation truth.** 60 promised titles and 22 remaining text-guard
   suites are MEASURED. Two audit comments, one stale plan claim and 17 oracle-A
   citations corrected. F-E and F-H addressed.

## Findings this pass produced, in the code it was fixing

- **D14** — migration 118 does NOT restore the schema default ACLs. Measured
  through the whole cycle on 17.11: all sixteen entries survive the re-apply.
  118's REVOKE reaches what its own TABLE inherited; the schema default is
  migration 122's subject. Both off-target calls now declare the measurement.
- **D15** — the rollback text check is unimplementable without a SQL lexer,
  because `DO $$ BEGIN … END $$` is ordinary PL/pgSQL and migration 053 uses
  it. Detection replaced prediction.
- **D16 / RT2-1** — deriving the column-privilege set fixed RT-7's growth axis
  and opened a shrink axis. Red-team round 2 narrowed the probe to `SELECT`
  alone and every caller still passed. Closed by a floor of four inside
  `deriveColumnPrivileges`.

## The two open questions from round 1, both answered

- **"Three failures in a full `--project integration` run"** (spec axis):
  DISPROVED. The full `test` row passed in the gate at `1f2a33136` and again at
  `476145667`.
- **F-B, 118 flaky at ~1 in 46:** NOT REPRODUCED. 25 consecutive runs of the
  nine live-DB files, 64 of 64 each time, plus two full gate runs. Recorded as
  unreproduced rather than fixed — if it returns, the suspect is the
  `columnComments` literal, which failed once while `columnDefaults` two lines
  above passed.

## Known, deliberately not done

- The byte-identical `MIGRATION_117_ADMIN_AUDIT_LOG` copies in
  `scripts/ci/__tests__/{mint,revoke}-admin.integration.test.ts` still exist.
  Both files are OUTSIDE `allowed_edit_surface`; pointing them at the shared
  export needs a third surface amendment. The shared definition is now a strict
  SUPERSET of both, and its JSDoc says to delete the local copies when either
  file is next touched. **Owner decision.**
- Two `not.toEqual([])` absence proxies survive outside this branch's surface
  (`src/lib/agents/operator/__tests__/schema.test.ts`,
  `src/lib/demos/__tests__/select-qualifying.test.ts`). Same shape as RT-13,
  unchanged code, out of scope for a round-2 pass.

## What remains

1. `bash scripts/feature-state.sh set-phase reviewed` — after
   `node .agents/skills/feature/scripts/red-team-status.mjs` passes.
2. PR with `gh pr create --draft`, CI green, then `gh pr ready`.
3. **Push and merge both need owner approval** (`required_approvals`).

## Issue scope, unchanged

- **#1301** — the seven suites. This branch.
- **#1307 RT-4** — the PostgreSQL 17 lane. Done and measured: `acldefault`
  yields 8 privileges including MAINTAIN on 17 against 7 on 16.
- **#1307 RT-5** — already closed by `08c2b4a0e` before this run started.
- **#1173** — NOT this branch. Already built on the unmerged
  `fix/batch-e-screens-vs-runtime` (commit `696d4bb2e`). Owner decision.
- **Deferred:** twenty-two further suites carry the same text-guard weakness
  (deviations D8, measured), including `migration-035-rls-policies`,
  `migration-040-rls-tightening` and `migration-045-onboarding-demos-rls`.
