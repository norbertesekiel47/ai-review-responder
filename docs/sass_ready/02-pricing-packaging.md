# Spec 02 — Pricing & Packaging

> **Goal:** Lock the **live four-tier model** (Founders / Basic / Standard / Premium) as the documented source of truth, add a per-location usage meter + soft-cap notifications (80/100/120%), and surface proration + trial mechanics — all on the **existing** Stripe-first billing path. This spec documents and hardens what ships today; it does **not** re-SKU customers.

---

## 1. Why this matters

Pricing is the highest-leverage growth lever and the hardest to change after launch. Get the value metric (per-location), packaging (limits low / features high), and trial mechanic right or compound through the next 12 months of churn.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- **Tiers already exist** in `src/lib/accounts/tier-config.ts` (`TIER_CONFIG`): `founders` ($19), `basic` ($29), `standard` ($79), `premium` ($199), each with included locations, per-location overage, and feature gates. This spec documents that reality — there is no Starter/Growth/Scale scheme.
- **Pricing page already exists** at `src/app/(public)/pricing/PricingContent.tsx` and **already renders a monthly/annual toggle** with annual prices. (The earlier "no annual discount UI" claim was wrong.) Basic/Standard/Premium currently render "coming soon"; Founders is active.
- **Per-location overage already shipped** via Stripe `quantity`: `src/lib/payments/create-checkout-session.ts` (`computeOverageQuantity`) builds the base + overage line items; `worker/jobs/billing/UpdateStripeOverageWorker.ts` syncs subscription quantity on location add/archive/tier-change.
- Billing snapshot / overage math: `src/lib/accounts/quota.ts` (`currentBillingSnapshot`) reads **stored** `accounts.locations_included` / `locations_overage_price_cents` (grandfathered) — except base price, which still reads live `TIER_CONFIG.baseCents` (known TODO; founders base **not** grandfathered yet).
- 7-day `past_due` grace enforced in `src/lib/shared/subscription-guard.ts`; checkout blocked for `past_due` in `src/app/api/billing/checkout/route.ts`.
- **Genuinely missing:** in-product usage meter; soft-cap threshold notifications (80/100/120%); `accounts.auto_upgrade_opt_in` column; customer-facing proration FAQ; a `docs/billing/` reference set. Lead capture uses `src/app/(public)/book-a-demo` (`LeadIntakeForm`), not a `contact-sales` page or Calendly.

## 3. Target state

### Value metric
**Per-location subscription + overage on review volume.** Owners want unlimited viewer seats; charge for locations. Stripe `quantity` on a single recurring price drives base billing. Overage = metered usage item on the same subscription.

### Tiers (live model — 4, source of truth = `TIER_CONFIG`)
| Tier | Base (US$/mo) | Annual | Included locations | Overage / extra location | Multi-location |
|---|---|---|---|---|---|
| Founders | $19 | ~$15/mo | 1 | $25 | Yes (early-adopter, capped slots) |
| Basic | $29 | ~$24/mo | 1 | — (single-location) | No |
| Standard | $79 | ~$64/mo | 1 | $25 | Yes |
| Premium | $199 | ~$159/mo | 5 | $20 | Yes |

> Source of truth is `src/lib/accounts/tier-config.ts`. ⚠️ Per-tier **review caps** and feature-gate flags also live there — confirm the exact cap numbers against the file before publishing customer copy; do **not** invent caps in the spec. Stored `accounts.locations_included` / `locations_overage_price_cents` grandfather existing customers; base price is **not** grandfathered yet (`quota.ts` TODO — would need an `accounts.base_price_cents` column).

### Overage
- Soft cap at 80% / 100% / 120% with in-product notifications.
- 120% triggers tier-upgrade prompt + 7-day grace; on day 8, either auto-upgrade (if customer opted-in) or feature-downgrade (publishing only, no new generations) until paid.
- Never silent-block: a hard cap by surprise is a churn event.

### Trial
- **14-day free trial, no credit card.**
- **30-day money-back guarantee on first paid month.**
- "Try with sample data" pre-trial demo (no email required) — see [Spec 06](./06-onboarding-activation.md).

### Annual
- Monthly/Annual toggle is **already live** on `(public)/pricing` (annual ≈ 2 months free). Remaining work: expose annual Stripe prices for all four tiers once Basic/Standard/Premium leave "coming soon".
- Target 30–40% revenue on annual within 12 months.

### Proration (Stripe defaults + documented)
- **Upgrades:** prorate immediately, charge difference.
- **Downgrades:** schedule at next period boundary, no refund.
- **Add-location mid-cycle:** prorate immediately.
- **Remove-location mid-cycle:** credit on next invoice, no refund.

### Coupons, partner, enterprise
- Stripe Coupons + Promotion Codes behind feature flag `pricing.promo_codes_enabled`.
- Referral program (in-product link, 20% off both sides for 3 months) ships month 6.
- Agency / partner pricing: manual deal-desk via `docs/sales/deal-desk.md` until 10+ agency customers.
- "Contact Sales" tier on pricing page → Calendly with 3-field qualifier (locations, vertical, current tool).

## 4. Implementation tasks

