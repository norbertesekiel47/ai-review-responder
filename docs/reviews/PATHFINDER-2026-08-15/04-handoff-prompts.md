# Pathfinder 2026-08-15 — handoff prompts (Phase 4)

Six handoffs. Each is a copy-pasteable `/make-plan` prompt. Ordered by value,
not by proposal number.

Suggested sequencing: **H1 and H2 first** (highest risk, both touch invariants),
then H3, then H4/H5/H6 in any order. H4 and H5 are independent of everything
else and can run in parallel.

---

## H1 — Pin the auto-policy gate chain (guard-integrity cluster, P7)

```
/make-plan

Close a measured test-coverage gap on invariant #3 ("no unapproved posting"). This is
NOT a production bug — the gate code is correct today. The defect is that nothing
fails if it stops being correct. Each item below was verified by mutation: the
production code was broken, the FULL suite (862 files / 11,340 tests) ran, and it
stayed green.

TARGET: one table-driven suite over the existing LOCKED_GATE_CHECKS array
(worker/jobs/publisher/auto-policy-publish.ts:512-520). For each gate, deny exactly
that one and assert the lane terminates without a provider call.

ROOT CAUSE (fix this, not the symptoms): worker/jobs/publisher/__tests__/auto-policy-publish.test.ts:10-17
pins every gate collaborator to its ALLOW value (runtimeEnabled=true, veto='proceed',
held=false, judge='post') and re-asserts them in beforeEach at :267-272. No test ever
overrides them. Five separate tests would be five chances to repeat that mistake.

UNPINNED GUARDS — all five survived mutation:
  - auto-policy-publish.ts:491  isPublishableAutoPolicy's `approval_method === AUTO_POLICY`
                                conjunct (outside the array — add explicitly)
  - auto-policy-publish.ts:529  judge outcome — CLAUDE.md invariant #3 states judge
                                availability IS a posting precondition (outside the array)
  - auto-policy-publish.ts:560  evaluateRuntimeGate (AUTO_APPROVAL_ENABLED)
  - auto-policy-publish.ts:570  evaluateVetoGate outcome mapping
  - auto-policy-publish.ts:624  evaluateModerationGate (invariant #4 on the publish path)

NOT foldable into the table — handle separately:
  - ResponsePublisherWorker.test.ts:239 and :250 are WORSE than untested: their titles
    claim the coverage ("completes outbox without action when subscription is cancelled" /
    "...when location is archived"). Mechanism: they push exactly two rows into the mock
    sql return queue; with the guard at ResponsePublisherWorker.ts:143 (or :127) removed,
    the queue runs dry, resolvePublishTarget yields no_connection, and the flow reaches the
    SAME assertions via parkResponseForOwnerReconnect. Fix the FIXTURE so the guard is the
    only thing that can produce the asserted outcome.
  - ResponsePublisherWorker.ts:224-227 auto_policy edit-lane invariant throw — no test at all.
  - src/lib/approval/locks.ts:87 lockPendingResponse's status check — only the CONSUMER of
    ResponseNotPendingError is pinned (thrown from a mock in http-routes.test.ts /
    service.test.ts); the PRODUCER is not. Suites that run it for real feed fixtures whose
    every response is status:'pending_approval' (service.test.ts:180,240,272,310,394,437,
    479,555,618), so the rejecting branch is never reached.
  - src/lib/admin/business-summary.ts:235 `AND nd.template = 'approval_request'` — this one
    is a CORRECTNESS bug if it regresses, not just coverage: it feeds approval_rate, hence
    every churn score and the at-risk list itself. Also :234 and :251 (`WHERE ... IN (SELECT
    id FROM biz)`) — deleting either is a full-table-scan regression invisible to the
    existing test, which asserts only the bound array VALUE (business-summary.test.ts:96),
    never the predicates that consume it.

FLOWCHARTS: docs/reviews/PATHFINDER-2026-08-15/01-flowcharts/f1-admin-business-console.md

VERIFY THE WAY THE FINDING WAS FOUND: for each new test, break the guard, confirm the test
FAILS, restore. A test that passes both ways is the defect you are fixing.

ANTI-PATTERN GUARDS:
  - Do NOT add a test per guard — the table is the point.
  - Do NOT change production code in auto-policy-publish.ts. It is correct; only tests change.
  - Do NOT weaken the shared mock defaults for other tests — override per-case.
  - 40 of ~55 mutations were correctly killed. The auto-approval decision matrix pins all 11
    block reasons independently. Do not "improve" surfaces that are already sound.
```

---

## H2 — One eligibility owner in payments (P3 + P4)

