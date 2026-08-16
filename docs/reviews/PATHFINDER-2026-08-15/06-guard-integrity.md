# Pathfinder 2026-08-15 — guard-integrity census

Answers the question the `#833` arch-log entry posed: *"Worth asking how many
older guards have the same shape."*

**Answer: 15.**

## Method

Mutation-checking, not reading. For each candidate: identify the production
line the test claims to guard → break it → run tests → record whether the suite
stayed green → revert. The decisive run for every finding below was the **full
862-file / 11,340-test parallel project**, not just the owning file, so "no other
test catches it" is measured rather than inferred. Baselines were captured before
each mutation and failure sets diffed, so one flaky local integration suite never
contaminated a verdict.

**Working tree left clean** — `git diff --stat` empty, verified.

**Orchestrator verification:** finding A1 was independently reproduced. Deleting
the `approval_method === APPROVAL_METHOD.AUTO_POLICY` conjunct from
`worker/jobs/publisher/auto-policy-publish.ts:491` leaves all 32 tests in
`auto-policy-publish.test.ts` passing. Guard restored; `git diff` confirmed empty.

## What this is and is not

**These are not production bugs.** Every guard listed is correct in the shipped
code. What is missing is the tripwire: nothing fails if a future change removes
them. One item (E3) is the exception — it would be a live correctness bug on
regression, because it silently corrupts a score rather than opening a hole.

## The two shapes

- **(A) The mock never reaches the guarded query.** The test "covers" the line but
  pins nothing — control flow reaches the same assertions by another route.
- **(B) A pin lost in a test split.** The behaviour is still in production code, but
  no assertion fails if it is removed.

---

## Group A — auto-policy publish gate chain (invariant #3). Shape A. 5 instances.

Root cause, singular: `auto-policy-publish.test.ts:10-17` pins every collaborator
to its ALLOW value and re-asserts them in `beforeEach` at `:267-272`. No test ever
overrides them. `ResponsePublisherWorker.test.ts:98` mocks the module out wholesale,
and the live-DB concurrency suite covers only tier/subscription.

