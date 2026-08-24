I’m using the repository’s `verify-spec` workflow because this is an evidence-backed plan/spec audit. I’ll start with the eval’s 19 promised tests, then verify every cited artifact and cross-check plan assumptions against the amendments and architecture invariants.

---

The audit is larger than 15 verifiable claims, so the selected workflow calls for sectioned verification. I’m splitting the evidence work into eval coverage, implementation/code assumptions, and database/runtime semantics, while I independently read all governing text and re-check any surprising result.

---

The eval suite is demonstrably under-specified: direct-unit tests can stay green while the production hook, release-cycle phase wiring, worker registration, and settings UI/API are absent. I’m doing the final evidence pass now, including the transaction races and all 15 cited artifacts.

---

Baseline gates are clean: lint, typecheck, and 12,656 non-DB tests passed; 47 DB-gated files were skipped because `TEST_DATABASE_POOL_URL` is unset. I’m checking the repository’s static tenant/RLS/flag policies next so the review distinguishes plan defects from pre-existing baseline failures.

---

The plan requires revision. Yes: all 19 promised tests can pass while production wiring is absent, owner approval is broken by a race, release behavior violates the winning amendments, and the settings/worker surfaces are incomplete.

## Primary: missing failing tests

The 19 titles at [plan:99](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:99) mostly exercise proposed helpers directly. They do not prove the feature works end-to-end.

### Approval and generation

- **MISSING FAILING TEST — `"the initial ask-generation finale auto-approves and enqueues the Veto notice when every gate holds"`** — pins the actual `generateAsksForBatch` hook; otherwise all verb tests pass with no production caller. [plan:413](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:413)

- **MISSING FAILING TEST — `"regenerateAsk never invokes the auto-approval lane"`** — pins the accepted initial-generation-only deviation. [deviations:15](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-deviations.md:15)

- **MISSING FAILING TEST — `"turning the auto flag on does not retroactively approve a previously built batch"`** — pins the intake’s explicit no-sweep edge. [intake:39](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:39)

- **MISSING FAILING TEST — `"a finale with zero live rendered Outreach rows closes or fails without attempting auto approval"`** — pins the `tally.alive > 0 && close.status === 'not_settled'` guard. [plan:421](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:421)

- **MISSING FAILING TEST — `"preserves an owner approval committed after the final render but before the generation finale"`** — pins the real race: child persistence commits at [ask-generation.ts:1090](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/ask-generation.ts:1090), owner approval can then win at [approval.ts:384](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/approval.ts:384), and the later auto CAS must quietly preserve it instead of throwing and retrying the finale forever.

- **MISSING FAILING TEST — `"an opt-out or Governor suspension committed before the auto-approval CAS wins the race"`** — pins account-lock serialization; settings and suspension writers lock the account at [settings.ts:381](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:381) and [suspension.ts:271](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/suspension.ts:271), while the proposed reader takes no account lock.

- **MISSING FAILING TEST — `"rolls back approval and batch_approved when veto-notice enqueue fails"`** — pins transactional-outbox invariant #2, not merely successful coexistence of the rows. [.claude/CLAUDE.md:43](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:43)

- **MISSING FAILING TEST — `"autoApproveBatch rethrows a 23505 from every constraint except solicitation_batches_one_active_send_per_business"`** — pins named-constraint handling rather than classifying unrelated corruption as `slot_held`. [plan:390](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:390)

- **MISSING FAILING TEST — `"the database-backed gate approves a trialing SubscriptionTier.AUTOPILOT account"`** — pins both the real tier value and invariant #11’s `trialing` full-access behavior. [tier-config.ts:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/accounts/tier-config.ts:12), [.claude/CLAUDE.md:69](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:69)

- **MISSING FAILING TEST — `"the real generation finale leaves the batch built when SOLICITATION_SEND_ENABLED is off"`** — pins the master flag at the production condition reader, not only the pure property function. [D20:999](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:999)

- **MISSING FAILING TEST — `"a Reply row or location override alone never enables Solicitation auto approval"`** — pins the exact tuple `persona='solicitation'`, `action_class='sending'`, `location_id IS NULL`. [D20:999](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:999)

- **MISSING FAILING TEST — `"a suspended policy on another account never blocks this account"`** — pins tenant scope around D19’s “any row for the account.” [D19:963](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:963)

- **MISSING FAILING TEST — `"Judge unavailability at approval time does not block auto approval"`** — pins the intake’s decision that Judge remains release-owned. [intake:30](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:30)

### Veto anchoring and Halt

- **MISSING FAILING TEST — `"runReleaseCycle invokes the Veto-anchor phase before release and reports the anchored count"`** — pins phase wiring and ordering; all direct `anchorVetoDeadlines` tests can pass when the cycle never calls it. [plan:547](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:547)

- **MISSING FAILING TEST — `"one corrupt anchor candidate does not prevent a healthy sibling from anchoring"`** — pins promised per-candidate transaction isolation. [plan:519](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:519)

- **MISSING FAILING TEST — `"sent-but-not-delivered, wrong-template, and different-batch delivery rows never anchor"`** — pins `delivered_at IS NOT NULL`, the template literal, and `entity_id` correlation. D9 expressly rejects provider acceptance or row existence. [D9:571](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:571)

- **MISSING FAILING TEST — `"the Veto anchor preserves delivered_at microseconds when calculating the deadline"`** — pins SQL-side arithmetic and prevents a JS `Date` round trip. [.claude/CLAUDE.md:209](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:209)

