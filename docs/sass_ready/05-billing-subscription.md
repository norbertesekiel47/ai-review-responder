# Spec 05 — Billing & Subscription Lifecycle

> **Goal:** Stripe is the source of truth. Webhook idempotency already exists (`inbound_events`); **extend** reconciliation to catch subscription-level drift, add a `past_due` countdown timestamp + day-variant banner, branded dunning over 28 days, and a cancellation survey. Build on the existing `subscription-guard` + reconcile pollers — don't rebuild them.

---

## 1. Why this matters

Billing bugs translate directly to chargebacks, refunds, and churn. The architecture invariants ("Stripe-first" pattern, outbox for billing writes) are already strong; the gap is **operational visibility** — drift detection, dunning UX, and the customer-facing past_due experience.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- **Webhook idempotency already shipped.** `worker/ingress/stripe.ts` handles `checkout.session.completed`, `invoice.payment_failed`, `invoice.paid`, `customer.subscription.{deleted,updated}` and dedups via the **`inbound_events`** table (`claimInboundEvent('stripe', event.id, …)`), shared across Stripe/Resend/Twilio/Zernio. ⚠️ There is **no** `processed_stripe_events` table and no need for one — the spec's "build it" tasks are largely **done**.
- **Reconciliation pollers already exist:** `StripeLocationsReconcilePoller` (location-count ↔ tier) and `CancellationGracePoller` (30-day grace → archive) in `worker/background/pollers/`. A subscription-level Stripe↔DB drift walk is the gap to **add**.
- `subscription-guard.ts` (`src/lib/shared/subscription-guard.ts`) already implements `cancelled`→skip, `past_due`→7-day grace, `pending_payment`→generator-only, used across 11+ workers.
- **`PastDueBanner` already exists** in `src/components/dashboard/SubscriptionStatusBanner.tsx` (with `CancelledBanner`). The work is to make it **day-variant with a countdown**, not create it.
- Checkout blocked for `past_due` (409) in `src/app/api/billing/checkout/route.ts`; Stripe Customer Portal wired at `src/app/api/billing/portal/route.ts` (portal also captures cancellation reasons).
- ✅ **`accounts.past_due_at` shipped** (migration **043**, PR #81, 2026-05-24). Set on the first `active → past_due` transition (`invoice.payment_failed`), preserved across repeated failures while still `past_due`, cleared on recovery (`invoice.paid`) **and** on cancellation (`customer.subscription.deleted`) — all inside the existing handler transactions, with a `subscription_status_changed` audit row written through `src/lib/audit/log.ts`. The countdown now has its data source; remaining work is the **day-variant banner UI** only.
- **Genuinely missing:** subscription-level reconciliation; day-variant countdown; branded dunning cadence; `cancellation_surveys` table + exit-survey UI; Stripe Tax; `docs/runbooks/{dunning,chargebacks,stripe-tax-enablement}.md`.

## 3. Target state

### Reconciliation
- **`BillingReconciliationPoller`** in `worker/background/pollers/` runs hourly.
- Walks Stripe subscriptions → DB and DB → Stripe.
- Categorizes drift:
  - **Safe (auto-heal):** status mismatch (DB says active, Stripe says active too but with different timestamps), trailing whitespace, etc.
  - **Unsafe (page):** price drift, quantity drift, missing subscription, duplicate subscription.
- Max drift detection lag: 1 hour. Alert via Sentry on unsafe drift.

### Webhook idempotency (already implemented — keep)
- Dedup is via the existing **`inbound_events`** table (`external_event_key` unique on `event.id`), claimed at handler entry. **No** new `processed_stripe_events` table.
- Handlers already compute desired state by reading the Stripe API (`stripe.subscriptions.retrieve`), not by incrementing DB state — webhooks are unordered.
- Outbox pattern wraps state-change + downstream-enqueue (architecture invariant).
- Remaining work: when adding subscription-level reconciliation events, route them through the same `claimInboundEvent` dedup.

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

### Past_due UX (enhance the existing banner)
- **Prerequisite:** the day-delta needs a "past_due since" timestamp. Add `accounts.past_due_at` (set when `invoice.payment_failed` first flips status to `past_due`, cleared on `invoice.paid`), or derive from the Stripe invoice's first-failure date. Without it, no countdown is possible.
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

1. Add `worker/background/pollers/billing-reconciliation-poller.ts` for **subscription-level** Stripe↔DB drift (price/quantity/status/missing/duplicate). Hourly. Sentry alert on unsafe drift. Register in `worker/index.ts` using the existing poller registration pattern (mirror `StripeLocationsReconcilePoller`). Consider folding into that poller if scope overlaps.
2. ~~Migration — `accounts.past_due_at TIMESTAMPTZ NULL`~~ — ✅ **done (migration 043, PR #81).** Idempotency already exists via `inbound_events` (no `processed_stripe_events` table).
3. ~~Set/clear `past_due_at` in the `invoice.payment_failed` / `invoice.paid` handlers~~ — ✅ **done (PR #81).** Set on first `payment_failed`, cleared on `paid` and on `subscription.deleted`, each in the existing handler transaction alongside a `subscription_status_changed` audit row via `src/lib/audit/log.ts`.
4. **Enhance the existing `SubscriptionStatusBanner.tsx`** (`PastDueBanner`) to be day-variant: compute the delta from `accounts.past_due_at`, render variants by day (1/3/5/7). Do **not** create a new `src/components/billing/PastDueBanner.tsx`.
5. Read-only mode at day 8: worker actions are **already** gated by `subscription-guard.ts`. Add the **UI/route** read-only layer in `src/middleware.ts` using `past_due_at + 7 days < now()`; UI hides Approve/Publish. Keep the worker guard as the authoritative backstop.
6. Add `docs/runbooks/dunning.md` documenting cadence + email templates.
7. Add `docs/runbooks/chargebacks.md` with response template + evidence checklist.
8. Add `docs/billing/proration.md` (engineering reference) + customer-facing FAQ at `/help/billing/proration` (cross-link to Spec 02).
9. Build cancellation flow UI: retention prompts → exit survey → Stripe cancel-at-period-end.
10. Admin "grant extension" action: founder can add N days of grace, logged in audit. Surface in Settings → Admin (admin role only).
11. Stripe Tax enablement runbook in `docs/runbooks/stripe-tax-enablement.md`. Dry-run a $1 test subscription in each jurisdiction.

## 5. Acceptance criteria

- [ ] `BillingReconciliationPoller` runs hourly in prod and writes a heartbeat log line.
- [ ] Drift detected within 1 hour, paged at P1 for unsafe categories.
- [ ] Replaying the same Stripe event is a no-op (via existing `inbound_events` dedup — covered by a test, no new table).
- [x] `accounts.past_due_at` set on first `invoice.payment_failed`, cleared on `invoice.paid` (and on cancellation). ✅ PR #81.
- [ ] Past_due banner shows day-variants on day 1, 3, 5; full-screen modal on day 5; read-only mode at day 8 (verified by setting a test account's `past_due_at` to T-8 days).
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
- Code anchors: `worker/ingress/stripe.ts`, `worker/background/pollers/{StripeLocationsReconcilePoller,CancellationGracePoller}.ts`, `src/lib/shared/subscription-guard.ts`, `src/components/dashboard/SubscriptionStatusBanner.tsx`, `src/app/api/billing/{checkout,portal}/route.ts`, `inbound_events` table (migration 001), outbox pattern (`.claude/skills/outbox-pattern.md`)
- Architecture invariant: "Transactional outbox" + "Subscription guard in all customer-facing workers" in `CLAUDE.md`

## 9. Implementation in the current repo

- **Idempotency is solved** — `inbound_events` + `claimInboundEvent` is the dedup. Any new event handler (reconciliation, dunning) routes through it. Don't add a parallel dedup table.
- **`past_due_at`** is the one schema gap. Set/clear it inside the existing `invoice.payment_failed` / `invoice.paid` handlers in `worker/ingress/stripe.ts`, in the same outbox transaction as the status change.
- **Reconciliation** mirrors the registration of `StripeLocationsReconcilePoller` in `worker/index.ts` (BullMQ/poller boot). Categorize drift conservatively — unknown category ⇒ unsafe ⇒ page.
- **Banner** is a pure client-side enhancement of `SubscriptionStatusBanner.tsx`; the day-delta comes from a server-provided `past_due_at`. Read-only mode splits in two: worker actions already blocked by `subscription-guard.ts`; the route/UI layer is the new `middleware.ts` check.
- **Cancellation survey:** the Stripe Customer Portal already captures a coarse cancellation reason; the `cancellation_surveys` table + 4-question UI is the richer in-app path — write it on the `customer.subscription.deleted` handler or a pre-cancel form. Don't duplicate the portal's reason capture; complement it.
- **Dunning/Stripe Tax/chargebacks** are net-new runbooks + Stripe config; no code prerequisites beyond `past_due_at`.

---
_Verified 2026-05-23 against migration head 042. Corrected three false "missing" claims (idempotency via `inbound_events`, reconcile pollers, `PastDueBanner` all already exist); removed the redundant `processed_stripe_events` migration; flagged the absent `past_due_at` as the real blocker for the countdown._
