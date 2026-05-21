# Spec 05 — Billing & Subscription Lifecycle

> **Goal:** Stripe is the source of truth, an hourly reconciliation worker catches drift, dunning runs branded over 28 days, past_due has a visible countdown UI, and every webhook is idempotent + commutative.

---

## 1. Why this matters

Billing bugs translate directly to chargebacks, refunds, and churn. The architecture invariants ("Stripe-first" pattern, outbox for billing writes) are already strong; the gap is **operational visibility** — drift detection, dunning UX, and the customer-facing past_due experience.

## 2. Current state (RepWorth)

- Tier-change pattern is Stripe-first; base-item fallback removed; reconciliation contract documented in code comment (per recent PRs).
- Outbox pattern (`job_outbox`) enforces transactional state changes (architecture invariant).
- Subscription guard in customer-facing workers: `cancelled` → no-op, `past_due` → 7-day grace, `pending_payment` → skip notification + publisher (architecture invariant).
- Checkout blocked for `past_due` (recent fix).
- No periodic reconciliation worker visible. No customer-facing past_due banner UI. No documented dunning email cadence.

## 3. Target state

### Reconciliation
- **`BillingReconciliationPoller`** in `worker/background/pollers/` runs hourly.
- Walks Stripe subscriptions → DB and DB → Stripe.
- Categorizes drift:
  - **Safe (auto-heal):** status mismatch (DB says active, Stripe says active too but with different timestamps), trailing whitespace, etc.
  - **Unsafe (page):** price drift, quantity drift, missing subscription, duplicate subscription.
- Max drift detection lag: 1 hour. Alert via Sentry on unsafe drift.

### Webhook idempotency
- `processed_stripe_events` table keyed by Stripe `event.id`.
- Every handler computes desired state by reading Stripe API (`stripe.subscriptions.retrieve`), not by incrementing from current DB state — webhooks are not ordered.
- Outbox pattern continues to wrap state-change + downstream-enqueue (architecture invariant).

### Customer billing portal
- **Stripe Customer Portal** for card, invoices, receipts, billing email, tax ID. Do not rebuild.
- Native UI for: plan change, location add/remove, downgrade scheduling (because business logic).
- Link from Settings → Billing.