- **MISSING FAILING TEST — `"anchoring writes exactly one veto_window_granted step with actor, first delivery, granted minutes, and deadline"`** — pins D9’s append-only immutable grant record, not merely the batch column. [D9:585](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:585)

- **MISSING FAILING TEST — `"a concurrent owner Halt that wins the batch lock prevents both the deadline and veto_window_granted step"`** — pins the race rather than a pre-halted fixture. [plan:519](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:519)

- **MISSING FAILING TEST — `"an owner can halt an auto_policy batch during its Veto window as owner_veto and cancel every unsent row"`** — pins the actual owner action and authorization promised by D9/intake. [D9:598](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:598), [intake:18](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:18)

### Release-time recheck

- **MISSING FAILING TEST — `"a Governor suspension latched after approval downgrades an unreleased auto_policy batch as policy_suspended"`** — the promised titles cover only flag, tier, and row removal, omitting the fourth intake reason. [intake:19](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:19)

- **MISSING FAILING TEST — `"approval_downgraded records the exact auto-lane reason and never judge_unavailable"`** — pins the durable reason. Existing `downgradeApproval` hard-codes `judge_unavailable`. [release.ts:1800](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/release.ts:1800)

- **MISSING FAILING TEST — `"SOLICITATION_SEND_ENABLED off holds an auto_policy batch unchanged and releases nothing"`** — pins the winning B15/master-switch behavior instead of the proposed downgrade. [amendments:513](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:513)

- **MISSING FAILING TEST — `"a subscription lapse holds an auto_policy batch unchanged and resumes after recovery"`** — pins B14; subscription loss is recoverable withholding, not `autopilot_entitlement_lost`. [amendments:428](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:428)

- **MISSING FAILING TEST — `"a mid-drip or expired auto_policy batch is held when an auto condition fails, never unapproved"`** — pins coherent state after a send and after the reapproval window closes. [D18:909](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:909), [release.ts:1788](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/release.ts:1788)

- **MISSING FAILING TEST — `"an auto-condition failure wins over simultaneous Judge unavailability before first release"`** — pins the promised auto-before-Judge order and its reason/counter. [plan:586](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:586)

- **MISSING FAILING TEST — `"ReleaseCycleReport increments only the successful autoDowngradedByReason bucket and never Judge downgraded"`** — pins observability vocabulary and successful-CAS-only counting. [plan:594](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:594)

- **MISSING FAILING TEST — `"policy deletion or suspension committed before the release CAS prevents that release"`** — pins the release-time condition read and state transition under the authoritative locks. The plan currently reads through `ctx.sql` before opening the downgrade/release transaction. [plan:590](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:590)

### Veto-notice worker

- **MISSING FAILING TEST — `"the solicitation_veto_notice Worker is registered in queue routing, the workers map, failure sinks, and health monitoring"`** — pins production reachability, not dispatch in isolation. [plan:480](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:480)

- **MISSING FAILING TEST — `"the Worker logs systemic failure when no Veto-notice channels are enrolled"`** — pins the intake’s zero-enrollment case; the cloned precedent quietly returns before dispatch when enrollment is empty. [PendingPostNoticeWorker.ts:76](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts:76), [intake:34](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:34)

- **MISSING FAILING TEST — `"claimSolicitationVetoNoticeDelivery deduplicates retries through the exact partial-index predicate"`** — pins claim-before-send and byte-for-byte `ON CONFLICT` inference. [.claude/CLAUDE.md:197](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:197)

- **MISSING FAILING TEST — `"an abandoned pending Veto-delivery claim becomes retryable after the stale-claim interval"`** — pins the crash-recovery behavior in the precedent helper. [delivery.ts:151](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/notifications/delivery.ts:151)

- **MISSING FAILING TEST — `"one failed Veto-notice channel does not prevent later enrolled channels from delivering"`** — pins per-channel exception isolation. [dispatch.ts:120](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/dispatch.ts:120)

- **MISSING FAILING TEST — `"a retry after anchoring sends unclaimed channels without resending claimed channels"`** — pins the explicit “anchored is not a skip” rule. [plan:467](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:467)

- **MISSING FAILING TEST — `"a queued notice is quietly skipped after downgrade, Halt, or send closure"`** — pins stale-job safety at Worker/context level. [plan:467](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:467)

- **MISSING FAILING TEST — `"an unset WhatsApp Veto template skips only WhatsApp while healthy channels continue"`** — pins pre-filter-before-claim and channel isolation. [plan:476](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:476)

- **MISSING FAILING TEST — `"the Veto-notice CTA is NEXT_PUBLIC_APP_URL/dashboard/requests and contains no approval token"`** — pins the real Requests route. The plan says `/requests` and cites a builder the precedent does not contain. [plan:471](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:471), [MobileTabBar.test.tsx:81](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/components/dashboard/__tests__/MobileTabBar.test.tsx:81)

- **MISSING FAILING TEST — `"a hard bounce for solicitation_veto_notice marks owner_email_bounced"`** — pins owner-directed classification; the existing allowlist does not include the new template. [resend.ts:90](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/ingress/resend.ts:90)

### Settings/API/UI

- **MISSING FAILING TEST — `"enabling Solicitation auto approval requires standard expansion confirmation and writes nothing without it"`** — pins the locked confirmation requirement. [plan:647](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:647)

- **MISSING FAILING TEST — `"PATCH round-trips a valid dailySendCap and vetoWindowMinutes and defaults an omitted window to 60"`** — pins valid persistence and D20’s default; rejection-only tests allow valid values to be ignored. [D20:971](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:971)

