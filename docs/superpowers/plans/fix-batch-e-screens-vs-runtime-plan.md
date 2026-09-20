# Plan — Batch E: screens that contradict the runtime

Issues: **#1314** (auto-approval headline), **#1054** (billing plan-switch labels, P1), **#1173** (worker boot flag line).

Intake: `docs/superpowers/plans/fix-batch-e-screens-vs-runtime-intake.json` (locked).
Worktree root: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-batch-e-screens-vs-runtime`.
Every `Create:` / `Modify:` path below is relative to that root.

## Orientation for an engineer new to this codebase

RepWorth drafts replies to Google reviews. A draft reaches Google only after an
**Approval method** is recorded: `owner` (a person clicked approve) or
`auto_policy` (the **Auto-approval lane** approved it under a policy the owner
set). Two subscription tiers exist: **Copilot** (owner approves everything) and
**Autopilot** (bounded autonomy). Only Autopilot grants auto-posting.

Two separate predicates exist in the codebase today, and confusing them is the
bug in #1314:

- **Readiness** (`src/lib/auto-approval/readiness.ts`) — *may the owner widen
  auto-approval?* Its `blockReasons` include `autopilot_unavailable`, which is
  computed as `tierGrantsAutopilot(tier) && autopilotPurchasable()`.
- **Posting block** (new, this plan) — *is this account structurally eligible to
  auto-post at all?*

They are not the same. An **Autopilot** account with `AUTOPILOT_PURCHASABLE=false`
gets `autopilot_unavailable` **and still posts**, because the runtime never reads
purchasability. Keying the headline on `autopilot_unavailable` would print "not
posting" while replies post. **Do not do that.** This is the single most
important constraint in this plan.

## New glossary term

**Posting block** — a structural, account-wide condition that makes the
**Auto-approval lane** decline every draft, independent of the policy row.
Distinct from readiness, which is an *expansion* predicate.

The word **structural** is load-bearing and narrows the claim deliberately
(skeptic round 2). A Posting block reports **configured eligibility** — flags,
tier, subscription — not live fleet health. The screen states what the account
is configured to do; the publisher owns the live health decision. So an account
with no Posting block is eligible to auto-post, which is not the same as a
guarantee that the next draft posts. Added to
`docs/context/core-reviews-responses.md` and its `CONTEXT-MAP.md` row by T1.

## Tracers

T1, T2 and T3 are **mutually independent**: disjoint file sets, no blocking
edges. T1 runs first alone (the enforcement spot check). T2 and T3 may then run
as concurrent subagents.

---

## T1 — Posting block: the auto-approval headline stops claiming replies post (#1314)

**Blocking edges:** none. Runs first.

**Files**

- `Create: src/lib/auto-approval/posting-status.ts`
- `Create: src/lib/auto-approval/__tests__/posting-status.test.ts`
- `Modify: src/lib/auto-approval/types.ts`
- `Modify: src/lib/auto-approval/settings.ts`
- `Modify: src/lib/auto-approval/__tests__/settings.test.ts`
- `Modify: src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx`
- `Modify: src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx`
- `Modify: src/lib/agents/operator/__tests__/context.test.ts`
- `Modify: docs/context/core-reviews-responses.md`
- `Modify: CONTEXT-MAP.md`
- `Modify: docs/directory/lib-reviews-responses.md`

### Behavior contract

**1. The new module owns the predicate.**

`buildAutoApprovalPostingStatus` is a pure function over five plain booleans. It
mirrors the **account-wide** structural refusals on the path a draft takes to
Google, and nothing else: four from `evaluateAutoApprovalCandidate`
(`worker/jobs/response-generation/auto-approval.ts:345`) plus the publisher's
Judge flag gate (`worker/jobs/publisher/judge-gate.ts:41`), which refuses AFTER
approval and is therefore not in that function. It takes no per-draft input,
because the settings page has no draft.

```ts
// src/lib/auto-approval/types.ts
export type AutoApprovalPostingBlockReason =
  | 'runtime_disabled'
  | 'judge_disabled'
  | 'autopilot_tier_required'
  | 'provider_moderation_disabled'
  | 'publisher_subscription_denied';

