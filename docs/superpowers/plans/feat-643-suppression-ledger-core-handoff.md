# Handoff — #643 Suppression ledger: schema + domain core

**Resume with:** `/feature-resume feat-643-suppression-ledger-core` from
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-643-suppression-ledger-core`.

**Phase:** `plan_approved` (`.feature/state.json`, head `0f098cf2`). Enforcement **ARMED**.
**Next step:** 4 — EXECUTE, via `superpowers:subagent-driven-development`.
**Zero implementation exists.** Every commit so far is docs.

---

## Read these, in this order — do NOT reconstruct from any transcript

| # | Path | Why |
|---|---|---|
| 1 | `.feature/intake.json` | The binding contract. `allowed_edit_surface`, the 19 `tests_to_add` titles (matched VERBATIM by the gate), `rollback_plan`, `observability`. The audit copy in `docs/superpowers/plans/` is identical. |
| 2 | `docs/superpowers/plans/2026-08-01-suppression-ledger-core.md` | The plan. **Start with the G1–G14 decision table** — it carries every locked decision plus its rationale and the review round that produced it. Then the task graph. |
| 3 | `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` | Locked spec. Sections this ticket owns are listed in the plan header. |
| 4 | `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` | B4, B6, B9. **B9 is amended by G1** — read G1 before trusting B9's FK wording. |
| 5 | `CONTEXT.md` → "Solicitation suppression & unsubscribe" | Glossary. Use these terms verbatim in every subagent prompt, commit and test name. |

The three adversarial review verdicts are in the session scratchpad
(`plan-review-verdict{,-r2,-r3}.md`), not the repo — they are superseded by the
plan itself and are not needed to execute.

---

## State of the world

- **Branch:** `feat-643-suppression-ledger-core`, 4 commits, all docs, tree clean.
- **Worktree:** sibling, own `node_modules`, ARMED. Prefix every Bash call with
  `cd <worktree-root> &&` — the harness resets cwd between calls.
- **Test DB:** live and required. `test_ws4` on `localhost:5499`
  (`TEST_DATABASE_POOL_URL` at `.env.local:301`; line 292 is a commented-out
  empty duplicate — ignore it). Has 091 + 093, does **not** have 096/097.
  Run `pnpm test:db:setup` after the migrations land.
- **Amendments used: 1 of 2.** `scripts/ci/tenant-scope-allowlist.ts` was added
  to the surface during planning. **A second amendment trips the abort
  criteria** — if a task needs a path outside the surface, stop and surface it.
- **Migrations head is 095.** This ticket adds 096 and 097.

## Execution order (blocking edges)

```
T1 (schema 096/097 + registries) ──┬── T2 (suppression.ts) ── T4 (populate seam)
                                   └── T3 (purge retention) ── T5 (receipt count)
T2, T4, T5 ────────────────────────────── T6 (spec amendments + migrations-log)
```

T2 and T3 are independent once T1 lands and may run in parallel.

**Every subagent prompt must carry:** the CONTEXT.md glossary excerpt, the task's
plan slice, and its blocking-edge context.

**First-task enforcement spot check (mandatory):** after T1 completes, diff
`git status --porcelain` against `allowed_edit_surface`. An out-of-surface file
means the guard did not bind for subagent tool calls — STOP and report, do not
dispatch T2.

## Traps that already cost a review round

1. **`suppressionMatchSql`'s executor parameter MUST be named `db`.**
   `ci:tenant-scope` has its own `extractSqlTagNames`
   (`tenant-scope-audit.ts:711`) seeded `{sql, tx, db}` — it never imports
   `sql-tag-scan.ts`. An `exec`-tagged template is silently skipped, the
   predicted violation never fires, and the allowlist entry then fails the
   unused-entry check. `primaryTrackedKeywordSql` uses `exec` and has the same
   blind spot — it is not a counter-example.
2. **Run `pnpm ci:tenant-scope` and read the REAL finding** before writing the
   allowlist entry. Do not pre-write it from the plan's prediction. Bump
   `ALLOWLIST_BASELINE` in the same change.
3. **`enqueueAnalyticsEvent` lives in `src/lib/analytics/enqueue.ts:20`**, not
   `analytics/events.ts` (that module owns the name allowlist only).
4. **The fallow marker must sit alone on the line directly above the
   declaration** — rationale goes above the marker. Copy
   `src/lib/config/worker.ts:265-266`.
5. **Neither migration suite may re-apply DDL.** 096 = introspection (modelled
   on 093/095), 097 = SQL-text inspection (modelled on 094).
   `live-db-suites-audit.ts` is OUTSIDE the edit surface, so a suite needing an
   allowlist entry cannot ship here.
6. **Delete suppression fixtures BEFORE `cleanupTenantAccount`** in every
   live-DB suite — `solicitation_suppressions.account_id` is a NO-ACTION FK to
   `accounts` and the helper deletes accounts directly.
7. **Copy 094's `IN (...)` list verbatim** into 097. Guessing it silently drops
   existing event names, and `ci:analytics-events` will not catch it.

## Gate

`bash scripts/verify-gate.sh` (`--review` for the last run before step 7). It
runs lint, typecheck, tests, every `ci:*` except `ci:fallow*`, the changed
integration suites, and the verbatim `promised-tests` check. **`pnpm ci:fallow`
is separate** and will flag `recordSuppression` as an unused export until its
justified suppression is in place (T2 Step 5).

Two intake test titles say `isSuppressed`, which G7 removed. **Keep them
verbatim** — user-confirmed. They exercise `suppressionMatchSql`; the behavior
they name is unchanged.

## Ship lane (step 8) — RISK=high

Staging ride first, then PR to `main`, then pause for explicit merge approval.
**`origin/staging` is 1 commit behind `origin/main`** (the post-#642
fast-forward was skipped) — fast-forward it before riding.