- **MISSING FAILING TEST — `"GET marks Solicitation available only when both server flags and tierGrantsAutopilot hold"`** — pins server-authoritative visibility. [.claude/CLAUDE.md:73](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:73)

- **MISSING FAILING TEST — `"the API route accepts the Solicitation operation and forwards and returns the Solicitation slice"`** — pins schema/route wiring; service tests alone cannot detect a rejecting strict schema. [types.ts:159](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/types.ts:159), [route.ts:80](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/api/settings/auto-approval/route.ts:80)

- **MISSING FAILING TEST — `"AutoApprovalClient conditionally renders the Solicitation card and submits toggle, cap, and window operations"`** — pins the entire promised user-visible surface. [AutoApprovalClient.tsx:113](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:113)

- **MISSING FAILING TEST — `"enabling Solicitation twice upserts exactly one account-default row through WHERE location_id IS NULL"`** — pins idempotency and the partial-index conflict target. [settings.ts:727](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:727)

- **MISSING FAILING TEST — `"disabling Solicitation deletes only its account-default sending row and preserves Reply and location policies"`** — pins deletion scope; the promised deletion title would pass after an over-broad account-wide delete. [D20:999](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:999)

- **MISSING FAILING TEST — `"a trialing Autopilot account can enable Solicitation auto approval"`** — pins invariant #11 at the settings write seam. [.claude/CLAUDE.md:69](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:69)

## Secondary plan findings

All findings below are high-confidence.

1. **The proposed “CAS zero is impossible” claim is false.** The final child persists before the finale transaction begins at [ask-generation.ts:1090](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/ask-generation.ts:1090). An owner can approve during that gap at [approval.ts:384](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/approval.ts:384). The finale then locks the already-approved row and the proposed auto CAS matches zero; [plan:394](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:394) says to throw. That rolls back outbox completion and creates a retry loop. Treat already-owner-approved as a quiet owner-won/not-attempted outcome.

2. **Approval and release condition reads are not serialized with policy writers.** The finale owns the batch lock but does not take the account lock used by settings/Governor. The release mapper is called outside the authoritative batch transaction at [plan:590](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:590). A deletion or suspension can commit after the read but before approval/release. Use the documented mixed-lane order—batch first, then `lockAutonomyAccount`—and re-read conditions under those locks. [account-lock.ts:10](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/account-lock.ts:10)

3. **The release mapper contradicts the winning amendments.** [plan:583](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:583) downgrades for either flag and subscription loss. B14 requires subscription lapse to hold and recover, [amendments:428](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:428), while B15 says master send flag-off defers rather than terminalizes, [amendments:513](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:513). Only the auto-approval flag, actual tier loss, policy removal, and suspension belong in auto downgrade.

4. **Reusing `downgradeApproval` as written records a false Judge reason.** It hard-codes `{reason: 'judge_unavailable'}` at [release.ts:1800](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/release.ts:1800). The plan then says the new path uses the same call at [plan:602](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:602). Parameterize the existing verb with a typed reason and have Judge pass `judge_unavailable`; do not clone the split body and retain a lying spine record.

5. **The property generator has no positive Autopilot arm.** It generates `autopilot_monthly` and `copilot_monthly` at [plan:321](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:321), but the real values are `autopilot` and `copilot` at [tier-config.ts:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/accounts/tier-config.ts:12). An implementation that always declines can therefore satisfy the proposed property. Import `SubscriptionTier`.

6. **Task 8’s PATCH shape is incompatible with the current API.** The plan proposes an optional top-level `solicitation` object at [plan:633](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:633), but the route accepts a strict `operation` discriminated union at [types.ts:159](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/types.ts:159). Add explicit Solicitation operations and reuse the existing confirmation/audit transaction. The suggested `randomUUID()` also conflicts with this table’s established UUIDv7 convention and current module behavior. [migration 055:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/supabase/migrations/055_auto_approval_policy.sql:12), [settings.ts:227](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:227)

7. **The worker’s cited link precedent is factually wrong.** `pending-post-notice/context.ts` only loads database context; link construction happens in the Worker/dispatch path and creates `/approve/{token}` at [dispatch.ts:153](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/dispatch.ts:153). The actual Requests route is `/dashboard/requests`. The plan must specify direct construction from `NEXT_PUBLIC_APP_URL`, without an approval token.

8. **Hard-bounce support is outside the allowed edit surface.** `solicitation_veto_notice` must be added to `OWNER_DIRECTED_TEMPLATES` at [resend.ts:90](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/ingress/resend.ts:90), but `worker/ingress/**` is absent from [intake:51](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:51). Without an accepted surface amendment, a bounced first Veto email will not suppress subsequent owner email attempts.

9. **Savepoints are supported, but the plan must state their exact use.** In postgres.js 3.4.9, the failing statement must run through the savepoint handle and the `23505` must escape the callback so postgres.js issues `ROLLBACK TO`; catch it outside. [postgres source:258](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/node_modules/postgres/src/index.js:258), [existing precedent:477](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/reviews/import-consent.ts:477). Catching inside the callback or running the CAS through the outer `tx` leaves the parent transaction aborted.

10. **PgBouncer and the two planned notice predicates are otherwise sound if implemented literally.** The finale lock is inside `sql.begin` at [ask-generation.ts:1131](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/ask-generation.ts:1131), and the plan promises a per-candidate transaction for anchoring. The migration predicates at [plan:208](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:208) match the established literal shapes. The remaining transaction defect is the unlocked condition-read TOCTOU above, not a currently specified standalone `FOR UPDATE`.

## Mandatory cited-artifact check