export interface AutoApprovalPostingStatus {
  blocked: boolean;
  reasons: AutoApprovalPostingBlockReason[];
}
```

```ts
// src/lib/auto-approval/posting-status.ts
interface BuildAutoApprovalPostingStatusInput {
  runtimeEnabled: boolean;
  judgeEnabled: boolean;
  tierGrantsAutopilot: boolean;
  providerModerationEnabled: boolean;
  publisherSubscriptionAllowed: boolean;
}
export function buildAutoApprovalPostingStatus(
  input: BuildAutoApprovalPostingStatusInput,
): AutoApprovalPostingStatus;
```

Follow the shape of `buildAutoApprovalReadiness` (`readiness.ts:20`) exactly:
push each reason onto an array in declaration order, then derive `blocked` from
`reasons.length > 0`. Reason order in the array is the declaration order above.

Negative cases the module must get right:

- Nothing is keyed on `autopilotPurchasable()`. The input field is named
  `tierGrantsAutopilot`, not `autopilotAvailable`, so a caller cannot pass the
  readiness value by accident.
- Several inputs false at once yields several reasons, not the first one.
- `policy_suspended` is **not** a member. Suspension is already the headline's
  first branch and the readiness block's own reason; adding it here would give
  one fact two owners.

**Why `judge_disabled` is a member (skeptic round 1, P1).** CLAUDE.md invariant
#3 states it directly: "Judge availability is a posting precondition:
`JUDGE_ENABLED=false` or judge unavailability makes `ResponsePublisherWorker`
downgrade unposted auto-policy rows to owner review." `applyJudgeGateInTx`
(`worker/jobs/publisher/judge-gate.ts:41`) downgrades on `!judgeEnabled()`
before any other check. Production runs with every autonomy flag OFF, so this
is the exact state the headline lies about today. The input is one flag read
(`judgeEnabled()`, `src/lib/responses/judge-flags.ts:3`) and costs nothing.

**Why Judge HEALTH is deliberately NOT a member (skeptic round 1, P1,
REJECTED).** `isJudgeHealthy` (`src/lib/responses/judge-health.ts:73`) is three
fleet-wide queries — a scan over `responses` joined to `businesses`/`accounts`,
a scan over `judge_verdicts`, and a poller-liveness lookup — and its own
docblock says it is "used only by the auto-policy publisher gate". Running it on
every settings-page render buys a transient answer that can flip before the next
draft is generated. The line this plan draws: a **Posting block** is
*structural, account-wide and stable*. `JUDGE_ENABLED=false` is structural and
free; Judge health is operational, and the repo already surfaces it through
`HealthAlertPoller` and `checkJudgeSweepLiveness`. **Residual gap, stated
plainly:** with `JUDGE_ENABLED=true` and a dead sweep, the headline still claims
posting. Name this in the PR description.

**2. The settings loader computes it.**

In `src/lib/auto-approval/settings.ts`, beside `buildReadiness` (`:1177`), add
`buildPostingStatus(account: SettingsAccountEntitlementRow | undefined)`.

It reads the same accessors `buildReadiness` already reads
(`autoApprovalRuntimeEnabled()`, `providerModerationEnabled()` — both already
imported) plus:

- `judgeEnabled()` from `@/lib/responses/judge-flags`.

- `tierGrantsAutopilot(account?.subscription_tier)` from `@/lib/accounts/tier-config`
  — the single authoritative tier predicate, already imported by this file.
- `checkSubscription({ status, workerType: 'publisher', pastDueAt, accountFlags }).allowed`
  from `@/lib/shared/subscription-guard`.

Use `SettingsAccountEntitlementRow`'s fields verbatim
(`settings-guards.ts:23`): `subscription_tier`, `subscription_status`,
`past_due_at`, `flags`. When `account` is `undefined`, treat the tier as absent
and the publisher subscription as denied — a missing account row cannot post.

**Do not reuse `accountSubscriptionWritable`** (`settings-guards.ts:66`). That is
billing-mutation writability, a different predicate; `checkSubscription` with
`workerType: 'publisher'` is the one the publisher actually runs.

Attach the result as a **sibling** field on the response:

```ts
// src/lib/auto-approval/types.ts — AutoApprovalSettingsResponse
export interface AutoApprovalSettingsResponse {
  accountDefault: AutoApprovalPolicyApiState;
  locations: AutoApprovalLocationSettings[];
  readiness: AutoApprovalReadiness;
  posting: AutoApprovalPostingStatus;   // new
  solicitation: SolicitationAutoApprovalApiState;
}
```

`AutoApprovalReadiness` and `AutoApprovalReadinessBlockReason` are **not
touched**. That is what keeps `docs/admin-api/admin-api.d.ts`,
`src/lib/admin/business-detail-types.ts:206`, `mappers.ts:184` and
`ci:admin-contract` out of this change.

`src/lib/agents/operator/context.ts` consumes `AutoApprovalSettingsResponse`.
Its runtime projection reads selected fields and accepts the addition — there is
no strict schema to reject the new key (verified, skeptic round 1). But its
typed test fixture at `src/lib/agents/operator/__tests__/context.test.ts:105`
returns an object literal typed `AutoApprovalSettingsResponse` **without**
`posting`, so it fails typecheck. Add `posting` to that fixture. This is the one
surface amendment on this branch (amendment 1 of 1); no schema relaxation and no
production change in `src/lib/agents/` is needed.

**3. The client renders the fourth tone.**

In `AutoApprovalClient.tsx`, `describePolicyStatus` (`:634`) gains a
`'blocked'` tone. Branch order becomes, top to bottom:

1. `account.suspended` → existing `'suspended'` branch, unchanged. **Suspended
   wins over everything.**
2. `data.posting.blocked` **and** the page would otherwise claim posting — that
   is, either `account.threshold !== null`, or `account.threshold === null` with
   at least one posting location override → the new `'blocked'` branch.
3. `account.threshold === null` with no posting overrides → existing plain
   `'off'` branch, unchanged. It is already true, so a Posting block must not
   change it.
4. otherwise → existing `'on'` branch, unchanged.

The `'blocked'` branch returns:

- `title`: when a threshold is set —
  `` `Set to ${autoApprovalThresholdLabel(account.threshold)}, but no reply posts automatically right now.` ``
  When only overrides are set, name the locations instead of a threshold, using
  the existing `joinNames` helper (`:696`).
- `detail`: one line per reason from `data.posting.reasons`, mapped through a
  new `POSTING_BLOCK_COPY` table, then the closing line
  `'Every reply waits for your approval until that changes.'`
- `canTurnOff`: **not unconditionally `true`** (skeptic round 1, P2). The
  existing handler (`AutoApprovalClient.tsx:358`) sends only
  `set_account_manual`, and the server changes only the account-default
  threshold (`settings.ts:706`). When the account default is already `null` and
  only location overrides are armed, that action changes nothing and leaves
  those locations ready to resume posting the moment the block clears — which is
  exactly why the existing override-only branch sets `canTurnOff: false`.
  Mirror it: `canTurnOff: account.threshold !== null`.

`POSTING_BLOCK_COPY` is a `Record<AutoApprovalPostingBlockReason, string>`,
placed beside `BLOCK_REASON_COPY` (`:60`) and following its owner-language
style. Suggested copy:

| Reason | Sentence |
|---|---|
| `runtime_disabled` | `Auto-posting is not switched on for RepWorth yet.` |
| `judge_disabled` | `Our reply review step is switched off right now, and nothing posts without it.` |
| `autopilot_tier_required` | `Auto-posting is part of the Autopilot plan, and this account is on Copilot.` |
| `provider_moderation_disabled` | `Safety screening for replies is switched off right now, so nothing posts on its own.` |
| `publisher_subscription_denied` | `Your billing needs attention before any reply can post.` |

Hard-coding "Copilot" is correct: `tierGrantsAutopilot` is true only for
Autopilot, so the only tier that can produce this reason is Copilot. Import the
name through `planLabel`-equivalent means or write the literal with a comment;
do **not** compare a tier string inline.

In `PolicyStatusBanner` (`:702`), map the new tone: variant `banner-attn`
(`src/app/(authenticated)/_styles/console.css:1267`), icon `alert`, and
`role="status"` — this is not an alert, the account is safe; it is a truthful
correction. Suspended keeps `banner-red` and `role="alert"`.

### Edge cases delegated, not re-tested

`past_due` inside the 7-day grace (allowed) and `pending_payment` (denied for
the publisher) are decided entirely by `checkSubscription`, which owns its own
suite. This tracer tests that the *result* of that call becomes
`publisher_subscription_denied`, not the grace arithmetic. Do not duplicate
`checkSubscription`'s cases here.

### Security contract

No trust boundary is crossed. The new field is computed server-side from the
account row already loaded under the caller's existing tenant scope
(`loadSettingsAccount` filters `WHERE id = ${accountId}`), and is read-only. No
new input is accepted, no side effect is produced, and invariant #13 holds — the
browser learns the fact from the API response and no `NEXT_PUBLIC_*` companion
is added.

Negative test title covering the boundary: `loadAutoApprovalSettings leaves
readiness.blockReasons unchanged by the posting fact` — proves the new field did
not leak into the admin-facing contract.

### Invariants

- #3: no file under `worker/jobs/` is touched; no posting precondition changes.
- #13: server-authoritative; no `NEXT_PUBLIC_*`.
- #15: `settings.ts` already receives `db: SqlExecutor` as a parameter; keep it.
- `AutoApprovalReadiness` stays an expansion predicate and is byte-unchanged.

### Test seams and titles

Seam `src/lib/auto-approval/posting-status.ts` — `buildAutoApprovalPostingStatus`:

- `reports autopilot_tier_required when the tier does not grant autopilot`
- `reports runtime_disabled when the auto-approval runtime flag is off`
- `reports provider_moderation_disabled when provider moderation is off`
- `reports publisher_subscription_denied when the publisher subscription check denies`
- `reports every applicable reason together, not just the first`
- `reports no reason and blocked false when every structural gate passes`
- `does not report a reason for an autopilot tier whose sale is paused`
- `reports judge_disabled when the judge flag is off`

Seam `src/lib/auto-approval/settings.ts` — `loadAutoApprovalSettings`:

These tests exist to prove the loader passes the RIGHT value to each input. A
pure-builder test cannot catch a caller that forwards the wrong boolean, which
is precisely the purchasability trap (skeptic round 1, P2). Every input gets a
loader test that only the correct wiring passes:

- `loadAutoApprovalSettings returns posting.blocked true for a copilot account`
- `loadAutoApprovalSettings returns posting.blocked false for an autopilot account with the runtime on`
- `loadAutoApprovalSettings leaves readiness.blockReasons unchanged by the posting fact`
- `loadAutoApprovalSettings returns posting.blocked false and readiness.blockReasons containing autopilot_unavailable for an autopilot account whose sale is paused`
  — **the trap test.** It asserts both halves at once: the posting fact says
  posting happens, and readiness independently says expansion is blocked. A
  loader that forwarded `tierGrantsAutopilot(tier) && autopilotPurchasable()`
  fails only this one.
- `loadAutoApprovalSettings reports runtime_disabled for an autopilot account when the runtime is off`
- `loadAutoApprovalSettings reports provider_moderation_disabled when provider moderation is off`
- `loadAutoApprovalSettings passes the loaded status past_due_at and flags to the publisher subscription check and propagates its denial`
  — a loader calling `checkSubscription` with `workerType: 'generator'`, or
  hard-coding `true`, fails this.
- `loadAutoApprovalSettings reports judge_disabled when the judge flag is off and every other structural gate passes`
  — the fifth input needs its own loader test like the other four (skeptic round
  2, P2). A loader hard-coding `judgeEnabled: true`, or wiring
  `autoApprovalRuntimeEnabled()` into that slot, passes every other loader test.
- `loadAutoApprovalSettings reports tier and publisher subscription blocks when the account row is missing`

Seam `AutoApprovalClient.tsx` rendered with a fixture response. The existing
fixtures at `src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx:50`
and `:202` show the shape;
every fixture needs the new `posting` key:

- `headline does not claim automatic posting for an armed policy on a copilot tier`
- `headline names the autopilot tier reason for an armed policy on a copilot tier`
- `headline does not claim automatic posting for an armed policy when the runtime flag is off`
- `headline still claims automatic posting for an autopilot tier whose sale is paused`
- `headline does not claim automatic posting for an armed autopilot policy when the judge flag is off`
- `suspended headline wins over a posting block`
- `headline does not claim location overrides post when posting is structurally blocked`
- `plain off headline still renders when no threshold is set and posting is blocked`
- `blocked headline keeps the turn off auto-posting action`
- `blocked override-only headline does not offer an account-default turn-off action`
- `headline does not claim automatic posting when provider moderation is the only posting block`
- `headline does not claim automatic posting when publisher subscription denial is the only posting block`
- `headline remains on when posting is unblocked but readiness blocks expansion for autopilot_unavailable`
  — this fixture must carry the **contradictory** facts explicitly:
  `posting: { blocked: false, reasons: [] }` together with
  `readiness: { canExpand: false, blockReasons: ['autopilot_unavailable'], … }`.
  A headline driven by `!readiness.canExpand` fails only this one.
- `blocked headline uses the attention banner and renders every posting reason on its own detail line`
  — asserts the `banner-attn` class, `role="status"`, and one rendered line per
  reason for a fixture carrying two reasons. Text-only assertions let the
  presentation stay wrong (skeptic round 1, P3).

### Completion evidence

`pnpm vitest run src/lib/auto-approval/__tests__/posting-status.test.ts` green,
plus the two modified suites green, plus `pnpm ci:admin-contract` green
(proving the shared contract did not move).

---

## T2 — One owner for tier order; plan-switch labels stop deriving it from price (#1054)

**Blocking edges:** none. Independent of T1 and T3.

**Files**

- `Modify: src/lib/accounts/tier-config.ts`
- `Modify: src/lib/accounts/__tests__/tier-config.test.ts`
- `Modify: src/lib/payments/plan-presentation.ts`
- `Modify: src/components/dashboard/settings/BillingPanel.tsx`
- `Modify: src/components/dashboard/settings/__tests__/BillingPanel.test.tsx`

### Behavior contract

**1. One owner for the order.**

`src/lib/accounts/tier-config.ts` already owns `SubscriptionTier`,
`isSubscriptionTier`, `tierGrantsAutopilot` and `TIER_CONFIG`. It gains the
order and the direction:

```ts
/** Ascending AUTONOMY, not price. Copilot is owner-approves-everything;
 *  Autopilot grants bounded autonomy. */
