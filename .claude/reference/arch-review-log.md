# Architecture review log

Entropy counter for the `/feature` workflow (feature.md step 8): every merged
feature increments the counter. At **≥ 5 merges** since the last architecture
pass, the orchestrator reminds the user to schedule an architecture review
session (the user's call — never started automatically). A completed pass
resets the counter to 0 and adds a row below.

**Merges since last architecture pass: 7 — THRESHOLD EXCEEDED, a review is overdue** (#640 — #625 consent ledger, 2026-08-01; #647 — #643 suppression ledger, 2026-08-03; #654 — #644 unsubscribe opt-out, 2026-08-03; #659 — #645 manual suppression paths, 2026-08-05; #682 — #674 importReview keystone, 2026-08-05; #685+#686 — #673 import-consent schema, migrations 100+101, 2026-08-05; #689 — #675 consented-import selection, 2026-08-06)

Scope the next pass should cover: the four findings this pass opened — **#590** (gate-wiring drift: `ci:*` set spelled out in three unsynchronised places), **#591** (two worker suites forked the shared `sql` mock), **#592** (`exec` blind spot in the SQL vocabulary audits), **#593** (`solicitation_asks.evidence` discriminant enforced at read, not write) — plus whether #590's meta-audit actually closed the "checks that appear to run but exercise nothing" class, and the still-open **#581**, **#582**, **#587**.

Added by #647 (#643), for the next pass to weigh — three workflow-mechanism
findings, none blocking, all recorded in `lab-notes.md` under "2026-08-03":

- **`verify-gate.sh` does not own its DB precondition.** An intake could declare
  `pnpm test:db:setup` — which DROPs schema `public` — as a `verification_command`,
  and the gate launches those in parallel with the `test` row. It produced a fully
  spurious RED. Candidate fix: run DB provisioning serially before the fan-out, or
  reject destructive commands from `verification_commands`.
- **`migration-immutability-guard.sh` keys on the migrations-log head, not on
  "applied".** Every in-place amendment of a local-only migration is a false
  positive, and this workflow produces that shape whenever the migrations-log task
  runs before the ship lane. Candidate fix: a per-entry applied marker.
- **`reclassify` counts workflow artifacts against the implementation they
  describe.** #643 fired at 2.94× with production code at 435 lines and 37/37 files
  in-surface; 1,537 of the counted lines were the plan, deviations, intake and
  handoff. Candidate fix: exclude `docs/superpowers/plans/**`, and budget
  production and test volume as two separate estimates.

Also carried, not a code finding: the RISK=high lane's staging ride makes
`git merge --ff-only main` structurally impossible afterwards — `main` gets a
squash commit while `staging` carries a real merge, so reconciling needs a
verified-identical-trees `reset --hard` + `--force-with-lease`. This will recur on
every high-risk feature; feature.md step 8's post-merge instruction should say so.

Added by #654 (#644), for the next pass to weigh. **The staging-reconcile item above
recurred exactly as predicted** — `staging` ended 61 ahead / 1 behind after the squash
merge and needed `reset --hard origin/main` + `--force-with-lease`. Second occurrence, so
it is no longer a hypothesis; `deployment-guide.md` step 5 does document the reset, but
feature.md step 8 still says "fast-forward `staging` onto `main`", which is the instruction
that cannot work. One code finding and two workflow-mechanism findings:

- **`inject`-only suites are structurally blind to the raw request line — and one such
  blind spot was hiding a live limiter bypass for all five ingress providers.** Absolute-form
  request targets (RFC 9112 §3.2.2) resolve normally through `find-my-way` while leaving
  `request.url` absolute, defeating the decoded-path arm of the ingress-scope test; a
  mutation run reported the surviving arm as dead logic because `app.inject()` normalises
  the target and every rate-limit test in the repo goes through it. Closed for #644 with a
  real-socket test. **The pass should ask what else assumes a normalised request line** —
  signature verification, path-prefix auth checks, and the WAF-adjacent rules are the
  candidates, and none of them has a raw-socket test today.
- **`feature-cleanup.sh` silently cleans nothing when run from inside a feature worktree.**
  It derives `MAIN_ROOT` from its own cwd and then skips `[ "$WT" = "$MAIN_ROOT" ]`, so the
  worktree you are standing in — the one that just merged — is the one it cannot remove. It
  reports SKIP/KEEP rows for everything else and exits 0, which reads as success. Candidate
  fix: resolve `MAIN_ROOT` from `git worktree list`'s first entry (the real main checkout)
  rather than `rev-parse --show-toplevel`, or refuse to run from a non-main checkout.
- **feature.md step 8's post-merge sweep is described as impossible from the shipping
  session, and it is not.** #643's lab note concluded the sweep "must run from the main
  checkout AFTER `feature-cleanup.sh` removes the worktree". That route was unavailable here
  (main checkout on an unrelated branch; cleanup skips its own worktree). Parking
  `.feature/intake.json` and branching the shipping worktree off `origin/main` satisfies both
  guard rules — same checkout for containment, no intake for arming — and needs no
  launch-time env var. Candidate fix: document park-and-branch as the sanctioned route, and
  note that the branch must come off `origin/main`, since local `main` lags every squash merge.

Added by #659 (#645), for the next pass to weigh. **The staging-reconcile item is now
on its THIRD consecutive occurrence** (#647, #654, #659) — it is not a hypothesis and
not bad luck, it is what the high-RISK lane structurally produces. #659 additionally
hit the *inverse* shape: `staging` was left holding an OLDER auth tree than `main`
because a second branch rode staging mid-flight and landed on main as a squash, so
"reconcile" meant moving staging **forward**, not discarding work. feature.md step 8
still says "fast-forward `staging` onto `main`". Two workflow findings and one
code-shaped finding:

- **A refactor can blind a static security audit, and the type checker will not
  notice.** Extracting the three admin suppressions routes' shared preamble into a
  `withAal2JsonBody` wrapper typechecked, passed every route test, and turned
  `ci:admin-aal2` RED on all three routes — that audit is a file-level TEXT scan for
  `requireAdminWithAal2`, so three genuinely gated routes read as ungated. The audit
  exposes a `GATED_SHARED_HELPERS` allowlist that would have silenced it; taking it
  would have traded a greppable gate for a shorter file. **The pass should ask which
  other `ci:*` audits are text scans whose premise a legal refactor can void** —
  `ci:static-policy`, `ci:tenant-scope` and `ci:outbox-seam` are all string-matching
  audits over source, and none has a test proving it still fires after its target is
  wrapped, aliased, or re-exported.
- **`fallow` is a CI-only gate and nothing local tells you so.** `verify-gate.sh`
  runs 28 checks and not this one; CLAUDE.md says `ci:fallow` "gates nothing", which
  is true of that script but not of `fallow.yml`'s `ci:fallow:coverage`, which is a
  PR check. #645 was fully green locally through two review rounds and failed fallow
  the first time a PR existed. Candidate fix: either add fallow to `verify-gate.sh`
  or say plainly in CLAUDE.md that a green local gate does not predict the fallow
  check.
- **Local `fallow` and CI `fallow` disagree, and the local one invents findings.**
  Without `--coverage`, CRAP is estimated from export references; locally that
  reported `ContactRow` as HIGH (63.6 CRAP) while the coverage-informed CI run did
  not flag it at all. Anyone refactoring to satisfy local fallow is chasing a number
  CI does not compute. Candidate fix: make `ci:fallow` refuse to run without a
  coverage file, or label estimated findings as non-gating in the output.

Added by #682 (#674), for the next pass to weigh. **The staging-reconcile item is now
on its FOURTH consecutive occurrence** (#647, #654, #659, #682) — `staging` ended 21
ahead / 1 behind and needed the `deployment-guide.md` §5 `reset --hard origin/main` +
`--force-with-lease`. feature.md step 8 *still* says "fast-forward `staging` onto
`main`". Four occurrences is no longer a finding to weigh; it is a one-line doc fix
that keeps being deferred. Three findings, all about **checks that cannot see what
they claim to check**:

- **`describeWithDb` asserts nothing about the schema, and the convention text reads
  as though it does.** CLAUDE.md says live-DB suites "**assert** their schema
  (`assertSchemaReady`) instead of applying migrations", which is a statement about
  the *convention*; `src/__tests__/helpers/describe-with-db.ts` only gates on
  `TEST_DATABASE_POOL_URL`. #674's plan asserted the helper "handles the schema
  assertion" and shipped a suite with no assertion; the nearest precedent
  (`read.integration.test.ts`) has the same gap, so copying the neighbour propagates
  it. 32 suites do call it, so the convention is real but unenforced. **The pass
  should ask whether `ci:live-db-suites` — which already parses every live-DB suite —
  should require an `assertSchemaReady` call**, and whether the requirement should be
  checked against what the transaction under test *writes* rather than what the suite
  reads (#674 shipped a first fix asserting 071 for tables it reads, missing
  `agent_runs.parent_run_id` from 088 that the code under test writes).
- **`ci:live-db-suites` enumerates via `git ls-files` and is blind to untracked
  files, and its pass output cannot evidence otherwise.** A new suite audited before
  staging passes vacuously; and because `scripts/ci/live-db-suites-audit.ts` prints
  filenames only in its failure branch, no passing run can ever show *which* files it
  inspected. This is the #590 "checks that appear to run but exercise nothing" class,
  in a check added to close that class. Candidate fix: print the inspected count on
  success, and fail when a `*.integration.test.ts` in the working tree is untracked.
- **Plan-embedded code is a third-class citizen of every quality gate.** Three plan
  review rounds on #674 accumulated a wrong column name (`run_id` for `agent_run_id`),
  a missing assertion, a dead type cast, and a vacuous audit step — none visible to
  lint, tsc, or any test, because a plan is prose to every tool in the repo. It is
  then executed nearly verbatim by a subagent. **The pass should ask whether plans
  containing fenced `sql`/`typescript` blocks deserve any mechanical check at all** —
  even just extracting identifiers and grepping them against the migrations would have
  caught the one defect that would have stopped the keystone's only live-DB suite from
  running.

Added by #685/#686 (#673), for the next pass to weigh. **The staging-reconcile item
reached its FIFTH occurrence** (#647, #654, #659, #682, #685) — same divergence, same
`reset --hard` + `--force-with-lease`, this time additionally blocked by the harness
permission classifier so the owner ran it by hand. feature.md step 8 still says
"fast-forward". One new finding:

- **A locked intake has no channel for ticket amendments posted after its lock.**
  #670's resolution amended #673's enum to three values ~17 minutes after #673's
  intake was signed; three plan-review rounds and two branch-review rounds later,
  migration 100 shipped the four-valued CHECK to both environments, corrected same-day
  by migration 101 (#686). Every review validates against the intake — by design —
  so an amendment that only lives on the ticket is structurally invisible. **The pass
  should ask where the re-read belongs** (plan sign-off and the step-8 preflight are
  the candidates in the lab-notes entry) and whether the amendment protocol should
  REQUIRE the amending session to open a PR against the running feature's intake
  copies rather than posting a comment and hoping.

| Date | Trigger | Scope reviewed | Outcome |
|------|---------|----------------|---------|
| 2026-07-17 | baseline (log created) | — | counter initialized |
| 2026-07-24 | 8 merges ≥ 5 threshold (#508, #514–#516, #551, #554, #561, #564) | Solicitation subsystem (restraint policy, ingest lane, planned executor #543) + the reliability wave | 6 findings, no blockers. **S1** csv_ingest advisory-lock key has two independent owners (`acquireCsvIngestLock` vs the inline literal in `worker/jobs/csv-ingest/failed-hook.ts:63`) — a rename silently splits the lock and the suite stays green; export one owner. **S2** `contact_csv_uploads` terminalization written 3× (ingest.ts:343, ingest.ts:377, failed-hook.ts:75); fold into one module during #543, which adds a 4th writer to that tx. **S3** (#543, pre-build) the working-tree D4 revision creates the batch row with `built_at = NULL` and filters owner reads to built rows, but D4 still forbids a status column and an expiry poller — a build that exhausts retries is permanently invisible with nowhere to record the failure. **S4** (#543, pre-build) D2's fan-out is bounded only by `MAX_DATA_ROWS`=5,000 → ~15k inserts in one job/tx; `BATCH_CAP`=25 caps sends, not evaluations. **R1** the single-replica invariant now carries 4 load-bearing mechanisms (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1, and — new in #515 — the in-process LLM circuit breaker) with zero mechanical guard; `railway.toml` has no `numReplicas` and nothing fails if one appears. **R2** outbox enqueue seam covers 13 typed helpers vs 28 production files hand-writing `INSERT INTO job_outbox`; `ci:outbox-topics` checks only the topic literal. Tracked already, not re-raised: #555 (restraint-policy date fail-open), #565 (contacts-lane complexity). Health: maintainability 92.3, duplication 1.6%, zero scope findings in repo-wide `fallow health` (local CRAP unavailable — `coverage-final.json` dated Jul 16 predates every reviewed PR). |
| 2026-07-27 | 5 merges ≥ 5 threshold (#570, #571, #574, #575 — map-#528 completion wave; #583) + the #585/#586/#588/#589 debt sweep | map-#528 wave (run-engine executor, rival picker, Requests watch-mode, competitor delta digest), the debt sweep's four closures, and the CI/measurement surface (`ci:*` audits, fallow gate, `.claude/reference/*` allowlists) | 4 new findings, no blockers. **Carried-forward closures all confirmed.** R1 closed by #586 — `railway-replicas` rule at `scripts/ci/static-policy-audit.ts:790` + `worker/config/replica-identity.ts` wired from `worker/index.ts`/`worker/sentry.ts`; *detection without enforcement is the right posture* — Railway injects a per-replica id but no replica count, so no process can assert it is alone, and the one mechanically blockable path (config-as-code) IS blocked. #587 correctly scopes the residue. R2 closed by #588 — *verdict holds*: 15 typed helpers vs 29 files writing raw `INSERT INTO job_outbox`, and `src/lib/shared/job-outbox-status.ts` documents why a fragment seam would have been actively wrong (a bind parameter inside `ON CONFLICT … WHERE` defeats partial-index inference), so guarding the vocabulary is the correct seam. S1/S2 closed by #565 (`acquireCsvIngestLock` exported at `ingest.ts:380`; single terminal writer at `ingest.ts:394`). S3 shipped as built *with an answer* — `worker/jobs/solicitation-batch/failed-hook.ts` records an exhausted build on the run spine via `failSolicitationBatchRun`, so it is not "nowhere recorded"; not re-raised. **New: #590** (HIGH) `ci:live-db-suites` (`package.json:39`) is wired into neither `.github/workflows/ci.yml` nor `lefthook.yml` — the only one of 15 — while CLAUDE.md and #585's commit body both claim CI enforcement; the general defect is that the `ci:*` set is hand-spelled in three places with nothing forcing agreement, and `scripts/verify-gate.sh:60` already derives it correctly in the one place that does. This is the mechanism behind the #581 class (local vs gating signal divergence). **#591** (HIGH) `RankingTrackingWorker.test.ts:23` / `WeeklySummaryWorker.test.ts:34` fork the shared `createMockSql()` harness for a body-specific `jsonb_array_elements` string sniff, justified by a false claim that `vi.hoisted` cannot reach a shared helper (`worker/__tests__/helpers/mock-sql.ts:8-14` documents the async-import form; `judge-store.test.ts:3-7` uses it; 100 files consume it). **#592** (LOW) `sql-tag-scan.ts:17` omits the `exec` SqlExecutor spelling that the fragment builders now use — no violation today, expired precondition. **#593** (LOW) `solicitation_asks.evidence` discriminant enforced by a throw in `batch-view.ts:94` with no CHECK at `088:155`. Already tracked, not re-raised: #581, #582 (verified still open — `purge-stages.ts:256` deletes `contact_csv_uploads` unlocked), #587. Health: score 77 B, maintainability 92.2 (good), duplication 1.7%, 0 churn hotspots, dead files 0.3%; 14 refactoring targets (3 high), 153 high-complexity functions. Repo-wide CRAP is **not quotable** per #581 — fallow matched Istanbul coverage for only 5,665 of 24,082 functions, so unmatched functions are estimated from export references. |
