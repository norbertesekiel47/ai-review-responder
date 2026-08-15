# Architecture review log

Entropy counter for the `/feature` workflow (feature.md step 8): every merged
feature increments the counter. At **≥ 5 merges** since the last architecture
pass, the orchestrator reminds the user to schedule an architecture review
session (the user's call — never started automatically). A completed pass
resets the counter to 0 and adds a row below.

**Merges since last architecture pass: 3.**

- **PR #821** — admin invite funnel (2026-08-14). **Heavy entropy: schema +
  billing + auth in one branch.** Two migrations (**105**
  `accounts.checkout_attempt_coupon_id` + a rewrite of
  `accounts_checkout_attempt_complete_check`; **106** one analytics event name),
  one new env var (`BETA_COMP_COUPON_ID`, server-only, no `NEXT_PUBLIC_*`
  companion), one flag **re-scoped** rather than added
  (`SELF_SERVE_SIGNUP_ENABLED` now gates only anonymous account-minting), and no
  new dependency. Deletion was a first-class deliverable: the 4-section admin
  form, `pending_payment_admin_handoff`, `PendingAdminHandoffScreen`, the admin
  prefill route, and `/api/dashboard`'s hardcoded `paymentUrl` are all gone.
  New single owners worth the pass's attention: `resolveFunnelEntry`
  (`src/lib/onboarding/funnel-entry.ts`) replaced **three** disagreeing
  destination deciders, and the coupon decision now rides the immutable
  `checkout_attempt_*` snapshot rather than a live env read. Tenant-scope
  allowlist stayed at 400 (one snippet refreshed twice). **Four surface
  amendments** (D-1, D-8, D-11, D-18) — past the stated abort threshold, each
  owner-approved. `reclassify` WARN at 4.1× the production-line estimate,
  adjudicated as estimate error, not lane error (D-11).
  **For the pass:** (a) `create-business.ts` still holds two ~115-line
  near-duplicate insert paths whose 21-column order is comment-synchronized —
  deliberately deferred, filed as
  `docs/future-plans/2026-08-14-unify-create-business-insert-paths.md`, and it
  writes the rows `onboarded_by`/coupon-eligibility/cleanup-poller all read;
  (b) `businesses.onboarded_by` now carries a **fourth** meaning (comp
  eligibility) on top of provisioning attribution, trial eligibility, and the
  cleanup-poller exclusion — a step-7 adversarial finding argued for replacing it
  with a dedicated entitlement and was rejected as `non_goals[2]`, so the
  overload is knowingly retained and is the single most likely thing to bite next;
  (c) prod is gated — 105 cannot be applied where 077 has not been.
- **PR #805** — #790 response-rate period framing (2026-08-12, squash
  `db4dd4a1`). UI copy/placement only: no KPI arithmetic, query, API, migration,
  env var, flag, dependency, schema, worker, or ingestion change. Keeps response
  rate on `detected_at`; adds one shared owner-facing denominator explanation to
  the per-location and All-Locations cards; amends ADR 0019 Decision 2.
- **PR #793** — #757 Review-time anchor on the rendered dashboard (2026-08-11,
  squash `17f60e2c`). Read-path only: no migration, env var, flag, or dependency.
  Applies the ADR-0019 anchor at the rendered plug lines in
  `src/lib/dashboard/{service,aggregate-queries}.ts` and deletes Stack A
  (`src/lib/kpi/service.ts` + `GET /api/dashboard/kpis`, zero consumers);
  `kpi/types.ts` remains, `src/lib/kpi/fragments.ts` is the new single owner,
  and the tenant-scope allowlist moved 408 → 401. Follow-ups: **#789**
  (Spec 11/metric restoration), **#790 resolved by PR #805**, and **#791**
  (All-Locations combined velocity month-name sorting).