export const SUBSCRIPTION_TIER_ORDER = [
  SubscriptionTier.COPILOT,
  SubscriptionTier.AUTOPILOT,
] as const satisfies readonly SubscriptionTierValue[];

export type TierChangeDirection = 'up' | 'down' | 'same';

export function tierChangeDirection(
  from: SubscriptionTierValue,
  to: SubscriptionTierValue,
): TierChangeDirection;
```

Implement by index comparison in `SUBSCRIPTION_TIER_ORDER`. Price is never read.

**2. Delete both duplicate order constants.**

There are two today. Both must import the new one instead:

- `src/lib/payments/plan-presentation.ts:8` — `WS8_PLAN_ORDER`. Delete it;
  `planPricesForVariant` maps `SUBSCRIPTION_TIER_ORDER` instead.
- `src/components/dashboard/settings/BillingPanel.tsx:19` — `BILLING_PLAN_ORDER`.
  Delete it; the card grid maps `SUBSCRIPTION_TIER_ORDER` instead.

This is behavior-preserving for both: the arrays are element-identical today.

**3. Both price comparisons go.**

- `BillingPanel.tsx:440` —
  `const isDowngrade = option.basePriceCents < accountData.billing.basePriceCents;`
  becomes a direction computed from `currentTier` and `tier`. When `currentTier`
  is `null` no direction is computed and the button is already disabled.
- `BillingPanel.tsx:402-403` — `selectedIsDowngrade` repeats the same comparison
  for the modal. (The issue text says `:364`; that line is preview-response
  handling. Corrected by skeptic round 1.) Same replacement, from `currentTier` and `selectedTier`.

`TierChangeModal`'s `isDowngrade: boolean` prop becomes
`direction: TierChangeDirection`. Its only consumers are `BillingPanel.tsx` and
`__tests__/BillingPanel.test.tsx`; update both. Keep the modal's existing
title/heading/verb wording, now selected on `direction === 'down'` instead of
`isDowngrade`.

The button class stays `btn-secondary` for `'down'` and `btn-primary` otherwise,
matching today.

**4. The identical ternary (symptom 3) gets real downgrade copy.**

`BillingPanel.tsx:165-169` has two byte-identical arms. (The issue text says
`:135-139`; those are modal props. Corrected by skeptic round 1.) Replace with two independent decisions, not one nested ternary:

1. The billing sentence: the `trialing` copy, or the proration copy. Unchanged.
2. The autonomy warning, shown whenever `direction === 'down'`:

> Replies will stop posting on their own. Every reply waits for your approval
> from the moment the plan changes.

**The warning is NOT gated on `!trialing`** (skeptic round 1, P2). Invariant #11
grants a `trialing` account full access, treated like `active` everywhere, so a
trialing Autopilot account genuinely has autonomy and genuinely loses it. A
trialing downgrade shows the trial billing copy **and** the warning.

Render the warning as its own element so a test can assert it independently, not
as a string concatenated into the billing paragraph.

### Security contract

None crossed. `isDowngrade`/`direction` is presentation-only and is never sent
to `POST /api/billing/tier-change`; confirm by reading `confirmTierChange`
(`:371`), whose body posts only `accountId` and `newTier`. That is the invariant
this tracer must not break.

### Invariants

- No bare subscription-tier string literal is introduced; tier order has exactly
  one owner after this tracer.
- `isDowngrade` (now `direction`) stays presentation-only.
- No change to `TIER_CONFIG` values, Stripe Prices, or proration.
- Invariant #9a holds: `accountData.billing.basePriceCents` is still the stored,
  grandfathered price and is still what a *current* plan card displays
  (`BillingPanel.tsx:442-444`). This tracer removes it only from the
  *direction* decision.

### Test seams and titles

Seam `src/lib/accounts/tier-config.ts` — `tierChangeDirection`:

- `tierChangeDirection returns up for copilot to autopilot`
- `tierChangeDirection returns down for autopilot to copilot`
- `tierChangeDirection returns same for a tier to itself`
- `tierChangeDirection follows autonomy order when catalogue prices are equal or reversed`
  — today's catalogue order happens to agree with autonomy order, so every other
  direction test also passes a price-based implementation (skeptic round 1, P2).
  This one pins the contract: assert the direction while stubbing `TIER_CONFIG`
  prices equal, then reversed.

Seam `BillingPanel` rendered with fixture account data:

- `billing card labels the copilot option Downgrade for an autopilot account`
- `billing card labels the autopilot option Upgrade for a copilot account`
- `billing card direction ignores a grandfathered stored base price`
  — fixture: an autopilot account whose `billing.basePriceCents` is below both
  catalogue prices. Before this change both cards read "Upgrade". After it, the
  copilot card reads "Downgrade".
- `billing cards retain upgrade and downgrade labels when both catalogue prices are equal`
- `tier change modal warns that replies stop posting on their own when moving to copilot`
- `tier change modal omits the autonomy warning when moving to autopilot`
- `opening the copilot modal from a grandfathered autopilot account shows downgrade wording regardless of stored price`
  — the card fixture alone does not reach the modal's own comparison at
  `:402-403`; an implementation that fixes the cards and keeps the modal's price
  comparison passes every other T2 test (skeptic round 1, P2). Assert the modal
  title, heading and confirm verb, not only the warning.
- `opening the autopilot modal from a copilot account whose stored price exceeds both catalogue prices shows upgrade wording`
- `trialing autopilot to copilot modal preserves trial billing copy and warns that replies stop posting on their own`

### Completion evidence

The two modified suites green, and `pnpm typecheck` clean (it proves every
`TierChangeModal` consumer was updated).

---

## T3 — The worker boot line names every autonomy flag (#1173)

**Blocking edges:** none. Independent of T1 and T2.

**Files**

- `Create: worker/boot-flag-summary.ts`
- `Create: worker/__tests__/boot-flag-summary.test.ts`
- `Modify: worker/index.ts`
- `Modify: docs/directory/worker-root.md`

### Behavior contract

**1. The module owns the flag list.**

`worker/index.ts` is a boot file with no test seam — importing it boots Fastify.
Extract per invariant #12 ("entry points orchestrate; modules own failure
behavior") and the working rule that boot files orchestrate only.

```ts
// worker/boot-flag-summary.ts
/** One boolean per flag, keyed by the ENV VAR NAME so an operator can grep the
 *  log for the same string they set on Railway. Exactly eleven keys. */
