# Handoff — #643 Suppression ledger: schema + domain core

**Resume with:** `/feature-resume feat-643-suppression-ledger-core` from
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-643-suppression-ledger-core`.

**Phase:** `gate_green` (`.feature/state.json`). **Step 4 EXECUTE is complete** —
all six tasks landed, the verify gate is GREEN, and step 6.5 deviations triage is done.
**Next step:** 6 — REVIEW 0 (adversarial), which is **user-invocable only**.

> ### FIRST ACTION: re-arm
> ```bash
> cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-643-suppression-ledger-core
> bash scripts/arm-check.sh   # must print ARMED before any edit
> ```
> The worktree is NOT parked this time — the gate is green, so the session could end
> cleanly. If `arm-check.sh` does not print ARMED, STOP and report.

---

## Read these, in this order — do NOT reconstruct from any transcript

| # | Path | Why |
|---|---|---|
| 1 | `docs/superpowers/plans/feat-643-suppression-ledger-core-deviations.md` | **Start here.** The step-6.5 triage table is at the top: 33 entries, 33 ACCEPT, 0 RE-PLAN, plus the four entries flagged for the step-7 reviewers. |
| 2 | `.feature/intake.json` | The binding contract. `allowed_edit_surface`, the 19 `tests_to_add` titles (all present verbatim — `promised-tests` PASS), `rollback_plan`, `observability`. The audit copy in `docs/superpowers/plans/` is byte-identical (sha256 `5078c6d6…`). |
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

**Diff:** 37 files, 5,052 changed lines — 435 production, 207 migrations, 2,644 tests,
165 real docs, 1,537 workflow artifacts. All 37 in-surface. **Amendment budget: 1 of 2
used**, spent during planning (`scripts/ci/tenant-scope-allowlist.ts`).

**`ALLOWLIST_BASELINE` walked 410 → 413**: T2 +1 (`suppressionMatchSql`'s deliberately
unscoped `global` arm), T3 +2 (the token-scrub `UPDATE`'s `OR` + stripped subquery, same
shape as the existing `notification_deliveries` pair). T4 and T5 added none.

## Gate status — GREEN at `fe675af0`

All 32 rows PASS: lint, typecheck, whole-repo `test`, all 17 `ci:*` audits, five
`verification_commands`, all six changed integration suites, and `promised-tests`
(19/19 verbatim).

**One standing WARN, owner-approved:** `reclassify` fires at 2.77× (5,052 vs 1,800
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

- **Step 6 — REVIEW 0, adversarial (RISK=high).** User must run
  `/codex:adversarial-review` on the branch; it is not agent-invocable. Triage with
  `superpowers:receiving-code-review`. An approach-level finding may mean revisiting the
  plan, not just patching code. Re-run the gate after any change.
- **Step 6.5 — DONE** (triage table at the top of the deviations file).
- **Step 7 — dual review.** Run `bash scripts/blast-radius.sh` first, then two parallel
  fresh agents (spec & correctness; standards & maintainability via
  `/thermo-nuclear-code-quality-review`). Both get the triaged deviations file; the spec
  agent also gets `blast-radius.md`. Full reports to `docs/reviews/<branch>/`, findings
  tables only in context. **Commit the reports + triage verdicts.** Last gate run before
  this is `verify-gate.sh --review` (adds coverage + a changed-line `diff-coverage` row).
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
