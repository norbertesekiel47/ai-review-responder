# Spec 02 — Pricing & Packaging

> **Goal:** Three tiers (Starter / Growth / Scale), per-location value metric, hybrid subscription + overage, soft caps with notification, 14-day no-CC trial — all wired to Stripe-first reconciliation.

---

## 1. Why this matters

Pricing is the highest-leverage growth lever and the hardest to change after launch. Get the value metric (per-location), packaging (limits low / features high), and trial mechanic right or compound through the next 12 months of churn.

## 2. Current state (RepWorth)

- Stripe-first tier-change pattern hardened (per recent PRs); base-item fallback removed; reconciliation contract documented in code comment.
- Multi-location overage shipped (PR #28) — per-location billing already supported via Stripe quantity.
- 7-day past_due grace implemented; checkout blocked for past_due.
- No public per-month overage calculator; no in-product meter; no annual discount UI; no documented proration FAQ.

## 3. Target state

### Value metric
**Per-location subscription + overage on review volume.** Owners want unlimited viewer seats; charge for locations. Stripe `quantity` on a single recurring price drives base billing. Overage = metered usage item on the same subscription.

### Tiers (3, no more)
| Tier | Price (US$/location/mo, monthly) | Annual (17% off) | Review cap | Key feature gates |
|---|---|---|---|---|
| Starter | $49 | $490/yr | 100/loc/mo | 1 location, basic dashboard, email approval |
| Growth | $89 | $890/yr | 200/loc/mo | up to 10 locations, brand voice tuning, SMS approval, roll-up dashboard, 30-min onboarding call |
| Scale | $149 | $1490/yr | 500/loc/mo | 25+ locations, API, SSO, audit log export, per-location roles, dedicated CSM, custom voice training |

> Numbers above are starting points to A/B-test; the **structure** is the spec, not the dollar.

### Overage
- Soft cap at 80% / 100% / 120% with in-product notifications.
- 120% triggers tier-upgrade prompt + 7-day grace; on day 8, either auto-upgrade (if customer opted-in) or feature-downgrade (publishing only, no new generations) until paid.
- Never silent-block: a hard cap by surprise is a churn event.

### Trial
- **14-day free trial, no credit card.**
- **30-day money-back guarantee on first paid month.**
- "Try with sample data" pre-trial demo (no email required) — see [Spec 06](./06-onboarding-activation.md).

### Annual
- Default toggle on pricing page: **Monthly / Annual (2 months free)**.
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

1. Document tier matrix in `docs/billing/tiers.md`. Source of truth for both Stripe products + UI copy.
2. Surface tier matrix in `src/app/pricing/page.tsx`. Monthly/annual toggle. Per-location calculator. Soft-cap policy linked.
3. Add in-product meter component (`src/components/billing/UsageMeter.tsx`) showing `reviews_processed / cap` with 80/100/120% color states. Render in dashboard top bar when usage > 60%.
4. Wire 80% / 100% / 120% threshold notifications via existing `NotificationWorker`. Email + in-app banner.
5. Implement `auto_upgrade_opt_in` boolean on `accounts`. UI in Settings → Billing.
6. Build customer-facing proration FAQ at `/help/billing/proration` — surface the documented Stripe-first contract.
7. Build "Contact Sales" page `src/app/contact-sales/page.tsx` → Calendly link with qualifier form.
8. Add `docs/billing/proration.md` (engineering reference) and link from `docs/runbooks/operational-runbook.md`.
9. Backfill: re-issue current customers' Stripe subscriptions onto new SKUs via a one-time migration runbook in `docs/runbooks/pricing-migration-YYYY-MM.md`.

## 5. Acceptance criteria

- [ ] All three tiers exist in Stripe (monthly + annual = 6 prices).
- [ ] Pricing page renders three tiers + toggle + calculator without flicker (Lighthouse perf ≥ 90).
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
- Code anchors: `worker/jobs/billing/*`, `src/app/api/billing/*`, `docs/runbooks/multi-location.md`