```
/make-plan

Two entangled duplications in the checkout path. Grouped because they touch the same two
route files; splitting them would mean two rounds of churn on the same lines.

TARGET A — one trial-eligibility predicate. Entry point: resolveCheckoutContext
(src/lib/payments/plan-activation.ts:759).

  Today it is spelled twice and the two DISAGREE:
    - plan-activation.ts:774           trialEnabled() && onboarded_by === null
    - src/app/api/billing/checkout/route.ts:156
                                       trialEnabled() && selfServeSignupEnabled()
                                       && status === PENDING_PAYMENT && onboarded_by === null

  DECIDE BEFORE COLLAPSING — the divergence may be legitimate. #821 re-scoped
  SELF_SERVE_SIGNUP_ENABLED to gate ONLY anonymous account-minting, so ANDing it could
  wrongly deny a trial to an admin-invited owner walking the funnel. Determine which
  reading is correct, then either (a) move the terms into resolveCheckoutContext and have
  billing/checkout call it, or (b) make the laxer path a NAMED ARGUMENT with a documented
  reason. Either way: one predicate. Two call sites independently answering the same
  question is what must not survive.

TARGET B — one primary-scoped onboarded_by accessor. Export a SQL fragment
(primaryOnboardedBySql) beside the decision code that already owns the correct spelling.

  Three spellings today:
    - plan-activation.ts:399-404          primary-scoped, archived-excluded — THE CORRECT ONE
    - billing/checkout/route.ts:102-107   second primary-scoped spelling
    - plan-activation.ts:765              NOT scoped by is_primary — this is the fix

  plan-activation.ts:765 reads onboarded_by from the business passed in. The comment at
  :396 — 350 lines above, on the correct reader — names this exact mistake: "An unscoped
  read of onboarded_by would be just as wrong the other way." The function's own docstring
  at :752 states the invariant it can violate ("an admin/partner-onboarded business must
  never receive a $0 trial via direct POST").

  IT IS LATENT, NOT LIVE — verified. Sole consumer is select-plan/route.ts:215; adding a
  location requires canAddLocationForAccount → subscriptionGrantsFullAccess, so a
  pending_payment account cannot hold a second business, and businessId IS the primary at
  that moment. Do not write an incident report. DO make the query correct on its own terms
  rather than correct by a precondition enforced two modules away — note that
  add-location-tx.ts:215 omits onboarded_by entirely, so added locations default to NULL.

ALSO: correct the stale comment at billing/checkout/route.ts:92-94 — it cites
dashboard/route.ts as a peer reader, and dashboard/route.ts:112 records that branch as
deleted.

FLOWCHARTS: 01-flowcharts/f6-checkout-attempt.md, 01-flowcharts/f5-onboarding-funnel.md

ANTI-PATTERN GUARDS:
  - DO NOT split the onboarded_by overload. Replacing it with a dedicated entitlement was
    raised in #821 and rejected on the record as non_goals[2], because migration 025
    backfilled it on every pre-025 row — NULLing those would grant trial eligibility and
    strip a CleanupAbandonedSignupsPoller guard. Re-opening that is the owner's call.
  - Keep primary_onboarded_by a SCALAR SUBQUERY, never a JOIN predicate: the join feeds
    COUNT(b.id) AS active_locations and a predicate there would collapse it to 1 and
    mis-price every multi-location attempt (plan-activation.ts:393-398).
  - Do NOT touch the F3-billing / F6-snapshot split. Invariant #9a makes those two read
    models deliberate; they are on the DO-NOT-UNIFY register.
  - Every Stripe param must keep reading the durable snapshot, never a live env read. That
    property was verified to hold across all 12 parameters — do not regress it.
```

---

## H3 — Make the admin MFA control mean what it says (P5)