export function buildBootFlagSummary(): Record<string, boolean>;

/** The emit itself, so a test can prove the record reaches the log — and not
 *  merely that the record is correct (skeptic round 1, P2). */
export function logBootFlagSummary(
  logger: { log(message: string, data: unknown): void },
): void;
```

`logBootFlagSummary` calls `logger.log('Feature flags', { flags: buildBootFlagSummary() })`
and nothing else.

Eleven entries, in this order — the four that ship today, then the five autonomy
flags, then the two solicitation flags:

| Key | Accessor | Module |
|---|---|---|
| `CHANNELS_TELEGRAM_ENABLED` | `channelsTelegramEnabled()` | existing import in `worker/index.ts` |
| `CHANNELS_WHATSAPP_ENABLED` | `channelsWhatsappEnabled()` | existing import |
| `SELF_SERVE_SIGNUP_ENABLED` | `selfServeSignupEnabled()` | existing import |
| `ZERNIO_PUBLISHING_ENABLED` | `zernioPublishingEnabled()` | existing import |
| `TRIAGE_ENABLED` | `triageEnabled()` | `src/lib/reviews/flags.ts:4` |
| `ESCALATION_ENABLED` | `escalationEnabled()` | `src/lib/escalations/flags.ts:7` |
| `JUDGE_ENABLED` | `judgeEnabled()` | `src/lib/responses/judge-flags.ts:3` |
| `GOVERNOR_ENABLED` | `governorEnabled()` | `src/lib/auto-approval/flags.ts:7` |
| `AUTO_APPROVAL_ENABLED` | `autoApprovalRuntimeEnabled()` | `src/lib/auto-approval/flags.ts:3` |
| `SOLICITATION_SEND_ENABLED` | `solicitationSendEnabled()` | `src/lib/solicitation/flags.ts:16` |
| `SOLICITATION_AUTO_APPROVAL_ENABLED` | `solicitationAutoApprovalEnabled()` | `src/lib/solicitation/flags.ts:24` |

Each value comes from its feature's existing `flags.ts` accessor, never from
`process.env` and never from a second `readFlag` call site — `ci:static-policy`
bans inline flag reads outside `src/lib/config/`. All eleven accessors exist
today; the module imports them and adds none.

`solicitationWatchEnabled()` (`src/lib/solicitation/flags.ts:6`) is deliberately
**excluded**. It gates the contacts upload surface, not outbound contact to a
person, so it is not in the audited set the owner chose.

The function reads `process.env` only through those accessors, which are not
memoized, so a test can set an env var and call it again.

**2. `worker/index.ts` only logs it.**

Replace the `console.log` block at `worker/index.ts:627-633` with one call:

```ts
logBootFlagSummary(createWorkerLogger('worker'));
```

The prose line goes. Verified before planning: three `docs/` hits exist and none
blocks this. `docs/runbooks/deployment-guide.md:804` is an env-var list header,
not the boot line. `docs/runbooks/owner-offboarding-staging-dry-run.md:217` and
the two `docs/runbooks/evidence/2026-08-30-*` hits are completed `- [x]`
checklist items and frozen evidence recording a PAST observation — historical
record, not a live instruction. **Edit none of them.** No runbook change and no
surface amendment is owed by this tracer.

`createWorkerLogger` (`src/lib/shared/logger.ts:189`) emits one JSON object per
line and sanitizes object args through the analytics blocked-key sanitizer.
Booleans carry no secret, so nothing is redacted.

### Security contract

No trust boundary is crossed and no secret is disclosed. All eleven values are
booleans; the line already printed four of them. No env var *value* other than
its truthiness reaches the log, which is the property that keeps
`list-variables`-style plaintext-secret exposure out of this path.

### Invariants

- #12: `worker/index.ts` gains no logic, only the call.
- #13: flags stay server-authoritative; no `NEXT_PUBLIC_*` companion.
- `ci:static-policy`: no new inline `process.env.*_ENABLED` read.
- The boot line stays inside the existing `try` block, so a throwing accessor
  still exits 1 through the existing handler.

### Test seams and titles

Seam `worker/boot-flag-summary.ts` — `buildBootFlagSummary`, with env set via
`vi.stubEnv`:

- `boot flag summary contains exactly the eleven declared flag keys including all four existing boot flags`
  — assert the sorted key list against the literal eleven. A seven-key summary
  carrying only the autonomy and solicitation flags would delete the four
  existing boot signals and still pass a "names all five" assertion (skeptic
  round 1, P2).
- `boot flag summary names all five autonomy flags`
- `boot flag summary names both solicitation flags`
- `boot flag summary maps each key to its own accessor when exactly one flag at a time is true`
  — eleven cases, one env var true per case. A summary that assigns every key
  one accessor's value passes all-true and all-false fixtures (skeptic round 1,
  P2).
- `boot flag summary reports false for a flag set to a value other than true`
- `boot flag summary reports true only for the literal string true`
- `logBootFlagSummary calls the supplied logger once with Feature flags and all eleven flag booleans`
  — an EMPTY `logBootFlagSummary` passes every builder test and every source
  assertion (skeptic round 2, P2). Pass a spy logger; assert one call, the exact
  message `'Feature flags'`, and a `{ flags: … }` payload whose eleven booleans
  are built independently of `buildBootFlagSummary`.
- `worker startup calls the boot flag summary logger unconditionally inside the startup try block`
  — `worker/index.ts` cannot be imported in a test; importing it boots Fastify.
  A substring check is too weak: `// logBootFlagSummary(…)`,
  `if (false) logBootFlagSummary(…)`, and a call inside a never-invoked function
  all satisfy it (skeptic round 2, P2). Parse the file instead —
  `ts.createSourceFile` from the `typescript` devDependency — and assert that a
  `CallExpression` on `logBootFlagSummary` exists, that its nearest enclosing
  function is `main`, and that every node between that call's
  `ExpressionStatement` and `main` is a `Block` or a `TryStatement`. Parsing
  drops comments for free, and the ancestor rule kills the dead-branch and
  dead-function cases. Precedent for a source-level assertion:
  `src/__tests__/ci-audit-wiring.test.ts`.
