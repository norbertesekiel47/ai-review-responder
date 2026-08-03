# Handoff — #643 Suppression ledger: schema + domain core

**Resume with:** `/feature-resume feat-643-suppression-ledger-core` from
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-643-suppression-ledger-core`.

**Phase:** `gate_green` (`.feature/state.json`). **Steps 4, 6 and 6.5 are complete, and
the one accepted review finding is FIXED** — all six tasks landed, the adversarial review
ran, its single [high] finding was triaged ACCEPTED and applied at `cd861e6b`, and the
verify gate is GREEN (`--review` mode) at that same commit. **Next action: step 7, dual
review.**

## The step-6 fix — APPLIED at `cd861e6b`, gate GREEN

The accepted [high] finding is fixed and verified. `token_hash` now carries a named
`CHECK (token_hash ~ '^[a-f0-9]{64}$')` in migration 096, the two dishonest fixtures hash
real strings, and a 6-case `it.each` plus a `pg_get_constraintdef()` assertion cover it.
**Mutation-checked**: removing the CHECK fails 6 of the 7 new assertions. Head stayed 097;
`ALLOWLIST_BASELINE` stayed 413. Full record in the deviations file under
"Step 6 adversarial review".

> The `MIGRATION_GUARD_DISABLE=1` relaunch that unblocked it is **spent** — it was needed
> only to amend 096. Nothing downstream needs it, so a normal `claude` relaunch is fine
> from here.

---


## Read these, in this order — do NOT reconstruct from any transcript

| # | Path | Why |
|---|---|---|
| 1 | `docs/superpowers/plans/feat-643-suppression-ledger-core-deviations.md` | **Start here.** The step-6.5 triage table is at the top: 33 entries, 33 ACCEPT, 0 RE-PLAN, plus the four entries flagged for the step-7 reviewers. |
| 2 | `.feature/intake.json` | The binding contract. `allowed_edit_surface`, the 19 `tests_to_add` titles (all present verbatim — `promised-tests` PASS), `rollback_plan`, `observability`. The audit copy in `docs/superpowers/plans/` is byte-identical (sha256 `91786a3d…` — **amended at step 7**, two `tests_to_add` titles renamed off the forbidden `isSuppressed`; the pre-amendment hash was `5078c6d6…`). **Amendment budget is now 2 of 2 — exhausted.** |
| 3 | `docs/superpowers/plans/2026-08-01-suppression-ledger-core.md` | The plan. G1–G14 decision table first, then the task graph. |
| 4 | `CONTEXT.md` → "Solicitation suppression & unsubscribe" | Glossary. Five terms used verbatim throughout; re-read before writing any prompt or commit. |
| 5 | `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` | Locked spec, now carrying the G1 (§2.2) and G2 (§6.3) amendment banners T6 added. |

---

## What shipped — six task commits on top of T0

| Commit | Task | Substance |
|---|---|---|
| `a7cc34e6` | T1 | Migrations 096 (both tables, 2 partial uniques, 2 account-leading indexes, 2 CHECK pairings, RLS deny-all) + 097 (analytics CHECK swap); registry ripple across `events.ts`, `tenant-tables.ts`, `rls-inventory.md`, `schema-ready.ts` |
| `c0564823` | T2 | `src/lib/solicitation/suppression.ts` — three `as const` arrays, the `suppressionMatchSql` fragment (§1.2's sole owner), first-write-wins `recordSuppression` |
| `e2878ae8` | T3 | Purge retention: disposition entries, two verification arms, account-row delete + Unsubscribe token provenance scrub |
| `ddf114a7` | T4 | Build-time populate seam — LATERAL join in `loadCandidateWindow`, `toCandidate` stamping |
| `3a6d0794` | T5 | Aggregate purge receipt — retained global count threaded through the outbox payload to the template |
| `230054d5` | T6 | G1/G2 spec amendment banners; migrations-log head → 097 + retention-policy rows |
| `fe675af0` | gate | `test:db:setup` dropped from `verification_commands`; gate deviations recorded |
| `cd861e6b` | step 6 fix | 096 `token_hash` format CHECK + honest fixtures + 6-case rejection matrix; migrations-log entry. No production file touched. |

**Diff:** 37 files, 5,299 changed lines — 435 production (unchanged by the fix), 218
migrations, 2,757 tests, 172 real docs, 1,717 workflow artifacts. All 37 in-surface. **Amendment budget: 1 of 2
used**, spent during planning (`scripts/ci/tenant-scope-allowlist.ts`).

**`ALLOWLIST_BASELINE` walked 410 → 413 → 411**: T2 +1 (`suppressionMatchSql`'s
deliberately unscoped `global` arm), T3 +2 (the token-scrub `UPDATE`'s `OR` + stripped
subquery). T4 and T5 added none. **Step 7 gave back both of T3's**: dropping the
redundant `OR business_id IN (…)` left a plain account-scoped predicate the scanner
accepts natively, so the two entries were deleted, not retuned. Net for this branch: +1.

## Gate status — GREEN at `cd861e6b`

All 34 rows PASS: lint, typecheck, whole-repo `test`, all 17 `ci:*` audits, five
`verification_commands`, all six changed integration suites, `promised-tests`
(19/19 verbatim), plus `--review`'s `merge-coverage` and `diff-coverage`.

**One standing WARN, owner-approved:** `reclassify` fires at 2.94× (5,299 vs 1,800
estimated). Adjudicated as an **estimate error, not a lane error** — production code is
435 lines across exactly the files the plan named. Do not re-run step 0. Full reasoning
in the deviations file.

> **Gate re-run recipe** — the gate does NOT own its DB precondition, so both halves matter:
> ```bash
> cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-643-suppression-ledger-core
> export $(grep -E '^TEST_DATABASE_POOL_URL=' .env.local)   # else integration-suites SKIPs
> pnpm test:db:setup                                        # SERIALLY, never as a gate row
> bash scripts/verify-gate.sh                               # --review for the last run before step 7
> ```
> `pnpm test:db:setup` **drops schema `public`**. It raced the parallel gate on the first
> run and produced a fully spurious RED (27 route-test timeouts + a "behind head" live-DB
> failure). It is no longer a `verification_command`; keep it out of one.

## Remaining steps

- **Step 6 — DONE, fix landed.** `/codex:adversarial-review` ran against the branch diff;
  verdict `needs-attention`, one [high] finding, triaged ACCEPTED via
  `superpowers:receiving-code-review`. Not approach-level — no return to step 3 required.
  The fix shipped at `cd861e6b` and the gate was re-run GREEN after it.
- **Step 6.5 — DONE** (triage table at the top of the deviations file).
- **Step 7 — dual review.** Run `bash scripts/blast-radius.sh` first, then two parallel
  fresh agents (spec & correctness; standards & maintainability via
  `/thermo-nuclear-code-quality-review`). Both get the triaged deviations file; the spec
  agent also gets `blast-radius.md`. Full reports to `docs/reviews/<branch>/`, findings
  tables only in context. **Commit the reports + triage verdicts.** The
  `verify-gate.sh --review` run this step requires is **already done** at `cd861e6b`
  (`merge-coverage` + `diff-coverage` both PASS) — re-run it only if step 7 changes code.
- **Step 8 — SHIP, RISK=high lane.** Staging ride first, then PR to `main`, then PAUSE
  for explicit merge approval. Migrations apply staging-first, 096 then 097.

## Carried into step 8

- **`origin/staging` is 1 commit behind `origin/main`** (post-#642 fast-forward skipped).
  Fast-forward it before riding.
- **Migrations 096/097 are local-container-only today.** The log entries say so
  deliberately (075's phrasing, not 095's).
- **Add `PR #643` provenance to `CONTEXT.md`'s Suppression ledger entry at ship time** —
  the **Consent ledger** entry carries `PR #640`; #643's was left off because the PR did
  not exist yet.
- **Post-merge lab-notes promotions** (deviations file has the full text): the
  `test:db:setup`-races-the-parallel-gate mechanism; "never write a fallow suppression
  from a prediction — a live-DB suite that exercises the export prevents `unused-export`
  ever firing"; and estimating `estimated_diff_size` with production and test volume
  counted separately.
- **Document the codex-rescue task-ID issue** hit during planning: the companion reported
  no jobs recorded while the task existed only in the agent transcript; the round-2 review
  had to be re-dispatched via a direct `codex exec` CLI call.