```
/make-plan

#831 converted the admin MFA gate from structural to configuration: the channel runners
call config.resolveActor, a per-route value, so tsc cannot reject a mis-binding. The
compensating control is ci:admin-aal2. This handoff fixes the control, NOT the seam.

CONSTRAINT: ChannelRouteConfig stays 4 fields (src/app/api/_shared/channels/start.ts:12-15).
A portal discriminant is not available and re-planning the seam is out of scope. The
resolvers stay TWO functions — that asymmetry is a tenant-isolation boundary on the
DO-NOT-UNIFY register.

TARGET: scripts/ci/admin-aal2-audit.ts — convert scanRouteFile (:85) from text scan to AST.
This joins the 10 of 17 ci:* audits already AST-based; `typescript` is already a dependency.
Pattern-alignment, not a new layer.

THREE VERIFIED HOLES, all closed by this:
  1. FILE-SCOPED, NOT VERB-SCOPED. `const code = stripComments(text)` binds the WHOLE file
     and both rules are code.includes(...). A compliant `export async function GET` calling
     the token clears :109 for a sibling `export const POST` bound to a renamed owner
     resolver. The repo already has mixed-verb admin routes — src/app/api/admin/businesses/
     route.ts has GET at :25 and POST at :105.
  2. AN UNUSED IMPORT SATISFIES THE ALLOW RULE. In that same file, line 9 is
     `import { requireAdminWithAal2 } ...`. Delete the real call at :56 and the audit still
     passes. (That file is CORRECT today — its POST does gate at :56. The control simply
     would not notice if that stopped.) Require a CALL SHAPE, not a mention.
  3. ADMIN PAGES ARE NOT COVERED AT ALL. scanRouteFile:90 scopes to src/app/api/admin/.
     requireAdminPage's aal2 parameter (src/lib/auth/page-gate.ts:41) DEFAULTS TO FALSE and
     8 of 16 admin pages opt in, with no audit watching either way. Extend scope.

CORRECT THE DOCS WHILE HERE: .claude/CLAUDE.md says "an aliased import would still clear it."
That is wrong — a same-file alias leaves the literal string `resolveOwnerActor` and TRIPS the
deny rule at :100. Verified by executing scanRouteFile against constructed inputs. The real
evasion needs a SECOND file (a renaming re-export). Fix the wording.

PIN ALL THREE CASES: admin-aal2-audit.test.ts:11-261 covers neither indirection nor
mixed-verb nor unused-import.

CHEAP INTERIM ONLY IF AST IS NOT SCHEDULED NOW: require `requireAdminWithAal2(` with the
paren. One line, kills hole 2 only. Record as PARTIAL — it does not close this item.

FLOWCHARTS: 01-flowcharts/s1-auth-gate-seam.md, 01-flowcharts/f4-channel-actor-seam.md

CONTEXT THAT RAISES THE STAKES: proxy.ts:147's AAL2 enforcement is gated on
MFA_ENFORCEMENT_ENABLED, which is Off (env-vars.md:609). Per-route binding is therefore the
only live AAL2 layer on /api/admin/**.

BOUND THE CLAIM HONESTLY: residual exposure is AVAILABILITY, not privilege escalation —
proxy.ts:144 blocks non-admins from /api/admin/** and requireRole (db/auth.ts:120) 403s an
admin against role 'owner'. A mis-binding breaks the route rather than opening it. The
dangerous variant is admin mutations moving OFF the /api/admin prefix, invisible to both the
proxy prefix check and the audit's :90 scope. Do not overstate this as an active vulnerability.

ANTI-PATTERN GUARDS:
  - Do NOT add a 5th field to ChannelRouteConfig. A fifth means the seam is wrong; re-plan
    instead — and re-planning is not this ticket.
  - Do NOT merge the two resolvers.
  - Do NOT replace the audit with an eslint rule "for consistency" — ci:admin-aal2 is wired
    into the lint job and lefthook; moving it breaks ci-audit-wiring.test.ts (#590).
```

---

## H4 — Finish the #833 admin owner (P1 + P2)

```
/make-plan

#833 created src/lib/admin/business-summary.ts as the single owner of the admin business
query and collapsed the duplicate base query. It stopped one file short: the churn MATH and
the health PRESENTATION beside it are still doubled.

TARGET A — one health presentation. Component: src/components/admin/ui/HealthBadge.tsx
(already the declared owner; entry point HealthBadge({level, score})).

  Delete the private copy at src/app/admin/businesses/[id]/BusinessDetailClient.tsx:33-51
  and import the shared one.

  WHY IT MATTERS — the copies differ in TYPE SAFETY, not just location:
    - shared:  Record<ChurnScore['level'], string>  → a new level is a COMPILE ERROR
    - private: Record<string, string> + `?? HEALTH_BADGE_STYLES.healthy` / `?? level`
               → a new level renders SILENTLY GREEN as "Healthy"
  Only BusinessesClient.tsx and OverviewClient.tsx import the shared owner. The business
  DETAIL page — the third health surface — is the copy. This is exactly the failure mode
  spec §5.1 named ("would disagree with the Health column on /admin/businesses").

  BLOCKER TO HANDLE, NOT ROUTE AROUND: BusinessDetailClient receives data through
  types.ts:11-19 bridged by `as unknown as DetailData` (page.tsx:52). That cast is WHY the
  loose typing was tolerable. Delete the cast or type the level field properly.
  Re-casting to satisfy the shared component reintroduces the defect with extra steps.

  The private copy carries a confident comment (:40-44) explaining why it is not
  StatusBadge — accurate when written, now a stale rationale guarding a duplicate. Remove it.

TARGET B — one churn derivation. Extend business-summary.ts; do NOT create a third module.

  Export the metrics CTE fragment and the responseTimeTrend + computeChurnRiskScore
  composition, then rewrite:
    - src/lib/admin/business-detail/queries.ts:218-259   metrics CTE → the fragment
    - src/lib/admin/business-detail/mappers.ts:261-276   churn composition → the export
    - mappers.ts:258 / business-detail-service.ts:44     twin isSubscriptionTier guard +
                                                          identical throw string → one

FLOWCHART: 01-flowcharts/f1-admin-business-console.md

ALSO FIX THE DOC: .claude/CLAUDE.md claims "Health presentation has ONE owner,
src/components/admin/ui/HealthBadge.tsx". False as written until Target A lands.

ANTI-PATTERN GUARDS:
  - Do NOT create src/lib/admin/churn-metrics.ts. #833 established business-summary.ts as
    the owner of this query family and the tenant-scope allowlist is pinned to it at 396;
    a third module re-opens a baseline that just closed.
  - Keep the at-risk list FILTERED THEN CAPPED (overview-service.ts:171→:172→:179).
    Capping first surfaces healthy rows — the bug its tests exist to catch.
  - Keep ranking in TypeScript. computeChurnRiskScore has no SQL superset (account age makes
    every score non-zero); "ORDER BY ... LIMIT" is a named rejected alternative (spec §5.1).
  - Keep OVERVIEW_AT_RISK_LIMIT in overview-service.ts. The spec asks for page-sizes.ts but
    APP_LEAF_IMPORT_BAN makes that ILLEGAL (src/lib/** may not import @/app/**).
  - buildBusinessSummary must keep its `fallow-ignore-next-line complexity` comment.
  - Preserve sequential reads (#773). Do not "optimize" into Promise.all.
```

---

## H5 — Invariant #9b fix + mechanical bundle (P6 + P8)

```
/make-plan

One defect fix plus a behaviour-preserving cleanup bundle. No design decisions.

DEFECT — invariant #9b collapse (also crosses invariant #13):
  src/lib/locations/multi-location-mode.ts:12   featureEnabled && activeLocationCount > 1  ← owner
  src/hooks/useLocationVoiceForm.ts:196         locations.length > 1                       ← flag dropped

  The hook re-derives multi-location MODE client-side without the flag. Invariant #9b says
  the three checks (mode / visibility / eligibility) must never collapse to one boolean;
  invariant #13 says the browser learns flag state from the server, never decides it.
  Reachable failure: an account with >1 active location and the flag OFF renders
  multi-location voice UI. Fix: pass the server-resolved flag through the page payload and
  call shouldUseMultiLocationSettings. No audit covers this file — ci:static-policy's check
  is file-local by its own admission (static-policy-audit.ts:139-148).

BUNDLE (behaviour-preserving):
  - src/lib/dashboard/aggregate-service.ts:114-129 and :177-182 each start two DB operations
    before awaiting either; site 2 runs the 8-query fetchPerLocationAggregateSlices
    concurrently with getAccountRecentReviews. Every sibling read holds ONE slot and carries
    a do-not-revert comment. Sequence these (await the fatal read, then the degradable),
    KEEPING Promise.allSettled's Per-widget degradation semantics. Post-#773 this is bounded
    latency, not a wedge — so if the concurrency is deliberate, a comment saying so resolves
    it equally well. Either outcome, just not silence.
  - SingleLocationBrief (AggregateIntelligenceBriefCard.tsx:69-104) → IntelligenceBriefCard
    (kpi/IntelligenceBriefCard.tsx:11-42); drop the unused displayName prop.
  - Skeleton markup ×4 and error card ×3 → DashboardStatePanel.tsx:52, which already owns both.
  - buildPatch + dirtyCount: useSettingsForm.ts:45,:152 vs useLocationVoiceForm.ts:113,:205 → one.
  - Org-default SELECT ×3 → one: dashboard/channels/route.ts:59,
    settings/channels/page.tsx:71, business-channels-service.ts:115.
  - telegramAvailable/whatsappAvailable byte-identical: route.ts:22 vs page.tsx:32 → one.
  - /settings default spelled twice: page.tsx:4, SettingsSidebar.tsx:42 → one.
  - DELETE withRateLimit (route-helpers.ts:31) and withSession (:81) — zero production callers.
  - formatRelative ×2: BusinessesClient.tsx:32 (F1) vs ReviewFeedCard.tsx:334 (F2) → one.
  - resolveFunnelEntry re-spellings → call the pure owner (funnel-entry.ts:81):
    finish-signup:215-218, onboarding/start/page.tsx:67, onboarding/pay/page.tsx:90.
  - (authenticated)/layout.tsx:95 checks account_id but never role — add the role check.
  - Four hand-rolled createServerClient preambles → cookieBackedServerClient (db/auth.ts:26):
    page-gate.ts:44, require-owner-access.ts:44, (authenticated)/layout.tsx:63.
    EXCEPT proxy.ts:50 — middleware context; verify before touching. Forcing that one is the
    "abstraction for its own sake" anti-pattern.

FLOWCHARTS: 01-flowcharts/f2-owner-dashboard-portal.md, f3-owner-settings.md, s1-auth-gate-seam.md

EXPLICITLY OUT OF SCOPE: the twin voice write paths (api/settings/route.ts:42-48,:23-26,:69
vs api/settings/voice/route.ts:117-122,:105-108,:178). Two routes with DIFFERENT GATES
writing the same four businesses columns is a design decision, not a cleanup. Needs its own
scoping — do not fold it in here.

ANTI-PATTERN GUARDS:
  - Keep the three multi-location checks THREE functions. The fix is to CALL the owner, not
    to merge the trio.
  - Do not collapse Promise.allSettled into Promise.all — Per-widget degradation is a locked
    CONTEXT.md term.
  - resolveFunnelEntry must stay PURE (takes onboardingDemoEnabled() as an argument, reads no
    flag/env/DB). Do not let it start reading a flag to serve a new caller.
  - Do not resurrect the deleted paymentUrl.
```

---

## H6 — Census: live-DB-only pins are inert in CI

> **EXECUTED 2026-08-15 — PREMISE REFUTED.** The census ran and found CI's `test`
> job DOES run the live-DB lane (`ci.yml:182-212`, 91 suites measured). The prompt
> below is retained verbatim as the record of what was asked; the branch
> `chore/pf-h6-live-db-pins-census` holds the census (`07-live-db-pins-census.md`)
> and the real fix — pinning the previously-unpinned CI gate. Do not re-run this
> prompt as written.

```
/make-plan

INVESTIGATION FIRST, then a plan. Do not start by writing code.

FINDING: correctly-written tests pinning tenant-isolation and precedence behaviour exist but
NO GATE RUNS THEM. Confirmed for one case during the 2026-08-15 architecture pass:
suppressionMatchSql's global-wins ordering (ORDER BY (s.scope = 'global') DESC) and its
account scoping (s.account_id = ${accountId}) are killed ONLY by
src/lib/solicitation/__tests__/suppression.integration.test.ts.

WHY THAT MEANS "INERT": per .claude/CLAUDE.md, integration suites self-skip in CI when
TEST_DATABASE_POOL_URL is unset, and `pnpm test:integration` hard-gates ONLY the publisher
edit-existing-reply suite. So these pins pass locally for whoever has a DB and are absent
from the gate entirely.

TASK:
  1. Enumerate every *.integration.test.ts suite and identify which assertions are its
     EXCLUSIVE pins — behaviour no parallel-project test also covers. Mutation-check to
     prove exclusivity; do not infer it from names.
  2. Rank by what the pin protects. Tenant isolation and approval-path invariants first.
  3. Propose the narrowest fix that puts the high-value ones on a gate. Options to weigh —
     do not assume one: widen `pnpm test:integration`'s hard-gate list; add a CI job with a
     postgres service container (fallow.yml already stands one up — precedent exists);
     or port specific pins to the parallel project with a mock that can actually reach the
     guarded query.

CONTEXT: the same pass found 15 guards passing for the wrong reason in the PARALLEL suite.
This is the mirror class — guards that are correct but ungated. Both produce the same
outcome: a green gate that would not notice a regression.

ANTI-PATTERN GUARDS:
  - Do NOT convert integration suites to unit tests wholesale. Several exist precisely
    because a mock cannot reach the guarded query — that is the #833 defect shape.
  - Do NOT execute DDL at run time in any live-DB file. Provision with `pnpm test:db:setup`;
    assert with assertSchemaReady. ci:live-db-suites enforces this (AST-based, #694/#706).
  - A live-DB suite must be named *.integration.test.ts so vitest serializes it — concurrent
    DDL deadlocks (40P01).
  - Do not raise DB_POOL_MAX to make anything pass.
```
