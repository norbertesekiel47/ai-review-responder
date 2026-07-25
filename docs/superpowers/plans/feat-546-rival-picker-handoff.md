# Handoff — #546 rival picker (step 7 → step 8)

**Resume with:** `/feature-resume feat/546-rival-picker` from
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-546-rival-picker`.
Everything below is on disk — no prior transcript is needed.

## State

| | |
|---|---|
| Branch | `feat/546-rival-picker` (sibling worktree, not nested) |
| Phase | `reviewed` (`.feature/state.json`) |
| Enforcement | ARMED |
| Next step | **8 — SHIP**, RISK=high lane: **staging ride first**, then PR to `main`, pause for explicit merge approval |
| Amendments used | **2** — #1 migration tests, #2 tenant-scope allowlist (both owner-approved; see `surface_amendments` in the intake) |
| Plan review rounds | 3 of 3, closed at step 3 — do not reopen |
| Code review | step 7 complete, both axes, triaged and committed |

## What shipped

All five plan tasks, in order:

| Task | Commit | What |
|---|---|---|
| 1 | `9f3167b4` | Migration 089 — 3 nullable pick columns on `businesses`; `analytics_events_event_name_check` extended; 069's drift-guard narrowed and handed to 089 |
| 2 | `4ee64b34` | `src/lib/competitors/named-rival.ts` extracted from `WeeklySummaryWorker` (which shrank 596→478 lines); 3 sequential reads collapsed to ONE CTE query |
| 2b | `8518dc97` | Two `tenant-root-lookup` allowlist entries + baseline 405→407 |
| — | `1a0d5354` | Intake amendment #2 recorded in both copies |
| 3 | `b8c134bf` | `selectNamedRival` — pick honored, dropout note, source-discriminated digest copy, `competitor_delta_resolved` log line, CONTEXT.md sharpened |
| 4 | `fc2ce4f9` | `loadRivalPickerView` + `setNamedRivalPick`, owner-scoped GET/PUT route, durable `competitor_rival_picked` event |
| 5 | `470ba518` | `/settings/competitors` page + client + sidebar nav item |
| — | `6fdf5e9a` | Three test titles conformed to the intake contract verbatim; step 6.5 triage recorded |
| — | `d7559b00` | Step 7 review fixes (below) |
| — | `860402ba` | **Unrelated** owner-approved runbook doc commit (staging channels smoke test). Outside the edit surface by explicit decision — do not treat as drift. |

## Step 8 — what to do

1. **Ride staging first.** Apply migration **089 to the staging Supabase project BEFORE deploying**, then land the branch on `staging` (push auto-deploys the full stack).
   - **Hard ordering constraint:** the lane query now SELECTs `rival_place_id` / `rival_title_snapshot`, so this branch **cannot run anywhere 089 has not been applied**. Migration before deploy, not alongside.
   - 089 is NOT purely additive — it DROP/ADDs `analytics_events_event_name_check`, taking a brief ACCESS EXCLUSIVE lock and re-validating the table. `SET lock_timeout = '5s'` is in the migration.
2. **Smoke on staging:** pick a rival on `/settings/competitors`, confirm the weekly digest's Competitor Delta line names it without the `Auto-selected rival: ` prefix; clear it and confirm the prefix returns.
3. **PR to `main`**, all GitHub CI checks green, then **PAUSE for explicit merge approval**. Apply 089 to prod Supabase in lockstep at promotion.
4. After merge: `git pull --ff-only` on `main`, fast-forward `staging`, run `scripts/feature-cleanup.sh` (dry run first), then the post-merge sweep below.

## Verification status — read this before claiming green

`.feature/gate-status.json` is **RED on `test` and `diff-coverage`**, and that is a
known, owner-accepted environmental result, not an unknown. Full evidence is in the
deviations file under "Step 5 — verify gate evidence". Summary:

- **Green:** lint, typecheck, build, all 13 `ci:*` audits, `promised-tests` (all 19
  intake titles verbatim), and the dedicated `named-rival.integration` row — which
  **RAN against live Postgres, it did not SKIP**.
- **`test` red** from nondeterministic Postgres deadlocks in *unrelated* live-DB
  suites: the failing set was 13 → 5 → 4 → 6 → 2 files across runs, never the same
  twice. Many integration suites re-apply migrations and delete from the same tables
  in parallel against ONE shared test database.
- **Proof it is contention:** single-threaded (`vitest run --no-file-parallelism`)
  the suite is **782/782 files, 9568 tests, 0 failed**. Vitest ignores
  `VITEST_MAX_FORKS`/`MAX_THREADS`, so the gate cannot be serialized without
  `fileParallelism: false` in `vitest.config.ts` — a repo-wide change that belongs
  to its own ticket.
- **`diff-coverage` red only downstream** (no `coverage-final.json` when `test`
  fails). Measured directly: **478/507 added lines, 94.3%, min 80% — PASS.**
- **`reclassify` WARN**: 4835 changed lines vs a 900 estimate. Split — production
  **+1211/−161** (1.35×, inside tolerance), tests +1596, docs/CI +1801. Owner
  decision: note it, do not re-run step 0.
- To reproduce a local run, export `TEST_DATABASE_POOL_URL` **and**
  `DATABASE_POOL_URL` (both to the LOCAL test DB — `vitest.setup.ts` otherwise
  defaults the singleton to an unreachable placeholder that live-DB suites hit
  through production code paths).

## Step 7 review outcome

Two agents, both axes. Full reports + triage verdicts in `docs/reviews/feat-546-rival-picker/`.

**Fixed in `d7559b00`:**
1. **Blank-title guard on the pick-honor path** — `selectNamedRival` rejected blank
   titles nowhere, unlike every sibling path. 084 stores `title = ''` when SerpAPI
   omits a name, so a picked rival losing its name rendered a **nameless line in a
   customer-facing email**. Now falls back to the Auto-default rival with no dropout
   note (same semantics as the NULL-review-count case).
2. **`search_location` added to the write's `MAX(snapshot_date)` subquery** — it
   scoped by business+keyword only, while both read paths scope by search location too.
3. **Dead `multiLocation` prop removed** — `shouldUseMultiLocationSettings(flag,n) || n>1`
   is algebraically `n>1`, so the page advertised flag-awareness it could not have.
   Behavior unchanged and intentional; the prop was the lie.

**Deferred — valid, recorded, NOT dismissed.** Each needs its own ticket because it
is a cross-seam refactor that would breach this intake's edit surface:
- The write derives "latest pack" from `competitor_snapshots` while the reads derive
  it from `ranking_snapshots`; an **empty** latest pack makes the write's `MAX` fall
  back to the prior date and accept a pick the reads consider stale.
- The "nameable rival" rule is written three times (TS filter, TS guard, SQL
  predicate). Fix 1 re-aligned them; the triplication remains.
- Lane derivation (primary keyword + effective search location) is duplicated 3× in
  `named-rival.ts` and a 4th time in `worker/jobs/RankingTrackingWorker.ts:244-246`.
  Drift there yields zero-row joins → permanent "teaser"/"awaiting_pack" with no error.
- `requireSettingsOwner` + 3 type aliases are byte-identical to
  `settings/auto-approval/route.ts` — second use of a tenant-isolation guard, still
  un-extracted.
- `__testing` exports the decision core — effectively a second public interface,
  contradicting the module header's "callers learn three functions".

## Post-merge sweep (step 8 tail)

- **Promote to `.claude/reference/lab-notes.md`** — three durable lessons, none
  specific to this feature:
  1. **The immutable-CHECK migration-test landmine.** Whichever per-migration test
     holds the live "CHECK list ⟺ TS allowlist" assertion breaks the next time a
     value is added, because the migration it guards can never grow. Now handed
     058 → 069 → 089. It generalises beyond `analytics_events`:
     `agent_outcomes.outcome_kind` has the same shape.
  2. **Parallel shared-test-DB contention — and CI hides it.** These suites skip in
     CI because `TEST_DATABASE_POOL_URL` is unset, so the deadlocks only ever appear
     locally. That is the #520 blind spot, demonstrated repo-wide.
  3. **A blocked `UPDATE … FROM` does NOT see a concurrent committed pack.** Under
     READ COMMITTED, EvalPlanQual re-checks the *target* tuple but keeps the
     statement's original snapshot for joined tables — so a lock-blocked interleaving
     cannot test a stale-join race. Measured with a four-variant probe.
- Run `document-feature`, then a final `domain-modeling` sweep.
- Increment the merge counter in `.claude/reference/arch-review-log.md`.