- `worker startup no longer prints the prose feature flag line`
  — the file does not contain `[worker] Feature flags:`.

### Completion evidence

`pnpm vitest run worker/__tests__/boot-flag-summary.test.ts` green,
`pnpm ci:static-policy` green, `pnpm ci:directory-map` green (the new file has
its row in `docs/directory/worker-root.md`).

---

## Test-title map

Every `tests_to_add` entry in the intake maps to exactly one tracer:

53 titles: 30 original, 20 added by skeptic round 1, 3 by round 2.

| Group | Count | Tracer |
|---|---|---|
| posting-status builder | 8 | T1 |
| settings loader | 9 | T1 |
| headline | 14 | T1 |
| tier direction | 4 | T2 |
| billing cards | 4 | T2 |
| tier-change modal | 5 | T2 |
| boot flag summary | 6 | T3 |
| boot emit + startup wiring | 3 | T3 |
| **total** | **53** | |

Every title in the intake's `tests_to_add` appears verbatim in exactly one
tracer section above. The `promised-tests` gate row checks this mechanically.

## Not in this plan

- No migration, no env var, no flag flip.
- No change to `evaluateAutoApprovalCandidate` or any file under `worker/jobs/`.
- No change to `AutoApprovalReadiness`, `docs/admin-api/admin-api.d.ts`, or
  `ci:admin-contract`'s expected output.
