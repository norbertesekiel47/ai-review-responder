# Handoff — fix/1301-migration-guard-execution

A resumed session bootstraps from this file, then the triage record, then the
plan. It never needs the prior transcript.

**Resume with:** `/feature-resume fix/1301-migration-guard-execution`

---

## Where the run stopped

Step 7 review wave, round 1, **complete**. All four axes reported and all four
were adverse. The owner chose to FIX the findings and re-review, rather than
ship with named open gaps.

| Axis | Verdict |
|---|---|
| Standards & maintainability | do-not-approve (2 HIGH) |
| Spec & correctness | 8 findings |
| Red team | **OPEN_P0** |
| Adversarial approach (Codex) | REVISE |

**Read `docs/reviews/fix-1301-migration-guard-execution/triage-round-1.md`
next.** It carries every finding with a verdict, grouped into seven
workstreams, with the proving mutation for each. Do not re-read the four raw
reports unless triage is unclear on a point; they are 100 KB together.

## State on disk

- Phase `gate_green` at the wave's HEAD. Branch round 1 counted.
- Gate was GREEN at `a4becdc44` with fingerprint
  `70372003d0cd591811929197c3b6416e246d96944281eb8f6ca46b2a45ad0f56`.
  **That evidence is now void** — the report commits moved HEAD.
- Red-team finalizer RAN CLEAN: 40 process groups reaped, 0 mutations left.
  Sidecar status is `OPEN_P0` and will stay so until workstream 1 lands.
- Surface amendments: 2, the second owner-waived (deviations D4). **A third
  has no waiver behind it and returns to the abort criteria.**
- Deviations D1–D13, all ACCEPT.

## Environment — read before running anything

- Container `repworth-testdb-pg17`, PostgreSQL **17.11**, host port **5500**,
  database **`test_1301`**, at migrations head. `.env.local` points there.
- **NEVER run `pnpm test:db:setup`** while any agent is running: it drops
  schema `public`.
- **NEVER touch `repworth-testdb-recovery-20260914`** (postgres:16, port 5499).
  It serves seven databases for other worktrees including
  `fix/batch-e-screens-vs-runtime`.
- `.env.local` was verified intact at 322 lines with the correct
  `TEST_DATABASE_POOL_URL`. A review appendix claimed it had been scrubbed to
  three lines; that claim is disproved in the triage record. **Do not act on
  it.**
- Run the gate with `MAX_PARALLEL=2 VITEST_WORKERS=3`. At default fan-out it
  oversubscribes the machine and two unrelated load-sensitive suites
  (`red-team-mutation-runner`, `review-qr`) time out at 5s. Both pass in
  isolation; neither imports anything this branch touches.

## The fix order, and why

**1. Workstream 1 — the P0. Blocks everything.** My
`weakened-checks-reasons.md` claims "What no longer has a guard anywhere:
Nothing." It is false, the head commit message repeats it, and two axes found
it independently. Fix the document, add 048's column inventory to its oracle A,
amend the arch-review-log.

**2. Workstream 2 — the four catalogue blind spots.** All are gaps in
`readPublicCatalogue`, all proven by surviving mutations, so each fix has a
ready-made test. Do **RT-5 first**: a view over a deny-all table with `GRANT
SELECT TO anon` defeats every suite, which re-opens the exact boundary
migration 049 exists to close. Confirmed independently in psql; the probe is in
the triage record.

**3. Workstream 3 — the adversarial P1.** A migration carrying its own
`BEGIN … COMMIT` would commit 118's permissive default ACLs before the rollback
sentinel fires. Migration **119 already carries its own `BEGIN`/`COMMIT`**
(plan §2, Fact 1), so this is one migration away. Triage recommends detecting
the condition after the transaction rather than predicting it from the text.

**4. Workstreams 4–7** are consistency, harness quality, fragile assertions and
false doc claims. Workstream 7 is entirely my own wrong numbers — the title
count, the "fourteen" further suites (really twenty), "201 tests", and three
wrong descriptions in checked-in comments.

**One item needs measuring before it can be triaged:** F-B, 118 is
nondeterministic at roughly 1 in 46 runs. A flaky security guard is not
cosmetic. Reproduce it before merging.

**One claim still unverified:** the spec axis reported three failures in a full
`--project integration` run. Its stated cause is disproved, but the failures
themselves were never checked — the red team was mutating migrations at the
time and a concurrent run would have corrupted its baseline. Check this early.

## Do not undo these — the wave confirmed them sound

- No oracle-A drift: all 19 `readMigrationSql` uses are `tx.unsafe(...)`.
- All 21 `assertDegradeLanded` sites are per-object with full object coverage.
- No rollback leak, verified outside any transaction across 40 launches
  including three that failed mid-transaction under a mutated 118.
- The seven suites pass as a set, serially, under one shared advisory lock.
- **21 migration mutations, 14 caught.** `REVOKE ALL` vs `REVOKE SELECT`
  caught. A block-commented `ENABLE ROW LEVEL SECURITY` caught — the evasion
  class that beat #1171's regex. A widened role allowlist caught by oracle A.
- The two-oracle design is not the problem. The catalogue's coverage is.

## Round budget

Branch review round 1 spent. Rounds 2–3 are **verification-only**: one agent
per axis that had accepted findings, briefed with that axis's findings table
and the fix commits. They may not open new fronts. After round 3 the cap is
reached and the remaining disagreement goes to the owner.

The Codex adversarial axis should RESUME its session rather than start cold.
Plan-round session id: `01a0bda7-0982-7773-8164-298827ad35d0`. The round-1
adversarial axis ran as a fresh `codex exec` — check `.feature/logs/adversarial.log`
for its session id before resuming it.

## After the fixes

1. Re-run `bash .agents/skills/feature/scripts/verified-gate.sh --review`
   (not `verify-gate.sh` — only the wrapper writes the fingerprint).
2. Re-run the red-team pass scoped to the FIX HUNKS and their direct callers.
   `round-start` refuses a third round outright.
3. `node .agents/skills/feature/scripts/red-team-status.mjs` must pass before
   any external action. It recomputes status rather than trusting the sidecar.
4. Only then `bash scripts/feature-state.sh set-phase reviewed`.
5. PR with `gh pr create --draft`, CI green, then `gh pr ready`. Merge needs
   owner approval.

## Issue scope, unchanged

- **#1301** — the seven suites. This branch.
- **#1307 RT-4** — the PostgreSQL 17 lane. Done and measured: `acldefault`
  yields 8 privileges including MAINTAIN on 17 against 7 on 16, so migration
  122's MAINTAIN branch is asserted in CI for the first time.
- **#1307 RT-5** — already closed by `08c2b4a0e` before this run started.
- **#1173** — NOT this branch. Already built on the unmerged
  `fix/batch-e-screens-vs-runtime` (commit `696d4bb2e`). Owner decision.
- **Deferred:** twenty further suites carry the same text-guard weakness
  (deviations D8, corrected from fourteen by RT-9), including
  `migration-035-rls-policies`, `migration-040-rls-tightening` and
  `migration-045-onboarding-demos-rls` — the same deny-all RLS class.