### Dunning (28 days first failure → suspension)
| Day | Action | Channel |
|---|---|---|
| 0 | Payment fails. Stripe retry 1. | — |
| 1 | "Payment failed — update card." | Email + banner |
| 3 | Stripe retry 2. Banner persists. | — |
| 7 | Stripe retry 3 (final). Email. | Email + banner |
| 8 | **Read-only mode** (can view, can't approve/publish). | Banner + full-screen modal on first login |
| 14 | Final warning email. | Email |
| 21 | Auto-cancel subscription. | — |
| 22–112 | Data retained 90 days, easy reactivation. | — |
| 113+ | Account scheduled for deletion (see [Spec 03](./03-multitenancy-isolation.md)). | — |

### Past_due UX (the missing piece)
- **Day 1:** dismissable banner ("Payment failed — update card") linked to Stripe Customer Portal.
- **Day 3:** persistent banner with countdown.
- **Day 5:** full-screen modal on login (dismissable once / day).
- **Day 7:** read-only mode at midnight UTC.
- Banner copy A/B tested via PostHog.

### Tax
- **Stripe Tax enabled day 1** for US (50 states) + EU + UK + AU + CA.
- Quarterly nexus review.

### Refunds & chargebacks
- 30-day money-back guarantee on first paid month (published in ToS).
- Pro-rated refunds at founder discretion thereafter.
- Chargeback response template: `docs/runbooks/chargebacks.md` with Stripe evidence checklist.
- Respond to every chargeback within 48 hours (default loss otherwise).

### Cancellation flow
- Self-serve in Settings → Billing → Cancel.
- Retention prompts (in order shown): pause 60 days / downgrade to lower tier / talk to founder (Calendly link).
- 4-question exit survey (reason / what would have changed your mind / NPS / can we contact you in 6 months).
- Target save-rate ≥ 20%.

### Enterprise invoicing
- Stripe Invoicing supports NET-30, PO numbers, custom line items.
- First 5 enterprise deals = manual deal-desk via `docs/sales/deal-desk.md`.

## 4. Implementation tasks

1. Build `worker/background/pollers/billing-reconciliation-poller.ts`. Hourly. Walk both directions. Sentry alert on unsafe drift. Add to startup registration in `worker/index.ts`.
2. Migration **044** — `processed_stripe_events(event_id PRIMARY KEY, processed_at)`. Index `(processed_at)` for retention sweep.
3. Refactor every Stripe webhook handler under `worker/ingress/stripe.ts` to check `processed_stripe_events` first; insert on success inside the outbox transaction.
4. Build `<PastDueBanner />` component (`src/components/billing/PastDueBanner.tsx`). Compute day delta from `accounts.past_due_at`. Render variant by day (1/3/5/7).
5. Implement read-only mode at day 8: middleware (`src/middleware.ts`) sets `req.readOnly = true` if `account.past_due_at + 7 days < now()`; UI hides Approve/Publish actions.
6. Add `docs/runbooks/dunning.md` documenting cadence + email templates.
7. Add `docs/runbooks/chargebacks.md` with response template + evidence checklist.
8. Add `docs/billing/proration.md` (engineering reference) + customer-facing FAQ at `/help/billing/proration` (cross-link to Spec 02).
9. Build cancellation flow UI: retention prompts → exit survey → Stripe cancel-at-period-end.
10. Admin "grant extension" action: founder can add N days of grace, logged in audit. Surface in Settings → Admin (admin role only).
11. Stripe Tax enablement runbook in `docs/runbooks/stripe-tax-enablement.md`. Dry-run a $1 test subscription in each jurisdiction.

## 5. Acceptance criteria

- [ ] `BillingReconciliationPoller` runs hourly in prod and writes a heartbeat log line.
- [ ] Drift detected within 1 hour, paged at P1 for unsafe categories.
- [ ] `processed_stripe_events` populated; replaying same event is a no-op.
- [ ] Past_due banner shows on day 1, 3, 5; full-screen modal on day 5; read-only mode at day 8 (verified by setting a test account's `past_due_at` to T-8 days).
- [ ] Dunning emails fire on days 1, 7, 14 (per Stripe + branded templates).
- [ ] Cancellation flow records reason, NPS, win-back-permission in `cancellation_surveys` table.
- [ ] Chargeback runbook tested in a tabletop exercise.
- [ ] Stripe Tax computing tax on every invoice in test jurisdictions.

## 6. Metrics & alerts

| Metric / Alert | Target |
|---|---|
| Reconciliation drift detection lag | < 1 hour |
| Unsafe drift events / month | Trending to 0 |
| Past_due → recovered rate | ≥ 60% by day 7 |
| Dunning email open rate | ≥ 50% |
| Cancellation save rate | ≥ 20% |
| Chargeback response time | < 48 hours, always |

## 7. Risks & mitigations

- **Risk:** Reconciliation auto-heal mis-classifies an unsafe drift as safe. **Mitigation:** auto-heal whitelist is conservative; any "unknown" category is unsafe by default.
- **Risk:** Read-only mode at day 8 too aggressive, surprises a customer. **Mitigation:** day-7 final warning email is mandatory; day-8 transition logged; reversible by single payment update.
- **Risk:** Stripe Tax mis-configured in a jurisdiction → tax debt. **Mitigation:** quarterly nexus review + TaxJar or Anrok backup if Stripe Tax limits hit.
- **Risk:** Webhook handler missed an event class → silent state divergence. **Mitigation:** reconciliation worker catches within 1 hour.

## 8. Dependencies & cross-links

- [Spec 02 — Pricing & Packaging](./02-pricing-packaging.md) (tier matrix, overage)
- [Spec 07 — Observability](./07-observability.md) (Sentry alert SLO)
- [Spec 17 — Legal](./17-legal-compliance-docs.md) (refund policy lawyered)
- Code anchors: `worker/ingress/stripe.ts`, `worker/background/pollers/`, outbox pattern (`.claude/skills/outbox-pattern.md`), subscription-guard pattern in worker jobs
- Architecture invariant: "Transactional outbox" + "Subscription guard in all customer-facing workers" in `CLAUDE.md`