- No flag registry and no CI audit keeping the boot summary complete. That is a
  real follow-up; file it if review asks for it, do not build it here.

## Review appendix

### Plan gate — round 1 (Codex plan skeptic, `gpt-6-astra`, read-only)

Session id `01a0bd0d-c297-7a93-99ae-af4aa2da01e9` — resume this session for a
verification round, never start one cold.
Brief: `.feature/plan-skeptic-brief.md`. Raw output:
`.feature/plan-skeptic-round1.jsonl`. `VERDICT: REVISE`, 13 findings.
Pre-validation before dispatch: `PREVALIDATE: PASS` (22 citations resolved).

| # | Sev | Finding | Verdict |
|---|---|---|---|
| 1a | P1 | The predicate omits the Judge's account-independent posting veto (`JUDGE_ENABLED=false`). | **ACCEPT** — `judge_disabled` added as a fifth reason, with a builder test, a loader input and a headline test. CLAUDE.md invariant #3 names it, and production runs in exactly that state. |
| 1b | P1 | The predicate omits Judge *health* (dead sweep, error density, staleness). | **REJECT.** `isJudgeHealthy` (`src/lib/responses/judge-health.ts:73`) is three fleet-wide queries — a `responses`⋈`businesses`⋈`accounts` scan, a `judge_verdicts` scan, and a poller-liveness read — whose own docblock scopes it to "the auto-policy publisher gate". Running it per settings render buys a transient answer that can flip before the next draft. A **Posting block** is structural, account-wide and stable; Judge health is operational and is already surfaced by `HealthAlertPoller` / `checkJudgeSweepLiveness`. Residual gap named in the PR: `JUDGE_ENABLED=true` + dead sweep still reads as posting. |
| 2 | P2 | The purchasability trap is untested at the loader boundary; a pure-builder test cannot catch a caller forwarding the wrong boolean. | ACCEPT — added the two-sided trap test asserting `posting.blocked false` **and** `readiness.blockReasons` containing `autopilot_unavailable`. |
| 3 | P2 | The loader tests do not prove the other three inputs are wired; `workerType: 'generator'` or a hard-coded `true` passes. | ACCEPT — one loader test per input, plus the missing-account-row case. |
| 4 | P2 | The eight headline titles do not force the branch to read `posting.blocked`; `!readiness.canExpand` survives them. | ACCEPT — added a fixture carrying the contradictory facts explicitly, plus moderation-only and subscription-only cases. |
| 5 | P2 | `canTurnOff: true` on every blocked branch exposes an action that leaves location overrides armed, because `set_account_manual` clears only the account default. | ACCEPT — `canTurnOff: account.threshold !== null`, mirroring the existing override-only branch. |
| 6 | P2 | Fixing the cards while keeping the modal's own price comparison at `:402-403` passes all eight T2 tests. | ACCEPT — two grandfathered modal tests asserting title, heading and confirm verb. |
| 7 | P2 | A live-catalogue-price comparison passes the whole direction list, because today's prices happen to agree with autonomy order. | ACCEPT — added equal-and-reversed price tests at both the function and the card. |
| 8 | P2 | A warning gated on `!trialing` passes the modal tests; invariant #11 gives a trial full autonomy, so a trialing downgrade also loses it. | ACCEPT — the warning is independent of the billing sentence and shows during a trial. |
| 9 | P2 | A seven-key summary deleting the four existing boot flags passes both naming tests. | ACCEPT — exact-eleven-key test plus a one-flag-at-a-time wiring test. |
| 10 | P2 | A correct but never-called helper passes every T3 test, leaving #1173 unfixed. | ACCEPT — the emit moves into `logBootFlagSummary`, and a source-level assertion proves `worker/index.ts` calls it and no longer prints the prose line. |
| 11 | P2 | `src/lib/agents/operator/__tests__/context.test.ts:105` returns a typed `AutoApprovalSettingsResponse` without `posting`; it fails typecheck and is outside the surface. | ACCEPT — surface amendment 1 of 1. No schema relaxation; no production change under `src/lib/agents/`. |
| 12 | P3 | Text-only headline assertions permit `banner-blue`, `role="alert"`, or only the first reason rendered. | ACCEPT — one presentation test asserting class, role and one line per reason. |
| 13 | P3 | Three citations wrong: modal comparison is `:402-403` not `:364`; the ternary is `:165-169` not `:135-139`; `worker/config/startup-assertion.ts` does not exist (`startup-assert.ts` does). | ACCEPT — all three corrected in the plan and the intake. |