> **Answers to three of the next pass's own scope questions, observed while shipping #757 — the pass should start from these rather than re-deriving them.**
>
> - **Scope item (1) — did #757 land P1 as specified? YES, with ONE recorded reversal.** One stack, `kpi/fragments.ts` as single owner (test-pinned), Stack A deleted, `kpi/types.ts` kept. **P1 asked for FOUR fragments; only TWO were extracted** — once Stack A is deleted, `detectedAtWindowFilter` and the TTR validity filter have **zero composers** (Stack B's response rate stays literal per ADR 0019 D2, which P1 itself forbids touching, and Stack B has no duration metric). Owner-adjudicated at intake, recorded as deviation D3 and in ADR 0019. Not drift — but the pass should confirm it agrees.
> - **Scope item (2) — did the sweep-miss mechanization end the missed-increment class? NO: IT NEVER SHIPPED.** `.claude/skills/document-feature/SKILL.md` still does not mention `arch-review-log.md` in its "What to update" table (`grep -c arch-review-log` → 0), so the mandatory log row the pass prescribed does not exist. The class has now failed **three times as prose** (#712, #716, #746) and the fix that was supposed to mechanize it was never applied. This increment was written by hand from the handoff doc's step-8 checklist, not by the skill — i.e. the class is still live and the next miss is a matter of who resumes without that checklist.
> - **Scope items (2) and (4) re-observed while shipping PR #821 — both classes are still live, and both fired again.**
>   - **(2) The mechanization has now SHIPPED — PR #823, 2026-08-14.** `.claude/skills/document-feature/SKILL.md`'s "What to update" table now carries an `arch-review-log.md` row, triggered "Always, on a MERGED feature", specifying the counter increment and the entry shape; the skill also records *why* the row exists so a future editor does not tidy it away. Before that, the class had claimed four features — #712, #716, #746, and #821 (whose increment was written **by hand** from a handoff checklist, because the skill did not ask for it). The prescribed fix survived **two** architecture passes unapplied, most likely because it always fell outside the locked edit surface of whichever feature discovered it: `.claude/skills/**` was outside #821's surface, and that branch had already spent four owner-approved amendments. It took a separate docs PR to land — which is the transferable lesson. **The next pass should verify the row is still present and that increments since #821 were made by the skill rather than by hand.**
>   - **(4) The gate's phase rewind fired three more times.** Same mechanism: `verify-gate.sh` calls `set-phase gate_green` on success unconditionally, so every gate run after review completion rewinds `reviewed` → `gate_green`. During #821's step 7 it fired after the review-fix gate, after the D-13 verification gate, and after the doc-sweep gate; each was repaired by hand with `set-phase reviewed`. Running total: **seven occurrences across five features** (#675, #677 ×2, #757 ×2, #821 ×3). The repair is cheap and the failure is loud, which is exactly why it keeps being tolerated rather than fixed — but it also means `phase` is not trustworthy as a resume signal unless the resuming session re-derives it, which `feature-resume` does.
> - **Scope item (4) — did the step-8 fallow preflight and the gate's phase-write removal ship? NEITHER.** `scripts/verify-gate.sh` still excludes `ci:fallow*` (lines 7, 195) with no step-8 preflight anywhere in the feature skill; and the gate still writes `phase` unconditionally (`feature-state.sh:50` is guarded, but `verify-gate.sh` calls `set-phase gate_green` on success), so running the gate after review completion rewinds `reviewed` → `gate_green`. **That rewind fired twice more during #757's ship** — once on resume, once after the evidence commit — and both times had to be repaired by hand with `set-phase reviewed`. Now four occurrences across three features (#675, #677 ×2, #757 ×2). The fallow half caused no incident here only because the branch happened to be clean.

Prior reset by the **2026-08-10 pass** (table row below). That pass reconciled the two flagged undercounts — **#712 counts** (its sweep PR #713 was never merged), **#716 counts, weighted entropy-negative** (verified dead-column cleanup) — making the true pre-reset figure **24 (4.8×)**. Full artifacts: `docs/reviews/PATHFINDER-2026-08-10/`. The window's merge list, retained for the record: (#758 — #688 KPI Review-time anchor, 2026-08-10 — read-path KPI re-anchor, no migration/flag/env var/dependency; `reviewTimeAnchor` fragments + TTR validity filter in `src/lib/kpi/service.ts` (interface unchanged), ADR 0019, tenant-scope allowlist re-pin ×3 (baseline 408); step-7 review spawned GA-blocking **#757** — `GET /api/dashboard/kpis` has ZERO consumers and the visible dashboard aggregates (`src/lib/dashboard/`) still bucket on `detected_at`, a pre-existing gap the pass should weigh when it reconciles the KPI surface; the flagged undercount conditionals below shift again with this +1: if #712 counts the figure is 23 (4.6×), if both #712 and #716 count it is 24 (4.8×); #749 — #731 deferred maintainability bundle, 2026-08-09 — four-item behaviour-preserving maintainability bundle out of #678's step-7 review, no migration/flag/env var/dependency and no new file; `toCardRow`'s seven `isOrphan` ternaries → one dispatch to two private mappers returning `Required<Pick<ReviewsListRow, …>>` in `src/lib/past-replies/replies-view.ts` (ADR 0018 addendum), the Reviews list's two `COUNT(*)` denominators + `AVG` merged into ONE `LEFT JOIN` + `COUNT(*) FILTER` query in `src/lib/past-replies/load-replies.ts` (three snapshots → one), `peekRegenBudget` deleted from `src/lib/costs/tracker.ts` in favour of `peekRegenBudgetBatch([id])` with the D-F fail-open posture preserved, and the retired `PAST_REPLIES_VIEW_ENABLED` dropped from the publisher edit-existing-reply suite; tenant-scope allowlist 409 → 408 (two entries out, one in); `reclassify` fired on the TEST bucket after the fix round (490 vs 230, 2.13×) — step 0 re-run, lane unchanged, recorded in the deviations log; the flagged undercount conditionals below shift again with this +1: if #712 counts the figure is 22 (4.4×), if both #712 and #716 count it is 23 (4.6×); #746 — #730 owner-facing open-flag predicate consolidation, 2026-08-10 — behaviour-preserving read-path consolidation out of #678's step-7 review (#725 inventory), no migration/flag/env var/dependency and no new file; `openFlagExistsSql` added to `src/lib/moderation/held-draft.ts` as the one owner of the read-side `status = 'open'` literal, with `hasOpenFlag` re-expressed on it, and 7 inline spellings across 6 owner-facing files collapsed onto the fragment (`reviews/[reviewId]/draft-status`, `past-replies/load-replies.ts`, `dashboard/service.ts`, `dashboard/aggregate-service.ts`, `dashboard/pending-count.ts` ×2, `agents/read.ts` — the last an anti-join → `NOT EXISTS` rewrite); the 8 deliberately-distinct consumers (admin disposition/queue/badge, health-alert backlog, offboarding purge lane, the producer) were left alone by design, `purge-verification.ts` most load-bearingly — it counts ALL statuses and consolidating it onto an `'open'`-filtered predicate would have been a correctness bug, not a cleanup; **this entry was MISSED at merge** — PR #748, its own post-merge sweep, touched `lab-notes.md`, `currents.md` and `progresstracking.md` but not this file, so the counter read 20 when it should have read 21 (reconciled 2026-08-10, #710 closing PR). This is the THIRD instance of the same missed step after #712 and #716; #743 — #728 persist-boundary content-freshness gate + generation-cache provenance, 2026-08-09 — ADR 0017 implementation on the response-generation persist boundary, no migration/flag/env var/dependency; lane-independent skip-the-INSERT gate in `worker/jobs/response-generation/persist.ts` + `stale_review_content` completion reason (`OUTBOX_COMPLETION_REASON`) + `CachedGeneration.reviewContentHash` provenance binding in `src/lib/responses/generator.ts`; reclassify fired at ship (430 prod lines > 2×140, lane already heaviest — recorded in the deviations log); the flagged undercount conditionals below shift again with this +1: if #712 counts the figure is 21 (4.2×), if both #712 and #716 count it is 22 (4.4×); #741 — #727 row-state axes + action projection, 2026-08-09 — Reviews-list affordance remodel, invariant-#4-adjacent, no migration/flag/env var/dependency; six-valued `row_state` deleted for the two-axis model + Action slot in `src/lib/past-replies/replies-view.ts`, ADR 0018, shared `ReplyPanel` extraction in `PastReplyCard.tsx`; the flagged undercount conditionals below shift again with this +1: if #712 counts the figure is 20 (4.0×), if both #712 and #716 count it is 21 (4.2×); #735 — #726 legacy Past Replies hold gates, 2026-08-09 — invariant-#4 approval-path change, no migration/flag/env var/dependency; 4 route-handler gates + 2 tenant-scope sqlSnippet updates (baseline unchanged at 409); the flagged undercount conditionals below shift with this +1: if #712 counts the figure is 19 (3.8×), if both #712 and #716 count it is 20 (4.0×); #733 — #729 Generate transaction extraction, 2026-08-09 — behaviour-preserving refactor, no migration/flag/env var, no new dependency; route→module move (`src/lib/reviews/on-demand-generate.ts`), tenant-scope allowlist −3 entries (baseline 409), one-line `statusArraySql` widening; #720 — #706 live-DB helper scan, 2026-08-08 — CI/test tooling, no runtime surface, no migration/flag/env var, one CI script plus its test file; #714 — #695 import consent enforcement locus + durable block reason, 2026-08-08 — worker + outbox seam, no migration/flag/env var, ADR 0016 + one generalized writer; #708 — #697 import consent analytics sink, 2026-08-08 — observability only, no migration/flag/env var, one catch block; #705 — #694 live-DB DDL detector, 2026-08-08 — CI/test tooling, no runtime surface; #640 — #625 consent ledger, 2026-08-01; #647 — #643 suppression ledger, 2026-08-03; #654 — #644 unsubscribe opt-out, 2026-08-03; #659 — #645 manual suppression paths, 2026-08-05; #682 — #674 importReview keystone, 2026-08-05; #685+#686 — #673 import-consent schema, migrations 100+101, 2026-08-05; #689 — #675 consented-import selection, 2026-08-06; #691 — #677 import offer + decision API, 2026-08-07; #698 — #679 import consent worker guard + migration 102, 2026-08-08; #701 — #696 verify-gate row identity, 2026-08-08 — workflow tooling, no runtime surface; #702 — #672 on-demand generation cost policy, `BURST_MAX` 5→10, 2026-08-08). **Correction:** the #698 entry previously read "map #667 complete" — it is not. #698 completed the *consent enforcement* spine; the map still owes **#678** (Reviews list, now fully unblocked) and **#680** (closing cleanup migration). PR **#700** (#671 reviews list surface) is deliberately **not counted** — docs-only, zero runtime lines, so it adds no architectural entropy. **Possible undercount, flagged not absorbed (2026-08-08):** PR **#712** (#678 Reviews list + On-demand generation, merged `e447ee5b`) carries substantial runtime surface — 71 files, ~9.3k insertions across `src/lib/past-replies/`, a new `/api/dashboard/reviews/[reviewId]/generate` route, `src/lib/costs/tracker.ts` and two publisher files — yet appears in no entry above and has no post-merge sweep commit on `main`. The #695 sweep did **not** add it, to avoid double-counting if that feature's own step 8 is still pending; if it is not, the true figure is **17** and the overdue multiple is 3.4×. Whoever runs the architecture pass should reconcile this first. **Second possible undercount, flagged not absorbed (2026-08-08):** PR **#716** (#680 legacy backfill counters DROPPED, merged `7b5718c1`) appears in no entry above either. What is observable: 16 files, ~1.6k insertions; a schema change — `supabase/migrations/103_drop_legacy_backfill_counters.sql` drops four columns from `zernio_backfill_runs` and has been applied to **both** Supabase projects in lockstep; it is the declared point of no return for the Consented Review Import epic (#667), after which ADR 0015 §4's revert-only backout no longer suffices; and its own record states **zero production TypeScript changes**. Its own post-merge sweep, PR **#718** (`0b3a1d20`), touched `lab-notes.md`, `review-ingestion.md`, `currents.md` and `progresstracking.md` but **not this file**, so the omission looks like a missed step rather than a deliberate exclusion — unlike PR #700, which is recorded above as deliberately not counted. Its true architectural weight is not assessed here: a migration that only drops already-dead columns and a migration that reshapes a live contract are not the same entropy, and deciding which this is belongs to the pass, not to the counter. If #716 counts, the figure is **17** (3.4×); if both #712 and #716 count, **18** (3.6×).

Scope the NEXT pass should cover: (1) execution status of the 2026-08-10 handoffs — H2 (imported-row hash bug), H3 (STRUCTURAL_GATES, invariant #3), H4 (one-owner sweep), H5 (mechanical bundle), H6 (doc-truth) — and whether **#757** landed the one-stack KPI consolidation as specified in `03-unified-proposal.md` P1; (2) whether the sweep-miss fix (mandatory `arch-review-log.md` row in `document-feature`'s table) actually ended the missed-increment class — it failed three times as prose before being mechanized; (3) **PR #713** disposition (rebase, drop its superseded log hunk, merge the rest — it holds #678's only build record); (4) whether the step-8 fallow preflight and the gate's phase-write removal (05-process-findings §4–5) shipped; (5) the DO-NOT-UNIFY register (`03-unified-proposal.md` P4) — confirm nothing on it was "cleaned up".

> **ADJUDICATED 2026-08-10:** every "Added by" section below was weighed by the
> 2026-08-10 pass — verdicts (CLOSED / FIX / PROTOCOL / DEFER) live in
> `docs/reviews/PATHFINDER-2026-08-10/05-process-findings.md`; the FIX items are
> handoffs H2–H6 in `04-handoff-prompts.md`. Retained below as historical record
> only — do not re-weigh.

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

Added by #691 (#677), for the next pass to weigh. **The staging-reconcile item
reached its SIXTH occurrence** (#647, #654, #659, #682, #685, #691) — same
divergence, same `reset --hard` + `--force-with-lease`. feature.md step 8 still
says "fast-forward `staging` onto `main`", which **cannot** work after a squash
merge: `main` gets one new commit whose parent is the old `main`, so the branch
tip is not an ancestor and `--ff-only` always fails. This is not an
environment quirk to be re-diagnosed each ship; it is the deterministic
consequence of squash-merging, and the workflow text is simply wrong. **The pass
should decide whether step 8 says "reset `staging` to `main`" outright**, and
whether the tree-equality check (`git rev-parse origin/staging^{tree}` ==
`origin/main^{tree}`) that makes the force-push provably content-neutral belongs
in the workflow as a required precondition. Two further findings:

- **The `fallow`-outside-the-local-gate class reached its THIRD consecutive
  occurrence** (#659, #689, #691), each costing a post-open fix commit, a gate
  re-run, and — on RISK=high branches — a staging re-ride. The #689 lab note
  already prescribes running `pnpm ci:fallow` before opening the PR; prescribing
  it in lab-notes has now failed twice. **The pass should ask whether the
  step-8 preflight should RUN it** rather than document it, given
  `verify-gate.sh` deliberately excludes `ci:fallow*` and that exclusion is
  correct on its own terms. Note the clone half has a surface-budget
  interaction: fallow matches clones repo-wide, so the reported partner can sit
  outside the branch's surface and "fix it there" costs an amendment.
- **`verify-gate.sh` and the /feature workflow both own `.feature/state.json`'s
  `phase`, and the gate's write is unconditional.** Running the gate after
  review completion rewinds `reviewed` → `gate_green`, which makes a resumed
  session re-enter step 7 and open a review round against feature.md's cap on
  already-reviewed code. Hit twice in the #677 ship session. This is the mirror
  of #675's opposite trap (the phase had to be *held* at `executing`). **The
  pass should decide who owns that field** — a gate that only ever advances, a
  gate that writes `lastGreenGateSha` but never `phase`, or an explicit
  `--phase` flag.

| Date | Trigger | Scope reviewed | Outcome |
|------|---------|----------------|---------|
| 2026-07-17 | baseline (log created) | — | counter initialized |
| 2026-07-24 | 8 merges ≥ 5 threshold (#508, #514–#516, #551, #554, #561, #564) | Solicitation subsystem (restraint policy, ingest lane, planned executor #543) + the reliability wave | 6 findings, no blockers. **S1** csv_ingest advisory-lock key has two independent owners (`acquireCsvIngestLock` vs the inline literal in `worker/jobs/csv-ingest/failed-hook.ts:63`) — a rename silently splits the lock and the suite stays green; export one owner. **S2** `contact_csv_uploads` terminalization written 3× (ingest.ts:343, ingest.ts:377, failed-hook.ts:75); fold into one module during #543, which adds a 4th writer to that tx. **S3** (#543, pre-build) the working-tree D4 revision creates the batch row with `built_at = NULL` and filters owner reads to built rows, but D4 still forbids a status column and an expiry poller — a build that exhausts retries is permanently invisible with nowhere to record the failure. **S4** (#543, pre-build) D2's fan-out is bounded only by `MAX_DATA_ROWS`=5,000 → ~15k inserts in one job/tx; `BATCH_CAP`=25 caps sends, not evaluations. **R1** the single-replica invariant now carries 4 load-bearing mechanisms (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1, and — new in #515 — the in-process LLM circuit breaker) with zero mechanical guard; `railway.toml` has no `numReplicas` and nothing fails if one appears. **R2** outbox enqueue seam covers 13 typed helpers vs 28 production files hand-writing `INSERT INTO job_outbox`; `ci:outbox-topics` checks only the topic literal. Tracked already, not re-raised: #555 (restraint-policy date fail-open), #565 (contacts-lane complexity). Health: maintainability 92.3, duplication 1.6%, zero scope findings in repo-wide `fallow health` (local CRAP unavailable — `coverage-final.json` dated Jul 16 predates every reviewed PR). |
| 2026-07-27 | 5 merges ≥ 5 threshold (#570, #571, #574, #575 — map-#528 completion wave; #583) + the #585/#586/#588/#589 debt sweep | map-#528 wave (run-engine executor, rival picker, Requests watch-mode, competitor delta digest), the debt sweep's four closures, and the CI/measurement surface (`ci:*` audits, fallow gate, `.claude/reference/*` allowlists) | 4 new findings, no blockers. **Carried-forward closures all confirmed.** R1 closed by #586 — `railway-replicas` rule at `scripts/ci/static-policy-audit.ts:790` + `worker/config/replica-identity.ts` wired from `worker/index.ts`/`worker/sentry.ts`; *detection without enforcement is the right posture* — Railway injects a per-replica id but no replica count, so no process can assert it is alone, and the one mechanically blockable path (config-as-code) IS blocked. #587 correctly scopes the residue. R2 closed by #588 — *verdict holds*: 15 typed helpers vs 29 files writing raw `INSERT INTO job_outbox`, and `src/lib/shared/job-outbox-status.ts` documents why a fragment seam would have been actively wrong (a bind parameter inside `ON CONFLICT … WHERE` defeats partial-index inference), so guarding the vocabulary is the correct seam. S1/S2 closed by #565 (`acquireCsvIngestLock` exported at `ingest.ts:380`; single terminal writer at `ingest.ts:394`). S3 shipped as built *with an answer* — `worker/jobs/solicitation-batch/failed-hook.ts` records an exhausted build on the run spine via `failSolicitationBatchRun`, so it is not "nowhere recorded"; not re-raised. **New: #590** (HIGH) `ci:live-db-suites` (`package.json:39`) is wired into neither `.github/workflows/ci.yml` nor `lefthook.yml` — the only one of 15 — while CLAUDE.md and #585's commit body both claim CI enforcement; the general defect is that the `ci:*` set is hand-spelled in three places with nothing forcing agreement, and `scripts/verify-gate.sh:60` already derives it correctly in the one place that does. This is the mechanism behind the #581 class (local vs gating signal divergence). **#591** (HIGH) `RankingTrackingWorker.test.ts:23` / `WeeklySummaryWorker.test.ts:34` fork the shared `createMockSql()` harness for a body-specific `jsonb_array_elements` string sniff, justified by a false claim that `vi.hoisted` cannot reach a shared helper (`worker/__tests__/helpers/mock-sql.ts:8-14` documents the async-import form; `judge-store.test.ts:3-7` uses it; 100 files consume it). **#592** (LOW) `sql-tag-scan.ts:17` omits the `exec` SqlExecutor spelling that the fragment builders now use — no violation today, expired precondition. **#593** (LOW) `solicitation_asks.evidence` discriminant enforced by a throw in `batch-view.ts:94` with no CHECK at `088:155`. Already tracked, not re-raised: #581, #582 (verified still open — `purge-stages.ts:256` deletes `contact_csv_uploads` unlocked), #587. Health: score 77 B, maintainability 92.2 (good), duplication 1.7%, 0 churn hotspots, dead files 0.3%; 14 refactoring targets (3 high), 153 high-complexity functions. Repo-wide CRAP is **not quotable** per #581 — fallow matched Istanbul coverage for only 5,665 of 24,082 functions, so unmatched functions are estimated from export references. |
| 2026-08-10 | 24 merges ≥ 5 threshold (4.8× — reconciled from the quoted 22 by counting #712 and #716; the Consented Review Import epic #667 + maps #710, suppression #643–#645, KPI anchor #688) | Pathfinder pass over the entropy window: 7 features charted (F1 Review import, F2 Import consent, F3 On-demand generation, F4 Reviews list, F5 held-draft seam, F6 persist boundary, F7 suppression/unsubscribe — 301 flowchart nodes, every node file:line-cited), 20 within-feature + 10 cross-feature duplication findings, 11 process items adjudicated. Artifacts: `docs/reviews/PATHFINDER-2026-08-10/00-05` | **Headline: the code held its shape; the entropy was in the workflow layer.** Health 77 B → 77 B, maintainability 92.2 → 92.2, duplication 1.7% → **1.3%**, churn hotspots 0 → 0 across 24 merges — while the process layer accumulated 3 missed counter increments, 6 staging-reconcile incidents (doc-fixed pre-pass), 3 fallow-surprise PRs, 2 phase rewinds, and 1 wrong-CHECK migration from the intake-amendment gap. **KPI verdict (P1):** ONE stack — Stack B composes extracted ADR-0019 anchor fragments (`kpi/fragments.ts`) at 14 verified plug lines; `getLocation/AccountKpiSummary` + `GET /api/dashboard/kpis` DELETED (zero consumers, verified ×3); `kpi/types.ts` kept (9 importers); #757 rendered fully mechanical. **1 behavioral bug found (H2):** imported rows hash differently than live rows (`zernio-ingest-shared.ts:425-453` vs `computeContentHash`) → spurious content-changed lane on later updates. **Invariant-#3 hardening (H3):** structural auto-approval candidacy spelled ×3 with nothing forcing agreement → STRUCTURAL_GATES table. One-owner sweep (H4): `zernio://` template ×7/5 files, `review_exceptions` ON CONFLICT ×2, one JS in-flight hand-spell. Mechanical bundle (H5) + doc-truth (H6). DO-NOT-UNIFY register (P4) records 8 verified-deliberate specializations incl. the row-lock preambles and the PgBouncer-guard non-finding. Process verdicts (05): sweep-miss → mandatory log row in `document-feature`; gate stops writing `phase` (records `lastGreenGateSha`); step 8 RUNS `pnpm ci:fallow` (0.6s measured); audit self-tests for the 4 text-scan audits; `ci:live-db-suites` evidence-completeness; intake amendments become PRs against intake copies, never comments. |
