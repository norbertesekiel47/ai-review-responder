# Pathfinder 2026-08-15 — live-DB pins census (handoff H6)

Answers the "systemic amplifier" section of `06-guard-integrity.md`, which
proposed that correct tenant-isolation tests exist but that **no gate runs
them**, and called this "plausibly the larger of the two problems".

**Verdict: the finding is REFUTED. The gate exists and has since #244.**

CI's `test` job — a required check — stands up a `postgres:16` service
container, sets `TEST_DATABASE_POOL_URL`, applies bootstrap + every migration,
and runs the full `pnpm test`. **91 of 92 integration suites execute on every
non-docs PR.** The pins in question are gated.

What is real, and is what this handoff ships a fix for, is one level up: the
gate was **unpinned and misdocumented**. Nothing in the repo asserted that the
wiring exists, every suite degrades to a *silent skip* rather than a failure
when the database is absent, and three separate places in the tree asserted the
opposite of the truth. That stale documentation is the measured cause of the
H6 finding itself.

---

## 1. What runs where today

| Fact | Evidence |
|---|---|
| CI `test` job runs a real Postgres | `.github/workflows/ci.yml:182-195` (`services.postgres`, `image: postgres:16`) |
| …and sets the gate variable | `.github/workflows/ci.yml:196-197` `TEST_DATABASE_POOL_URL` |
| …and provisions the schema to head | `.github/workflows/ci.yml:205-206` → `.github/actions/test-db/action.yml:27-36` (bootstrap + every migration, in order) |
| …and runs the whole suite | `.github/workflows/ci.yml:211-212` `run: pnpm test` = `vitest run` = **both** vitest projects |
| `test` is a required check | `.claude/CLAUDE.md` "CI & repo"; skipped only on docs-only PRs (`ci.yml:177`) |
| `fallow.yml` stands up a **second** container | `.github/workflows/fallow.yml:45-65` — for coverage accuracy (#581), not as a gate |
| `pnpm test:integration` hard-gates **one** suite | `package.json` `test:integration` → `vitest run worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts` |

**The trap.** `pnpm test:integration` is a developer fast-path, not the CI
gate. Reading its one-suite list as CI's coverage is precisely the inference
that produced the H6 finding. CI never calls that script.

### Measured, not inferred

CI run **31926012239**'s predecessor `31907581265` (`refactor/overview-spec-alignment`,
2026-08-15), `test` job log:

```
✓ integration  src/lib/solicitation/__tests__/suppression.integration.test.ts (13 tests) 145ms
✓ integration  worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts (9 tests) 267ms
Test Files  953 passed | 1 skipped (954)
```

Parsed across the whole log: **91 integration suites ran, 1 skipped.** The
abstainer is `worker/ingress/stripe/__tests__/trial-test-clock.integration.test.ts`,
which drives Stripe's live Test Clock API and documents itself at line 16 as
"NOT a candidate for the CI gate (CI has no Stripe credentials)". Correct
exclusion, not a gap. Total skipped integration *tests* repo-wide: 5.

`suppression.integration.test.ts` — the exact suite `06` named as ungated — ran
green with 13 tests.

---

## 2. Census — 92 suites

Repo-wide: 67 under `src/`, 24 under `worker/`, 1 under `tests/`.

### 2.1 By category

