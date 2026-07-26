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

## Step 8 — progress, 2026-07-25

**Step 8.1 is DONE. Step 8.2 is BLOCKED on an owner decision about `staging` drift.**

| | |
|---|---|
| 089 → staging Supabase | ✅ **applied + verified** (`kubdiqdhqbhwmqfditeg`) |
| Branch → `staging` | ⛔ **not landed** — merge aborted, blocked (below) |
| Staging deploy | none triggered; `origin/staging` is byte-identical to before |
| PR to `main` | ✅ **open — [#574](https://github.com/RepWorth/ai-review-responder/pull/574)**, awaiting explicit merge approval |

### 8.1 — migration applied (done)

089 is on staging, verified by **schema introspection, not the ledger**: three
nullable columns on `businesses` (`text`/`text`/`timestamptz`) and
`analytics_events_event_name_check` containing `competitor_rival_picked` with
`convalidated = true`. Preflight found zero `analytics_events` rows outside the
new allowlist, so the constraint re-ADD validated clean. Applied via
`apply_migration` under the name `089_competitor_rival_pick`, matching the
ledger precedent set by `088_solicitation_batch_executor`.

This is safe to leave in place with the code un-deployed: the columns are
nullable and nothing reads them until the branch lands. It does **not** need
re-applying when the ride resumes.

### 8.2 — BLOCKER: `staging` has drifted 58 commits from `main`

`git merge --no-ff feat/546-rival-picker` into `staging` **conflicted on 8
files** (`WeeklySummaryWorker.ts`, `weekly-value-report.ts`,
`batch-builder.ts`, `solicitation-batch/index.ts` + their tests, and two plan
docs). The merge was **aborted**; both the `staging` branch and the
`staging-ride` worktree are clean and untouched.

Root cause is squash-merge drift, not a real code conflict. Measured:

- `git cherry origin/main origin/staging` → **53 commits unique to staging**, and
  every one is a pre-squash original of **#541**, **#539**, or **#543** — all
  three already merged into `main` as single squashed commits (`#564`, `#570`,
  `#571`). Same work, different SHAs, so git sees add/add collisions.
- `git diff origin/main origin/staging` → **4 insertions, 151 deletions**.
  Staging is *behind* main in content: it lacks 151 lines of late PR review
  fixes, and its 4 unique lines are superseded earlier forms of code main has
  since refactored. **Nothing on `staging` exists that `main` does not.**
- Cause: CLAUDE.md's "after promotion, fast-forward `staging` onto `main`"
  step was skipped after those three merges.

**Owner asked to stop here** rather than pick a realignment. The two paths:

1. **Reset and re-ride** (recommended): `git reset --hard origin/main` on
   `staging`, merge `feat/546-rival-picker` (conflict-free — the branch already
   contains all of `origin/main`), `git push --force-with-lease`. Yields a
   staging env equal to prod + this feature, which is what the ride should test.
   Cost: force-push rewrites `staging` history. Content-safe per the diff above.
2. **Hand-resolve** all 8 conflicts taking main's side. No force-push, but it
   preserves the drift and re-conflicts on the next ride.

Either way the drift is a **pre-existing repo issue, not caused by #546** — the
next feature to ride staging hits exactly the same wall.

### 8.3 — resume from here

1. Settle the 8.2 decision, land the branch on `staging`, let the push
   auto-deploy the full stack. (Skip 8.1 — already applied.) **PR #574 was
   opened ahead of this at the owner's explicit request, so the staging ride
   and the PR are now running out of the lane's usual order** — if #574 merges
   without a ride, the smoke test below moves to prod and 089 must be applied
   to prod *before* the deploy lands.
2. **Smoke on staging:** pick a rival on `/settings/competitors`, confirm the weekly digest's Competitor Delta line names it without the `Auto-selected rival: ` prefix; clear it and confirm the prefix returns.
3. **PR to `main`**, all GitHub CI checks green, then **PAUSE for explicit merge approval**. Apply 089 to prod Supabase in lockstep at promotion.
4. After merge: `git pull --ff-only` on `main`, fast-forward `staging`, run `scripts/feature-cleanup.sh` (dry run first), then the post-merge sweep below.

## Verification status

**The gate is GREEN, and it is green because the root cause was fixed — not
accepted.** History matters here, so both halves are recorded.

### What was red, and why

Across 8 runs the `test` row failed with a *different* set of files every time
(13 → 5 → 4 → 6 → 2 → 8), always with `deadlock detected` or a `beforeAll`/test
timeout, and **never a failed assertion**. Cause: the 45 `*.integration.test.ts`
suites share ONE test database, and several re-apply migrations and DELETE from
the same tables while running in parallel.

The clinching evidence came from this branch's own suite. In the parallel run
`named-rival.integration.test.ts` died with `deadlock detected` inside its
**teardown DELETE**, while the gate's dedicated isolated row for that exact
file **passed**. Same file, same commit, opposite results — contention, not a
defect.

### The fix (surface amendment #3, owner-approved)

`vitest.config.ts` now uses the documented Vitest `projects` recipe: a
`parallel` project excluding `*.integration.test.ts`, and an `integration`
project including them with `fileParallelism: false` and `sequence.groupOrder`
so the two groups never overlap. Verified split: **45 integration + 738
parallel = 783**, zero leakage.

This is deliberately narrower than the repo-wide `fileParallelism: false` an
earlier session proposed — that would serialize all 783 files for no benefit on
the 738 that never touch Postgres. **CI cost is zero either way**: the
integration suites skip in CI because `TEST_DATABASE_POOL_URL` is unset, which
is exactly why CI never surfaced this (the #520 blind spot, repo-wide).

One follow-on: hoisting the shared options out of `defineConfig()` widened
`jsx.runtime` from its literal to `string`, breaking `typecheck` and `build`.
Fixed with `as const` and commented in place.

### Result

`test` **PASSES**: 782 passed / 1 skipped (783 files), **9569 tests passed**,
with all 45 integration suites RUNNING against live Postgres, not skipping.
Suite duration also dropped from 333s to 119s — the deadlock retries and
10s hook timeouts are simply gone.

- **`reclassify` WARN** persists: ~6100 changed lines vs a 900 estimate. Split —
  production **+1211/−161** (1.35×, inside tolerance), the rest tests and
  docs/CI. Standing owner decision: note it, do not re-run step 0.
- To reproduce a local run, export `TEST_DATABASE_POOL_URL` **and**
  `DATABASE_POOL_URL` (both to the LOCAL test DB — `vitest.setup.ts` otherwise
  defaults the singleton to an unreachable placeholder that live-DB suites hit
  through production code paths).
- Run the gate as `scripts/verify-gate.sh --review`. Without `--review` it runs
  `pnpm test` instead of `pnpm test:coverage`, and the **`diff-coverage` row
  silently disappears** — a plain-run green covers strictly fewer checks.

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