**Cleared by the round, recorded so review does not re-buy them:** the Admin API
contract stays unchanged (`AutoApprovalDiagnostics` carries
`AutoApprovalReadiness`, not the settings response, and the admin mapper builds
readiness independently); the operator has no strict schema that would reject
the new key; T3 introduces no banned flag read; `banner-attn` exists; the two
order constants are element-identical.

### Plan gate — round 2 (verification-only, resume of session `01a0bd0d-…`)

Brief `.feature/plan-skeptic-round2.md`, raw output
`.feature/plan-skeptic-round2.jsonl`. `VERDICT: REVISE`. Resume cost 1.03 M
input tokens of which 996 K cached, 4 K output — the resume worked as intended.

**12 of 13 round-1 findings confirmed ADDRESSED**, each against a named plan
section. **Rejection 1b accepted**: "A settings-page projection of configured
structural eligibility can reasonably exclude live fleet-health evaluation,
provided the residual limitation remains explicit." The round pushed back on two
of my justifications and was right to: the `judge-health.ts` docblock's "used
only by" describes its current consumer rather than prohibiting another, and
transience alone is not decisive, since flags and subscription state also change
after render. The decision stands on **ownership**, not on those two arguments —
this screen reports configuration and entitlement; the publisher owns the live
health decision.

