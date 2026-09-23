# Current Implementation Map

This file explains what is actually built in the repository today, how it maps to the implementation plan, and what is left to build.

> **State map — newest at the top.** Plain-English per-feature summaries of what is
> true now. This is NOT a build log (that's [progresstracking.md](progresstracking.md))
> and NOT a file inventory (that's `.claude/reference/` + [docs/directory.md](directory.md)).
> Older snapshots are archived — see the pointer further down.
> - [progress-archive/currents-history-2026-04-to-05.md](progress-archive/currents-history-2026-04-to-05.md) — pre-2026-05 (the three "Every File In The Project" dumps, April-era feature deep-dives, the stale "What's Left To Build" fossil).
> - [progress-archive/currents-history-2026-05-to-2026-08-14.md](progress-archive/currents-history-2026-05-to-2026-08-14.md) — 2026-05-22 → 2026-08-15 (billing/locations UX through the Architecture pass).
> - [progress-archive/currents-history-2026-08-16-to-18.md](progress-archive/currents-history-2026-08-16-to-18.md) — 2026-08-16 → 2026-08-18 (the executed Architecture pass through the admin Halt latch surface).

Last updated: 2026-09-22 (six single-owner cleanups merged — approval-lane transitions, one outreach INSERT, one cancellation-grace day count, shared drip/nudge send strategies, execution-based RLS guards, rule 16 pinned cell-for-cell; follow-ups #1447, #1454, #1455).

## Quick summary — six single-owner cleanups: approval transitions, outreach insert, grace window, send strategies, RLS guards, rule 16 (2026-09-22, PRs #1448–#1453)

**What changed.** Six backlog tickets landed as six PRs. Nothing a user sees changed. Each PR gave one owner to something that had been written out in more than one place, or it replaced a weak test with a strong one.

**What is true now.**
- **Approval transitions (#1367).** `src/lib/approval/transitions.ts` owns the `approved` / `edited` / `superseded` UPDATE for the owner-approval lane's three modes (token, session, callback). It is not the owner for the whole repo: 14 other sites still write their own UPDATE, and unlike these three they set `updated_at`. **#1454** tracks them.
- **Outreach inserts (#1112).** `insertOutreachRenders` in `src/lib/solicitation/outreach.ts` holds the one INSERT column list for `solicitation_outreach`. `insertOutreachRender` is now a one-line call to it. `settleGenerationExhaustion` writes every hole in one statement, so the lock window drops from N+1 round trips to 2.
- **Cancellation grace (#1371).** `CANCELLATION_GRACE_DAYS` in `src/lib/shared/cancellation-grace.ts` owns the 30-day count, for the dashboard route's deadline and for `CancellationGracePoller`'s SQL. The start date still has two rules: the route falls back to `subscription_activated_at` and the poller does not. **#1455** needs an owner decision.
- **Drip and nudge sends (#1403).** `worker/jobs/send-and-record-strategies.ts` owns the two crash-after-send strategies, `sendMarkedFirst` and `sendKeyed`. The day-7 drip and the owner nudge use `sendMarkedFirst`; day-1 and day-30 use `sendKeyed`. Both handlers now pass fallow.
- **RLS guards (#1384).** The 035, 040 and 045 guard suites now run their migration against the live test DB and compare catalogue definitions. They no longer match migration SQL text with regexes.
- **Runbook rule 16 (#1414).** `failure-alert.test.ts` builds rule 16's four runbook cells from the emitter's exports and compares each cell by exact equality. Rules 1–15 and 17–18 remain open under **#1447**.

**The new shape.** `src/lib/approval/transitions.ts` · `src/lib/shared/cancellation-grace.ts` · `worker/jobs/send-and-record-strategies.ts` · `insertOutreachRenders` in `outreach.ts` · `src/lib/shared/__tests__/migration-0{35,40,45}-*.integration.test.ts`.

## Quick summary — the two sibling offboarding workers page per offboarding, and a stranded offboarding is named (2026-09-21, #1412 + #1413)

**What changed.** The RT-08 shape #1016 fixed in the purge worker — one constant Sentry message, no fingerprint, retry and terminal in ONE issue — was still standing in `TeardownWorker` and `BillingScheduleWorker`. All three now emit through one module, `worker/jobs/account-offboarding/failure-alert.ts`: `[<message>, terminal, <account_offboarding_id>]` at `error`, the shared `[<message>, retry]` at `warning`, alert AFTER the durable marks, a Sentry throw swallowed. Runbook **rules 17 and 18** join rule 16 and `failure-alert.test.ts` pins all three rows to the exported constants.

**What is true now.** The three purge paths #1413 named have a signal. A not-found dispatch alerts as terminal under the id it was dispatched for (all three workers). A throw from `loadPurgeOffboarding` is caught by its own try; on the exhausted attempt it marks `failed` / `failed_step='purge'` by the payload's ids and alerts. A watchdog terminalization still runs no handler — the offboarding stays `purge_scheduled` with `purge_started_at` set — so `checkStrandedAccountOffboardings` runs last in the health poller and raises one `account_offboarding_stranded:<id>` finding per offboarding whose newest offboarding outbox row is `failed` while the offboarding is neither terminal nor `failed`. **Rules 1, 16, 17 and 18 are all written and unconfigured**: nothing pages until an operator builds them. **#1411** (no re-run for a terminally failed purge) and **#1414** (a machine-readable rule record instead of a regex over prose) stay open.

**The new shape.** `worker/jobs/account-offboarding/failure-alert.ts` (+ `__tests__/failure-alert.test.ts`) · the three workers · `worker/background/pollers/health-alert/checks.ts` (`checkStrandedAccountOffboardings`, last, isolated) · `docs/runbooks/beta-launch-alerting.md` §1 + rules 16–18 · `scripts/ci/tenant-scope-allowlist.ts` (+1, baseline 383). No migration, flag, env var or dependency.

## Quick summary — a second MFA factor can be enrolled; abandoned unverified factors are an unmeasured risk (2026-09-21, PR #1416)

**What changed.** `useMfaEnrollment` sent the fixed friendly name `RepWorth` on every TOTP enrollment, and Supabase Auth rejects a second factor with a name the user already holds — so an admin or owner with one verified factor could not add or rotate one, behind a generic "Could not start MFA enrollment." (#1149, found on the #468 staging smoke). Now `startEnrollment` reads `listFactors()` **fresh** before it derives a name (start → cancel → start leaves an unverified factor the hook's state does not know about) and sends the first unused of `RepWorth`, `RepWorth 2`, … from the pure `nextFactorFriendlyName` in `src/lib/auth/mfa.ts`. Enrollment errors show a reason: mapped copy for `mfa_factor_name_conflict` and `too_many_enrolled_mfa_factors`, otherwise the Supabase message — except a provider message that matches the AAL2 step-up sentinel (`/sign in again/i`, owned by `SecuritySections.tsx`), which falls back to the generic text so provider text can never switch on the step-up link. Challenge, verify and unenroll stay on the server route.

**What is true now, and what is not measured.** The name conflict used to cap abandoned unverified factors at ONE per user; every start → cancel now banks another. Whether GoTrue expires them, or counts them against the enrolled-factor limit, is **not verified** — three reviewers could not establish it offline, the intake gated the PR on a staging measurement, and the owner then merged without it. **#1418 (P1)** carries the four measurements (real capacity from zero verified factors, expiry timing and trigger, recovery at capacity, blocked interval). If unverified factors do not expire, a first-time user could block their own enrollment, and the unenroll route needs AAL2. Named debt: the step-up sentinel now lives in two files, bound by a test that catches a changed pattern but not a widened one (RT-1149-F6).

**The new shape.** `src/lib/auth/mfa.ts` (`nextFactorFriendlyName`) · `src/components/auth/useMfaEnrollment.ts` · review record `docs/reviews/fix-1149-mfa-second-factor-name/` + `docs/reviews/red-team/fix-1149-mfa-second-factor-name-05137d/` (three rounds, the third owner-authorized, 0 survivors).

## Quick summary — a failed offboarding purge is now its own alert, and there is still no way to re-run one (2026-09-21, PR #1417)

Deleting an account's data can fail terminally. Until this merge that failure told nobody: `alertPurgeFailure` sent one Sentry message with no fingerprint, so an early retry `warning` and the final `error` landed in the **same Sentry issue**, and a first-seen rule could only ever fire on the retry — then stay silent for the event that actually means an unmet deletion obligation.

**What is true now.**

- The terminal arm carries the fingerprint `[account_offboarding_purge_failed, terminal, <account_offboarding_id>]` at `error`; the retry arm carries the shared `[account_offboarding_purge_failed, retry]` at `warning`. **One Sentry issue per terminally failed offboarding** — Sentry's action throttle is per issue, so a shared terminal issue would have swallowed a second account's page for the rest of the hour.
- The cost of that choice is deliberate and stated: N offboardings failing systemically open N issues and send N pages, with no aggregate ceiling. Repeats on the *same* offboarding are still throttled for 60 minutes.
- `docs/runbooks/beta-launch-alerting.md` gains **rule 16** — and it is **REQUIRED, NOT CONFIGURED, and not delivery-proven**. Nothing pages from it until an operator builds it in Sentry (staging first, read the saved rule and destination back). It joins rule 1 and rule 11 on the list of written-but-unbuilt rules.
- **There is no supported way to re-run a terminally failed purge.** `validatePurgeableOffboarding`, `AccountOffboardingPurgePoller` and `shouldTransitionToPurgeScheduled` all disqualify a `status='failed'` / `failed_step='purge'` row, and the one admin route that writes those columns leaves them untouched for it. Recovery is deliberate engineering work, tracked in **#1411**. Until it lands, treat such an account as holding **live PII**: the purge runs Stripe-redaction-first with no per-stage checkpoint, so a terminal failure before the parent tombstone stage leaves names, emails, phones and addresses in place while the auth user is already deleted.
- ~~Three paths in the same lane still raise no `terminal:true` event (**#1413**), and the sibling `TeardownWorker` / `BillingScheduleWorker` alerts carry the identical one-shared-issue shape (**#1412**).~~ Both closed the same day — see the quick summary above.
- `#612` remainder: the `csv_ingest` advisory-lock-key single-owner scan now walks `src/lib` + `worker`, so the offboarding purge lane is inside the guard.

**The new shape.** `worker/jobs/account-offboarding/PurgeWorker.ts` (two exported fingerprint constants — moved to `failure-alert.ts` by #1412) · `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` (the rule-16 pin moved to `failure-alert.test.ts` by #1412) · `src/lib/solicitation/__tests__/ingest.test.ts` · `docs/runbooks/beta-launch-alerting.md` §1 + rule 16. No migration, flag, env var, dependency or new module.

## Quick summary — every machine now needs `gitleaks` installed to push (2026-09-21, PR #1415)

A full credential set was committed at the repo root in `24353cf1` on 2026-04-06, deleted from the tree, and is permanent in git history (audit item C1). Nothing stopped a second one. Now something does — and it changes what a working developer machine is.

**What is true now.**

- **`gitleaks` is a required external tool.** `brew install gitleaks`. The new audit `ci:secret-scan` **fails closed** when the binary is absent, so the pre-push hook and every `scripts/verify-gate.sh` run hard-fail without it. `verify-gate.sh` derives its audit set from package.json's `ci:*` keys, so the row appeared in every local gate with no gate edit.
- The scan reads **commits**, not the working tree: `<base ref>..HEAD` (`origin/main` by default, `GITHUB_BASE_REF` on a PR) with `--redact` and `--diff-merges=remerge`. A secret one commit adds and a later commit removes is still caught — and so is one pasted into a merge resolution. Because it reads commits, **a later commit cannot clear a finding**; the fix is to rewrite the commit that introduced it.
- A pass is a four-way conjunction, not "the report was empty": exit 0, `[]` on stdout, gitleaks' own scanned-commit count at or above the commits that add a text line, and no git error marker on stderr. gitleaks 8.30.1 exits **0 with `[]` when its own `git log` fails**, so an empty report alone proves nothing.
- CI installs **gitleaks 8.30.1 pinned by sha256 per `runner.arch`** in the `lint` job. The local install is unpinned Homebrew — the two can drift, and the script prints both versions on its first line so the drift is visible.
- `.gitleaks.toml` adds two allowlists, both scoped `targetRules = ["generic-api-key"]`. An unscoped `[[allowlists]]` block disables **every** rule for what it matches.
- `docs/runbooks/secrets-rotation-api-keys.md` is new: it records six owner-reported rotations of 2026-09-20 and the decision **not** to scrub history. Audit C1 stays unticked — step 3 is partial, five non-LLM keys have no rotation procedure yet.

**The new shape.** `scripts/ci/secret-scan.ts` + its test (new) · `.gitleaks.toml` (new) · `package.json` `ci:secret-scan` · `lefthook.yml` pre-push · `.github/workflows/ci.yml` `lint` · `docs/runbooks/secrets-rotation-api-keys.md` (new). No npm dependency, flag, env var, migration or schema change.

## Quick summary — the two complexity hotspots are gone, by decomposition not suppression (2026-09-19, PR #1340)

Issue #616 tracked two functions `fallow` had flagged for a long time. Neither was broken; both had simply grown until nobody could read them in one sitting. They are now split, and **nothing they do changed** — no schema, no migration, no flag, no env var, no dependency, and not one pre-existing test body edited.

**What is true now.**

- `src/lib/shared/logger.ts` `emit` was cognitive 24 with a CRAP score of 106.4, which `fallow` grades **critical**. It is now assembly over six module-private helpers. Its external interface is untouched, and the exact byte string it writes is pinned by a characterization test.
- `worker/jobs/OnboardingDemoWorker.ts` `handleOnboardingDemo` was cognitive 25, cyclomatic 19, 144 lines. It is now orchestration only, at cognitive 7 / cyclomatic 8.
- Two of its steps moved out into the existing `worker/jobs/onboarding-demo/` package, which already used dependency injection: `subscription-guard.ts` and `cost-reconcile.ts`.
- `fallow health` reports **zero findings** for both functions.

**The new shape.**

| file | what it holds now |
|---|---|
| `src/lib/shared/logger.ts` | `emit` plus six private helpers; same public `createWorkerLogger` |
| `worker/jobs/OnboardingDemoWorker.ts` | the root, orchestration only |
| `worker/jobs/onboarding-demo/subscription-guard.ts` | **new** — the demo's subscription gate; takes `failTerminal` as an injected parameter |
| `worker/jobs/onboarding-demo/cost-reconcile.ts` | **new** — the two best-effort cost steps |
| `scripts/ci/tenant-scope-allowlist.ts` | three entries follow the query to its new file — same SQL, same `od.id` scoping |

**Two things a reader should know.**

1. **A signed-off intake said something false about the code, and the plan review caught it.** The intake claimed every non-completing path releases the 20¢ cost reserve. It does not: the subscription `SELECT`, `claimDemo` and `markOutboxCompleted` all sit outside the outer `try` and release nothing. The intake was narrowed to the as-built contract and pinned by a test — deliberately *not* "fixed", because changing it would be a behaviour change on a behaviour-preserving branch.
2. **This branch shipped with the `/feature` `reviewed` transition waived**, by owner decision recorded as deviation D11. That is a workflow exception, not a code compromise: two red-team findings are fixed and hand-verified but have no journaled proof, because the round that *raised* them was the last one the runner allows. The two structural causes are filed as **#1342** and **#1343**.

## Quick summary — the Release cycle stops letting a refused account starve everyone else (2026-09-19, PR #1337)

The solicitation **Release cycle**'s candidate scan takes the 50 oldest approved batches, and *then* asks whether each account may send. So an account the cycle always refuses kept its slots for the batches' whole 72-hour window, releasing nothing, while every other account waited behind it. #900 closed half of that; this closes both halves, exactly.

**What is true now.** Two arms inside the one scan statement drop an account before it can take a slot, and each drops exactly the accounts its own gate would refuse:

- **No full entitlement** (`cancelled`, `past_due`, `pending_payment`) — a correlated `NOT EXISTS` on `accounts` that binds `FULL_ACCESS_SUBSCRIPTION_STATUSES`, the array `subscriptionGrantsFullAccess` is now built on. One owner, so a `trialing` account can never be excluded by mistake.
- **At its daily cap** — the arm no longer assumes the platform default of 10. The cycle reads the configured caps once a tick, resolves each through `resolveAccountDailySendCap`, and binds the numbers into SQL, so `LEAST(configured, 10)` still exists in exactly one place: TypeScript.

A refused account's rows are untouched — still `rendered`, so paying inside the window resumes the drip. A tick that excludes everything still names the gate that stopped it, under the first gate amendment B6 lists, never two reasons for one account.

**The distinction worth keeping.** The scan's arms are a *discovery bound*: they may lag by one tick and that is safe. The per-account gates are the *authorization*: nothing downstream re-checks either dial, so they read current state. An owner lowering the cap mid-tick binds immediately. A single owner of the calculation does not require a single observation of mutable data.

**The new shape**

| File | What it does now |
|---|---|
| `src/lib/solicitation/release.ts` | Both fairness arms; `readResolvedAccountCaps` (per-tick snapshot, arm only) + `capBindArrays`; `readAccountDailySendCap` retained for the gate; second withhold count |
| `src/lib/shared/subscription-status.ts` | Exports `FULL_ACCESS_SUBSCRIPTION_STATUSES`; the predicate is implemented over it |
| `scripts/ci/tenant-scope-allowlist.ts` | +2 entries (`accounts` in the scan, `auto_approval_policies` in the caps read); baseline 380 → 382 |

**Known limit, stated rather than implied.** These arms cover *account-level* refusals only. A mid-drip `auto_policy` batch held by a failed auto condition still holds its slot until the 72-hour sweep terminalizes it, so the candidate window is not generally starvation-free. That needs a cursor or rotation and is a separate ticket.

Not shipped: no migration, no flag, no dependency, no owner-facing surface change. The lane issues one statement more per tick, by design.

## Quick summary — The alerting gaps are closed: paging is proven, not assumed (2026-09-16)

Four open items from the G.3 campaign are done. **§4.8 (stopped probe) passes on production and organically:** four missed check-ins since 09-06, the latest at 09-13T05:20Z, created `REPWORTH-PRODUCTION-3` and fired rule `3925256` 49 s later, with the Discord message owner-confirmed. The 2026-09-01 "Sentry creates no issue" verdict was true for **staging only** — and the two monitors differ in one place: staging carries a hand-set `failure_issue_threshold` and `max_runtime: 5`, production has both `null`. The rig that was edited is the broken one, so no Sentry support ticket is needed.

**§4.7 (killed worker) is unblocked and passes.** D-6 blocked it because Sentry refuses `*.railway.app`; the staging worker now answers at `worker.staging.repworth.net`, and uptime monitor `10354501` mirrors production `8341697` exactly. Stopping the worker produced failures at 14:29/14:34/14:39Z, issue `REPWORTH-STAGING-1E` at 14:39:44Z, a Discord page, and auto-recovery at 14:54:42Z after a `--from-source` restore verified at commit `35b7e8c7f`. **Measured detection budget: 13 minutes**, identical in production.

The **`endpoint:admin-mfa-gate` → Discord rule** exists as `3999385`, verified by API readback. Its documented "5 events in 10 minutes" threshold was deliberately dropped: the only available frequency filter is a cumulative counter with no interval, which would silence the first occurrences forever; the 60-minute throttle is the volume control, as on every sibling rule. **U1's server half is an accepted risk** by owner decision, and the earlier claim that the U1 probe "paged nobody" is corrected — rule `3920752` fired. Evidence: [`runbooks/evidence/2026-09-16-alerting-gap-closure-evidence.md`](runbooks/evidence/2026-09-16-alerting-gap-closure-evidence.md).

## Quick summary — Beta tester one is live in production (2026-09-16)

The first customer completed the whole journey against a real Google Business Profile, and every step was verified by query in production. The Admin app created the account and sent the invite (`/invite` 200, email delivered); the owner finished a live Stripe Checkout at **$0.00 due today** on the new **$49** Copilot founding price, with a card captured and the comp discount ending 2026-12-16, so cycle four bills $49. Google connected, the owner accepted the Import offer, and the backfill pulled **31 reviews** (13 of them with existing owner replies, stored as `posted` so we never re-reply).

A live review then drove the loop by itself: ingest → OpenAI `gpt-4o-mini` draft → approval email **sent and delivered in 2.7 s** → read-only approval page (audit row, SHA-256 token, device cookie) → **one owner-approved reply posted to Google** at 10:37:40Z with `approval_method='owner'`. 0 failed jobs, 0 held drafts, 0 Judge verdicts (correct: the Judge reviews auto-posts, and auto-approval is off). Whole-run AI spend: **$0.000168**.

Three behaviours worth knowing: imported reviews do **not** auto-draft; a draft you request by hand sends **no** email (`on-demand-generate.ts` suppresses it, which is also what excludes it from auto-posting); and the Connect banner can flash for a second after a successful connect. Evidence: [`runbooks/evidence/2026-09-16-beta-tester-one-evidence.md`](runbooks/evidence/2026-09-16-beta-tester-one-evidence.md). Still open: legal review, insurance, alerting drills §4.7/§4.8, and U1's server half.

## Quick summary — Owner Operator Run E: Restore and policy refusals (2026-09-15, #1293)

Merged as `d4a96f3205bc1061cd03f6fe0bceb0eabb546ebf` at 2026-09-15T16:39:27Z, owners can prepare receipt-derived
Restore proposals and inspect Rules timeline; explicit Apply uses current
authorization, readiness, confirmation and freshness checks. Clear override
and server-only inverse state preserve row absence and exact prior policy dials.
Closed refusal reasons persist with the winning turn and render separately from
proposals and requested capabilities. Existing settings and refusal writers
remain authoritative; no new agent framework is introduced.

**The new shape:** `src/lib/agents/operator/restore.ts` prepares inverses;
`restore-inputs.ts` validates receipt-derived state; `proposals.ts` reads
paged history; `refusals.ts` owns the closed refusal map. Existing `turns.ts`
fences completion, and the existing settings/refusal writers own mutations.

The [E evidence](runbooks/evidence/2026-09-15-owner-operator-run-e-evidence.md)
records qualified J1–J7 PASS, matched staging UI/worker deployments and completed
SQL/Auth/queue/browser cleanup. Parent ba0c65bb full-gate PASS is historical. Closed
semantic-warning diagnostics retain privacy without changing model behavior.
The original J5 failure, uncaptured J6 GET key and invalid blank J7 captures
remain disclosed. Migration 121 lockstep and alert 3993328 configuration are
verified; alert delivery is unproven. Report commit fb66d15d changes only two
reports (195 insertions / 7 deletions), with final certification CLEAR:
2,437 identities; 361 killed / 2,076 excluded; all 12 findings fixed, zero open/waived.
Round2 finalized 802 launches / 401 pairs, preserving400's target miss and401's
same-ID second-attempt kill. Required CI34962247726 passed; deploy-install
validly skipped. Optional Fallow failed on eight complexity findings/two clones.
E2E34962247838 passed 30 / 54 skipped; Doctor34962247896 passed.
The local post-report wrapper is **NOT GREEN**: four timeouts, then ten
(14,893 passed / 1,316 skipped in 1,280.09s); remaining checks stopped.
The owner [approved the bounded verification exception](reviews/codex-owner-operator-run-e/release-verification-approval.md).
Feature #1293 is merged; matched staging deployment/readiness [post-merge readback](runbooks/evidence/owner-operator-run-e-2026-09-15/postmerge-readback.json) passed on d4a96f3. `/ready` returned HTTP200 at16:49:55.515Z with PostgreSQL and both Redis connections OK; named flags are unchanged and production Operator remains UNSET. This documentation closeout publishes the remaining records; GitHub retains its PR and merge identity.
Architecture records this feature once, 2→3; the separate docs merge does not count.
D docs #1292 merged as `30896acbcb2ee127131504e531f230fcfc7e4409`, closing the
sequencing dependency. Its shortened observation remains unchanged; the pilot
owner/window remains BLOCKED-human and production Operator enablement remains
a separate human decision. The [spec §15](roadmap/2026-09-11-owner-operator.md#15-review-log)
owns the feature merge and the remaining documentation/deployment status.

## Quick summary — Owner Operator Run D: recoverable turns and checkpoint closure (2026-09-14, #1291)

Exhausted dispatches now resolve the exact bound Operator turn and outbox together. A live or contended claim keeps recoverable work; a failed transaction leaves an exhausted dispatch eligible for watchdog recovery. Healthy predecessor waits refresh only their owned dispatch while releasing the turn, then delay the same job without spending failed retries. A durable `dispatch_exhausted` result offers a new conversation instead of leaving the owner waiting indefinitely.

**The new shape:** lifecycle reconciliation in `src/lib/agents/operator/turns.ts`; dispatch/watchdog ownership in `worker/background/pollers/OutboxPoller.ts`; fenced waits in `worker/jobs/agent-turn/AgentTurnWorker.ts`; failure vocabulary in `src/lib/agents/operator/schema.ts` and Console wording in `src/app/(authenticated)/dashboard/operator/wording.ts`. Existing modules remain the owners; no migration, new flag or dependency was added.

Staging proved tone Apply affecting the next worker-generated draft, the stored secondary-location target surviving a selector change, and durable recovery at 390px and 1440px. The corrected deployed watchdog also resolved an exhausted dispatch left by rollback, followed by independent zero-residual cleanup. [Run D evidence](runbooks/evidence/2026-09-13-owner-operator-run-d-evidence.md) keeps the original campaign separate from that corrected-code check and owns post-merge deployment evidence.

Observation closed under the owner's duration amendment after **19h 50m 14.857381s**, with **24/24 completed turns**, p50 **6.838317s** and p95 **16.10373645s**. This was not a full 24-hour run. The 180s lease, 1,200s predecessor limit and 10s recheck remain. Feature #1291, squash `fb91cd2f4a3769f5ac35227cf58751720d83b381`, passed the final local gate and required CI. The campaign ran with the Operator enabled in staging. No production enablement or flag change was made. The named owner/window in spec §12.1 item 9 remains **BLOCKED-human**. Run E may resume only after this separate documentation closeout merges.

## Quick summary — Tier repricing: Copilot $79 / $49, Autopilot $149 / $99 (2026-09-14)

Owner decision 2026-09-14. `TIER_CONFIG` (`src/lib/accounts/tier-config.ts`) now reads Copilot list **$79**, founding **$49**, extra location **$79**; Autopilot list **$149**, founding **$99**, extra location **$149**. An extra location costs the full list price on every account, founding included — deliberate.

Every price surface (pricing page, plan picker, billing panel, checkout snapshot) derives from `TIER_CONFIG`; no copy hardcodes an amount. New Stripe Prices were created in both modes, and the six `STRIPE_PRICE_*` variables point at them per environment; `pnpm verify:stripe-prices` is the parity gate. `RETAINED_STRIPE_PRICE_HISTORY` stays empty on purpose: before the rotation, the owner had every customer account removed from production and staging, so no subscription references an old Price. Invariant #9a still holds for any account created from here on.

The Beta comp coupon is unchanged (100% off for 3 months), so an invited tester still checks out at $0 and moves to $49 (Copilot founding) at month four.

## Quick summary — Owner Operator Run C: policy proposals and measured consequences (2026-09-13, #1278)

The Operator now prepares auto-reply scope, veto-window and daily-cap changes alongside the four voice operations. Console (Harbor) cards show the full effective rules, inherited or overridden scope, confirmation requirements and server-calculated 30-day consequences. Apply uses the existing policy writer inside one transaction, rechecks authorization and both policy versions, and saves the actual before/after state, consequence window, exclusions and retained-veto count in its receipt. The [Operator directory](directory/lib-owner-operator.md) maps those modules; provider contracts live in `src/lib/llm/`.

Only confirmed-live reviews enter historical estimates; imported reviews and unknown provenance are shown separately. Initial ingestion records provenance on the existing run spine without relabeling older reviews. Registered structured tasks now deliver their JSON schema to the providers. These changes add no Apply-triggered generation or posting.

The reviewed candidate passed the full local gate and the corrected pre-merge staging journey: ten-review arithmetic, account-default contraction, same-receipt replay, Cafe clarification and weekend capability capture. [Deployment and cleanup evidence](runbooks/evidence/2026-09-13-owner-operator-run-c-evidence.md) records the earlier failed attempt separately. Release reference: #1278, `280d1b0137f4f5a3e2cd613abe7464238d0f665e`. Both staging deployments match that squash; the fresh mobile Apply and desktop receipt reload passed with old/new eligibility5/0of8, one audit and all25cleanup checks zero.

The Operator remains enabled in staging and disabled in production. Staging auto-approval remains disabled; the contraction worked without enabling it. The retained-veto alert is configured in staging, with live delivery untested. §12.1's traffic/owner-dependent items and the COO-recorded owner pilot remain open; the [blank observation template](runbooks/owner-operator-pilot-observation-template.md) leaves owner and window to the founder. Runs D and E are separate follow-ups.

## Quick summary — Owner Operator T8: LIVE on staging, first live turn fixed, §12.1 checkpoint recorded (2026-09-13, #1276)

`OWNER_OPERATOR_ENABLED=true` on staging on both lanes since 03:04Z (Railway worker + the Vercel `staging` Custom Environment); **production stays off**. Sentry rule 11 (`subsystem:worker_job` AND `queue:agent_turn` → Discord) exists in both projects: staging `3984512`, production `3984518`.

**What the first live turn taught.** It failed `model_output_invalid` on both pinned models: the LLM seam declares no output schema to any provider and validates only after the completion arrives, and the Operator prompt said "the declared schema" without declaring one. Fixed the same hour: the system prompt spells `OperatorModelOutputSchema` (prompt `2026-09-13.1`) and every proposable's `inputShape` rides its `allowedOperations` entry; `prompt.test.ts` and `catalog.test.ts` pin both to the schema. Two open follow-ups in spec §14: hand the schema to the provider per task (`response_format` / tool input) so the shape is a provider guarantee, and give the keyless eval harness one live case per structured task.

**Checkpoint (§12.1, in the spec).** Driven on staging after the fix: a tone Proposal → Apply → accurate Receipt with `businesses.tone` read back; reload resumes the turn, repeat Apply returns the same Receipt, resend returns the same ids; a concurrent settings write → `stale` with Refresh plan, an unknown id → 404, a bumped contract → `contract_changed`. Five completed turns: p50 8.38 s, p95 9.5 s (3 to 5 s of it the outbox poller's claim wait). Constants unchanged with the floors recorded. Waiting on review traffic, a second location and the owner: the next-draft tone check, the secondary-location turn, the COO-roster owner. The auto-approval Apply path is estimated in §13 (14–16 h). Red-team RT-B8 is closed.

**The new shape:** unchanged from Run B, plus `src/lib/agents/operator/__tests__/prompt.test.ts` and the `inputShape` field on every proposable in `catalog.ts`.

## Quick summary — Owner Operator Run B MERGED: Apply, Decline, receipts, the Operator screen — flag still off everywhere (2026-09-13, #1273)

Run B landed on `main` as squash `34857b73b` (02:13Z) after a staging ride at `f96b1a879` proved build and boot with the flag off (Railway worker `/ready` green on Postgres, queue Redis and cache Redis; Vercel staging READY). `staging` was realigned to `main`. No migration, no new dependency, no env var. `OWNER_OPERATOR_ENABLED` is still off in every environment: the server page answers `notFound()`, the routes 404 `operator_disabled` before any write, and the nav entry does not render.

**What an owner gets when the flag turns on.** The **Operator screen** at `/dashboard/operator` (Console/Harbor, inside the authenticated shell). A message posts an **Operator turn** against the location frozen at POST; the screen polls with back-off (2 s → 5 s after 30 s) under an independent 4-minute deadline, and a lost POST response retries the identical submission. Every card is rendered from a STORED row: the **Proposal** card shows the exact before/after of the five voice fields and offers Apply and Not now; `applyProposal` runs one lock-before-check transaction (the `businesses` row, then the proposal; contract version refused before any lock; actor, subscription, offboarding and tier revalidated under the locks; the three-way **Version token** compare text to text) and writes the server-owned **Receipt** in the same transaction — a repeat Apply returns the stored Receipt and executes nothing. A `stale` or `contract_changed` card offers **Refresh plan**, a new turn from the Proposal's original `owner_text`. A **Requested capability** card has no button, by type. The summary panel reads Run A's granular helpers, not the dashboard DTOs (the architecture pass refuted the "reuse" default, H1-D). One `hasImpersonationCookie` and one operator gate (`src/app/api/operator/gate.ts`) serve the three mutation routes; `/api/operator` rides the owner-API AAL2 allowlist.

**The new shape:** `src/lib/agents/operator/{apply,version-token}.ts` · `src/app/api/operator/gate.ts` + `proposals/[id]/{apply,decline}/route.ts` · `src/app/(authenticated)/dashboard/operator/` (page, `OperatorClient`, `ProposalCard`, `ReceiptView`, `SummaryPanel`, `TurnBody`, the hooks `useOperatorConversation` / `useTurnPoll` / `useProposalWrites`, `wording.ts`, `operator.css`) · `src/lib/admin/impersonation/cookie.ts` · glossary terms **Receipt** and **Refresh plan** in `docs/context/owner-operator.md` · e2e `e2e/operator.spec.ts` (self-skips without the auth harness).

**How it was verified.** Plan locked after three Codex rounds; a four-axis review wave (30 findings fixed, 4 rejected with evidence); a red-team run that closed CLEAR and was then preserved as history when two CI fixes (`fallow`, React Doctor) changed production files after the close; a FRESH three-round red-team run over those fixes — 88 rows, 62 killed, one P0 (the Receipt's `before` was unmeasured) and three P1 fixed, two owner authorizations recorded verbatim — CLEAR at `e11aeceda`. Browser evidence at 390 and 1440 for nine states on a throwaway local Supabase stack.

**Still owed before any flag flip (the T8 follow-up PR):** Sentry rule 11 (`subsystem:worker_job` AND `queue:agent_turn` → Discord) in both projects — NOT BUILT; the staging flip through the `flag-flip` skill; p50/p95 of `completed_at - created_at` on staging; the constants tune; spec §12.1 and §15; the open red-team P2 RT-B8 (the refetch on a second message in an adopted conversation has no discriminating test). Spec §14 keeps the two Run A open items (OutboxPoller stranded turn CA1, the predecessor-wait clock CA4).

## Quick summary — Owner Operator Run A MERGED, flag still off everywhere (2026-09-12, #1270)

Run A landed on `main` as squash `d8e3f334f`. Migration 120 is on BOTH Supabase projects (staging 2026-09-12 morning, production at promotion the same day, introspection-verified byte-identical). `staging` was realigned to `main`. `OWNER_OPERATOR_ENABLED` is off in every environment: the routes 404 `operator_disabled`, the `agent_turn` lane fails a dispatched turn with that reason, nothing posts, no executor exists.

**What changed after the review wave.** A fresh red-team run (three rounds) found and closed one real oracle gap — the **Turn claim** lease that stops a second paid model call had no test; the race test now asserts exactly one model call and one billed cost, and a direct `claimTurn` case proves a second claim inside the lease gets nothing — plus two untested branches (`allowedOperations` gate, `budget_exceeded` terminal) and the `agent_turn` alert path: the topic joined `checkFailedOutboxByTopic`'s closed allowlist (the #628 class), the job-failure-sink signal `subsystem:worker_job` + `queue:agent_turn` has runbook rule 11 (**Sentry rule not yet built — required before the flag flips**), and spec §14 states what is and is not alerted. Red-team status CLEAR as a *scope* claim: 237 inventory rows were never mutation-tested and the sidecar says so.

**The new shape (unchanged from the pre-merge summary below):** `supabase/migrations/120_owner_operator.sql` · `src/lib/agents/operator/` · `worker/jobs/agent-turn/` · `src/app/api/operator/{turns,turns/[id],conversation}/route.ts` · `src/lib/responses/voice-settings.ts` · glossary `docs/context/owner-operator.md` · review record `docs/reviews/feat-owner-operator-run-a/` + `docs/reviews/red-team/feat-owner-operator-run-a-b83a4f/`.

**Owed to Run B's first docs commit:** red-team P2-4 (the runbook triage step reaches the turn through `outbox_id`, not `turn_id`) and the rule-11 Sentry build.

## Quick summary — Owner Operator Run A: the turn pipeline, flag off everywhere (2026-09-11)

The **Owner Operator** — the conversational surface an owner will use to configure RepWorth by talking — exists end to end as a *pipeline*, behind `OWNER_OPERATOR_ENABLED` (server-only, default off, unset in every environment). Spec of record: [`docs/roadmap/2026-09-11-owner-operator.md`](roadmap/2026-09-11-owner-operator.md); glossary: [`docs/context/owner-operator.md`](context/owner-operator.md).

**What Run A built.** Migration 120's four tables (`agent_conversations`, `agent_turns`, `agent_proposals`, `agent_unsupported_requests`) with deny-all RLS and a hard-delete offboarding disposition. The `agent_turn` outbox topic, queue and typed enqueue helper. A POST route that creates an **Operator turn** and its outbox row in one transaction, plus two account-scoped owner reads. `AgentTurnWorker`, which claims the turn on a 180-second lease, waits for its predecessor with `moveToDelayed` (a wait, not a retry), re-authorizes actor, subscription posture and location from the database, builds a **Context snapshot**, makes one cost-guarded `owner_operator` LLM call, and writes reply segments, **Proposals** and **Requested capabilities** in one **Fenced completion**. The operation catalog registers three reads, four voice proposables and one capture. `src/lib/responses/voice-settings.ts` is now the single transactional writer for a location's voice fields, shared by the settings route and the Operator, with `highlight_facts` in the column map.

**What it deliberately does not do.** Nothing applies. There is no screen, no Apply, no Decline, no receipt, no consequence line, no executor, and none of the three auto-approval operations — so `requires_confirmation` is always false in Run A, because no registered operation widens autonomy. A **Proposal** is a stored row; nothing reaches Google and no `auto_approval_policies` row moves. Those are Run B.

**Two properties worth knowing before touching it.** The snapshot has no *field* that could hold review text, response text or a reviewer name — `sampleResponses` is excluded by type, not by filter — and a pasted review in an owner message is scrubbed on the read path while the stored `owner_text` stays intact. And a zero-row fenced UPDATE means the lease was lost: discard the model output and exit, never retry and never touch the outbox row.

**Flipping it.** Migration 120 must be applied in that environment FIRST — `runContentPurgeStage` names the four tables unconditionally and raises `42P01` at plan time without them — and both lanes read the flag, so it is set in Vercel AND Railway. `agent_turn` is the third flag-gated LLM lane at concurrency 1; ADR 0005's flag-on envelope moved 11 → 12 for it, and a fourth gated lane still forces the global-semaphore conversation.

## Quick summary — Admin home cutover and Overview retirement (#1192 + #1201, candidate)

The configured server-only `ADMIN_APP_URL` supplies the Admin default across login, callback, owner/onboarding redirects, both retained sidebar brand links, and the end-impersonation return. External password-login defaults use full document navigation. MFA keeps its existing local-only `next` rules: the exact `/admin` proxy route relays to the configured home only after the existing session, Admin-role and AAL2 checks, preserving refreshed cookies on the source host. No broad redirect of surviving Admin pages is introduced.

The legacy Overview page/client/tests and their navigation/file pins are removed following the owner's #1225 Page parity approval. All Admin APIs, nav-counts, remaining tranche-4 pages, shared UI and impersonation session behavior remain. The lazy URL accessor validates a configured HTTP(S) origin and never imports server configuration into shared/client auth code. Staging, production rollout authorization and browser limitations are recorded in the [cutover evidence ledger](runbooks/evidence/2026-09-11-admin-home-cutover-staging-evidence.md); this candidate is not a completed rollout.

## Quick summary — legacy business-page retirement (#1202, 2026-09-11)

The legacy business list, detail and new-business pages and their co-located tests are removed after the owner's #1226 Page parity approval and [Admin app PR #10](https://github.com/RepWorth/admin-app/pull/10) merge (`44452f060f78c691cc81188b6bbd05a6d3be82c1`). Navigation, runtime gate tests, file pins and inventory follow the smaller page set. Overview, Jobs and Autonomy preserve business facts and surviving actions while replacing retired business links with plain text and Admin app guidance; no early `ADMIN_APP_URL` read is introduced.

All API routes, shared widgets, impersonation and synthetic audit fixtures remain. The accepted port explicitly substitutes the generated Admin Disconnect endpoint for the legacy cookie endpoint (ADR 0031 D2), and adds the owner's approved exact main-app impersonation link with adjacent account ID. Port screenshots are fixture comparisons; Computer Use remains unavailable and this retirement does not claim live browser verification.

## Quick summary — legacy Security and Runbook retirement (#1200, 2026-09-11)

The legacy `/admin/security` and `/admin/runbook` pages and their page-specific tests are removed after the owner's #1224 Page parity approval and [Admin app PR #3](https://github.com/RepWorth/admin-app/pull/3) merge (`0104047b69aa774e1ebd8a4f70c6f4ef93d82fd2`). The legacy sidebar no longer links to either route. Jobs now directs operators to the runbook in the Admin app in plain text, without reading `ADMIN_APP_URL` before ADR 0029's Overview retirement batch.

The MFA and other Admin APIs, shared enrollment hooks, auth/support pages, and synthetic gate-audit fixtures remain. The unrelated past-replies empty-state assertion survives the runbook hard-pin removal. This is ADR 0031 tranche 1 under the owner's LEAN rule; #1192 and #1203 retain their separate staging and red-team requirements.

## Quick summary — selected editorial landing (2026-09-10)

The local landing route now uses the owner's chosen **F3 composition with F1's Working Atlas roadmap**, between the existing hero and night closing bookend. The courtyard fleet, original CRT agents, five job films, supervision scene and Copilot-left/Autopilot-right lever are retained. Roadmap chapters frame the bright left, darker center and clouded right of the original high-resolution map.

The final polish makes the phone agent index readable below its curved frame, adapts the sticky media to short viewports, keeps agent selection aligned with the visible paragraph, and supplies stills when original media fails. Primary CTAs retain their server-authoritative signup/early-access destination. Comparison controls are absent from `/`.

**The new shape:** `LandingExperience.tsx` composes all nine sections directly; each middle section lives in its own folder (`problem/`, `fleet/`, `personas/`, `jobs/`, `watchdogs/`, `tiers/`, `future/`) with its CSS, and `section-scopes.css` holds the two shared type scopes. Section media lives under `public/fleet/`, `public/jobs/` and `public/tiers/`. The same-day cleanup deleted the `design-*` comparison routes, the exploration component folders, their public assets, and the superseded original middle sections with their helpers (`staged`, `carousel`, `agent-flip-card`, `future-route`); a pixel comparison at eight viewports confirmed `/` unchanged. The [chosen design record](brand-asset-library/collections/2026-09-final/chosen-design.md) owns exact decisions, measurements, verification scripts and limitations. Browser checks use local Chromium and staging; backend lead submission is simulated in the design record's checks.

## Quick summary — job_outbox deny-all RLS, and the staging/prod drift closes (2026-09-07, PR #1175)

`job_outbox` — the Outbox job table, the dispatch spine every async workflow
writes through — was the **only** table of the 54 in schema `public` whose RLS
state differed between the two Supabase projects. Production had it on;
staging had it off, with the public anon key holding all eight privileges.

That was not a disclosure gap alone. `anon` held INSERT, and `OutboxPoller`
dispatches whatever rows it finds to BullMQ without asking who wrote them, so
anyone with the public staging anon key could enqueue an Outbox job of their
choosing. It also held TRUNCATE, which row-level policies do not restrain at
all.

Migration 119 closes it in both lanes: RLS enabled, zero policies,
`REVOKE ALL … FROM anon, authenticated`. The ALTER is guarded on
`relrowsecurity` so the production apply — where the flag was already set —
skipped it rather than taking `ACCESS EXCLUSIVE` on the busiest table in the
schema to write a value it already held.

**The drift is closed for the whole schema, not just this table.** One
identical query over all 54 `public` tables — RLS flags, force flags, ACLs,
policy counts — now returns the same md5 on both projects.

**Provenance.** This is migration 107's deferred half. Production was
provisioned with the Supabase `ensure_rls` DDL event trigger and acquired the
posture for free; staging was created after Supabase dropped it and never did.
107 removed the generator and left its output for a reviewed migration of its
own.

**The new shape**

| File | What it is |
|---|---|
| `supabase/migrations/119_job_outbox_rls.sql` | the migration — guarded ALTER, REVOKE, table comment, one transaction |
| `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts` | the boundary's guard. `ci:rls-audit` covers only `TENANT_TABLES`, and `job_outbox` is deliberately not a member, so this suite is the regression guard — the role 117's suite plays for `admin_audit_log` |
| `scripts/ci/live-db-suites-audit.ts` | one line: the suite joins `MIGRATION_SHAPE_FILES`, because it now EXECUTES the migration rather than parsing it |

**Why the test executes the migration.** Five independent red-team passes found
nine P0s — every one in the guard, none in the migration. A regex approximation
of a SQL lexer lost to a new construct each time. The suite now degrades the
table to the pre-119 posture, proves that vulnerable state exists, applies the
checked-in file verbatim, and diffs the catalogue across every `public` table.
PostgreSQL is the parser.

**Not done, tracked as #1176:** 21 production and 20 staging tables still hold
client-role grants behind deny-all RLS, and `anon` holds TRUNCATE on 49 of 50
tables. Inert today for the same reason production's `job_outbox` was inert —
except for TRUNCATE, which that argument does not cover.

## Quick summary — Landing "Where this is going" is a route map (2026-09-06)

Section 5 of the landing page no longer shows four "Planned" cards. It is an
interactive survey chart: a generated dark-green ground, an SVG road, and
fifteen stops — five shipped (run spine, Reply, Solicitor, Review QR, Restraint
tab) lit gold with landmark cutouts; the forward roadmap's locked Phases 1–5
dim on a dashed road; Phases 6–8 plus the two former cards the roadmap does not
name (Social media, Fake review disputes) in fog past a horizon line, on dotted
branches from Phase 5. Each stop is a button that opens a glass card with its
body; below 900px the chart becomes a vertical trail with every body visible.
Honesty devices kept: on-chart "not available yet" legend, `Phase n` / `Later`
markers beside every unbuilt name, future tense on every unbuilt body (pinned
by `FutureSection.test.tsx`). Code: `src/components/sections/landing/future/`;
assets: `public/future/roadmap-ground.jpg`, `public/future/stops/*.webp`;
design contract: `docs/brand-asset-library/design-systems/landing/DESIGN.md` § Future + `measurements.md`.
## Quick summary — Admin MFA events get an audit sink (#468, 2026-09-06; pre-merge)

Admins have `role='admin'` and no `account_id`, and `account_audit_log` requires
one — so every admin MFA event (enrollment, step-up, factor removal) was silently
dropped since the admin enrollment surface shipped (#467). Fixed by a dedicated
sink, not by relaxing the account table.

- **`admin_audit_log`** (migration 117): the admin control-plane actor trail,
  keyed on `actor_user_id`, no account column. Deny-all RLS with zero policies
  AND `REVOKE ALL … FROM anon, authenticated` (RLS filters rows, not table
  privileges). FK with no referential action: deleting a referenced admin
  fails rather than cascading the trail away. Keep forever. Not a
  `TENANT_TABLES` member; `TABLE_DISPOSITIONS` `not_applicable` (the actor is
  always an admin, never an offboarded owner).
- **`writeAdminAuditLog`** joins `writeAccountAuditLog` in `src/lib/audit/log.ts`
  — one writer per sink, both in one file.
- **The MFA route routes by role** through ONE memoised `users` lookup:
  admin → admin sink; owner with account → account sink; anything else →
  Sentry `audit_actor_unroutable`, no row. Best-effort is preserved: an audit
  failure never blocks the MFA action.
- **Enrollment is its own event.** `mfa_factor_enrolled` when the factor was
  `unverified` before `verify` (read from `user.factors`, which `getUser()`
  already returns — no second Supabase call), else `mfa_challenge_succeeded`.
  Every verify payload carries `factor_status_before`. Applies to owners too.
- **Guard:** `ci:rls-audit` only covers `TENANT_TABLES`, so the read-only live
  suite `migration-117-admin-audit-log.integration.test.ts` asserts RLS on,
  zero policies, both client roles denied all four privileges, real-writer
  persistence, and the named-FK rejections.
- Out of scope: an admin viewer (SQL only), auditing enrollment *start* (runs
  in the browser), moving other admin actions into the new sink, and
  populating `ip`/`user_agent`/`request_id` on MFA rows.


## Quick summary — Marketing pages: one system, five jobs (2026-09-06; pre-merge)

The landing, features, and how-it-works pages no longer read as a reply tool.
Each now gives comparable space to five jobs — respond, protect/govern,
request, brief, measure — under the agentic frame (one agent per job, one
permission each, every action on the run spine, two watchdogs, the autonomy
dial).

- **Landing**: a new `jobs/` ledger section between the personas and the
  watchdogs (five equal rows). Hero scope note, problem essay, persona and
  fleet cards, closing CTA, metadata, and the shared `PRODUCT_BLURB` widened
  from "Google reviews" to the five jobs.
- **Features**: 9 chapters in 3 role groups became 13 chapters in 5 job
  groups (Respond · Request · Brief · Measure · Govern). New chapters: Review
  QR, Solicitor, Dashboard (Rep Pulse formula from `REP_PULSE_WEIGHTS`),
  Restraint. Insights pairs the weekly brief with the monthly impact report.
  The group ribbon and index rows size to 1–4 chapters (`--seg-i/--seg-n`,
  `--idx-n`).
- **How it works**: the six-step pipeline stays; a new "loops around it" band
  (Request · Brief · Measure · Record) and three FAQ entries follow it.
- **Contract change (owner decision 2026-09-06)**: Solicitor is present tense
  and `status: 'live'` in the fleet and persona data, on the commitment to
  flip `SOLICITATION_WATCH_ENABLED` + `SOLICITATION_SEND_ENABLED` in
  production (both on in staging). PRODUCT.md, BRAND-KIT §6, the Claude
  project instructions, landing DESIGN.md, and brand-story.md were updated in
  the same change; the Review QR (live, un-flagged) was added to every
  shipped list. Owner channels stay "by email" — Telegram/WhatsApp are off in
  prod and are not named.


## Quick summary — Restraint evidence (#1076/#1077/#1048, 2026-09-05; pre-merge)

The Restraint tab qualifies historical automatic-policy gaps even after
automatic posting is enabled. It also discloses when the bounded archival
history omits older events, independently of refusal totals and entry limits.
Neither fix invents an activation date or backfills a decision.

Solicitation's `already_reviewed` gate uses retained, dated reviews linked to
earlier outreach for the contact at this location. Deleted or undated reviews
do not qualify; spontaneous reviewer matching is outside this change. Consent
and suppression still take precedence, and the existing atomic ask/run/refusal
writer records the decision. Owner copy states this narrower evidence rule.

The shape stays in existing files: `src/lib/refusals/read.ts` owns the archival
overflow fact, the two Restraint components validate and present it, and
`src/lib/solicitation/batch-builder.ts` supplies matched review evidence.
`GhostPipeline.tsx` owns the corrected Requests explanation. No migration,
dependency, or feature flag is added. These changes remain local pending the
guarded verification/review and separately authorized shipping steps.

## Quick summary — **Refusal ledger**: every lane now writes (2026-09-01, PRs #1034/#1044/#1042/#1043/#1049/#1055)

**Every one of the seven Refusal lanes now records its decisions. The table is
written; nothing reads it yet — the reader is the Restraint tab, #1014, and it
is the last slice.**

The closed vocabulary, verified in `src/lib/refusals/vocabulary.ts`:

* **Seven lanes** (`REFUSAL_SOURCES`) — `held_draft`, `auto_post_revoked`,
  `autonomy_suspended`, `ask_withheld`, `outreach_withheld`, `batch_halted`,
  `policy_gate_held`.
* **Eight owner-facing categories** (`REFUSAL_CATEGORIES`), frozen at write
  beside the `vocabulary_version` that froze them.
* **Seven lane category maps.** Six lanes carry one map each, except
  `outreach_withheld`, which has two — its RENDER and DISPATCH writers decide
  different things at different moments. `held_draft` is **the one lane with no
  map at all**, because it has no code axis (constraint C4).

**What each slice added.** #1034 landed the five remaining category maps as a
shared prerequisite, carved out of the three slices that would otherwise have
raced for them. #1010 gave the three solicitation single-site lanes their
writers and added the ledger's **set-based arm** (`writeRefusalEvents`, one
`jsonb_to_recordset` INSERT) — needed because `ask_withheld` can reach 5,000
rows in one build, and looping the single-row helper would put that many round
trips inside a transaction holding the per-Business advisory lock. #1011 wired
the `outreach_withheld` RENDER lane and moved its clock to decision time. #1012
added `auto_post_revoked` and widened `account_id`. #1049 swept the debt those
three deferred. #1013 closed it with `held_draft` and `policy_gate_held`, both
inside the ONE `sql.begin` that carries invariant #4's moderation-hold
atomicity.

**One lane is live in code but silent in production, and that matters for
#1014.** `AUTO_APPROVAL_ENABLED` is `false` in production, which makes
`auto_approval_disabled` a STRUCTURAL gate: `isAutoApprovalCandidate` returns
false, no policy row is read, and `policy_gate_held` writes **zero** rows —
not few, zero. It turns on at position 4 of the ordered go-live flip, never at
a merge. So the **Coverage start** #1014 plans to render from
`accounts.created_at` is not yet honest for that lane. Raised on #1014;
merge ordering alone does not settle it.

**What is left.** Slice 7 of 7 — the **Restraint tab** (#1014): the report, the
archived-location footnote and the archived-period line. Reads render the
STORED `refusal_category` and never re-derive it.

## Quick summary — **Refusal ledger**, slice 1 of 7 (2026-08-30, PR #1019)

**RepWorth now has a place to record the things it decided NOT to do — one row
per decision, written when the decision was made. The table exists; nothing
writes to it or reads it yet.**

A **Refusal** is a *decision*, which is what excludes every neighbour that looks
like one: an owner act is the owner's decision, a delivery failure is an act
that did not land, an elapsed clock weighed nothing, and a Judge verdict is a
post-publication observation. It is **RECORDED, never re-derived** — the parent
effort tried to project this surface over seven tables and could not ORDER it,
because two lanes carry no immutable timestamp of their own. That failure is
why `occurred_at` exists and why it is writer-supplied.

`refusal_events` carries twelve columns, five CHECK constraints, three indexes
and **deny-all RLS** — the last is load-bearing rather than a default:
`all_refusal_codes` is non-owner-facing under ADR 0023, and **RLS filters rows,
not columns**, so an owner-readable policy could not withhold it.

Two constraints encode defects rather than hygiene. **C3** is biconditional
(`business_id IS NOT NULL` ⇔ not `autonomy_suspended`) because joining the audit
log through `businesses` multiplied one account-wide suspension by the location
count. **C5** gained two clauses the locked #1001 shape lacked: with
`refusal_code = 'winner'` against `all_refusal_codes = ARRAY['different', NULL]`
the original expression returned NULL, **and a CHECK passes on NULL** — Postgres
accepted a row lying about its own precedence. Reproduced on a live database
before the fix, and live-fired again on staging at promotion.

**No write site and no read.** The only code naming the table in the same change
is the account-offboarding purge, which must honour the `hard_delete` /
`must_be_absent` disposition the table forces — **no cascade reaches it**, so an
explicit account-scoped DELETE is the only thing that removes these rows.

**What #1009 then added (2026-08-31, #1031).** `src/lib/refusals/vocabulary.ts`
(the two closed axes) and `write.ts` (the ONE insert helper, on
`writeAccountAuditLog`'s model), the `autonomy_suspended` write site inside
`suspendAccountAutonomy`'s existing transaction, the eleventh `ArchivalPoller`
retention arm on `REFUSAL_LEDGER_RETENTION_DAYS = 180`, and a Sentry sink in
`AutonomyGovernorScheduler` — that scheduler is not a BullMQ worker, so
`attachJobFailureSink` never saw its per-candidate failures and a ledger error
would have left an account un-suspended silently every fifteen minutes.

Three things #1009 learned the hard way and are worth carrying: the input type
is a **per-lane union** transcribing CHECKs C1–C4, because a flat record lets a
mis-paired lane raise `23514` and abort the deciding transaction; the kill
switch's warning is rate-limited per **disabled episode** with the structured
log line as the DURABLE transport, because `Sentry.captureMessage` returns on
queue rather than delivery and swallows transport failures; and
`refusal_events`' account FK has no `ON DELETE` action by design, so every
live-DB teardown that deletes an account must clear the Refusal first.

The new shape:
- `supabase/migrations/116_refusal_events.sql` — table, 5 CHECKs, 3 indexes, deny-all RLS
- `scripts/ci/tenant-tables.ts` (**two structures**) · `docs/security/rls-inventory.md`
- `src/lib/account-offboarding/{table-disposition,purge-verification}.ts` ·
  `worker/jobs/account-offboarding/purge-stages.ts` — the purge surface
- `docs/adr/0023-refusal-log-owner-safe-projection.md` ·
  glossary: `docs/context/refusal-ledger.md` → **Refusal**, **Refusal source**, **Refusal category**, **Restraint tab**
- migration **116** — staging + prod 2026-08-30, lockstep, verified identical by
  constraint and index fingerprint

**#1009 SHIPPED 2026-08-31** (#1031) — the insert helper, its
`REFUSAL_LEDGER_ENABLED` kill switch, the `ArchivalPoller` sweep arm and the
first write site. **Superseded — every remaining write site has since
shipped, across #1034/#1010/#1011/#1012/#1049/#1013. See the entry at the top
of this file. Only the Restraint tab (#1014) is left.** #1008 could not say
where the FIRST write site lands and named #1009's PR as the change that
would. **#1009 settled it (D16): the first site is `autonomy_suspended`, one
site inside `suspendAccountAutonomy`, shipped beside the helper — and the rest
followed across #1010–#1013.** The deciding evidence was never the artifact count, which is
tied: it is #1004's verbatim slice order and #1009's ticket body §5.

## Quick summary — **Review QR** (2026-08-26, PR #982)

**Every location can now print a QR code that sends a customer straight to that
location's Google write-review page — through a RepWorth-owned redirect, so a
printed code never goes stale.**

The QR encodes the public **QR redirect** `/q/<businessId>`, which 302s to a
Google write-review deep link CONSTRUCTED from the stored, `isPlaceId`-validated
place id — no stored destination URL, no open redirect, hex CIDs refused. The
gate is `subscriptionAllowsQrRedirect` (`{active, trialing, past_due}` —
`past_due` deliberately keeps an already-printed counter code alive through the
grace window); every refusal (bad id, missing row, archived location,
`pending_payment`/`cancelled`, non-canonical place id) serves one byte-identical
scanner page, with the reason coded in the log only. Each scan best-effort
inserts a `qr_scan_redirected` analytics event AFTER resolve (random event key
per scan — a deterministic key would dedupe and undercount). Owners get the code
at `/dashboard/requests/qr`, with a per-location printable view. Moved out of
Settings by #1092; `/settings/review-qr` now redirects there.

The new shape:
- `src/app/q/[businessId]/route.ts` — the public **QR redirect**
- `src/lib/locations/review-qr.ts` (+ `getQrRedirectRow` in `repo.ts`) — resolve + refusal policy
- `src/app/(authenticated)/dashboard/requests/qr/` — owner surface + print view
  (#1092; `src/app/(authenticated)/settings/review-qr/page.tsx` survives as the redirect)
- `subscriptionAllowsQrRedirect` (`src/lib/shared/subscription-status.ts`) ·
  `qr_scan_redirected` (`src/lib/analytics/events.ts` + `docs/analytics/events.md`) ·
  migration **115** (CHECK widen; staging 2026-08-26, prod 2026-08-27, lockstep) ·
  glossary: `docs/context/review-qr.md` → **Review QR**, **QR redirect**

Post-merge ops (2026-08-27): WAF rule 3c `qr-redirect-per-ip-enforce` (`/q/*`,
30 req/60s per IP → 429) published + burst-verified — the redirect writes one
durable `analytics_events` row per anonymous scan (adversarial finding A2,
accepted ops gate; `docs/runbooks/vercel-waf-rate-limiting.md` Component 3).

## Quick summary — #631 **Auto-approval lane** (2026-08-24, PR #950)

**Autopilot accounts can now let solicitation send batches approve themselves — with an
owner veto window before anything sends. Every gate is OFF in every environment.**

The ask-generation finale approves a batch as `approval_method='auto_policy'` only when
four conditions hold (both server flags, full subscription access, the Autopilot tier,
no account-wide Governor suspension) AND the owner's opt-in policy row exists — decided
once, never on regeneration; a racing owner approval wins quietly. The owner then gets a
**Veto notice** (email/Telegram/WhatsApp, batch-scoped, tokenless CTA to
`/dashboard/requests`); the FIRST provider-accepted send starts the veto window, and the
**Veto anchor** release phase stamps the deadline once, fail-closed per D9 — no sent
notice, no anchor, no release, ever. Every release tick re-checks the conditions and
downgrades a lapsed batch back to owner review with the exact reason (flag off, tier
lost, policy removed, suspension). Judge stays release-owned (#900); the pre-existing
dead-sweep liveness blind spot is **CLOSED** (#949, migration 118) — `isJudgeHealthy` reads a durable
`judge_sweep` heartbeat and fails closed without one, which is also why flipping `JUDGE_ENABLED` on
costs a ≤60s warm-up window of downgrades.

The new shape:
- `src/lib/solicitation/auto-approval.ts` — condition gate, `auto_policy` verb, **Veto anchor**
- `worker/jobs/solicitation-veto-notice/` — the notice worker family (pending-post-notice clone)
- `src/lib/auto-approval/solicitation-settings.ts` + `settings-guards.ts` — opt-in lane + shared write-guards
- migration **113** (index-only; applied staging + prod 2026-08-24, lockstep) ·
  `SOLICITATION_AUTO_APPROVAL_ENABLED` default OFF · glossary: `docs/context/solicitation-send-mode-breaker-release-attribution.md` → **Auto-approval
  lane**, **Veto notice**, **Veto anchor** (LOCKED)

Deploy-inert proven on staging 2026-08-24 (clean boot, flags confirmed OFF). #633 owns
the ordered go-live flips.


## Quick summary — #900 **Solicitation release poller** (2026-08-23, PR #920)

**The loop that decides which approved messages are allowed to go out today — and the
thing that finally lets a wedged send batch close by itself.** One
Postgres-state-driven poller, five phases in a fixed order, every 60 seconds.

```
phase 1  unknown sweep      an Outreach row stuck `sending` past 60 min with no in-flight
                            outbox row → terminalize `unknown` + Sentry alert.
                            THIS IS WHAT DISCHARGES #915's BLOCKER.
phase 2  send_window_elapsed a batch past its 72h send window → Halt latch, no actor
phase 3  batch_expired       a batch never approved inside its 7-day window → same latch
                            (makes the 11-day `stalled` alert unreachable, not just unlikely)
phase 4  RELEASE             Send breaker → platform ceiling → account cap → per-child.
                            The ONLY phase `SOLICITATION_SEND_ENABLED` gates.
                            Outreach rows CAS `rendered → queued`, one send job each.
phase 5  backstop join       a second CALLER of `closeBatchIfSettled`, never a second
                            implementation
```

**"Flag off" does NOT mean "poller idle", and that is deliberate.** The flag suppresses
phase 4 only. Gating the whole cycle would strand a batch flipped off mid-drip with
`queued` rows forever, and migration 091's one-active-send index would then block that
location permanently — the exact wedge phase 1 exists to clear.

**No migration** — 091 and 110 already carried every column, CHECK member and index.

**Still inert in production.** `SOLICITATION_SEND_ENABLED` is off everywhere. This merge
removes #915's *blocker*; the flip itself is a separate decision.

The new shape:

| File | What it owns |
|---|---|
| `src/lib/solicitation/release.ts` | The deep module. `runReleaseCycle` (the five-phase order), `sweepSystemHalt` (one body, both clock-driven sweeps), `runAccountArm` / `runBatchArm` (the two isolation units), `capacityStop` (the three capacity gates asked once). |
| `worker/background/pollers/SolicitationReleasePoller.ts` | Composition root. Owns `sql`, the interval and the guarded-poll scaffolding — and nothing else. Deliberately does NOT read the send flag. |
| `src/lib/solicitation/approval.ts` | Gains `latchSystemHalt`, the Halt latch's THIRD arm — the one with no actor, which migration 091's halt-consistency CHECK enforces by requiring `halted_by IS NULL` for exactly its two reasons. |
| `src/lib/shared/job-outbox-helpers.ts` | Gains `enqueueSolicitationSend`, the typed enqueue for the release → send handoff. |

**One env var:** `SOLICITATION_RELEASE_POLL_INTERVAL_MS` — optional, 60s default. It
rejects one more class than its `JUDGE_POLL_INTERVAL_MS` precedent: a value at or below
the 45s cycle timeout is invalid, because a hung cycle must free the single-flight flag
before the next tick.

## Quick summary — #899 **Solicitation send worker** (2026-08-22, PR #912)

**The first code in this repo that can put a real email in front of a real customer.**
It is merged and inert: `SOLICITATION_SEND_ENABLED` is off in every environment, and
**it must stay off until #900 ships** (see the blocker below).

What it does, per job, for one **Outreach row**:

```
tx1 (short): stale-attempt guard → per-business advisory lock → batch row → outreach row
             → seven-item Dispatch gate → consent snapshot → Lazy child
             → unsubscribe token mint → CAS queued → sending
provider:    NO lock held. Idempotency key = the outreach row id.
             Retryable failures absorbed IN-PROCESS, while the raw token is still in scope.
tx2 (short): CAS sending → sent|failed  +  child terminal  +  solicitation_sent outcome
             +  outbox completion  +  closeBatchIfSettled      ← ONE transaction
```

**No migration** — #898's migration 110 already carried this family's schema work.

The new shape:

| File | What it owns |
|---|---|
| `src/lib/solicitation/dispatch.ts` | The deep module. `applyDispatchGate` (pure, owns B6's order and the withheld-reason mapping) and `dispatchOutreach` (the orchestrator). |
| `src/lib/solicitation/send-retry.ts` | `classifySendFailure` — D12c's terminal/retryable split, pure. |
| `worker/jobs/solicitation-send.ts` | Composition root. Extract the outbox handle, call one domain function. |
| `worker/jobs/solicitation-send/failed-hook.ts` | The only writer of `send_exhausted`. Picks its terminal by arrival status. |

**Four behaviours worth knowing** (a reader of amendment B6 alone would get each wrong;
all four are now recorded upstream as **B15**):

1. The two SLOW gate items (re-lint, re-moderation) run **above** `tx1` with no lock held —
   re-moderation is a ~10s provider call. `tx1` then proves the locked bytes still match the
   ones those verdicts were computed over, so the guarantee is checked rather than assumed.
2. A row already `sending` is **never re-gated and never re-sent**. The raw unsubscribe token
   died with the crashed process, so no correct message can be rebuilt.
3. A flag-off **defers**; it never terminalizes. 091/110 carry no `flag_off` withheld reason.
4. The exhaustion hook writes `unknown`/`send_indeterminate` for a `sending` row, not `failed` —
   calling a possible send "not sent" can put that customer in a future batch and email them twice.

> **⚠️ Enablement blocker — issue #915.** #899's recovery path for a crash between its two
> transactions IS #900's D12d `unknown` sweep. Until that ships, a dead process leaves a row
> in `sending` that nothing can terminalize: the batch never settles and the one-active-send
> index blocks every future batch for that location. Merging was safe; **flipping the flag is not.**

## Quick summary — #898 **Send governors** (2026-08-21, PR #904)

**Nothing here sends mail, and that is the point.** #898 ships the schema and the
three governors that #899 (the send worker) and #900 (the release-side consumer)
will stand on, so those two land without a migration between them. Today the
breaker can trip, page and be reset — but nothing reads it on the send path yet.

**The asset being protected is the Sending identity** — one `reviews@` mailbox and
one sending domain that every account sends through. That is why the **Send
breaker** is a platform singleton and not a per-tenant dial: one account's bad
contact list burns the deliverability everyone else is sending on. It is **not**
the **Halt latch** — that stops one batch; this stops all sending, everywhere.

**Three governors:**

- **Send caps** — a platform ceiling and a per-account daily cap, counted on
  UTC days.
- **Send breaker** — a rolling 7-day window that trips above a **2% hard-bounce
  rate** or a **0.3% complaint rate**, and never below 100 sends. The
  `HealthAlertPoller` is its only tripper, so a trip lands within one poll
  interval (5 min).
- **Bounce discrimination** — the Solicitation lane now records `bounce_kind`
  beside `bounced_at`, because the breaker must count hard bounces only.

**Three things that surprise people:**

- **The window is not a cohort.** The denominator is send-dated, the numerators
  are signal-dated, so a burst of bounces from a send nine days ago still trips
  it and the ratio can exceed 1.0. That is deliberate — the intuitive cohort
  measure dilutes a fresh bad batch with sends whose bounces have not landed,
  which is the fail-*open* direction.
- **A reset is a bounded half-open probe, not a re-arm.** Resetting moves the
  window's lower edge to that instant, so only post-reset activity is measured
  and the breaker stays quiet until 100 fresh sends accumulate. Roll
  `SOLICITATION_PLATFORM_DAILY_CAP` down *before* resetting — the ceiling is the
  only thing bounding how much mail leaves during the probe.
- **An open breaker is a STATE, not an event.** It re-pages every tick while it
  stands, under a constant title so Sentry collapses the repeats. One dropped
  page must never equal a silent platform-wide halt.

**It never self-clears.** The only thing that closes a trip is an admin at
**Safety → Send breaker** (`/admin/solicitation`), with a mandatory note enforced
both by the route and by migration 110's `reset_consistency` CHECK — so "who
cleared this, and why" cannot be unanswerable by omission. The latch table is
append-only with at most one open trip, because a second breach would otherwise
overwrite the very record someone reviews after the fact.

**The cost of a trip, which is easy to miss:** the breaker and the 72-hour send
window run on different clocks and nothing reconciles them. A trip that stays
open for days converts every batch approved in the 72 hours before it — across
every account — into `cancelled` / `send_window_elapsed`. That is a recorded
trade (amendment B14): a cancelled batch is an honest terminal state an owner can
act on; the alternative buries the trip under a stalled-batch alert storm.

**The new shape:**

| File | Role |
|---|---|
| `supabase/migrations/110_*.sql` | withhold vocabulary, `bounce_kind`, the latch table |
| `src/lib/solicitation/send-breaker.ts` | window read model, trip, fail-closed read, reset |
| `src/lib/solicitation/send-caps.ts` | ceiling resolver, account cap, UTC-day counters |
| `worker/background/pollers/health-alert/checks.ts` | the only tripper; isolated so a write failure cannot discard the other findings |
| `worker/ingress/resend/solicitation-lane.ts` | records `bounce_kind` |
| `src/app/admin/solicitation/**` | the reset surface (Island system, AAL2) |
| `docs/runbooks/solicitation-sending-domain.md` §8 | the operational procedure |

**Operational note:** all send flags stay OFF. Migration 110 is applied to
staging **and** production — lockstep complete, no standing exception.

## Quick summary — #872 **Ask withdrawal** (2026-08-18, PR #883)

**Until today, an owner who spotted one wrong message after approving a batch
had exactly one lever, and it cost them the whole cohort.** The **Halt latch**
stops a batch; it does not spare the other contacts, and because a halted ask
keeps `status='send'`, everyone in that batch is `over_contacted` for
`MIN_GAP_DAYS` — so a rebuild inside 30 days withholds them all. The cost of
one bad message was every message.

**Ask withdrawal is the cheap lever.** The owner taps `Withdraw` on a single
row; that one **Outreach row** goes `cancelled` / `owner_withdrawn` and nobody
else in the batch is affected. It is legal in exactly the **Batch states** where
the latch would have cancelled that row — `veto_window`, `approved`, `sending`
— and the row itself must be `rendered` or `queued`, **never `sending`**: halt's
"no further sends, not undo" contract is inherited whole rather than re-argued.

**It only ever moves toward restraint.** It removes a message; it never adds,
replaces or edits one. That is why it needs no re-lint, no re-moderation and no
per-ask approval state (the batch stays approved, `approved_at` and the veto
clock untouched), and why it does not reopen ADR 0020, whose subject is
*replacing* approved bytes: a message that does not send cannot violate **Owner
approval**'s byte-for-byte guarantee. ADR 0021 records that argument.

**What it does not do:** it does not release the contact. A withdrawn ask keeps
`status='send'` exactly like a halted one, so that person stays
`over_contacted` for `MIN_GAP_DAYS`. The saving is the *other* contacts — one
lost instead of the cohort.

Two details worth knowing:

- **It is keyed on the ask, not the row.** The verb resolves the live attempt
  under the batch lock, so a stale tab still withdraws the right message.
- **Idempotence outranks the state gate.** Withdrawing the last live row settles
  the batch, so a retry on that very row arrives in `closed` — it still answers
  "already withdrawn" (a fact about the row) rather than a 409 about the batch.

The new shape:

| Where | What |
|---|---|
| `supabase/migrations/109_outreach_owner_withdrawn_disposition.sql` | Widens 108's cancel arm by one value, `owner_withdrawn`. Applied to **staging and production** in lockstep on merge day; all three databases (local, staging, prod) carry a byte-identical constraint. |
| `src/lib/solicitation/approval.ts` | `withdrawAsk` — the fifth human-triggered verb, appended beside approve / halt / adminHalt / regenerate. Same lock order as the latch (advisory batch → batch row → outreach row → spine), one transaction, one `ask_withdrawn` step, then `closeBatchIfSettled`. The decision itself is the pure `classifyWithdrawal(state, attempt)`. It deliberately does **not** share #865's private `latchHalt` — the latch writes `halted_at` on the batch and withdrawal writes nothing there. |
| `src/app/api/dashboard/solicitation/batch/withdraw/route.ts` | Thin route over `withScopedBatch`; `{ batchId, askId }` body read by the hoisted `readBatchAsk` (now shared with regenerate). 200 withdrawn · 200 already-withdrawn · 409 not-withdrawable / not-live · 404 not-found. |
| `src/app/(authenticated)/dashboard/requests/AskList.tsx` | `WithdrawableAskList` — a third sibling list. Per live row a `Withdraw` control behind an inline two-tap confirm; the read-only `AskList` stays structurally unable to render a control. |
| `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` | New `withdrawable` display facet, the `useArmedWithdrawal` hook (one armed row at a time; disarms when a refetch drops the row), and copy that announces the **server's** remaining count — never a client-side subtraction, because the client cannot see an in-flight row. |

## Quick summary — #665 purge-verifier blind spots · #662 suppressions console (2026-08-18, PR #882)

**Two low-severity defects filed off earlier ships, both about a system telling
the truth about itself. Nothing a customer could see was broken; what was broken
was the machinery that would have told us if it were.**

**#665 — the account-purge verifier was not checking everything the purge
clears.** When an owner deletes their data, one stage tombstones their business
rows and a second stage re-reads them to confirm nothing survived. The re-read
listed 17 columns. The tombstone cleared 22 — including the owner-attested
**physical postal address** and its four attestation columns. Nothing leaked:
the write side really did clear them. But had a future change stopped clearing
them, verification would have said "clean" and the purge would have completed.
The verifier now covers every column the tombstone writes — the five postal
columns the issue named, plus `category`, `tone`, both Stripe identifiers and
`archived_at`, which no issue had named.

This matters more than a detector usually would, because the verifier runs
*inside* the finalize transaction and **throws**. It is a gate, not a report: a
purge that fails verification does not complete.

**#662.1 — a receipt that outlived its own truth.** On `/admin/suppressions`, an
admin who recorded an opt-out saw a green receipt. If they then corrected that
record, the lookup panel updated to "Not suppressed" while the receipt directly
below still read "Already suppressed — no change." Two panels, one screen,
opposite claims about the same address. The receipt is now cleared whenever a
correction settles the ledger — including the already-removed case, which
*returns* rather than throws and is therefore just as settled. A correction that
genuinely **fails** deliberately leaves the receipt and the row alone.

**#662.2 — `PRIOR CORRECTIONS` showed a raw UUID.** The audit trail answered
"who removed this?" with `6b7a3503-1257-4f79-8e5e-6af46527f0a9`. It now shows
`Name (email)`, falling back to the raw UUID when the user row is genuinely
gone. No foreign key was added: a compliance record must outlive every referent
it names.

**One documentation fix that is really a warning.** A comment claimed the new
`users` join needed no tenant-scope exception because it was "structurally
scoped". It is not. `users` is not in the audit's table list at all, so
`ci:tenant-scope` never formed an opinion about it — a green audit is not a
review of a join it cannot see. What makes the join safe is its shape: one
primary-key lookup per correction, behind the admin MFA gate, returning staff
identity and never tenant data.

**The new shape**

| File | What it is now |
|---|---|
| `src/lib/account-offboarding/purge-verification.ts` | The `businesses` residue predicate covers all 27 tombstoned columns. Two are not residue checks: `tone` compares with `IS DISTINCT FROM` because the tombstone restores a schema default on a nullable column, and `archived_at IS NULL` is a violation because the tombstone *sets* it. |
| `src/lib/admin/suppressions-service.ts` | `lookupSuppressions` `LEFT JOIN`s `users` and returns `removedByUserLabel`. |
| `src/app/admin/suppressions/SuppressionsClient.tsx` | Renders the label; the correction mutation calls `entry.reset()`. |
| `scripts/ci/tenant-scope-allowlist.ts` | Corrections entry re-pinned for the new query shape. Baseline unchanged at **381**. |

No migration, no env var, no feature flag, no new dependency, no new file.