| Category | Count | Gated in CI | Portable to the parallel lane? |
|---|---|---|---|
| `migration-shape` (DDL/constraints/indexes) | 25 | yes | **No — impossible.** The subject IS the database |
| `concurrency-locking` (`FOR UPDATE`, advisory locks, races) | 12 | yes | Partially — ordering is text-pinnable, serialization is not |
| `approval-path` (#3/#4 — judge, veto, auto-approval, suspension) | 8 | yes | Mostly — the repo already does this |
| `ordering-precedence` | 4 | yes | Yes, as SQL-text pins |
| `tenant-isolation` (#8) | 1 | yes | Yes — already done (see M3/M4) |
| `other` | 42 | yes (41) | Case by case |

**22 of the 25 migration-shape suites have no unit sibling at all.** They are
the sole verification that a migration's DDL landed, and no mock can replace
them. This is the single strongest argument for protecting the *lane* rather
than porting individual pins.

### 2.2 Exclusive pins — mutation-proven

Method per `06`: break the guard in production code, run the **full 862-file
`parallel` project** (48s, 11,340 tests), record whether it stayed green,
restore byte-exact. Green ⇒ the pin lives only in the integration lane.

| # | Suite | Exclusive pin (`file:line`) | Protects | Mutation | Parallel project | Owning integration suite | Severity if the lane un-gated |
|---|---|---|---|---|---|---|---|
| M1 | `src/lib/solicitation/__tests__/suppression.integration.test.ts` | `src/lib/solicitation/suppression.ts:90` `ORDER BY (s.scope = 'global') DESC` | Global-wins precedence (spec G3). A global opt-out must outrank an account row, or an owner clears the account row, watches the contact stay suppressed, and cannot see why | dropped the `(s.scope = 'global') DESC` tier | **SURVIVED** (green) | **KILLED** — 2 failed / 11 passed | **High** — silent statutory-opt-out mis-report |
| M2 | same | `src/lib/solicitation/suppression.ts:88` `s.account_id = ${accountId}::uuid` | Invariant #8 tenant scope on the suppression lookup | replaced with `${accountId}::uuid IS NOT NULL` | **SURVIVED** (green) | **KILLED** — 2 failed / 11 passed | **High** — cross-tenant suppression read |
| M7 | `src/lib/reviews/__tests__/import-offer-view.integration.test.ts` | `src/lib/reviews/import-offer-view.ts:153` `ORDER BY jo.created_at DESC` | Newest-run precedence in the import-offer read model; a stale run from a previous import would otherwise decide the offer state | dropped the `ORDER BY` | **SURVIVED** (green) | not re-run locally (suite skips — see §3.1) | Medium — wrong Import offer shown |

The M1/M2 evidence is **two-sided**: the 862-file parallel project stays green,
*and* the owning integration suite goes red. That is what makes "exclusive"
a measurement rather than an absence of evidence.

### 2.3 Correctly killed by the parallel lane — 5 mutations

The negative results bound the problem, and they matter: they show the repo
*already* applies "port the pin to a mock-sql text assertion" widely and well.

| # | Guard | Killed by |
|---|---|---|
| M3 | `src/lib/db/account-guard.ts:208` cross-account mismatch (#8) | `src/lib/db/__tests__/account-guard.test.ts` |
| M4 | `src/lib/locations/update-display-label.ts:41` `AND account_id =` on the UPDATE (#8) | `src/lib/locations/__tests__/display-label.test.ts` |
| M5 | `worker/jobs/publisher/veto-window-gate.ts:101` `ORDER BY aal.created_at DESC` | `veto-window-gate.test.ts` (6 tests) |
| M6 | `worker/jobs/response-generation/persist.ts:368` `FOR UPDATE` on the review row | `persist.test.ts` — *"locks the review row FOR UPDATE as the FIRST tx statement"* |
| M8 | `worker/jobs/publisher/veto-window-gate.ts:99` `AND aal.business_id =` (#8) | `veto-window-gate.test.ts` + `live-db-suites-audit.test.ts` |

**The top-ranked category came back clean.** Both tenant-isolation guards
(M3, M4) and both approval-path guards (M5, M8) are pinned in the parallel
lane. 5 of 8 mutations killed; the 3 survivors are ordering/precedence and one
tenant scope inside a solicitation read.

### 2.4 What was not checked

- 8 mutations, not 92. Sampling was ranked as instructed: tenant-isolation and
  approval-path first, ordering next. The `other` bucket (42 suites) was
  categorized but not mutation-swept.
- The 25 migration-shape suites were **not** mutated. Mutating them means
  editing a shipped migration; their exclusivity is structural and needs no
  proof — nothing else in the repo reads the live schema.
- `e2e/` Playwright specs are out of scope (separate lane, separate workflow).

---

## 3. DB-awake interaction

`pnpm test` with the local test DB reachable: **exit 0.**

```
Test Files  907 passed | 47 skipped (954)
     Tests  11753 passed | 330 skipped (12083)
```

No `#520`/import-time-singleton breakage. `REPWORTH_DISABLE_LIVE_DB_SUITES=1`
was **not** needed, so every fix option stayed on the table.

### 3.1 Local ≠ CI, and CI is the stronger lane

`npx vitest run --project integration` locally: **45 passed, 47 skipped (92).**
CI runs **91**. The difference is not a repo defect — CI provisions the schema
to head on every run (`.github/actions/test-db`), whereas a developer's local
test database is at whatever migration it was last provisioned to, and suites
whose required migration is missing skip rather than run.

Two consequences worth knowing:

- **A local integration run is not evidence about CI coverage.** Half the lane
  can be asleep on a laptop while all of it runs on the PR. Run
  `pnpm test:db:setup` before drawing any conclusion from a local integration
  pass — and read the *test count*, not the colour.
- This is the same "a skip and a pass look identical" hazard already recorded in
  lab-notes for direct `vitest run` invocations. It applies to the whole lane,
  not just to one file.

Note `autopilot-entitlement-concurrency.integration.test.ts`, flagged red at
baseline in `06`, passed here — this worktree's `.env.local` carries both
`TEST_DATABASE_POOL_URL` and a reachable `DATABASE_POOL_URL`, which is the
documented cause of that failure (lab-notes 2026-08-09). Not a regression, and
it did not contaminate any verdict: every mutation verdict above is a diff
against the same 862-file parallel baseline.

---

## 4. The real defect, and the fix

The three options in the handoff all address "the suites do not run". They do
run, so none of them is the right fix.

What is actually broken:

1. **The gate is unpinned.** Deleting four lines of YAML from `ci.yml`'s `test`
   job un-gates all 92 suites *and leaves CI green*, because `describeWithDb`
   registers `describe.skip` rather than failing when the DB is absent. That is
   the #520 failure mode, one config edit away, on a lane that is the sole
   coverage of 22 migrations.
2. **The gate was misdocumented, and it cost something measurable.**
   `vitest.config.ts:11-15` asserted "the integration suites self-skip there
   because `TEST_DATABASE_POOL_URL` is unset" — true before the service
   container, false after. Two prior reviews caught it
   (`docs/reviews/feat-643-suppression-ledger-core/step7-standards-maintainability.md:118,291`
   and `step7-spec-correctness.md:205-206,553`, the latter explicitly: *"False
   since…"*) and both deferred the correction to "whenever that file is next
   touched". It was never touched. The Pathfinder pass then read it, trusted
   it, and filed H6.

### Shipped

- **`src/__tests__/ci-audit-wiring.test.ts`** — a new `describe('live-DB lane
  is gated in CI')` block pinning the four load-bearing facts (postgres
  service, `TEST_DATABASE_POOL_URL`, the `test-db` provisioning step, `run:
  pnpm test`), plus that `pnpm test` is exactly `vitest run` with no
  `--project` narrowing, plus a floor on the suite count. Chosen home because
  #590's block directly above it exists for the identical failure class — an
  audit present in `package.json` and wired into nothing, while CLAUDE.md
  claimed CI enforced it. **Zero new CI minutes**: it is a unit test inside an
  already-required job.
  - Guard verified to fail on all four un-gating edits: removing the service
    image, removing the env var, replacing the `test-db` step, and narrowing
    `pnpm test` to `--project parallel`. Each produced `1 failed | 61 passed`.
- **`vitest.config.ts`** — the stale comment corrected, with the counts
  refreshed (45→92 suites, 738→862 parallel files) and a note recording why it
  is worth keeping honest.
- **`.claude/CLAUDE.md`** — the two lines that reinforced the false reading
  (dev-commands line 13, gotcha line 211) rewritten to state that `pnpm test`
  is the gate and `pnpm test:integration` is not.
- **`tests/__tests__/seed-multi-location.integration.test.ts:24-25`** — same
  stale "unset in CI" claim, corrected.
- **`scripts/ci/live-db-suites-audit.ts`** — `ci-audit-wiring.test.ts` added to
  the existing `NOT_LIVE_DB` allowlist. The audit's R1 detector is a text match
  on `TEST_DATABASE_POOL_URL`, and the new guard necessarily *names* that
  variable to assert ci.yml sets it, while opening no connection. This is the
  allowlist's stated purpose ("files that mention TEST_DATABASE_POOL_URL
  without connecting to it"); the alternative — renaming the guard to
  `*.integration.test.ts` — would move a DB-free file into the serialized
  project for nothing.

### Deliberately not done

- **No new CI job, no postgres service added anywhere.** Option (a) is moot —
  the container already exists in `ci.yml` and again in `fallow.yml`. Adding a
  third would add minutes to every PR for coverage that already runs.
- **No pins ported to the parallel lane** (option (b)). The three exclusive
  pins are already gated; duplicating them buys redundancy inside one job while
  adding a second place to maintain each assertion. `suppression.integration.test.ts:35-47`
  argues its own case here: ON CONFLICT inference against a real partial index
  and DB CHECK behaviour "can only be proven here, never by a type". Porting
  the ordering half while leaving the constraint half live would split one
  suite's contract across two lanes for no gain in gate coverage.
  **If a future change ever makes the CI DB conditional, revisit this** — M1,
  M2 and M7 are the three that would go dark first.

### Residual risk this fix does not cover

The guard is static. It proves the YAML *says* the database is there; it cannot
prove the container was *reachable* at run time. A service container that fails
its health check fails the job loudly, so this is bounded — but a suite whose
`describeWithDb` skips for any other reason still skips silently. The narrow
version of `06`'s original concern survives here, and an execution sentinel for
the whole lane (the #719 pattern, generalized) is the natural next step if it
ever bites.

---

## 5. Reviewer checklist

1. **Is the refutation right?** Re-run the parse: pull any recent `test` job log
   (`gh run view <id> --log --job <test-job-id>`) and count
   `✓ integration <file>` lines. Expect 91.
2. **Does the new guard actually fail?** Delete `image: postgres:16` from
   `ci.yml`'s `test` job and run
   `npx vitest run src/__tests__/ci-audit-wiring.test.ts`. Expect one failure.
   Repeat for the env var, the `test-db` step, and `run: pnpm test`.
3. **Is `06-guard-integrity.md` now wrong?** Its "systemic amplifier" section
   and its `⚠️ killed only by the integration suite` annotation both stand as
   *observations* — M1/M2 reproduce exactly — but its conclusion ("correct tests
   that no gate runs") does not. That file is uncommitted work in the parent
   checkout and was deliberately left untouched by this handoff.