Finding 10 was NOT closed, and two of my own fixes introduced defects. All three
applied; no round 3 is spent, because each is a concrete edit with no judgment
left in it.

| # | Sev | Finding | Verdict |
|---|---|---|---|
| R2-1 | P2 | Finding 10 still open: nothing promises to test the extracted emit. An EMPTY `logBootFlagSummary` passes all six builder tests and the source assertion. | ACCEPT — added `logBootFlagSummary calls the supplied logger once with Feature flags and all eleven flag booleans`, asserting the message and payload against independently built values. |
| R2-2 | P2 | The source substring assertion has a false-negative mode: `// logBootFlagSummary(…)`, `if (false) logBootFlagSummary(…)`, and a call in a never-invoked function all pass it. | ACCEPT — replaced with a `ts.createSourceFile` parse asserting the call's nearest enclosing function is `main` and every node between its statement and `main` is a `Block` or `TryStatement`. Parsing drops comments for free; the ancestor rule kills the dead-branch and dead-function cases. |
| R2-3 | P2 | The fifth input has no isolated loader test, contradicting the plan's own new claim that "every input gets a loader test". | ACCEPT — added `loadAutoApprovalSettings reports judge_disabled when the judge flag is off and every other structural gate passes`. |
| R2-4 | P3 | T1 still said "four plain booleans" and "only mirrors `evaluateAutoApprovalCandidate`" after gaining a fifth input the Judge gate owns. | ACCEPT — corrected; the Judge gate refuses AFTER approval and is therefore not in that function. |
| R2-5 | P3 | The `POSTING_BLOCK_COPY` table lacked a `judge_disabled` row. | ACCEPT — row added. The exhaustive `Record` type catches an omitted implementation entry on its own. |
| R2-6 | P3 | The test-title map miscounted the groups. | ACCEPT — recounted: 53 titles, verified to appear verbatim in the plan. |
| R2-7 | P3 | "whether the lane will actually post" implies a health-aware guarantee this change deliberately declines to give. | ACCEPT — the goal and the **Posting block** definition now say *structurally eligible to auto-post*, and the definition states that no Posting block means eligible, not guaranteed. |

**Round 3: not spent.** The command allows up to three. Every remaining item was
a concrete, checkable edit with no disagreement in it, and the round's own
verdict line says rejection 1b "is not the reason for the verdict below".
Spending a round to re-read seven mechanical edits is over-reviewing.

Contract after round 2: 53 test titles, 16 edge cases, 26 surface entries,
1 surface amendment. `PREVALIDATE: PASS`.

### Branch review — step 7

_(populated at step 7's review wave)_
