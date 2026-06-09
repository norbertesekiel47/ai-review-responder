# Billing Compliance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** Locked via grill + hardened through 3 OpenAI-Codex adversarial review rounds → APPROVED (2026-06-08). Source of truth for the *decisions* is the grill artifact (`~/.claude/grill-codex/20260608-210253/PLAN.md` + `PLAN-REVIEW-LOG.md`); this file is its executable form.

**Goal:** Close the billing-compliance and Stripe-best-practice gaps surfaced in the 2026-06-08 audit — sales-tax collection, a single pinned/bounded Stripe client, accurate auto-renewal disclosure on **both** recurring-charge surfaces, a tax-safety regression guard, and price-change safety (grandfathering guard + Stripe parity) — all behind reversible config so they can land pre-revenue without breaking the (currently keyless/unconfigured) live checkout.

**Architecture:** Code changes touch six things: (1) extract one shared Stripe client factory and migrate all 8 construction sites to it; (2) add Stripe Tax fields to the single shared `createCheckoutSession`, gated behind a server-only `STRIPE_TAX_ENABLED` flag; (3) add a regression test locking that the billing-reconciliation drift poller ignores invoice-level tax; (4) add a conspicuous auto-renewal disclosure to the onboarding plan picker; (4b) add a tax/renewal qualifier to the in-app tier-change confirmation (the second recurring-charge surface); (5) add a grandfathering regression test + a Stripe price-parity script so future price changes are safe-by-default. Everything operational (enabling Stripe Tax, Product/Price tax config, dunning, flags, legal sign-off) is captured in the **Launch-Gate Checklist**, not code.

**Tech Stack:** Next.js 16 (server routes), Railway worker (Fastify + BullMQ), `stripe@22.2.0` (SDK default API version `2026-05-27.dahlia`), Vitest, Testing Library, Postgres.js, tsx scripts.

**Decisions locked in the 2026-06-08 grill + Codex rounds:**
1. Footprint: **pre-revenue / not decided** → this is preventive, not remediation.
2. Sales tax: **enable Stripe Tax**, `tax_behavior='exclusive'` (gated behind a flag here for reversibility); disclosure says "plus applicable taxes".
3. Cancellation: copy points to the **real** mechanism ("Cancel anytime from your account" → `/account/offboarding`, not "Settings"); go-live gated on `ACCOUNT_OFFBOARDING_ENABLED=true` + an E2E cancellation smoke (launch-gate).
4. Renewal disclosure: conspicuous line at the CTA on the picker **and** the tier-change modal + rely on Stripe Checkout for in-flow consent.
5. Stripe client: **one shared factory, pinned `apiVersion` + bounded timeout/retries** (note: the pin equals the SDK default *today*; it is future-proofing for outbound calls only — webhook payload shapes are governed by the Stripe **endpoint** version, a launch-gate item).
6. Webhooks/dunning: **defer dispute/SCA handler code; configure the Stripe Dashboard** (launch-gate item).
7. Pricing changes: **grandfathering** is the chosen, already-built semantic (new customers pay new prices; existing customers retain old). Zero new code for the behavior; Task 5 adds only guards. Repricing *existing* customers is out of scope (cohort migration + ARL §17602(g) notice).

**Out of scope (fast-follow, intentionally not built here):** `charge.dispute.created` handler, `invoice.payment_action_required` (SCA) handler, reusing an existing Stripe customer on re-checkout, aligning the 7-day app grace with Stripe's retry window, repricing existing customers. See "Fast-Follow Backlog".

---

## File Structure

