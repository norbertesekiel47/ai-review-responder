# ADR 0034 — Readiness' Autopilot entitlement is tier-only

## Status

Accepted — 2026-09-20. Records why **readiness** stopped folding
`autopilotPurchasable()` into `autopilot_unavailable`, and why that is a
correction rather than a loosening.

Terms: `docs/context/core-reviews-responses.md` → **Posting block**,
**Auto-approval lane**, **Approval method**. Design of record:
`docs/roadmap/2026-07-01-agentic-reputation-platform-design.md` §8.
Code: `src/lib/auto-approval/settings.ts` (`buildReadiness`),
`src/lib/auto-approval/readiness.ts`,
`src/lib/payments/tier-purchasability.ts`,
`src/lib/auto-approval/solicitation-settings.ts`.

## Context

Two questions were wearing one word.

**Readiness** (`buildAutoApprovalReadiness`) answers: *may this owner WIDEN the
auto-approval they already have?* It is the gate behind every expansion write —
`assertExpansionReady` throws `AutoApprovalExpansionBlockedError` with its
`blockReasons` when it says no.

**Purchasability** (`autopilotPurchasable()`) answers a sales question: *may
someone BUY Autopilot right now?* It is
`AUTOPILOT_PURCHASABLE === 'true' && autoApprovalRuntimeEnabled()` — a
commercial kill switch for the checkout surfaces (`/pricing`, the onboarding
plan picker, `assertTierPurchasable`).

`buildReadiness` composed the two:

```ts
const autopilotAvailable = Boolean(
  tierGrantsAutopilot(account?.subscription_tier) && autopilotPurchasable(),
);
```

So pausing the **sale** of Autopilot froze the **settings** of every owner who
had already bought it. Their `autopilot_unavailable` was reported on the
auto-approval screen and enforced on every expansion write, while the posting
runtime — which never reads purchasability at any point in
`decideAutoApproval` → `ResponsePublisherWorker` — carried on auto-posting their
replies. The owner was told they could not widen autonomy they were visibly
already exercising, for a reason that was about our price list.

This is the same conflation #1314 named from the other side. The **Posting
block** (`buildAutoApprovalPostingStatus`) exists precisely because it could not
be derived from readiness, and purchasability was the headline example of why.

The Solicitation lane had already decided this question the other way.
`assertSolicitationExpansionAllowed`
(`src/lib/auto-approval/solicitation-settings.ts`) passes
`autopilotAvailable: tierGrantsAutopilot(lockedAccount.subscription_tier)` with
a comment saying it is "deliberately NOT `autopilotPurchasable`, because an
existing Autopilot subscriber keeps entitlement during a sales pause". One
builder was being fed two different meanings of one input by its two callers.

## Decision

**`buildReadiness` derives `autopilotAvailable` from tier entitlement alone.**

```ts
const autopilotAvailable = tierGrantsAutopilot(account?.subscription_tier);
```

`autopilot_unavailable` now means exactly one thing in both lanes: this account
is not on the Autopilot tier.

## Why this is not a loosening on the runtime axis

Nothing is lost. `buildAutoApprovalReadiness` takes `runtimeEnabled` as its own
separate input, fed from `autoApprovalRuntimeEnabled()`, and pushes
`auto_approval_disabled` when it is off. The `autoApprovalRuntimeEnabled()` half
of `autopilotPurchasable()` was therefore redundant *inside this one
expression* — with `AUTO_APPROVAL_ENABLED=false` the removed conjunct and the
surviving input refused in lockstep, and only the surviving input's reason named
the real cause. Pinned by
`a paused-sale Autopilot account cannot expand settings when AUTO_APPROVAL_ENABLED is false`
(`src/lib/auto-approval/__tests__/settings.test.ts`), which drives a confirmed
expansion through the settings WRITER — not the pure builder — and asserts both
the `auto_approval_disabled` refusal and that no row was written.

## The cost, stated plainly

**This widens who may expand auto-approval.** In exactly one case it removes the
last refusal: an otherwise-eligible Autopilot account, runtime on, moderation
enabled and validated, subscription writable, policy not suspended, not a
preview, not impersonated — where a paused sale was the only thing saying no.
That account can now widen its dials. That is the intended fix, not a side
effect, and it is the whole behavioural delta.

What still binds, unchanged, on every expansion write through
`assertExpansionReady`:

- `auto_approval_disabled` — `AUTO_APPROVAL_ENABLED` is off
- `autopilot_unavailable` — not on the Autopilot tier (Copilot, or no account
  row at all: `tierGrantsAutopilot(undefined)` is false)
- `provider_moderation_disabled` / `provider_moderation_not_validated`
- `subscription_not_writable` — including the past-due grace window and
  offboarding's billing-mutation block
- `policy_suspended` — the Governor's per-account kill switch
- `preview_environment`
- `impersonation_not_allowed`

And none of this touches invariant #3: readiness governs *settings writes*, not
posting. Widening a dial still buys nothing at publish time that the trust dial,
the veto window, moderation, the Judge and `tierGrantsAutopilot` do not
independently allow.

## Consequences

- A paused sale no longer freezes an existing Autopilot owner's settings. If we
  ever *want* a sales pause to also freeze in-place autonomy, that is a new,
  separately named block reason and a deliberate product decision — not a reused
  purchasability flag.
- The two lanes agree about one word. `autopilot_unavailable` has a single
  meaning, and the Reply lane no longer contradicts the comment in
  `solicitation-settings.ts`.
- The #1314 derivation trap survives with a different discriminator. Readiness
  still carries inputs the runtime never reads (`providerModerationValidated`,
  `previewEnvironment`, `impersonated`), so the Posting block must still never be
  derived from readiness; the guard test now keys on
  `provider_moderation_not_validated` instead of a paused sale.
- The **Posting block** glossary entry in
  `docs/context/core-reviews-responses.md` still says readiness "folds in
  `autopilotPurchasable()`" and cites the paused-sale divergence as its
  example. That sentence is now false and needs the discriminator above; it is
  outside this change's edit surface.
- `autopilotPurchasable()` keeps its remaining callers, which are all genuinely
  about buying: `/pricing`, the onboarding plan picker, `/api/account/settings`
  plan presentation, `assertTierPurchasable`, and the admin business-detail
  mapper.

## Alternatives considered

**Leave the conjunct, document the trap.** Rejected. It was already documented —
in `posting-status.ts`, in the #1314 test comments, and in the glossary — and
documentation did not stop the behaviour being wrong: an owner was still refused
a widening for a reason that had nothing to do with them. It also leaves two
lanes disagreeing about what one word means, with the disagreement recorded as a
deliberate comment in each. A comment explaining a trap is not a substitute for
removing it.

**Strip purchasability and add an explicit `autopilot_sale_paused` reason.**
Rejected, for now. It preserves today's behaviour under an honest name, but
nobody has asked for a sales pause to freeze existing owners' settings, and
inventing the reason would make a real product decision as a side effect of a
naming fix. Revisit if such a requirement actually arrives.