1. Document the live tier matrix in `docs/billing/tiers.md` — derived from `TIER_CONFIG`, single source for UI copy + Stripe products. Cross-link the existing `docs/runbooks/multi-location.md` (already covers tier architecture) rather than duplicating it.
2. Pricing page already exists (`src/app/(public)/pricing/PricingContent.tsx`) with the monthly/annual toggle. Remaining work: add a **per-location calculator** and link the soft-cap policy. No new page.
3. Add in-product meter `src/components/billing/UsageMeter.tsx` showing `reviews_processed / cap` with 80/100/120% color states. Source numbers from `currentBillingSnapshot()` in `src/lib/accounts/quota.ts` (add a review-count field if absent). Render in the dashboard top bar above 60% utilization.
4. Wire 80/100/120% threshold detection. ⚠️ `NotificationWorker` (`worker/jobs/notification/`) dispatches **SMS/Telegram/WhatsApp/Email** for review approvals — it is not an in-app channel. Email the owner via the existing email path; the **in-app banner** is a separate dashboard component (mirror `SubscriptionStatusBanner.tsx`), not a NotificationWorker output. Threshold detection runs on the worker (Vercel = UI only).
5. Add `accounts.auto_upgrade_opt_in BOOLEAN NOT NULL DEFAULT false` (claims the next free migration number — see note). UI toggle in Settings → Billing.
6. Build customer-facing proration FAQ at `/help/billing/proration` — surface the documented Stripe-first contract.
7. **No new contact-sales page.** Reuse the existing `src/app/(public)/book-a-demo` lead-intake flow for the "Contact Sales" CTA (`LeadIntakeForm` already captures locations/vertical/tool); switch to Calendly only if booking friction proves to be the bottleneck.
8. Add `docs/billing/proration.md` (engineering reference) and link from `docs/runbooks/operational-runbook.md`.
9. ~~Re-SKU customers onto new tiers~~ — **removed.** The live four tiers are the model (§3); there is no migration off a Starter/Growth/Scale scheme because that scheme was never shipped.

> **Migration numbering:** head is **042**. Specs 02, 04, and 05 each add schema in this batch. Don't hard-code a number — claim the next free one in the PR and renumber if another lands first (README convention).

## 5. Acceptance criteria

- [ ] All four tiers exist in Stripe with monthly + annual prices; `TIER_CONFIG` and Stripe products reconciled (audited).
- [ ] Pricing page renders all four tiers + toggle + per-location calculator without flicker (Lighthouse perf ≥ 90).
- [ ] Usage meter visible in-app at 60%+ utilization; tested with seeded data.
- [ ] 80/100/120% notifications fire reliably under load test (10 accounts crossing threshold same hour).
- [ ] Proration matches documented contract in 5 manual upgrade/downgrade scenarios.
- [ ] Trial signup without CC works end-to-end; trial → paid conversion event fires.
- [ ] Money-back-guarantee macro published in Help Scout.

## 6. Metrics

| Metric | Target |
|---|---|
| Trial → paid conversion | 15–25% |
| Annual mix of revenue | 30–40% within 12 months |
| Overage notification → upgrade rate | ≥ 20% |
| Forced downgrade rate (day 8) | ≤ 5% of capped accounts |
| Avg revenue per location (ARPL) | Track monthly, optimize quarterly |

## 7. Risks & mitigations

- **Risk:** Per-location pricing too high for solo single-location signups. **Mitigation:** Starter tier remains intentionally entry-level; explicitly drop single-location prospects with one-location-only language at top of pricing page.
- **Risk:** Overage causes bill shock. **Mitigation:** "max bill this month" cap displayed in meter UI; opt-in auto-upgrade default OFF.
- **Risk:** Stripe Tax misconfigured on annual prices. **Mitigation:** dry-run a $1 test subscription in each jurisdiction before launch.

## 8. Dependencies & cross-links

- [Spec 05 — Billing & Subscription Lifecycle](./05-billing-subscription.md) (reconciliation worker, dunning, past_due UX)
- [Spec 17 — Legal & Compliance Docs](./17-legal-compliance-docs.md) (refund policy lawyered)
- [Spec 26 — Financial Operations](./26-financial-operations.md) (revenue recognition, gross margin)
- Code anchors: `src/lib/accounts/tier-config.ts`, `src/lib/accounts/quota.ts`, `src/lib/payments/create-checkout-session.ts`, `worker/jobs/billing/*`, `src/app/api/billing/*`, `docs/runbooks/multi-location.md`

## 9. Implementation in the current repo

- **Tier data** is already centralized in `src/lib/accounts/tier-config.ts` — every new surface (meter, calculator, docs) should import from there, never re-declare prices.
- **Usage meter:** new client component reading a server action / route that calls `currentBillingSnapshot()` (`src/lib/accounts/quota.ts`). The snapshot currently returns location/overage math; extend it with the period review count rather than querying reviews from the component.
- **Threshold notifications:** detection is a worker concern — fold a check into the existing billing/usage worker path or a small poller in `worker/background/pollers/`; emit the owner email via the existing email job. The in-app banner is a dashboard component sibling to `src/components/dashboard/SubscriptionStatusBanner.tsx`.
- **`auto_upgrade_opt_in`:** schema-only migration on `accounts`; read it in `quota.ts` / overage handling and the day-8 overage branch (cross-ref [Spec 05](./05-billing-subscription.md) read-only logic).
- **Proration:** purely documentation + a help page; the Stripe-first proration behavior already lives in `src/lib/payments/create-checkout-session.ts` and `UpdateStripeOverageWorker.ts` (`proration_behavior: 'create_prorations'`).

---
_Verified 2026-05-23 against migration head 042. Tier table rewritten to the live `TIER_CONFIG` (founders/basic/standard/premium); corrected false "no annual UI / no overage" claims; removed the never-shipped re-SKU task; retargeted contact-sales to the existing `book-a-demo` flow._