**Created:**
- `src/lib/payments/stripe-client.ts` — single owner of Stripe client construction (pinned `apiVersion`, `timeout`, `maxNetworkRetries`). Exposes `getStripe()` + `STRIPE_CLIENT_CONFIG` + `resetStripeClientForTests()`.
- `src/lib/payments/__tests__/stripe-client.test.ts` — unit tests for the factory.
- `src/lib/payments/__tests__/create-checkout-session.test.ts` — unit tests for the tax fields (flag on/off).
- `worker/background/pollers/billing-reconciliation/__tests__/drift.tax-safety.test.ts` — regression guard that tax never inflates the reconciliation total.
- `src/lib/accounts/__tests__/quota.grandfathering.test.ts` — locks that the billing snapshot reads STORED prices, not live `TIER_CONFIG` (invariant #9a).
- `scripts/verify-stripe-price-parity.ts` — reconciles each configured Stripe Price against `TIER_CONFIG` (launch-gate + price-change tool).

**Modified:**
- `src/lib/payments/create-checkout-session.ts` — re-export `getStripe`; add flag-gated Stripe Tax fields.
- `src/app/api/billing/portal/route.ts` — import `getStripe` from the new module (no behavior change).
- `worker/ingress/stripe/shared.ts` — re-export `getStripe`.
- `worker/jobs/billing/UpdateStripeOverageWorker.ts` — use shared `getStripe`.
- `worker/background/pollers/StripeLocationsReconcilePoller.ts` — use shared `getStripe`.
- `src/lib/account-offboarding/reactivate.ts` — use shared `getStripe`.
- `worker/jobs/account-offboarding/teardown-stripe.ts` — use shared `getStripe`.
- `worker/jobs/account-offboarding/BillingScheduleWorker.ts` — use shared `getStripe`.
- `worker/background/pollers/AccountOffboardingReactivationResetPoller.ts` — use shared `getStripe`.
- `worker/config/startup-assert.ts` — add `STRIPE_TAX_ENABLED` to the optional-boolean validation.
- `src/app/onboarding/pay/PlanPickerClient.tsx` — add auto-renewal disclosure copy.
- `src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx` — assert disclosure renders.
- `src/components/dashboard/settings/AccountPanel.tsx` — add tax/renewal qualifier to the tier-change estimate.
- `src/components/dashboard/settings/__tests__/AccountPanel.test.tsx` — assert the qualifier renders (create if absent).
- `package.json` — add `verify:stripe-prices` script.
- `.env.example` and `.claude/reference/env-vars.md` — document `STRIPE_TAX_ENABLED` + the price-change procedure.

**No DB migration.** None of these changes touch schema.

---

## Task 1: Shared Stripe client factory

Single owner for Stripe construction. Pins the API version (today the 8 sites float on the SDK default; 4 have no timeout/retries) and sets a bounded timeout + retries everywhere. Matches the defaults the offboarding clients already use.

> **Accepted tradeoff (Codex R1 #4):** the 4 currently-bare clients move from Stripe's ~80s default timeout to 20s. Explicitly accepted — these are background/checkout/webhook calls, and 20s already runs in prod on the 4 offboarding clients. Because `getStripe` becomes a shared module singleton, Step 8 audits the Stripe-mocking suites for cross-test state leakage.

**Files:** Create `src/lib/payments/stripe-client.ts`, `src/lib/payments/__tests__/stripe-client.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/lib/payments/__tests__/stripe-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStripe, resetStripeClientForTests, STRIPE_CLIENT_CONFIG } from '../stripe-client';

describe('stripe-client', () => {
  afterEach(() => {
    resetStripeClientForTests();
    vi.unstubAllEnvs();
  });

  it('pins the SDK apiVersion and bounds timeout + retries', () => {
    expect(STRIPE_CLIENT_CONFIG.apiVersion).toBe('2026-05-27.dahlia');
    expect(STRIPE_CLIENT_CONFIG.timeout).toBe(20_000);
    expect(STRIPE_CLIENT_CONFIG.maxNetworkRetries).toBe(2);
  });

  it('throws when STRIPE_SECRET_KEY is not set', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not set');
  });

  it('returns a singleton wired to the pinned apiVersion', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
    const a = getStripe();
    const b = getStripe();
    expect(a).toBe(b);
    expect(a.getApiField('version')).toBe('2026-05-27.dahlia');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/lib/payments/__tests__/stripe-client.test.ts` → FAIL (`Cannot find module '../stripe-client'`).

- [ ] **Step 3: Write the factory** — `src/lib/payments/stripe-client.ts`:

```ts
// src/lib/payments/stripe-client.ts
//
// Single owner of Stripe client construction. Every call site (checkout,
// portal, webhook ingress, overage worker, reconciliation poller, and the
// account-offboarding flows) MUST source its Stripe client from here so the
// apiVersion, timeout, and retry policy have one authoritative representation.
//
// apiVersion is pinned to the version the installed `stripe` SDK (22.2.0) is
// generated against. Bump this constant deliberately when upgrading the SDK,
// and keep the Stripe Dashboard webhook endpoint API version in lockstep
// (webhook payload shapes are governed by the ENDPOINT version, not this pin).

import Stripe from 'stripe';

export const STRIPE_CLIENT_CONFIG = {
  apiVersion: '2026-05-27.dahlia',
  timeout: 20_000,
  maxNetworkRetries: 2,
} as const;

let stripeInstance: Stripe | null = null;

/** Lazy singleton. Throws (does not crash on import) when the key is absent. */
export function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeInstance = new Stripe(key, {
      apiVersion: STRIPE_CLIENT_CONFIG.apiVersion,
      timeout: STRIPE_CLIENT_CONFIG.timeout,
      maxNetworkRetries: STRIPE_CLIENT_CONFIG.maxNetworkRetries,
    });
  }
  return stripeInstance;
}

/** Test-only: clears the singleton so env stubbing takes effect per case. */
export function resetStripeClientForTests(): void {
  stripeInstance = null;
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run src/lib/payments/__tests__/stripe-client.test.ts` → PASS (3 tests).

- [ ] **Step 5: Migrate the 4 bare core clients.** Each has a private/local `getStripe`. Replace local construction with the shared import:

  - **`src/lib/payments/create-checkout-session.ts`** — delete the local singleton (lines ~21-29) and replace with a re-export so the portal route's existing import keeps working:
    ```ts
    // Re-export the single shared Stripe client (one owner — see stripe-client.ts).
    export { getStripe } from '@/lib/payments/stripe-client';
    ```
  - **`worker/ingress/stripe/shared.ts`** — delete the local singleton (lines ~7-16) and replace with:
    ```ts
    export { getStripe } from '../../../src/lib/payments/stripe-client';
    ```
  - **`worker/jobs/billing/UpdateStripeOverageWorker.ts`** — delete the local singleton (~lines 30-39) and add:
    ```ts
    import { getStripe } from '../../../src/lib/payments/stripe-client';
    ```
  - **`worker/background/pollers/StripeLocationsReconcilePoller.ts`** — delete the local singleton (~line 48) and add:
    ```ts
    import { getStripe } from '../../../src/lib/payments/stripe-client';
    ```

- [ ] **Step 6: Migrate the 4 offboarding clients.** These already use `{ timeout: 20_000, maxNetworkRetries: 2 }`; the migration preserves that and adds the pinned `apiVersion`. In each file, delete the local `let stripeInstance … new Stripe(key, {…})` block and replace the local `getStripe` reference with the shared import:
  - `src/lib/account-offboarding/reactivate.ts:74` → `import { getStripe } from '@/lib/payments/stripe-client';`
  - `worker/jobs/account-offboarding/teardown-stripe.ts:23` → `import { getStripe } from '../../../src/lib/payments/stripe-client';`
  - `worker/jobs/account-offboarding/BillingScheduleWorker.ts:35` → `import { getStripe } from '../../../src/lib/payments/stripe-client';`
  - `worker/background/pollers/AccountOffboardingReactivationResetPoller.ts:36` → `import { getStripe } from '../../../src/lib/payments/stripe-client';`

  Keep `import type Stripe from 'stripe'` where the file still references `Stripe.Subscription` etc.; remove the value import where `Stripe` is no longer constructed.

- [ ] **Step 7: Verify nothing else constructs Stripe directly** — `rg -n "new Stripe\(" --type ts -g '!*.test.ts' -g '!*stripe-client.ts'` → **no matches**.

- [ ] **Step 8: Test-hygiene + typecheck + full suite (Codex R1 #4).** Audit every Stripe-mocking test suite (`rg -l "vi.mock\(.*stripe" --glob '*.test.ts'` and the suites importing the migrated modules). Where a suite relied on per-module construction, call `resetStripeClientForTests()` in `afterEach` (or re-mock `@/lib/payments/stripe-client`) so the shared singleton can't leak state across tests. Then `pnpm typecheck && pnpm test` → PASS. (Switch any now-unused `import Stripe from 'stripe'` to `import type`.)

- [ ] **Step 9: Commit** — `git commit -m "refactor(billing): single pinned, bounded Stripe client factory"` (stage the factory, its test, and all 8 migrated sites + portal route).

---

## Task 2: Stripe Tax on checkout sessions (flag-gated)

Add `automatic_tax`, address collection, and tax-ID collection to the single shared `createCheckoutSession`, gated behind a **server-only** `STRIPE_TAX_ENABLED` flag (default off). Enabling `automatic_tax` against an un-configured Stripe account makes `sessions.create` throw, so the flag keeps the change reversible/mergeable now. The `=== 'true'` read is fail-safe: any non-`'true'` value is OFF.

**Files:** Modify `src/lib/payments/create-checkout-session.ts`, `worker/config/startup-assert.ts`, `.env.example`, `.claude/reference/env-vars.md`; create `src/lib/payments/__tests__/create-checkout-session.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/lib/payments/__tests__/create-checkout-session.test.ts`. The `basic` tier path takes a single line item and never touches `sql`, so we test tax fields with only the Stripe client mocked:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.fn();

vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({ checkout: { sessions: { create: createMock } } }),
}));