| # | Guard | Mutation | Result |
|---|---|---|---|
| A1 | `:489-491` `isPublishableAutoPolicy` — `approval_method` conjunct | deleted the conjunct | **survived** |
| A2 | `:624-626` `evaluateModerationGate` (invariant #4 on publish) | body → `return 'continue'` | **survived** |
| A3 | `:560-562` `evaluateRuntimeGate` (`AUTO_APPROVAL_ENABLED`) | body → `return 'continue'` | **survived** |
| A4 | `:529-530` judge outcome | forced `'continue'` | **survived** |
| A5 | `:570-576` `evaluateVetoGate` outcome mapping | forced `'continue'` | **survived** |

**A4 is the sharpest.** `.claude/CLAUDE.md` invariant #3: *"Judge availability is a
posting precondition."* Nothing fails if the publisher stops honouring the judge's
verdict.

**A1's masking mechanism is instructive.** The only test touching non-publishable
state (`:593-594`, `:630-631`) mutates `responseStatus` **and** `approvalMethod`
together — so the status half masks the method half, and neither is independently
pinned.

## Group B — `ResponsePublisherWorker` owner lane. Shape A. 3 instances.

| # | Guard | Test claiming it | Result |
|---|---|---|---|
| B1 | `:143` `if (!subCheck.allowed)` (invariant #11) | `:239` *"…when subscription is cancelled"* | **survived** |
| B2 | `:127` `if (business.archived_at !== null)` | `:250` *"…when location is archived"* | **survived** |
| B3 | `:224-227` auto_policy edit-lane invariant throw | *none exists* | **survived** |

**B1/B2 are worse than untested — their titles claim the coverage.** Mechanism:
each pushes exactly two rows into the mock `sql` return queue and asserts only
absences plus one completion. With the guard removed, control flows on to
`resolvePublishTarget`, the queue is **exhausted**, the lookup yields `[]` →
`no_connection` → `parkResponseForOwnerReconnect` → `markOutboxCompleted`. Every
assertion still holds. The mocked handle never reaches the query the guard
depends on.

## Group C — approval claim primitive. Shape A. 1 instance.

**C1** — `src/lib/approval/locks.ts:87`
`if (row.status !== 'pending_approval') throw new ResponseNotPendingError(...)`.
Deleted; survived both the targeted run (with live DB: 22 files / 202 tests) and
the full project.

Two mechanisms combine. `token-mode.test.ts:29`, `session-mode.test.ts:31` and
`veto.test.ts:34` all `vi.mock('../locks')`. The suites that run it for real feed
fixtures whose every response is `status: 'pending_approval'`
(`service.test.ts:180,240,272,310,394,437,479,555,618`;
`approve-via-callback.test.ts:70`), so the rejecting branch is unreachable. What
*is* pinned is the error's **consumer** — `http-routes.test.ts` and
`service.test.ts` throw `ResponseNotPendingError` from a mock and assert the 409.
The producer is not.

This primitive is what stops a second approve/edit/regenerate on an
already-approved, vetoed or posted response.

## Group D — comparator tiers. Shape B. 2 instances.

**D1** — `src/lib/competitors/named-rival.ts:167-169`, the `rank_position` tier.
Its test is titled *"breaks ties by rank position with NULL rank last, then place
id"* (`named-rival.test.ts:51`) but the fixture is **aligned, not anti-aligned**:
`ChIJ_a` wins the place_id tier too, so either tier alone yields the asserted
result. Three mutations prove it:

| Mutation | Result |
|---|---|
| delete rank tier only | **survived** |
| delete place_id tier only | killed — but by `WeeklySummaryWorker.test.ts`, not this test |
| delete **both** tiers | killed — only now does this test fail |

Tier 2 has zero pinning assertion anywhere in the repo, under a test title that
names it.

**D2** — `src/lib/admin/overview-service.ts:177` `a.id.localeCompare(b.id)`, the
final total-order tie-break of the at-risk comparator (new in #833). Deleted;
survived. The name-tier test (`overview-service.test.ts:475`) deliberately
anti-correlates ids with names to prove tier 3 decides — a guard-the-guard that
leaves tier 4 unpinned. `Array.prototype.sort` is stable, so removal is invisible.
Low severity (determinism under a full name collision), exact shape.

## Group E — admin business-summary metrics CTE. Shape A. 3 instances.

Claiming test: `business-summary.test.ts:96` — *"requests metrics only for the ids
on the current page"* — whose own comment calls itself *"THE assertion this suite
exists for."* It asserts the bound **array value** (`metricsCall!.values[0]`), never
the predicates that consume it.

| # | Guard | Result |
|---|---|---|
| E1 | `:234` `WHERE nd.business_id IN (SELECT id FROM biz)` | **survived** |
| E2 | `:251` `WHERE rp.business_id IN (SELECT id FROM biz)` | **survived** |
| E3 | `:235` `AND nd.template = 'approval_request'` | **survived** |

E1/E2 are the spec §5.4 "bounded by the page, not the table" property — results are
unchanged by the outer `LEFT JOIN`, so removal is a silent full-table-scan
regression (the #505/#773 class). **E3 is a correctness bug on regression:** it
changes `approval_rate` / `notified_count`, hence every churn score and the at-risk
list itself.

## Group F — channel enrollment tenant scope. Shape B. 1 instance.

**F1** — `src/lib/channels/mobile-enrollment.ts:83` `AND account_id = ${accountId}`
on the `startMobileEnrollment` UPDATE branch. Deleted; survived the full project
and the live-DB `enroll-e2e.integration.test.ts`. Siblings pin the scope on the
INSERT (`:53`) and the SELECT (`:85`); the UPDATE-branch test (`:61-71`) asserts
only the status flip and `disabled_at = NULL`. Defense-in-depth (the row id came
from an account-scoped `SELECT … FOR UPDATE`), but the omission is exactly a pin
lost in a split.

---

## Cleared — 40 mutations correctly killed

The negative results matter: they prove the method and bound the problem.

- **Approval primitives** — `verifyDevice` device-binding; `assertLocationNotArchived`
  fail-closed; `lockValidLink` expiry; `token-mode.ts` `approve` tenant scope.
- **Auto-approval decision matrix** (`response-generation/auto-approval.ts`) — **all
  11** block reasons independently pinned. The best-guarded surface in the codebase,
  and the direct product of prior-pass handoff H3.
- **Invariant #4 at the producer** (`persist.ts`) — notify-skip; `flagged_responses` INSERT.
- **Publisher** — entitlement autopilot-tier conjunct; policy-suspension; archived;
  offboarding; auto_policy routing (`:111`); owner-lane moderation (`:155`); edit-lane
  `business_id` sibling probe.
- **Import consent** — `guardImportConsent` fail-closed `=== 'accepted'`; its `FOR
  UPDATE`; its `sql.begin` wrapper; `importConsentStateSql` inclusive `<=` boundary.
- **Solicitation suppression** — global-wins ordering; account scope. ⚠️ killed **only**
  by the integration suite — see below.
- **Channels** — `cancelMobileEnrollment` status guard; `already_verified` short-circuit;
  `disableChannelEnrollment` org-default scope.
- **Auth/routing** — `requireAdminWithAal2` AAL2 check; `resolveOwnerActor` `no_business` gate.
- **Comparators** — `DataTable` direction; `orderNotificationDispatchEnrollments`;
  `resolveChannels` order; `sortByDateDesc`; at-risk `pendingApprovalCount` tier;
  `named-rival` place_id tier.
- **Admin query** — `resp.status != 'superseded'`; the conditional COUNT.

## ~~The systemic amplifier~~ — REFUTED by H6 (2026-08-15, same day)

**Original claim, retained for the record:** `suppressionMatchSql`'s global-wins
ordering and account scoping are killed only by `suppression.integration.test.ts`;
integration suites self-skip without `TEST_DATABASE_POOL_URL`; `pnpm test:integration`
hard-gates only one suite — therefore those pins are "correct tests that no gate runs."

**What H6 found:** the *observations* reproduce exactly (M1/M2 survive the parallel
project alone; the owning integration suite goes 2 failed / 11 passed). **The
conclusion does not follow.** CI's `test` job — a required check — has run the
live-DB lane since #244: `.github/workflows/ci.yml:182-197` stands up `postgres:16`
and sets `TEST_DATABASE_POOL_URL`; `:205-206` provisions to head; `:211-212` runs
`pnpm test` = `vitest run` = **both** vitest projects. Measured on run `31907581265`:
**91 integration suites ran**, `suppression.integration.test.ts` among them, green.
`pnpm test:integration`'s one-suite list is a *local* convenience CI never calls —
reading it as CI's coverage was the error, and CLAUDE.md's "self-skips in CI"
wording (now corrected on the H6 branch) reinforced it.

**The real, narrower defect H6 then found:** that gate was **unpinned**. Delete four
YAML lines and CI stays green with all 92 suites silently skipped, because
`describeWithDb` skips rather than fails. H6 pinned the wiring in
`src/__tests__/ci-audit-wiring.test.ts` (fails on each of four un-gating edits) at
zero new CI minutes. Orchestrator independently verified the `ci.yml` wiring before
accepting the refutation.

Groups A–F above stand unchanged. This section was the only claim in the pass that
did not survive execution.

## Gaps

- `e2e/` Playwright specs not run — none of these are UI-reachable, but not excluded.
- One integration suite is red at baseline locally
  (`autopilot-entitlement-concurrency.integration.test.ts > subscription-updated holds
  entitlement first…`, 30s timeout). Unrelated to this pass; worth a look.
- ~55 candidates examined across four priority bands, not exhaustive. Not swept:
  `solicitation/{ask-generation,restraint-policy}.ts`, billing/tier-change math,
  offboarding purge stages, `worker/ingress/*` signature verification.

## Remediation

Handoff **H1** (`04-handoff-prompts.md`). The five Group-A instances get **one**
table-driven suite over the existing `LOCKED_GATE_CHECKS` array — five separate
tests would be five chances to repeat the root cause.