| # | Status | Evidence |
|---|---|---|
| 1 | **EXISTS** | [ask-generation.ts:1131](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/ask-generation.ts:1131) opens the finale transaction; outbox CAS 1134, advisory lock 1139, batch `FOR UPDATE` 1143, steps 1156, tally 1167, close 1172. |
| 2 | **EXISTS** | [approval.ts:269](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/approval.ts:269) contains `approveBatch`; approval CAS 384, `batch_approved` 421, named-index comment 300. |
| 3 | **EXISTS** | [release.ts:141](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/release.ts:141) has `ReleaseCycleReport`; phase machinery 315–409, candidate type without `approval_method` 1098, selector 1523, `applyJudgeSplit` 1692, `downgradeApproval` 1755. |
| 4 | **EXISTS** | The family has exactly [PendingPostNoticeWorker.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts:1), [context.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/context.ts:1), [dispatch.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/dispatch.ts:1), and [errors.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/errors.ts:1); SID pre-filter is [dispatch.ts:92](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/dispatch.ts:92). |
| 5 | **EXISTS** | [delivery.ts:143](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/notifications/delivery.ts:143) defines `claimPendingPostNoticeDelivery`. |
| 6 | **EXISTS** | [job-outbox-helpers.ts:32](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/shared/job-outbox-helpers.ts:32) has `AGGREGATE_TYPE_SOLICITATION_BATCH`; helper and literal predicate are 357–383. |
| 7 | **EXISTS** | [migration 074:109](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/supabase/migrations/074_trust_dial_veto_window.sql:109) has the index pair; [076:74](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/supabase/migrations/076_judge_verdicts_governor.sql:74) adds `entity_id`; [091:109](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/supabase/migrations/091_send_mode_spine_lifecycle.sql:109) has approval consistency, one-active index at 180, persona/action checks at 461. |
| 8 | **MISMATCH** | [tier-config.ts:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/accounts/tier-config.ts:12) says the IDs are `copilot` and `autopilot`, and `tierGrantsAutopilot` is at 47. The plan’s `_monthly` values are wrong. |
| 9 | **EXISTS** | Service seam exists in [settings.ts:163](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:163), response/schema in [types.ts:139](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/types.ts:139), route at [route.ts:21](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/api/settings/auto-approval/route.ts:21), client at [AutoApprovalClient.tsx:113](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:113). |
| 10 | **EXISTS** | [sentiment.test.ts:45](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/reviews/__tests__/sentiment.test.ts:45) has the fast-check `invariants` block. |
| 11 | **EXISTS** | [config/flags.ts:21](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/config/flags.ts:21) defines `readFlag`; [solicitation/flags.ts:6](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/flags.ts:6) contains current accessors. |
| 12 | **EXISTS** | [config/worker.ts:24](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/config/worker.ts:24) defines `rawOpt`; pending SID uses it at 170. |
| 13 | **EXISTS** | [feature-state.sh:1](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/scripts/feature-state.sh:1) and [verify-gate.sh:1](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/scripts/verify-gate.sh:1) both exist. |
| 14 | **EXISTS** | [release.integration.test.ts:1](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/__tests__/release.integration.test.ts:1) exists; the existing settings unit file is [settings.test.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/__tests__/settings.test.ts:1). |
| 15 | **EXISTS** | Installed postgres is 3.4.9; savepoint overloads are at [types/index.d.ts:723](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/node_modules/postgres/types/index.d.ts:723), implementation at [src/index.js:258](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/node_modules/postgres/src/index.js:258), and correct repository usage at [import-consent.ts:563](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/reviews/import-consent.ts:563). |

## Verification baseline

- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm test`: 951 files passed, 47 skipped; 12,656 tests passed, 338 skipped. DB suites were skipped because `TEST_DATABASE_POOL_URL` is unset.
- `pnpm ci:tenant-scope`: passed, 390/390.
- `pnpm ci:rls-audit`: static coverage passed; live DB portion skipped.
- `pnpm ci:static-policy` and `pnpm ci:analytics-events`: passed.

## Low-confidence appendix

One unresolved design question: Telegram currently returns provider acceptance at [telegram-channel.ts:105](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/notifications/channels/telegram-channel.ts:105), while shared finalization writes only `sent_at` at [delivery.ts:310](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/notifications/delivery.ts:310), and I found no Telegram delivery-confirmation ingress. A Telegram-only account may therefore receive the notice but never anchor. The fail-closed expiry is safe, but the intended product behavior should be stated before adding a test.

VERDICT: REVISE — the eval misses production seams and concurrency failures; the plan violates B14/B15, mishandles owner-approval and policy races, records false downgrade reasons, and mis-specifies the settings and worker integrations.

---

The stop hook found a real workflow blocker: `feature-surface` is red. I’ll inspect the gate output and compare the reported paths with the intake/deviations before deciding whether this is an implementation-surface defect or an expected audit artifact.

---

The red gate is not a code failure. It is `docs_only`, and the sole failure is that two future create-paths in the intake do not exist yet: migration 113 and the new worker directory. I’m consulting the guarded feature workflow before changing anything, because narrowing those paths would make the approved implementation plan impossible and broadening them requires sign-off.

---

The blocker is expected at plan-review stage, not a code failure. `feature-surface` rejects two approved future create-paths because they do not exist until implementation:

- `supabase/migrations/113_solicitation_auto_approval_lane.sql`
- `worker/jobs/solicitation-veto-notice/**`

This is already documented in [631-auto-approval-lane-handoff.md](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-handoff.md). Making the gate green now would require starting implementation, dishonestly narrowing the intake, widening its surface with approval, or bypassing/falsifying the guard.

No safe in-scope mutation is authorized by the review request. Please authorize either implementation or a feature-surface workflow amendment; otherwise this plan-review branch must remain intentionally red.

---

## 1. Confidence-filtered findings

All findings below are at least 80% confidence.

1. **The proposed auto-approval CAS can lose to owner approval, contrary to the plan’s “impossible” assertion.** The last child render commits outside the finale transaction at [ask-generation.ts:1090](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/ask-generation.ts:1090). Before the finale begins at line 1131, an owner can approve through [approval.ts:384](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/approval.ts:384). The finale then locks an already-approved row, and the proposed auto CAS matches zero; [plan:394](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:394) says to throw. That rolls back outbox completion and can retry forever. A pre-existing owner approval must produce a quiet `owner_won`/`not_attempted` outcome.

2. **Approval-time policy reads are not serialized with settings or Governor writers.** The finale holds the batch row but does not take the account lock used by settings at [settings.ts:381](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:381) and suspension at [suspension.ts:271](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/suspension.ts:271). An opt-out or suspension can commit after eligibility is read but before approval is stamped. This violates D19’s account-wide suspension guarantee at [governing spec:963](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:963). Use the documented batch-then-account lock order from [account-lock.ts:10](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/account-lock.ts:10), then read conditions and CAS under those locks.

3. **Release-time condition checking has a TOCTOU window.** The plan calls `autoReleaseBlockReason(ctx.sql, …)` before the transactional downgrade/release operation at [plan:590](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:590). A policy can be deleted or suspended after that read and before `releaseOutreachRow` queues a recipient. The condition read must be repeated inside the authoritative batch/account transaction before the release CAS.

4. **The proposed release mapper contradicts the winning amendments.** [plan:583](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:583) maps either flag and subscription loss to downgrade reasons. B14 requires subscription lapse to hold remaining rows and resume after recovery, [amendments:428](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:428), while B15 says master send flag-off defers rather than terminalizes, [amendments:513](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:513). Only the auto-approval flag, actual tier loss, policy removal, and suspension belong in auto downgrade.

5. **The proposed downgrade path writes a false durable reason.** Existing `downgradeApproval` always records `judge_unavailable` at [release.ts:1800](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/release.ts:1800), while [plan:602](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:602) says the auto path uses that same call. A policy suspension would therefore produce a spine record claiming Judge failed. Parameterize the existing verb with a typed reason and reuse one shared split implementation.

6. **The property test’s positive arm is unreachable.** The plan generates `autopilot_monthly` and `copilot_monthly` at [plan:321](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:321), but the authoritative values are `autopilot` and `copilot` at [tier-config.ts:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/accounts/tier-config.ts:12). `tierGrantsAutopilot` consequently returns false for every generated non-null tier, so an implementation that always declines can pass the property.

7. **Task 8’s proposed PATCH shape is incompatible with the existing API contract.** The plan adds an optional top-level `solicitation` object at [plan:633](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:633), but the route validates a strict `operation` discriminated union at [types.ts:159](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/types.ts:159) and [route.ts:80](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/api/settings/auto-approval/route.ts:80). The proposed body would receive HTTP 400 unless the entire contract were redesigned. Add explicit Solicitation operations and reuse the current confirmation/audit transaction.

8. **The settings upsert is underspecified against a partial unique index.** Existing account-default upserts explicitly use `ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL` at [settings.ts:727](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:727). Task 8 merely says “upsert.” Omitting or parameterizing the predicate produces “no unique or exclusion constraint matching” under Postgres. The literal predicate must be included exactly.

9. **The plan suggests the wrong ID generator for `auto_approval_policies`.** [plan:644](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:644) suggests `randomUUID()`, while the table declares the UUIDv7 application convention at [migration 055:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/supabase/migrations/055_auto_approval_policy.sql:12) and the current settings module uses `uuidv7()` at [settings.ts:227](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:227).

10. **The veto-notice link precedent is factually wrong.** [plan:471](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:471) specifies `/requests` and claims `pending-post-notice/context.ts` builds the dashboard link. That context module only loads data; dispatch creates a tokenized `/approve/{token}` URL at [dispatch.ts:153](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/dispatch.ts:153). The real Requests route is `/dashboard/requests`, pinned at [MobileTabBar.test.tsx:81](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/components/dashboard/__tests__/MobileTabBar.test.tsx:81). The new notice should directly construct `${appUrl}/dashboard/requests` without a token.

11. **Blindly cloning the pending-notice worker misses the intake’s no-enrollment failure signal.** The precedent quietly completes when enrollment is empty at [PendingPostNoticeWorker.ts:76](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts:76), while the intake requires a systemic-failure log when no channels are enrolled at [intake:34](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:34). A dispatch-only zero-delivery test does not exercise that early worker return.

12. **Hard-bounce classification is missing and outside the intake edit surface.** The new owner-directed template must be added to `OWNER_DIRECTED_TEMPLATES` at [resend.ts:90](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/ingress/resend.ts:90), but `worker/ingress/**` is absent from [intake:51](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:51). Otherwise a hard-bounced first Veto email does not set `owner_email_bounced`, and subsequent attempts continue targeting the dead address. This needs an approved surface amendment.

13. **postgres.js savepoints exist, but the plan does not pin their required control flow.** The failing CAS must execute through the savepoint handle, and `23505` must escape the callback so postgres.js issues `ROLLBACK TO` at [postgres/index.js:258](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/node_modules/postgres/src/index.js:258). Catch it outside, as explained at [import-consent.ts:477](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/reviews/import-consent.ts:477). Catching inside the callback or running the CAS through outer `tx` leaves the parent transaction in `25P02`.

14. **The cited finale does not have a PgBouncer lock bug, but the proposed release reader does.** The current finale’s `FOR UPDATE` is correctly inside `sql.begin` at [ask-generation.ts:1131](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/ask-generation.ts:1131). The anchor plan also promises per-candidate transactions. The unsafe part is the plain release condition read outside the authoritative transaction at [plan:590](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:590); adding a standalone `FOR UPDATE` there would remain a no-op under the rule at [.claude/CLAUDE.md:205](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:205).

## 2. MISSING FAILING TEST list

### Approval and generation

- **MISSING FAILING TEST — `"the initial ask-generation finale auto-approves and enqueues the Veto notice when every gate holds"`** — pins the actual `generateAsksForBatch` production hook; direct `autoApproveBatch` tests pass if the hook is omitted. [plan:413](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:413)

- **MISSING FAILING TEST — `"regenerateAsk never invokes the auto-approval lane"`** — pins the accepted initial-generation-only deviation. [deviations:15](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-deviations.md:15)

- **MISSING FAILING TEST — `"turning the auto flag on does not retroactively approve a previously built batch"`** — pins the intake’s explicit no-sweep edge. [intake:39](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:39)

- **MISSING FAILING TEST — `"a generation finale with zero live rendered Outreach rows closes or fails without attempting auto approval"`** — pins `tally.alive > 0` and `close.status === 'not_settled'`. [plan:421](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:421)

- **MISSING FAILING TEST — `"preserves an owner approval committed after the final render but before the generation finale"`** — pins the real interleaving and prevents the proposed zero-row CAS throw/retry loop. [ask-generation.ts:1090](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/ask-generation.ts:1090), [plan:394](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:394)

- **MISSING FAILING TEST — `"an opt-out or Governor suspension committed before the auto-approval CAS wins the race"`** — pins account-lock serialization and prevents approval from stale policy state. [suspension.ts:271](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/suspension.ts:271)

- **MISSING FAILING TEST — `"rolls back auto approval and batch_approved when veto-notice enqueue fails"`** — pins transactional-outbox invariant #2 rather than merely successful coexistence. [.claude/CLAUDE.md:43](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:43)

- **MISSING FAILING TEST — `"autoApproveBatch rethrows a 23505 from every constraint except solicitation_batches_one_active_send_per_business"`** — pins named-constraint handling and prevents unrelated corruption being mislabeled `slot_held`. [plan:390](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:390)

- **MISSING FAILING TEST — `"the database-backed gate approves a trialing SubscriptionTier.AUTOPILOT account"`** — pins the real tier constant and invariant #11’s trialing semantics. [tier-config.ts:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/accounts/tier-config.ts:12), [.claude/CLAUDE.md:69](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:69)

- **MISSING FAILING TEST — `"the real generation finale leaves the batch built when SOLICITATION_SEND_ENABLED is off"`** — pins the master flag in the database-backed evaluator rather than only a pure property function. [D20:999](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:999)

- **MISSING FAILING TEST — `"a Reply policy row or location override alone never enables Solicitation auto approval"`** — pins `persona='solicitation'`, `action_class='sending'`, and `location_id IS NULL`. [D20:999](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:999)

- **MISSING FAILING TEST — `"a suspended policy on another account never blocks this account"`** — pins tenant scope around D19’s account-wide suspension read. [D19:963](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:963)

- **MISSING FAILING TEST — `"Judge unavailability at approval time does not block auto approval"`** — pins the explicit decision that Judge is release-owned. [intake:30](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:30)

### Veto anchor and Halt

- **MISSING FAILING TEST — `"runReleaseCycle invokes the Veto-anchor phase before release and reports the anchored count"`** — pins phase wiring, order, and `ReleaseCycleReport`; direct helper tests pass if production never calls it. [plan:547](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:547)

- **MISSING FAILING TEST — `"one corrupt anchor candidate does not prevent a healthy sibling batch from anchoring"`** — pins promised per-candidate transaction isolation. [plan:519](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:519)

- **MISSING FAILING TEST — `"sent-but-not-delivered, wrong-template, and different-batch delivery rows never anchor"`** — pins `delivered_at IS NOT NULL`, the template literal, and `entity_id` correlation. [D9:571](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:571)

- **MISSING FAILING TEST — `"the Veto anchor preserves delivered_at microseconds when calculating the deadline"`** — pins SQL-side timestamp arithmetic and prevents JS `Date` truncation. [.claude/CLAUDE.md:209](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:209)

- **MISSING FAILING TEST — `"anchoring writes exactly one veto_window_granted step with actor, first delivery, granted minutes, and deadline"`** — pins D9’s complete append-only immutable grant record. [D9:585](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:585)

- **MISSING FAILING TEST — `"a concurrent owner Halt that wins the batch lock prevents both the deadline and veto_window_granted step"`** — pins the transaction race rather than a batch halted before scanning. [plan:519](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:519)

- **MISSING FAILING TEST — `"an owner can halt an auto_policy batch during its Veto window as owner_veto and cancel every unsent Outreach row"`** — pins the actual owner action, authorization, reason, and cancellation behavior promised by D9. [D9:598](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:598)

### Release-time recheck

- **MISSING FAILING TEST — `"a Governor suspension latched after approval downgrades an unreleased auto_policy batch as policy_suspended"`** — pins the fourth intake downgrade condition omitted from the 19 titles. [intake:19](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:19)

- **MISSING FAILING TEST — `"approval_downgraded records the exact auto-lane failure reason and never judge_unavailable"`** — pins truthful durable reason vocabulary for every auto downgrade. [release.ts:1800](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/release.ts:1800)

- **MISSING FAILING TEST — `"SOLICITATION_SEND_ENABLED off holds an auto_policy batch unchanged and releases nothing"`** — pins the master-switch behavior required by the winning amendment. [amendments:513](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:513)

- **MISSING FAILING TEST — `"a subscription lapse holds an auto_policy batch unchanged and resumes after recovery"`** — pins B14 and rejects downgrade to `autopilot_entitlement_lost`. [amendments:428](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:428)

- **MISSING FAILING TEST — `"a mid-drip or no-longer-reapprovable auto_policy batch is held when an auto condition fails, never unapproved"`** — pins coherent state after sending starts and after the approval window closes. [D18:909](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:909), [release.ts:1788](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/release.ts:1788)

- **MISSING FAILING TEST — `"an auto-condition failure wins over simultaneous Judge unavailability before first release"`** — pins auto-before-Judge order, reason, and counter ownership. [plan:586](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:586)

- **MISSING FAILING TEST — `"ReleaseCycleReport increments only the successful autoDowngradedByReason bucket and never Judge downgraded"`** — pins successful-CAS-only counting and observability vocabulary. [plan:594](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:594)

- **MISSING FAILING TEST — `"policy deletion or suspension committed before the release CAS prevents that release"`** — pins condition revalidation under the authoritative locks. [plan:590](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:590)

### Veto-notice worker

- **MISSING FAILING TEST — `"solicitation_veto_notice is registered in queue routing, the workers map, failure sinks, and health monitoring"`** — pins production reachability rather than dispatch in isolation. [plan:480](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:480)

- **MISSING FAILING TEST — `"the Worker logs systemic failure when no Veto-notice channels are enrolled"`** — pins the intake’s no-enrollment case across the worker’s early-return path. [PendingPostNoticeWorker.ts:76](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts:76), [intake:34](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/631-auto-approval-lane-intake.json:34)

- **MISSING FAILING TEST — `"claimSolicitationVetoNoticeDelivery deduplicates a retry through the exact partial-index predicate"`** — pins claim-before-send and byte-for-byte `ON CONFLICT` inference. [.claude/CLAUDE.md:197](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:197)

- **MISSING FAILING TEST — `"an abandoned pending Veto-delivery claim becomes retryable after the stale-claim interval"`** — pins crash recovery rather than permanent dedup blockage. [delivery.ts:151](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/notifications/delivery.ts:151)

- **MISSING FAILING TEST — `"one failed Veto-notice channel does not prevent later enrolled channels from delivering"`** — pins per-channel exception isolation. [dispatch.ts:120](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/dispatch.ts:120)

- **MISSING FAILING TEST — `"a retry after anchoring sends unclaimed channels without resending claimed channels"`** — pins the explicit “anchored is not a skip” behavior and channel-grain deduplication. [plan:467](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:467)

- **MISSING FAILING TEST — `"a queued Veto notice is quietly skipped after downgrade, Halt, or send closure"`** — pins stale-job safety in Worker/context, which dispatch-only tests bypass. [plan:467](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:467)

- **MISSING FAILING TEST — `"an unset WhatsApp Veto template skips only WhatsApp while healthy channels continue"`** — pins pre-filter-before-claim and channel isolation. [plan:476](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:476)

- **MISSING FAILING TEST — `"the Veto-notice CTA is NEXT_PUBLIC_APP_URL/dashboard/requests and contains no approval token"`** — pins the real Requests route and decision 7’s tokenless link. [MobileTabBar.test.tsx:81](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/components/dashboard/__tests__/MobileTabBar.test.tsx:81)

- **MISSING FAILING TEST — `"a hard bounce for solicitation_veto_notice marks owner_email_bounced"`** — pins owner-directed Resend classification and future email suppression. [resend.ts:90](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/ingress/resend.ts:90)

### Settings/API/UI

- **MISSING FAILING TEST — `"enabling Solicitation auto approval requires standard expansion confirmation and writes nothing without it"`** — pins locked decision 10. [plan:647](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md:647)

- **MISSING FAILING TEST — `"PATCH round-trips valid dailySendCap and vetoWindowMinutes and defaults an omitted Veto window to 60"`** — pins valid persistence and D20’s default; rejection-only coverage permits valid values to be ignored. [D20:971](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:971)

- **MISSING FAILING TEST — `"GET marks Solicitation available only when both server flags and tierGrantsAutopilot hold"`** — pins server-authoritative feature visibility. [.claude/CLAUDE.md:73](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:73)

- **MISSING FAILING TEST — `"the API accepts the Solicitation operation and forwards and returns the Solicitation slice"`** — pins schema and route wiring; service tests pass if the strict HTTP schema rejects the field. [types.ts:159](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/types.ts:159), [route.ts:80](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/api/settings/auto-approval/route.ts:80)

- **MISSING FAILING TEST — `"AutoApprovalClient renders the Solicitation card only when available and submits toggle, cap, and Veto-window operations"`** — pins the entire promised user-visible surface. [AutoApprovalClient.tsx:113](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:113)

- **MISSING FAILING TEST — `"enabling Solicitation twice upserts exactly one account-default row through WHERE location_id IS NULL"`** — pins idempotency and the exact partial-index target. [settings.ts:727](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:727)

- **MISSING FAILING TEST — `"disabling Solicitation deletes only its account-default sending row and preserves Reply and location policies"`** — pins deletion scope; the promised title permits an over-broad account-wide delete. [D20:999](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:999)

- **MISSING FAILING TEST — `"a trialing Autopilot account can enable Solicitation auto approval"`** — pins invariant #11 at the settings write seam. [.claude/CLAUDE.md:69](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/.claude/CLAUDE.md:69)

## 3. Mandatory cited-artifact check

1. **EXISTS** — [ask-generation.ts:1131](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/ask-generation.ts:1131) opens the finale transaction; outbox CAS is 1134, advisory lock 1139, batch `FOR UPDATE` 1143, `recordGenerationSteps` 1156, `readRenderTally` 1167, and `closeBatchIfSettled` 1172.

2. **EXISTS** — [approval.ts:269](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/approval.ts:269) contains `approveBatch`; the approval CAS is 384, `batch_approved` step 421, and the `solicitation_batches_one_active_send_per_business` comment 300.

3. **EXISTS** — [release.ts:141](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/release.ts:141) contains `ReleaseCycleReport`; phase helpers/list are 315–409, `ReleaseCandidateBatch` lacks `approval_method` at 1098, `selectReleaseCandidates` starts 1523, `applyJudgeSplit` is 1692, and `downgradeApproval` 1755.

4. **EXISTS** — The top-level family contains [PendingPostNoticeWorker.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts:1), [context.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/context.ts:1), [dispatch.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/dispatch.ts:1), and [errors.ts](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/errors.ts:1); the WhatsApp SID pre-filter is [dispatch.ts:92](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/worker/jobs/pending-post-notice/dispatch.ts:92).

5. **EXISTS** — [delivery.ts:143](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/notifications/delivery.ts:143) defines `claimPendingPostNoticeDelivery`.

6. **EXISTS** — [job-outbox-helpers.ts:32](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/shared/job-outbox-helpers.ts:32) defines `AGGREGATE_TYPE_SOLICITATION_BATCH`; `enqueuePendingPostNotice` and its literal partial-index predicate are 357–383.

7. **EXISTS** — [migration 074:109](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/supabase/migrations/074_trust_dial_veto_window.sql:109) has the pending-notice index pair; [migration 076:74](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/supabase/migrations/076_judge_verdicts_governor.sql:74) adds `notification_deliveries.entity_id`; [migration 091:109](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/supabase/migrations/091_send_mode_spine_lifecycle.sql:109) has approval consistency, the one-active index at 180, and persona/action checks at 461.

8. **MISMATCH** — [tier-config.ts:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/accounts/tier-config.ts:12) defines real IDs as `copilot` and `autopilot`, with `tierGrantsAutopilot` at 47; the plan’s `copilot_monthly`/`autopilot_monthly` sketch is wrong.

9. **EXISTS** — The settings service exists at [settings.ts:163](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/settings.ts:163), response/schema at [types.ts:139](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/types.ts:139), route at [route.ts:21](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/api/settings/auto-approval/route.ts:21), and client at [AutoApprovalClient.tsx:113](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:113).

10. **EXISTS** — [sentiment.test.ts:45](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/reviews/__tests__/sentiment.test.ts:45) contains an `invariants` describe block using fast-check.

11. **EXISTS** — [config/flags.ts:21](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/config/flags.ts:21) defines `readFlag`; [solicitation/flags.ts:6](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/flags.ts:6) contains the current solicitation accessors.

12. **EXISTS** — [config/worker.ts:24](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/config/worker.ts:24) defines `rawOpt`; `WHATSAPP_PENDING_POST_TEMPLATE_SID` uses it at 170.

13. **EXISTS** — [feature-state.sh:1](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/scripts/feature-state.sh:1) and [verify-gate.sh:1](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/scripts/verify-gate.sh:1) both exist.

14. **EXISTS** — [release.integration.test.ts:1](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/solicitation/__tests__/release.integration.test.ts:1) exists; the existing settings unit file is [settings.test.ts:1](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/auto-approval/__tests__/settings.test.ts:1).

15. **EXISTS** — Installed postgres.js exposes `TransactionSql.savepoint` at [types/index.d.ts:723](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/node_modules/postgres/types/index.d.ts:723), implements `SAVEPOINT`/`ROLLBACK TO` at [postgres/index.js:258](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/node_modules/postgres/src/index.js:258), and has correct repository usage at [import-consent.ts:563](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/reviews/import-consent.ts:563).

## 4. Low-confidence appendix

- **Telegram confirmation seam:** Telegram returns provider acceptance and an external message ID at [telegram-channel.ts:105](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/notifications/channels/telegram-channel.ts:105), while shared finalization writes only `sent_at` at [delivery.ts:310](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/631-auto-approval-lane/src/lib/notifications/delivery.ts:310). I found no Telegram delivery-confirmation ingress. A Telegram-only account may receive a notice but never obtain `delivered_at`, leaving the batch fail-closed until expiry. That is safe, but the intended product behavior is not sufficiently explicit to classify it as a ≥80% defect.

- **Queued-notice flag semantics:** Task 5 says to clone the pending-notice worker’s kill-switch shape, but it does not explicitly state whether already-queued Veto notices re-check only `SOLICITATION_AUTO_APPROVAL_ENABLED` or both Solicitation flags. Because master send flag-off is a recoverable hold under the amendments, suppressing or continuing transparency notices in that state needs an explicit product decision before pinning a test.

VERDICT: REVISE — the 19-test eval can pass without production wiring or race safety; the plan conflicts with B14/B15, mishandles owner/policy concurrency and downgrade reasons, and mis-specifies settings and worker integration.

---

The requested review has been delivered in full above; no further in-scope work remains.

---