vi.mock('@/lib/payments/price-tier-map', () => ({
  basePriceIdForTier: () => 'price_basic_123',
  overagePriceIdForTier: () => null,
}));

import { createCheckoutSession } from '../create-checkout-session';

describe('createCheckoutSession tax handling', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ url: 'https://checkout.stripe', id: 'cs_123' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('omits tax fields when STRIPE_TAX_ENABLED is off', async () => {
    vi.stubEnv('STRIPE_TAX_ENABLED', 'false');
    await createCheckoutSession('acct_1', 'basic', 'owner@example.com');
    const params = createMock.mock.calls[0][0];
    expect(params.automatic_tax).toBeUndefined();
    expect(params.billing_address_collection).toBeUndefined();
    expect(params.tax_id_collection).toBeUndefined();
  });

  it('adds tax + address + tax-id collection when STRIPE_TAX_ENABLED=true', async () => {
    vi.stubEnv('STRIPE_TAX_ENABLED', 'true');
    await createCheckoutSession('acct_1', 'basic', 'owner@example.com');
    const params = createMock.mock.calls[0][0];
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.billing_address_collection).toBe('required');
    expect(params.tax_id_collection).toEqual({ enabled: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/lib/payments/__tests__/create-checkout-session.test.ts` → FAIL (second test: `automatic_tax` is `undefined`).

- [ ] **Step 3: Add the flag-gated tax fields.** In `create-checkout-session.ts`, just above the `getStripe().checkout.sessions.create({ … })` call (~line 110), build the tax params and spread them in:

```ts
  // Stripe Tax is gated by a server-only flag: enabling automatic_tax against a
  // Stripe account that has not turned on Tax (or whose Prices lack tax_behavior)
  // makes sessions.create throw. Flip STRIPE_TAX_ENABLED only after the dashboard
  // is configured (see the Launch-Gate Checklist). tax_id_collection is a
  // deliberate B2B choice — RepWorth's customers are businesses.
  const taxParams = process.env.STRIPE_TAX_ENABLED === 'true'
    ? {
        automatic_tax: { enabled: true },
        billing_address_collection: 'required' as const,
        tax_id_collection: { enabled: true },
      }
    : {};

  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: lineItems,
    client_reference_id: accountId,
    customer_email: ownerEmail,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    ...taxParams,
  });
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run src/lib/payments/__tests__/create-checkout-session.test.ts` → PASS (2 tests).

- [ ] **Step 5: Validate the flag at worker boot (Codex R1 #5).** In `worker/config/startup-assert.ts`, add `STRIPE_TAX_ENABLED` to the optional server-only boolean validation set (alongside the other optional booleans), so a malformed value (`True`, `1`, …) is caught at boot. (Checkout itself runs in Next — the inline `=== 'true'` read is already fail-safe there; the Launch-Gate adds a staging-checkout verification after the Vercel flip.)

- [ ] **Step 6: Document the flag.** Add to `.env.example` (near the other `STRIPE_*` entries):
```bash
# Enables Stripe Tax on checkout sessions (automatic_tax + address + tax-id
# collection). Keep OFF until Stripe Tax is enabled in the dashboard and every
# Price has a tax_behavior — otherwise checkout session creation throws.
STRIPE_TAX_ENABLED=false
```
Add a row to `.claude/reference/env-vars.md`:
```markdown
| `STRIPE_TAX_ENABLED` | Off | Server-only. When `true`, checkout sessions enable `automatic_tax`, require a billing address, and collect tax IDs. Requires Stripe Tax enabled in the dashboard + `tax_behavior` on every Price first (enabling it before that makes `sessions.create` throw). No `NEXT_PUBLIC_*` companion. |
```

- [ ] **Step 7: Typecheck + static-policy audit + full tests** — `pnpm typecheck && pnpm ci:static-policy && pnpm test` → PASS (static-policy stays green: `STRIPE_TAX_ENABLED` is server-only, no `NEXT_PUBLIC_*` companion).

- [ ] **Step 8: Commit** — `git commit -m "feat(billing): flag-gated Stripe Tax on checkout sessions"`.

---

## Task 3: Reconciliation tax-safety regression guard

The billing-reconciliation drift poller compares the DB-expected total against the **pre-tax** sum of recurring subscription line amounts (`recurringSubscriptionLineTotalCents` → `undiscountedLineAmountCents` in `drift.ts`), so enabling Stripe Tax must not introduce false drift. The function reads, in order: `line.price.unit_amount` → `line.pricing.unit_amount_decimal` → `line.subtotal` → `line.amount`. This test locks that the **pre-tax** field wins over the lower-priority **tax-inclusive** fallbacks for a real `2026-05-27.dahlia` invoice shape.

**Files:** Create `worker/background/pollers/billing-reconciliation/__tests__/drift.tax-safety.test.ts`.

- [ ] **Step 1: Write the regression test:**

```ts
import { describe, expect, it } from 'vitest';
import {
  compareUpcomingInvoice,
  recurringSubscriptionLineTotalCents,
} from '../drift';

describe('reconciliation is tax-safe', () => {
  // Dahlia invoice lines expose pricing.unit_amount_decimal (price.unit_amount
  // is the legacy shape). The tax-inclusive values surface on subtotal/amount,
  // which this function only reads as a LAST resort — so they must be ignored.
  it('uses the Dahlia pre-tax pricing field, ignoring tax-inclusive subtotal/amount', () => {
    const previewInvoice = {
      lines: {
        data: [
          {
            quantity: 1,
            pricing: { unit_amount_decimal: '7900' }, // pre-tax — must win
            parent: { subscription_item_details: { subscription_item: 'si_1' } },
            subtotal: 8612, // 7900 + 712 tax — must be ignored
            amount: 8612,   // tax-inclusive — must be ignored
          },
        ],
      },
    };
    expect(recurringSubscriptionLineTotalCents(previewInvoice)).toBe(7900);
  });

  it('also handles the legacy price.unit_amount shape pre-tax', () => {
    const previewInvoice = {
      lines: {
        data: [
          {
            quantity: 1,
            price: { unit_amount: 7900 }, // pre-tax — must win
            parent: { subscription_item_details: { subscription_item: 'si_1' } },
            subtotal: 8612,
            amount: 8612,
          },
        ],
      },
    };
    expect(recurringSubscriptionLineTotalCents(previewInvoice)).toBe(7900);
  });

  it('does not flag drift when DB-expected equals the pre-tax recurring total', () => {
    expect(compareUpcomingInvoice('acct_1', 7900, 7900)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test** — `pnpm vitest run worker/background/pollers/billing-reconciliation/__tests__/drift.tax-safety.test.ts` → PASS (3 tests). If it ever fails, the reconciliation is reading a tax-inclusive field and the poller would false-alarm.

- [ ] **Step 3: Commit** — `git commit -m "test(billing): lock reconciliation tax-safety (pre-tax line totals)"`.

---

## Task 4: Auto-renewal disclosure on the plan picker

Add a clear recurring-terms statement next to the Subscribe CTA, plus a global fine-print line linking to the Terms. Stripe Checkout provides the in-flow recurring display + receipt; this is the pre-checkout consent surface. Copy uses the existing brand token `text-[#6a6a6a]`. `/legal/terms` is a real route (`src/app/(public)/legal/terms/page.tsx`; `/terms` redirects to it; already linked from landing/signup).

**Files:** Modify `src/app/onboarding/pay/PlanPickerClient.tsx`, `src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx`.

- [ ] **Step 1: Write the failing test** — add to `PlanPickerClient.test.tsx` (match the existing render/import style):

```tsx
it('discloses auto-renewal terms near the CTAs, mentions tax, and links to Terms', () => {
  render(<PlanPickerClient cancelled={false} />);
  // Per-card renewal line (one per plan card).
  expect(screen.getAllByText(/auto-renews monthly until you cancel/i).length).toBeGreaterThan(0);
  // Global fine print: tax mention + Terms link.
  expect(screen.getByText(/plus applicable taxes/i)).toBeInTheDocument();
  const termsLink = screen.getByRole('link', { name: /terms/i });
  expect(termsLink).toHaveAttribute('href', '/legal/terms');
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx` → FAIL.

- [ ] **Step 3: Add the per-card renewal line.** Immediately after the closing `</m.button>` (~line 117):
```tsx
              <p className="text-xs text-[#6a6a6a] -mt-4 mb-6 text-center">
                Auto-renews monthly until you cancel. Cancel anytime from your account.
              </p>
```

- [ ] **Step 4: Add the global fine print with tax mention + Terms link.** Immediately after the plan grid `</div>` that closes `grid md:grid-cols-4` (~line 145) and before the `{error && (` block:
```tsx
      <p className="text-xs text-[#6a6a6a] text-center mt-8 max-w-xl mx-auto">
        Subscriptions auto-renew monthly at the listed price plus applicable taxes
        until cancelled. Cancel anytime from your account. By subscribing you agree
        to our{' '}
        <a href="/legal/terms" className="underline hover:text-[#2a2a2a]">
          Terms
        </a>
        .
      </p>
```

- [ ] **Step 5: Run test to verify it passes** — `pnpm vitest run src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx` → PASS.

- [ ] **Step 6: Typecheck + lint + full tests** — `pnpm lint && pnpm typecheck && pnpm test` → PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(billing): disclose auto-renewal + tax terms on the plan picker"`.

---

## Task 4b: Disclosure on the second recurring-charge surface (tier-change modal)

The in-app tier-change confirmation (`AccountPanel.tsx`) shows a bold "New monthly estimate … Total $X.XX/mo" for a real prorated subscription change via `/api/billing/tier-change`, with no tax/renewal qualifier — so once Tax is on, that "Total" understates the charge. Add a **static** qualifier (not flag-gated: `STRIPE_TAX_ENABLED` is server-only and invariant #13 forbids a `NEXT_PUBLIC_*` companion; the wording is truthful whether tax is on or off).

**Files:** Modify `src/components/dashboard/settings/AccountPanel.tsx` and its test (`src/components/dashboard/settings/__tests__/AccountPanel.test.tsx` — create if absent).

- [ ] **Step 1: Write the failing test** — assert the qualifier renders when the billing preview is shown (match the existing AccountPanel render/mock style; the modal renders the estimate when `billingPreview` is set):

```tsx
it('discloses tax + renewal terms on the tier-change estimate', () => {
  // …render the tier-change modal with a billingPreview present…
  expect(
    screen.getByText(/before any applicable taxes/i),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/continues monthly until cancelled/i),
  ).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run src/components/dashboard/settings/__tests__/AccountPanel.test.tsx` → FAIL.

- [ ] **Step 3: Add the static qualifier.** In `AccountPanel.tsx`, immediately after the `billingPreview && !previewLoading && ( … )` estimate block closes (the `</div></div></div> )}` around line ~173) and before the `isDowngrade && newTier === 'basic'` warning:
```tsx
        {billingPreview && !previewLoading && (
          <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12, textAlign: 'center' }}>
            Estimate shown before any applicable taxes. Subscription continues
            monthly until cancelled.
          </p>
        )}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run src/components/dashboard/settings/__tests__/AccountPanel.test.tsx` → PASS.

- [ ] **Step 5: Typecheck + lint + full tests** — `pnpm lint && pnpm typecheck && pnpm test` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(billing): disclose tax + renewal terms on the tier-change modal"`.

---

## Task 5: Price-change safety (grandfathering guard + Stripe parity)

The chosen pricing semantic — **new customers pay new prices; existing customers keep their old price** — is already implemented via the stored snapshot on `accounts` (`base_price_cents`, `locations_included`, `locations_overage_price_cents`; invariant #9a, migration 054). No new code makes that work. Task 5 adds two guards so it can't silently break, and documents the change procedure.

**Files:** Create `src/lib/accounts/__tests__/quota.grandfathering.test.ts`, `scripts/verify-stripe-price-parity.ts`; modify `package.json`, `.claude/reference/env-vars.md`.

- [ ] **Step 1 (5a): Grandfathering regression guard — offline unit test.** Locks that `currentBillingSnapshot()` returns the STORED price, even when it differs from live `TIER_CONFIG`. Create `src/lib/accounts/__tests__/quota.grandfathering.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

import { currentBillingSnapshot } from '../quota';
import { sql } from '@/lib/db/server';
import { TIER_CONFIG } from '../tier-config';

const sqlMock = vi.mocked(sql);
afterEach(() => sqlMock.mockReset());

describe('currentBillingSnapshot grandfathering (invariant #9a)', () => {
  it('basic: returns the STORED base price, not live TIER_CONFIG', async () => {
    expect(TIER_CONFIG.basic.baseCents).toBe(2900); // current published price
    sqlMock.mockResolvedValueOnce([{
      subscription_tier: 'basic',
      locations_included: 1,
      locations_paid: 1,
      locations_overage_price_cents: 0,
      base_price_cents: 1900, // grandfathered — older, lower price
    }]);

    const snap = await currentBillingSnapshot('acct_1');
    expect(snap.basePriceCents).toBe(1900);   // STORED, not 2900
    expect(snap.totalCents).toBe(1900);
    expect(snap.overageUnits).toBe(0);
    expect(sqlMock).toHaveBeenCalledTimes(1); // basic short-circuits (no location-count query)
  });

  it('standard: stored base + stored overage price drive the total, ignoring live TIER_CONFIG', async () => {
    expect(TIER_CONFIG.standard.baseCents).toBe(7900);
    expect(TIER_CONFIG.standard.overageCents).toBe(2500);
    sqlMock
      .mockResolvedValueOnce([{
        subscription_tier: 'standard',
        locations_included: 1,
        locations_paid: 2,
        locations_overage_price_cents: 2000, // grandfathered overage (≠ 2500)
        base_price_cents: 6900,              // grandfathered base    (≠ 7900)
      }])
      .mockResolvedValueOnce([{ count: 2 }]); // 2 active locations → 1 overage unit

    const snap = await currentBillingSnapshot('acct_2');
    expect(snap.basePriceCents).toBe(6900);        // STORED
    expect(snap.overagePriceCents).toBe(2000);     // STORED
    expect(snap.overageUnits).toBe(1);             // 2 - 1
    expect(snap.totalCents).toBe(6900 + 1 * 2000); // 8900 — all grandfathered
  });
});
```

- [ ] **Step 2: Run 5a** — `pnpm vitest run src/lib/accounts/__tests__/quota.grandfathering.test.ts` → PASS (2 tests). (If the first two `expect(TIER_CONFIG…)` lines fail, update them to whatever the current published prices are — they document the live values the stored ones are deliberately differing from.)

- [ ] **Step 3 (5b): Stripe price-parity script.** Catches `TIER_CONFIG` ↔ Stripe `unit_amount` drift before any customer is mischarged. Create `scripts/verify-stripe-price-parity.ts`:

```ts
// scripts/verify-stripe-price-parity.ts
//
// Fails loudly if a configured Stripe Price has drifted from TIER_CONFIG —
// the displayed price (TIER_CONFIG) and the charged price (Stripe unit_amount)
// are two copies of one fact, so this reconciles them. Run before the first
// charge and after ANY price change (see the price-change procedure in
// .claude/reference/env-vars.md). NOT in blocking CI (needs live Stripe keys).
//
//   pnpm verify:stripe-prices
//
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
if (existsSync('.env.local')) dotenvConfig({ path: '.env.local' });
else dotenvConfig();

import { getStripe } from '../src/lib/payments/stripe-client';
import { basePriceIdForTier, overagePriceIdForTier } from '../src/lib/payments/price-tier-map';
import { TIER_CONFIG, type SubscriptionTierValue } from '../src/lib/accounts/tier-config';

const TAX_REQUIRED = process.env.STRIPE_TAX_ENABLED === 'true';
const TIERS = Object.keys(TIER_CONFIG) as SubscriptionTierValue[];

interface Mismatch { label: string; field: string; expected: unknown; actual: unknown; }

async function checkPrice(label: string, priceId: string, expectedCents: number): Promise<Mismatch[]> {
  const price = await getStripe().prices.retrieve(priceId);
  const out: Mismatch[] = [];
  if (price.unit_amount !== expectedCents) out.push({ label, field: 'unit_amount', expected: expectedCents, actual: price.unit_amount });
  if (price.currency !== 'usd') out.push({ label, field: 'currency', expected: 'usd', actual: price.currency });
  if (price.recurring?.interval !== 'month') out.push({ label, field: 'recurring.interval', expected: 'month', actual: price.recurring?.interval });
  if (TAX_REQUIRED && price.tax_behavior !== 'exclusive') out.push({ label, field: 'tax_behavior', expected: 'exclusive', actual: price.tax_behavior });
  return out;
}

async function main(): Promise<void> {
  const mismatches: Mismatch[] = [];
  for (const tier of TIERS) {
    const baseId = basePriceIdForTier(tier);
    if (!baseId) { mismatches.push({ label: `${tier} base`, field: 'env', expected: 'price id', actual: 'unset' }); continue; }
    mismatches.push(...await checkPrice(`${tier} base`, baseId, TIER_CONFIG[tier].baseCents));

    const overageId = overagePriceIdForTier(tier);
    if (overageId) mismatches.push(...await checkPrice(`${tier} overage`, overageId, TIER_CONFIG[tier].overageCents));
  }

  if (mismatches.length > 0) {
    console.error('Stripe price parity FAILED:');
    for (const m of mismatches) console.error(`  ${m.label}: ${m.field} expected=${m.expected} actual=${m.actual}`);
    process.exit(1);
  }
  console.log(`Stripe price parity OK for ${TIERS.length} tiers${TAX_REQUIRED ? ' (incl. tax_behavior)' : ''}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Add to `package.json` `scripts`:
```json
"verify:stripe-prices": "tsx scripts/verify-stripe-price-parity.ts",
```

- [ ] **Step 4: Document the price-change procedure** in `.claude/reference/env-vars.md` (near the `STRIPE_PRICE_*` entries):
  1. Create a **new** Stripe Price (Prices are immutable — you never edit `unit_amount`) with the new amount (+ `tax_behavior='exclusive'` if Tax is on).
  2. Point the `STRIPE_PRICE_*` env var → the new ID in **dev + staging + prod lockstep** (`startup-assert.ts` enforces presence of all 7).
  3. Update `TIER_CONFIG` cents to match the new Price.
  4. Run `pnpm verify:stripe-prices` against staging, then prod — must pass.
  5. Existing customers are unaffected (grandfathered via the stored `accounts` snapshot); only new signups + tier-changers get the new price. Repricing *existing* customers is a separate cohort migration + ARL §17602(g) fee-change notice (out of scope).

- [ ] **Step 5: Typecheck + full tests** — `pnpm typecheck && pnpm test` → PASS. (5b is not run in CI; smoke it locally with test keys if available: `pnpm verify:stripe-prices`.)

- [ ] **Step 6: Commit** — `git commit -m "feat(billing): grandfathering guard + Stripe price-parity check"`.

---

## Final Verification

- [ ] Full local gate: `pnpm lint && pnpm typecheck && pnpm test` → all green. (No DB-touching changes, so `ci:tenant-scope` / `ci:rls-audit` aren't required but remain safe to run. `ci:static-policy` must stay green — Task 2.)
- [ ] Open a PR to `main` (direct push blocked). Tasks 1, 4b & 5 touch worker/shared code, so per branch policy ride `staging` first, then land on `main` via PR with the 4 CI checks green.

---

## Launch-Gate Checklist (operational — NOT code; do before charging a real customer)

- [ ] **Stripe Tax — dashboard + tax mechanics (Codex R1 #1).** Enable Stripe Tax, set origin/business address, register in nexus states. Set **`tax_code='txcd_10103001'` on each of the 4 Products** (tax code is a Product field, not a Price field). For the **7** Prices (`STRIPE_PRICE_BASIC`, `_FOUNDING`, `_STANDARD`, `_PREMIUM`, `_STANDARD_OVERAGE`, `_PREMIUM_OVERAGE`, `_FOUNDERS_OVERAGE`), set `tax_behavior='exclusive'` — **update in place only if currently `'unspecified'`** (the field is immutable once set), otherwise **recreate the Price** and update its `STRIPE_PRICE_*` env var. Pre-revenue, recreate-from-scratch is the zero-ambiguity option. **Only then** set `STRIPE_TAX_ENABLED=true` (staging first).
- [ ] **Verify tax actually applies after the Vercel flip (Codex R2 #4).** `STRIPE_TAX_ENABLED` is read in Next/Vercel; a Vercel-side typo fails *safe* (silently OFF → under-collects). After flipping the flag on staging, run a real staging checkout and confirm the tax line appears — screenshot as evidence.
- [ ] **Price parity (Task 5b).** Run `pnpm verify:stripe-prices` against staging then prod — `TIER_CONFIG` must equal every configured Stripe Price's `unit_amount` / `currency` / `interval` (+ `tax_behavior='exclusive'` once Tax is on) before the first charge, and after any future price change.
- [ ] **Webhook endpoint API version = `2026-05-27.dahlia` (Codex R1 #3) — HARD BLOCKER.** Webhook payload shapes are governed by the endpoint version, not the SDK pin. Verify with a staging event whose payload the `worker/ingress/stripe/*` handlers parse cleanly.
- [ ] **Cancellation gate + smoke (Codex R2 #10).** `ACCOUNT_OFFBOARDING_ENABLED=true` (staging→prod) so the disclosed cancel path is live, plus an **end-to-end cancellation smoke** (reuse `docs/runbooks/owner-offboarding-staging-dry-run.md`) and monitoring of failed billing/offboarding jobs.
- [ ] **Dunning lifecycle.** Stripe → Billing → set failed-payment behavior to **cancel after retries exhausted** (the app reacts to `customer.subscription.deleted`).
- [ ] **Customer emails + retained-acknowledgment content (Codex R2 #2).** Enable Stripe receipts, failed-payment notices, card-expiring reminders. **Verify the retained email content** (screenshot/export) contains renewal terms, cancellation policy, how to cancel + contact info. If default receipts can't carry RepWorth's cancellation method/contact, **add a first-party acknowledgment email before launch** (code follow-up).
- [ ] **Tier-change fee-change timing (Codex R2 #1).** `AccountPanel` applies tier changes immediately with proration. CA BPC §17602(g) covers fee changes under existing auto-renewal terms. Confirm with counsel whether immediate proration needs advance notice / affirmative re-consent; if so, disable tier changes at launch or schedule them with the required notice window.
- [ ] **Terms content check (Codex R1 #11).** Confirm `/legal/terms` (rendered from `src/lib/legal/content.ts`, not stale `docs/legal/*`) actually states the auto-renewal cadence, price-plus-tax, and the cancellation method — and that `content.ts` tests cover it.
- [ ] **Forfeiture disclosure** surfaced in the offboarding `delete_data` confirmation UI (existing offboarding gate).
- [ ] **Legal sign-off (binding).** Confirm SaaS taxability/nexus + California ARL specifics (affirmative-consent record, retained acknowledgment, cancellation + contact info, fee-change timing) with counsel. Their answer may change *configuration* (states, flag) **or require CODE** (consent/ack records, acknowledgment email, gated tier changes) — if code is required, it **blocks the first charge** as a tracked follow-up. (The 2024 FTC "click-to-cancel" rule was reportedly vacated July 2025; rely on CA §17602 + counsel.)

---

## Fast-Follow Backlog (intentionally not built — revisit when volume warrants)

- **`charge.dispute.created` handler** — flag/suspend the account + alert ops. Until then, rely on Stripe's dispute emails + Dashboard (disputes have hard response deadlines; missed = auto-loss — acceptable only at zero charge volume).
- **`invoice.payment_action_required` (SCA/3DS)** — low priority on US cards; add when EU card volume is meaningful.
- **Reuse existing Stripe customer on re-checkout** — `createCheckoutSession` passes `customer_email` with no `customer`, so abandon-then-retry can spawn duplicate Stripe customers. When built **with Stripe Tax on, also pass `customer_update: { address: 'auto', name: 'auto' }` (Codex R1 #7)** or `automatic_tax` errors on a customer lacking an address.
- **Grace-window alignment** — the app degrades service at 7 days past_due while Stripe's Smart Retries run ~3 weeks; align the windows or message the gap to the owner.
- **Repricing existing customers** — no built-in mechanism; a cohort migration (Stripe `subscription.update` + re-snapshot `accounts` columns) plus ARL §17602(g) fee-change notice. Distinct from "change price for new customers," which the Task 5 procedure covers.

---

## Self-Review

**Spec coverage vs the 7 locked decisions:**
1. Pre-revenue framing → flag-gated, reversible approach. ✓
2. Stripe Tax exclusive + "plus applicable taxes" → Task 2 + Tasks 4/4b copy + Launch-Gate. ✓
3. Cancellation copy → real path + offboarding gate + E2E smoke (Launch-Gate). ✓
4. Conspicuous renewal disclosure on both surfaces → Tasks 4 + 4b. ✓
5. One shared pinned/bounded Stripe client → Task 1 (all 8 sites + verify grep + test-hygiene). ✓
6. Defer dispute/SCA code, configure dashboard → Launch-Gate + Fast-Follow. ✓
7. Grandfathering (new=new price, existing=old) → already built; Task 5 guards it (5a test + 5b parity + procedure). ✓

**Codex corrections baked in:** Product (not Price) tax code; update-if-unspecified-else-recreate for `tax_behavior`; Dahlia `pricing.unit_amount_decimal` + `subtotal`/`amount` fallbacks in the drift test; webhook endpoint version as a hard blocker; second consent surface (Task 4b); `STRIPE_TAX_ENABLED` in `startup-assert`; staging tax-line verification; retained-acknowledgment content check; tier-change fee-change timing; `customer_update` note on the deferred customer-reuse item; binding (not config-only) legal gate; FTC click-to-cancel vacatur.

**Type/name consistency:** `getStripe`, `STRIPE_CLIENT_CONFIG`, `resetStripeClientForTests`, `STRIPE_TAX_ENABLED`, `recurringSubscriptionLineTotalCents`, `compareUpcomingInvoice`, `currentBillingSnapshot`, `basePriceIdForTier`, `overagePriceIdForTier`, `TIER_CONFIG` match the real exports verified in the codebase. `apiVersion` literal `'2026-05-27.dahlia'` matches `stripe@22.2.0`'s SDK default.
