# Billing Locations UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make billing tiers consistent across onboarding and make Settings the primary, discoverable place to manage or unlock locations.

**Architecture:** Keep Stripe Price IDs as the charge source of truth and use verified local tier config for display. Separate three concepts that are currently conflated: multi-location mode, Locations settings visibility, and add-location eligibility. Keep backend add-location quota enforcement unchanged and make the UI reflect it.

**Tech Stack:** Next.js 15 App Router, React 18 client components, TypeScript, Zod, Stripe Billing/Checkout, Vitest with Testing Library.

---

## Scope Check

This is one cohesive billing/location UX change. It touches onboarding plan display/validation, Settings navigation, the Locations settings panel, and add-location billing preview. Each task below is independently testable and commits a small vertical slice.

## File Structure

- Create `src/app/onboarding/pay/plan-options.ts`: plan display metadata and price formatting derived from verified `TIER_CONFIG`.
- Create `src/app/onboarding/pay/__tests__/plan-options.test.ts`: unit coverage for four tiers and prices.
- Modify `src/app/onboarding/pay/PlanPickerClient.tsx`: render plan cards from shared plan options and widen tier state to `SubscriptionTierValue`.
- Create `src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx`: component coverage that all four plans render and Basic posts correctly.
- Modify `src/lib/shared/schemas.ts`: include `basic` in `SelectPlanSchema` and update comments.
- Create `src/lib/shared/__tests__/select-plan-schema.test.ts`: schema-level acceptance/rejection tests.
- Modify `src/app/api/onboarding/select-plan/route.ts`: update route comments and keep route behavior unchanged.
- Modify `src/app/api/onboarding/__tests__/select-plan.test.ts`: route-level Basic checkout test.
- Modify `src/lib/locations/multi-location-mode.ts`: add separate helpers for Locations tab visibility and add-location eligibility.
- Modify `src/lib/locations/__tests__/multi-location-mode.test.ts`: tests for the three separate concepts.
- Modify `src/components/dashboard/SettingsTabs.tsx`: support a single-location tab set that includes Locations without switching Voice to `/settings/voice`.
- Create `src/components/dashboard/__tests__/SettingsTabs.test.tsx`: tab-shape tests.
- Modify `src/components/dashboard/settings/SettingsShell.tsx`: pass the separate Locations visibility flag down to `SettingsTabs`.
- Modify `src/app/(authenticated)/settings/page.tsx`: compute multi-location mode and Locations visibility separately.
- Modify `src/app/(authenticated)/settings/SettingsClient.tsx`: render Settings with a Locations tab for one-location accounts when the feature flag is on; expose existing billing/change-plan controls so Basic locked-state CTAs have a real target.
- Modify `src/app/(authenticated)/settings/locations/page.tsx`: allow one-location accounts through when the feature flag is on and compute add-location state from account tier/status.
- Modify `src/app/(authenticated)/settings/locations/LocationsClient.tsx`: pass add-location state to the panel.
- Modify `src/components/dashboard/settings/LocationsPanel.tsx`: render either active Add Location CTA or Basic/inactive locked state.
- Modify `src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx`: locked-state and eligible-state coverage.
- Modify `src/lib/accounts/quota.ts`: include `includedLocations` in `BillingSnapshot`.
- Modify `src/lib/accounts/__tests__/quota.test.ts`: assert the new snapshot field.
- Modify `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx`: compute incremental add-location billing from `activeLocationCount + 1` and `includedLocations`.
- Modify `src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts`: billing preview math tests.

---

### Task 0: Confirm Stripe Price Verification

**Files:**
- Read only: `.env.local`
- Read only: `src/lib/accounts/tier-config.ts`
- Read only: `src/lib/payments/create-checkout-session.ts`

- [ ] **Step 1: Read configured Stripe Price IDs**

Run:

```bash
rg -n "^STRIPE_PRICE_(BASIC|FOUNDING|STANDARD|PREMIUM|FOUNDERS_OVERAGE|STANDARD_OVERAGE|PREMIUM_OVERAGE)=" .env.local
```

Expected values:

```text
STRIPE_PRICE_BASIC=price_1TUcE52ZehYF3mcPgriVbOdd
STRIPE_PRICE_FOUNDING=price_1TUcEP2ZehYF3mcPVEW9gwkR
STRIPE_PRICE_FOUNDERS_OVERAGE=price_1TUcET2ZehYF3mcP7GpiYT2b
STRIPE_PRICE_STANDARD=price_1TUcE92ZehYF3mcPbypCrnXN
STRIPE_PRICE_STANDARD_OVERAGE=price_1TUcED2ZehYF3mcPq5PUcZ6s
STRIPE_PRICE_PREMIUM=price_1TUcEG2ZehYF3mcPEzkW1skq
STRIPE_PRICE_PREMIUM_OVERAGE=price_1TUcEK2ZehYF3mcPJX5CfMtu
```

- [ ] **Step 2: Verify Stripe amounts**

Use the Stripe connector `_list_prices` with `limit: 100`, or the Stripe
Dashboard if the connector is unavailable. Confirm this exact mapping:

```text
price_1TUcE52ZehYF3mcPgriVbOdd  -> 2900  usd recurring month
price_1TUcEP2ZehYF3mcPVEW9gwkR  -> 1900  usd recurring month
price_1TUcET2ZehYF3mcP7GpiYT2b  -> 2500  usd recurring month
price_1TUcE92ZehYF3mcPbypCrnXN  -> 7900  usd recurring month
price_1TUcED2ZehYF3mcPq5PUcZ6s  -> 2500  usd recurring month
price_1TUcEG2ZehYF3mcPEzkW1skq  -> 19900 usd recurring month
price_1TUcEK2ZehYF3mcPJX5CfMtu  -> 2000  usd recurring month
```

If any amount differs, stop and reconcile the Stripe Price IDs or
`TIER_CONFIG` before implementing Task 1. Do not change visible onboarding
prices until this check passes.

---

### Task 1: Onboarding Plan Display Metadata

**Files:**
- Create: `src/app/onboarding/pay/plan-options.ts`
- Create: `src/app/onboarding/pay/__tests__/plan-options.test.ts`
- Modify: `src/app/onboarding/pay/PlanPickerClient.tsx`
- Create: `src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx`

- [ ] **Step 1: Write failing unit tests for plan options**

Create `src/app/onboarding/pay/__tests__/plan-options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatMonthlyPrice,
  getOnboardingPlans,
  ONBOARDING_PLAN_ORDER,
} from '../plan-options';

describe('onboarding plan options', () => {
  it('lists all four canonical onboarding tiers in display order', () => {
    expect(ONBOARDING_PLAN_ORDER).toEqual([
      'founders',
      'basic',
      'standard',
      'premium',
    ]);

    expect(getOnboardingPlans().map((plan) => plan.tier)).toEqual([
      'founders',
      'basic',
      'standard',
      'premium',
    ]);
  });

  it('formats verified canonical monthly prices', () => {
    const byTier = Object.fromEntries(
      getOnboardingPlans().map((plan) => [plan.tier, plan.price]),
    );

    expect(byTier).toMatchObject({
      founders: '$19',
      basic: '$29',
      standard: '$79',
      premium: '$199',
    });
  });

  it('formats whole-dollar and decimal prices', () => {
    expect(formatMonthlyPrice(7900)).toBe('$79');
    expect(formatMonthlyPrice(7950)).toBe('$79.50');
  });
});
```

- [ ] **Step 2: Run the new unit test to verify it fails**

Run:

```bash
pnpm exec vitest run src/app/onboarding/pay/__tests__/plan-options.test.ts
```

Expected: FAIL because `plan-options.ts` does not exist.

- [ ] **Step 3: Implement shared onboarding plan metadata**

Create `src/app/onboarding/pay/plan-options.ts`:

```ts
import {
  SubscriptionTier,
  TIER_CONFIG,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';

export interface OnboardingPlan {
  tier: SubscriptionTierValue;
  name: string;
  price: string;
  badge: string;
  badgeColor: string;
  badgeText: string;
  description: string;
  highlight: boolean;
  features: readonly string[];
  cta: string;
}

interface PlanCopy {
  name: string;
  badge: string;
  badgeColor: string;
  badgeText: string;
  description: string;
  highlight: boolean;
  features: readonly string[];
  cta: string;
}

export const ONBOARDING_PLAN_ORDER = [
  SubscriptionTier.FOUNDERS,
  SubscriptionTier.BASIC,
  SubscriptionTier.STANDARD,
  SubscriptionTier.PREMIUM,
] as const satisfies readonly SubscriptionTierValue[];

const PLAN_COPY: Record<SubscriptionTierValue, PlanCopy> = {
  founders: {
    name: 'Founding Member',
    badge: 'Limited — 10 slots',
    badgeColor: '#F2C3B9',
    badgeText: '#2a2a2a',
    description: 'Rate locked for life.',
    highlight: true,
    cta: 'Claim founding rate',
    features: [
      'Google review monitoring',
      'AI-powered personalized responses',
      'One-tap email approval',
      'Weekly review intelligence brief',
      'ROI dashboard',
      'Dedicated onboarding call',
      'Rate locked for life',
    ],
  },
  basic: {
    name: 'Basic',
    badge: 'Single location',
    badgeColor: '#E7E3DC',
    badgeText: '#2a2a2a',
    description: 'For one-location businesses getting started.',
    highlight: false,
    cta: 'Choose Basic',
    features: [
      'Google review monitoring',
      'AI-powered personalized responses',
      'One-tap email approval',
      'Weekly review intelligence brief',
      'One Google Business Profile location',
    ],
  },
  standard: {
    name: 'Standard',
    badge: 'Most popular',
    badgeColor: '#97B3AE',
    badgeText: '#ffffff',
    description: 'For growing teams that may add locations.',
    highlight: false,
    cta: 'Choose Standard',
    features: [
      'Everything in Basic',
      'Multi-location add-ons available',
      'Priority support',
      'Advanced analytics',
      'Custom response style guide',
    ],
  },
  premium: {
    name: 'Premium',
    badge: 'High volume',
    badgeColor: '#2a2a2a',
    badgeText: '#ffffff',
    description: 'For multi-location teams with higher review volume.',
    highlight: false,
    cta: 'Choose Premium',
    features: [
      'Everything in Standard',
      'Five included Google Business Profile locations',
      'Lower per-location add-on rate',
      'Up to 50 historical reviews backfilled on connect',
      'Priority support',
    ],
  },
};

export function formatMonthlyPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function getOnboardingPlans(): readonly OnboardingPlan[] {
  return ONBOARDING_PLAN_ORDER.map((tier) => ({
    tier,
    price: formatMonthlyPrice(TIER_CONFIG[tier].baseCents),
    ...PLAN_COPY[tier],
  }));
}
```

- [ ] **Step 4: Run the plan-options test to verify it passes**

Run:

```bash
pnpm exec vitest run src/app/onboarding/pay/__tests__/plan-options.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing component tests for the plan picker**

Create `src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanPickerClient } from '../PlanPickerClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlanPickerClient', () => {
  it('renders all four onboarding plans with canonical prices', () => {
    render(<PlanPickerClient cancelled={false} />);

    expect(screen.getByRole('heading', { name: 'Founding Member' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Basic' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Standard' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Premium' })).toBeInTheDocument();

    expect(screen.getByText('$19')).toBeInTheDocument();
    expect(screen.getByText('$29')).toBeInTheDocument();
    expect(screen.getByText('$79')).toBeInTheDocument();
    expect(screen.getByText('$199')).toBeInTheDocument();
  });

  it('posts tier basic when Basic is selected', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'checkout_unavailable' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PlanPickerClient cancelled={false} />);
    await user.click(screen.getByRole('button', { name: 'Choose Basic' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/onboarding/select-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: 'basic' }),
      });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Checkout unavailable');
  });
});
```

- [ ] **Step 6: Run the component test to verify it fails**

Run:

```bash
pnpm exec vitest run src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx
```

Expected: FAIL because Basic is not rendered and the component still has a three-tier union.

- [ ] **Step 7: Update `PlanPickerClient` to use shared plan options**

Modify `src/app/onboarding/pay/PlanPickerClient.tsx`:

```tsx
'use client';

import { useState } from 'react';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { getOnboardingPlans } from './plan-options';

const PLANS = getOnboardingPlans();

export function PlanPickerClient({ cancelled }: { cancelled: boolean }) {
  const [selecting, setSelecting] = useState<SubscriptionTierValue | null>(null);
  const [error, setError] = useState('');

  async function handlePick(tier: SubscriptionTierValue) {
    if (selecting) return;
    setSelecting(tier);
    setError('');
    try {
      const res = await fetch('/api/onboarding/select-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (res.status === 409 && body.subscriptionStatus === 'active') {
          window.location.href = '/dashboard';
          return;
        }
        setError(
          body.error === 'rate_limited'
            ? 'Too many attempts — wait a moment and try again.'
            : body.error === 'checkout_unavailable' || body.error === 'payment_link_unavailable'
              ? 'Checkout unavailable. Please contact support.'
              : 'Something went wrong. Please try again.',
        );
        setSelecting(null);
        return;
      }
      const { paymentUrl } = (await res.json()) as { paymentUrl: string };
      window.location.href = paymentUrl;
    } catch {
      setError('Connection failed. Please try again.');
      setSelecting(null);
    }
  }

  return (
    <div className="w-full max-w-6xl">
      {cancelled && (
        <p className="text-sm text-amber-700 mb-4 text-center">
          No worries — pick a plan when you&apos;re ready.
        </p>
      )}
      <h1 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-2 text-center">
        Choose your plan
      </h1>
      <p className="text-[#6a6a6a] text-center mb-10">
        You can switch tiers any time from your dashboard.
      </p>

      <div className="grid md:grid-cols-4 gap-6">
        {PLANS.map((plan) => {
          const isLoading = selecting === plan.tier;
          const isOtherLoading = selecting !== null && !isLoading;
          return (
            <div
              key={plan.tier}
              className={`relative rounded-2xl p-7 border shadow-lg flex flex-col bg-white ${
                plan.highlight
                  ? 'border-[#97B3AE]/40 bg-gradient-to-br from-[#F0EEEA]/60 to-white'
                  : 'border-[#97B3AE]/10'
              }`}
            >
              <div
                className="absolute -top-3 left-6 px-3 py-1 rounded-full text-xs font-medium"
                style={{ background: plan.badgeColor, color: plan.badgeText }}
              >
                {plan.badge}
              </div>

              <h3 className="text-xl font-medium text-[#2a2a2a] mt-2 mb-1">
                {plan.name}
              </h3>
              <p className="text-sm text-[#6a6a6a] mb-4">{plan.description}</p>
              <div className="mb-6">
                <span className="text-4xl font-medium text-[#2a2a2a]">
                  {plan.price}
                </span>
                <span className="text-[#6a6a6a] text-sm">/month</span>
              </div>

              <button
                type="button"
                onClick={() => handlePick(plan.tier)}
                disabled={isLoading || isOtherLoading}
                className={`block w-full text-center py-3 rounded-full font-medium text-sm mb-6 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  plan.highlight
                    ? 'bg-[#97B3AE] text-white shadow-lg hover:bg-[#7e9b96]'
                    : 'bg-[#F0EEEA] text-[#2a2a2a] border border-[#97B3AE]/10 hover:bg-[#e7e3dc]'
                }`}
              >
                {isLoading ? 'Redirecting to checkout…' : plan.cta}
              </button>

              <ul className="space-y-3 flex-1">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2 text-sm text-[#6a6a6a]"
                  >
                    <svg
                      className="w-4 h-4 text-[#97B3AE] shrink-0 mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-6 text-sm text-red-700 text-center" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run onboarding plan tests**

Run:

```bash
pnpm exec vitest run src/app/onboarding/pay/__tests__/plan-options.test.ts src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit onboarding plan display changes**

```bash
git add src/app/onboarding/pay/plan-options.ts src/app/onboarding/pay/__tests__/plan-options.test.ts src/app/onboarding/pay/PlanPickerClient.tsx src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx
git commit -m "fix: show all onboarding billing tiers"
```

---

### Task 2: Basic Tier Validation Through Select Plan

**Files:**
- Modify: `src/lib/shared/schemas.ts`
- Create: `src/lib/shared/__tests__/select-plan-schema.test.ts`
- Modify: `src/app/api/onboarding/select-plan/route.ts`
- Modify: `src/app/api/onboarding/__tests__/select-plan.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `src/lib/shared/__tests__/select-plan-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SelectPlanSchema } from '../schemas';

describe('SelectPlanSchema', () => {
  it.each(['founders', 'basic', 'standard', 'premium'] as const)(
    'accepts tier %s',
    (tier) => {
      expect(SelectPlanSchema.parse({ tier })).toEqual({ tier });
    },
  );

  it('rejects unknown tiers', () => {
    expect(() => SelectPlanSchema.parse({ tier: 'enterprise' })).toThrow();
  });
});
```

- [ ] **Step 2: Run schema test to verify it fails**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/select-plan-schema.test.ts
```

Expected: FAIL because `basic` is not accepted.

- [ ] **Step 3: Update `SelectPlanSchema` and comment**

In `src/lib/shared/schemas.ts`, replace the select-plan comment and schema with:

```ts
// Plan selection on /onboarding/pay. Owner picks founders, basic, standard,
// or premium; the route writes the choice to accounts.subscription_tier and
// returns the matching Stripe Checkout Session URL.
export const SelectPlanSchema = z.object({
  tier: z.enum(['founders', 'basic', 'standard', 'premium']),
});
type SelectPlanInput = z.infer<typeof SelectPlanSchema>;
```

- [ ] **Step 4: Run schema test to verify it passes**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/select-plan-schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing route-level Basic checkout test**

In `src/app/api/onboarding/__tests__/select-plan.test.ts`, add this test near the existing premium/standard success tests:

```ts
  it('accepts tier="basic" and returns the Basic checkout URL', async () => {
    mockCreateCheckoutSession.mockResolvedValueOnce({
      url: 'https://checkout.stripe.com/test/basic',
      sessionId: 'cs_test_basic',
    });

    const res = await POST(mkReq({ tier: 'basic' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paymentUrl).toBe('https://checkout.stripe.com/test/basic');
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      expect.any(String),
      'basic',
      'owner@example.com',
    );
  });
```

- [ ] **Step 6: Run route test to verify it passes after schema change**

Run:

```bash
pnpm exec vitest run src/app/api/onboarding/__tests__/select-plan.test.ts
```

Expected: PASS.

- [ ] **Step 7: Update route comments**

In `src/app/api/onboarding/select-plan/route.ts`, update comments that say `founders | standard | premium` so they say `founders | basic | standard | premium`. Do not change durable side-effect behavior in the route.

- [ ] **Step 8: Run all select-plan related tests**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/select-plan-schema.test.ts src/app/api/onboarding/__tests__/select-plan.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit validation changes**

```bash
git add src/lib/shared/schemas.ts src/lib/shared/__tests__/select-plan-schema.test.ts src/app/api/onboarding/select-plan/route.ts src/app/api/onboarding/__tests__/select-plan.test.ts
git commit -m "fix: accept basic onboarding plan selection"
```

---

### Task 3: Separate Location Mode Helpers

**Files:**
- Modify: `src/lib/locations/multi-location-mode.ts`
- Modify: `src/lib/locations/__tests__/multi-location-mode.test.ts`

- [ ] **Step 1: Expand failing helper tests**

Replace `src/lib/locations/__tests__/multi-location-mode.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import {
  canAddLocationForAccount,
  shouldShowLocationsSettings,
  shouldUseMultiLocationSettings,
} from '../multi-location-mode';

describe('shouldUseMultiLocationSettings', () => {
  it('keeps single-location settings when the feature flag is off', () => {
    expect(shouldUseMultiLocationSettings(false, 3)).toBe(false);
  });

  it('keeps single-location mode for accounts with one active location', () => {
    expect(shouldUseMultiLocationSettings(true, 1)).toBe(false);
  });

  it('uses multi-location mode once an account has multiple active locations', () => {
    expect(shouldUseMultiLocationSettings(true, 2)).toBe(true);
  });
});

describe('shouldShowLocationsSettings', () => {
  it('hides locations settings when the feature flag is off', () => {
    expect(shouldShowLocationsSettings(false)).toBe(false);
  });

  it('shows locations settings whenever the feature flag is on', () => {
    expect(shouldShowLocationsSettings(true)).toBe(true);
  });
});

describe('canAddLocationForAccount', () => {
  it.each(['founders', 'standard', 'premium'] as const)(
    'allows active %s accounts when the feature flag is on',
    (tier) => {
      expect(canAddLocationForAccount(true, tier, 'active')).toBe(true);
    },
  );

  it('does not allow Basic even when active', () => {
    expect(canAddLocationForAccount(true, 'basic', 'active')).toBe(false);
  });

  it('does not allow eligible tiers when subscription is not active', () => {
    expect(canAddLocationForAccount(true, 'standard', 'pending_payment')).toBe(false);
  });

  it('does not allow eligible tiers when the feature flag is off', () => {
    expect(canAddLocationForAccount(false, 'standard', 'active')).toBe(false);
  });

  it('does not allow unknown tiers', () => {
    expect(canAddLocationForAccount(true, 'enterprise', 'active')).toBe(false);
  });
});
```

- [ ] **Step 2: Run helper tests to verify they fail**

Run:

```bash
pnpm exec vitest run src/lib/locations/__tests__/multi-location-mode.test.ts
```

Expected: FAIL because the new helpers do not exist.

- [ ] **Step 3: Implement separate helper functions**

Replace `src/lib/locations/multi-location-mode.ts` with:

```ts
import { lookupTierConfig } from '@/lib/accounts/tier-config';

export function shouldUseMultiLocationSettings(
  featureEnabled: boolean,
  activeLocationCount: number,
): boolean {
  return featureEnabled && activeLocationCount > 1;
}

export function shouldShowLocationsSettings(featureEnabled: boolean): boolean {
  return featureEnabled;
}

export function canAddLocationForAccount(
  featureEnabled: boolean,
  subscriptionTier: string,
  subscriptionStatus: string,
): boolean {
  if (!featureEnabled) return false;
  if (subscriptionStatus !== 'active') return false;
  return lookupTierConfig(subscriptionTier)?.multiLocAllowed === true;
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
pnpm exec vitest run src/lib/locations/__tests__/multi-location-mode.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit helper separation**

```bash
git add src/lib/locations/multi-location-mode.ts src/lib/locations/__tests__/multi-location-mode.test.ts
git commit -m "refactor: separate location settings capability"
```

---

### Task 4: Settings Tabs and Main Settings Page

**Files:**
- Modify: `src/components/dashboard/SettingsTabs.tsx`
- Create: `src/components/dashboard/__tests__/SettingsTabs.test.tsx`
- Modify: `src/components/dashboard/settings/SettingsShell.tsx`
- Modify: `src/app/(authenticated)/settings/page.tsx`
- Modify: `src/app/(authenticated)/settings/SettingsClient.tsx`

- [ ] **Step 1: Write failing tab-shape tests**

Create `src/components/dashboard/__tests__/SettingsTabs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsTabs } from '../SettingsTabs';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('SettingsTabs', () => {
  it('uses the existing single-location tabs when locations settings are disabled', () => {
    render(<SettingsTabs activeTab="general" />);

    expect(screen.getByRole('tab', { name: /general/i })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('tab', { name: /locations/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /brand voice/i })).toHaveAttribute('href', '/settings#brand-voice');
  });

  it('adds Locations while keeping Brand Voice anchored for one-location capable accounts', () => {
    render(
      <SettingsTabs
        activeTab="general"
        locationsSettingsEnabled
        multiLocationEnabled={false}
      />,
    );

    expect(screen.getByRole('tab', { name: /general/i })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('tab', { name: /locations/i })).toHaveAttribute('href', '/settings/locations');
    expect(screen.getByRole('tab', { name: /brand voice/i })).toHaveAttribute('href', '/settings#brand-voice');
    expect(screen.queryByRole('tab', { name: /^account$/i })).not.toBeInTheDocument();
  });

  it('uses the multi-location account tabs for true multi-location accounts', () => {
    render(
      <SettingsTabs
        activeTab="account"
        locationsSettingsEnabled
        multiLocationEnabled
      />,
    );

    expect(screen.getByRole('tab', { name: /^account$/i })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('tab', { name: /locations/i })).toHaveAttribute('href', '/settings/locations');
    expect(screen.getByRole('tab', { name: /^voice$/i })).toHaveAttribute('href', '/settings/voice');
    expect(screen.getByRole('tab', { name: /notifications/i })).toHaveAttribute('href', '/settings/channels');
  });
});
```

- [ ] **Step 2: Run tab tests to verify they fail**

Run:

```bash
pnpm exec vitest run src/components/dashboard/__tests__/SettingsTabs.test.tsx
```

Expected: FAIL because `locationsSettingsEnabled` is not supported.

- [ ] **Step 3: Update `SettingsTabs`**

In `src/components/dashboard/SettingsTabs.tsx`, add the single-location-with-Locations tab set and prop:

```tsx
/** Single-location with location capability: General, Locations, Brand Voice, Notifications */
const TABS_SINGLE_WITH_LOCATIONS: Tab[] = [
  { id: 'general', label: 'General', icon: 'cog', href: '/settings' },
  { id: 'locations', label: 'Locations', icon: 'location', href: '/settings/locations' },
  { id: 'voice', label: 'Brand Voice', icon: 'sparkle', href: '/settings#brand-voice' },
  { id: 'channels', label: 'Notifications', icon: 'inbox', href: '/settings/channels' },
];
```

Update props and tab selection:

```tsx
interface Props {
  activeTab: SettingsTab;
  /** True only for accounts with 2+ active locations and the feature flag on. */
  multiLocationEnabled?: boolean;
  /** True when /settings/locations should be visible. */
  locationsSettingsEnabled?: boolean;
}

export function SettingsTabs({
  activeTab,
  multiLocationEnabled,
  locationsSettingsEnabled,
}: Props) {
  const tabs = multiLocationEnabled
    ? TABS_MULTI
    : locationsSettingsEnabled
      ? TABS_SINGLE_WITH_LOCATIONS
      : TABS_SINGLE;

  // keep existing refs/useLayoutEffect/render code, but include
  // locationsSettingsEnabled in the useLayoutEffect dependency array.
}
```

- [ ] **Step 4: Update `SettingsShell` prop forwarding**

In `src/components/dashboard/settings/SettingsShell.tsx`, update the prop interface and call:

```tsx
interface Props {
  activeTab: SettingsTab;
  children: React.ReactNode;
  saveBar?: {
    visible: boolean;
    dirtyCount: number;
    saving: boolean;
    onSave: () => void;
    onDiscard: () => void;
  };
  savedFlash?: boolean;
  multiLocationEnabled?: boolean;
  locationsSettingsEnabled?: boolean;
}

export function SettingsShell({
  activeTab,
  children,
  saveBar,
  savedFlash,
  multiLocationEnabled,
  locationsSettingsEnabled,
}: Props) {
  return (
    <div className="settings-content">
      <SettingsTabs
        activeTab={activeTab}
        multiLocationEnabled={multiLocationEnabled}
        locationsSettingsEnabled={locationsSettingsEnabled}
      />
      {children}
      {/* keep the existing save bar and toast unchanged */}
    </div>
  );
}
```

- [ ] **Step 5: Update `settings/page.tsx` to compute both booleans**

In `src/app/(authenticated)/settings/page.tsx`, compute and pass separate values:

```tsx
import {
  shouldShowLocationsSettings,
  shouldUseMultiLocationSettings,
} from '@/lib/locations/multi-location-mode';

export default async function SettingsPage() {
  const access = await requireOwnerAccess();

  const featureEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';
  const activeLocationCount = await getActiveLocationCount(access.accountId);
  const multiLocationEnabled = shouldUseMultiLocationSettings(
    featureEnabled,
    activeLocationCount,
  );
  const locationsSettingsEnabled = shouldShowLocationsSettings(featureEnabled);

  return (
    <>
      <TopBar
        title="Settings"
        subtitle={
          locationsSettingsEnabled
            ? 'Account, locations, voice, and notification preferences.'
            : 'Tune your voice, channels, and account preferences.'
        }
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <SettingsClient
        multiLocationEnabled={multiLocationEnabled}
        locationsSettingsEnabled={locationsSettingsEnabled}
      />
    </>
  );
}
```

- [ ] **Step 6: Update `SettingsClient` rendering**

In `src/app/(authenticated)/settings/SettingsClient.tsx`, update props and shell calls:

```tsx
interface Props {
  multiLocationEnabled: boolean;
  locationsSettingsEnabled: boolean;
}

export function SettingsClient({
  multiLocationEnabled,
  locationsSettingsEnabled,
}: Props) {
  const f = useSettingsForm();
  const accountData = useAccountData();

  const activeTab: SettingsTab = multiLocationEnabled ? 'account' : 'general';

  const shellProps = {
    activeTab,
    multiLocationEnabled,
    locationsSettingsEnabled,
  };

  if (f.fetchError) {
    return (
      <SettingsShell {...shellProps}>
        <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
          <div className="set-section-title" style={{ color: '#991B1B' }}>Error</div>
          <p style={{ fontSize: 13, color: '#B91C1C' }}>{f.fetchError}</p>
        </div>
      </SettingsShell>
    );
  }

  if (!f.data || !f.form) {
    return (
      <SettingsShell {...shellProps}>
        <p style={{ textAlign: 'center', color: '#6B7280', padding: '60px 0' }}>Loading settings…</p>
      </SettingsShell>
    );
  }

  if (multiLocationEnabled) {
    return (
      <SettingsShell
        activeTab="account"
        multiLocationEnabled
        locationsSettingsEnabled={locationsSettingsEnabled}
      >
        <AccountPanel
          data={f.data}
          accountData={accountData.data}
          accountLoading={accountData.loading}
          accountError={accountData.error}
          onAccountRefetch={accountData.refetch}
        />
      </SettingsShell>
    );
  }

  const profileAndBilling = locationsSettingsEnabled ? (
    <AccountPanel
      data={f.data}
      accountData={accountData.data}
      accountLoading={accountData.loading}
      accountError={accountData.error}
      onAccountRefetch={accountData.refetch}
    />
  ) : (
    <GeneralPanel data={f.data} />
  );

  return (
    <SettingsShell
      activeTab="general"
      locationsSettingsEnabled={locationsSettingsEnabled}
      savedFlash={f.savedFlash}
      saveBar={{
        visible: f.dirty,
        dirtyCount: f.dirtyCount,
        saving: f.saving,
        onSave: () => void f.save(),
        onDiscard: f.discard,
      }}
    >
      {profileAndBilling}
      <BrandVoicePanel form={f.form} set={f.set} />
      {f.saveError && (
        <p style={{ fontSize: 13, color: '#DC2626', marginTop: 4 }}>{f.saveError}</p>
      )}
    </SettingsShell>
  );
}
```

- [ ] **Step 7: Add a billing anchor in `AccountPanel`**

In `src/components/dashboard/settings/AccountPanel.tsx`, add an `id` to the Subscription & Billing section:

```tsx
      <div className="set-section" id="subscription-billing">
```

- [ ] **Step 8: Run tab tests**

Run:

```bash
pnpm exec vitest run src/components/dashboard/__tests__/SettingsTabs.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit Settings tab changes**

```bash
git add src/components/dashboard/SettingsTabs.tsx src/components/dashboard/__tests__/SettingsTabs.test.tsx src/components/dashboard/settings/SettingsShell.tsx "src/app/(authenticated)/settings/page.tsx" "src/app/(authenticated)/settings/SettingsClient.tsx" src/components/dashboard/settings/AccountPanel.tsx
git commit -m "fix: expose locations settings separately from switching mode"
```

---

### Task 5: Locations Page Locked and Eligible States

**Files:**
- Modify: `src/app/(authenticated)/settings/locations/page.tsx`
- Modify: `src/app/(authenticated)/settings/locations/LocationsClient.tsx`
- Modify: `src/components/dashboard/settings/LocationsPanel.tsx`
- Modify: `src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx`

- [ ] **Step 1: Add failing LocationsPanel tests**

Append these tests to `src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx`:

```tsx
describe('LocationsPanel add-location state', () => {
  it('shows Add location for eligible accounts', () => {
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        addLocationState={{ kind: 'enabled' }}
        onLocationChange={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: /add location/i })).toHaveAttribute(
      'href',
      '/dashboard/add-location',
    );
  });

  it('shows a Basic locked upgrade state instead of Add location', () => {
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        addLocationState={{
          kind: 'locked',
          title: 'Upgrade to add locations',
          description: 'Basic includes one location. Upgrade to Standard or Premium to add more.',
          ctaHref: '/settings#subscription-billing',
          ctaLabel: 'View plan options',
        }}
        onLocationChange={() => {}}
      />,
    );

    expect(screen.queryByRole('link', { name: /^add location$/i })).not.toBeInTheDocument();
    expect(screen.getByText('Upgrade to add locations')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view plan options/i })).toHaveAttribute(
      'href',
      '/settings#subscription-billing',
    );
  });
});
```

- [ ] **Step 2: Run LocationsPanel tests to verify they fail**

Run:

```bash
pnpm exec vitest run src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx
```

Expected: FAIL because `addLocationState` is not a prop.

- [ ] **Step 3: Add add-location state types and rendering**

In `src/components/dashboard/settings/LocationsPanel.tsx`, add the exported type near the existing entry types:

```tsx
export type AddLocationState =
  | { kind: 'enabled' }
  | {
      kind: 'locked';
      title: string;
      description: string;
      ctaHref?: string;
      ctaLabel?: string;
    };
```

Update `Props`:

```tsx
interface Props {
  locations: LocationEntry[];
  archivedLocations: ArchivedLocationEntry[];
  activeCount: number;
  accountId: string;
  addLocationState?: AddLocationState;
  onLocationChange: () => void;
}
```

Inside `LocationsPanel`, default the state:

```tsx
export function LocationsPanel({
  locations,
  archivedLocations,
  activeCount,
  accountId,
  addLocationState = { kind: 'enabled' },
  onLocationChange,
}: Props) {
  const [archivedExpanded, setArchivedExpanded] = useState(false);
```

Replace the current unconditional Add Location CTA with:

```tsx
      {addLocationState.kind === 'enabled' ? (
        <Link
          href="/dashboard/add-location"
          className="loc-add-cta"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 16,
            padding: '10px 16px',
            border: `1px dashed var(--rw-app-border)`,
            borderRadius: 8,
            color: 'var(--rw-blue-600)',
            fontSize: 14,
            fontWeight: 500,
            textDecoration: 'none',
            transition: 'all 160ms ease',
          }}
        >
          <Icon name="plus" size={14} />
          Add location
        </Link>
      ) : (
        <div
          className="loc-add-locked"
          style={{
            marginTop: 16,
            padding: '14px 16px',
            border: '1px solid var(--rw-app-border)',
            borderRadius: 8,
            background: '#F9FAFB',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: '#374151' }}>
            {addLocationState.title}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6B7280', lineHeight: 1.5 }}>
            {addLocationState.description}
          </p>
          {addLocationState.ctaHref && addLocationState.ctaLabel && (
            <Link
              href={addLocationState.ctaHref}
              className="btn btn-primary"
              style={{ marginTop: 12, display: 'inline-flex', fontSize: 12, padding: '6px 12px' }}
            >
              {addLocationState.ctaLabel}
            </Link>
          )}
        </div>
      )}
```

- [ ] **Step 4: Update `LocationsClient` to pass state**

In `src/app/(authenticated)/settings/locations/LocationsClient.tsx`:

```tsx
import {
  LocationsPanel,
  type AddLocationState,
  type LocationEntry,
  type ArchivedLocationEntry,
} from '@/components/dashboard/settings/LocationsPanel';

interface Props {
  locations: LocationEntry[];
  archivedLocations: ArchivedLocationEntry[];
  activeCount: number;
  accountId: string;
  addLocationState: AddLocationState;
}

export function LocationsClient({
  locations,
  archivedLocations,
  activeCount,
  accountId,
  addLocationState,
}: Props) {
  const handleLocationChange = () => {
    window.location.reload();
  };

  return (
    <SettingsShell
      activeTab="locations"
      multiLocationEnabled={locations.length > 1}
      locationsSettingsEnabled
    >
      <LocationsPanel
        locations={locations}
        archivedLocations={archivedLocations}
        activeCount={activeCount}
        accountId={accountId}
        addLocationState={addLocationState}
        onLocationChange={handleLocationChange}
      />
    </SettingsShell>
  );
}
```

- [ ] **Step 5: Update `settings/locations/page.tsx` gate and state**

In `src/app/(authenticated)/settings/locations/page.tsx`, import the new helpers and type:

```ts
import {
  canAddLocationForAccount,
  shouldShowLocationsSettings,
} from '@/lib/locations/multi-location-mode';
import type { AddLocationState } from '@/components/dashboard/settings/LocationsPanel';
```

Replace the `shouldUseMultiLocationSettings` guard with feature visibility:

```ts
  const featureEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';
  if (!shouldShowLocationsSettings(featureEnabled)) {
    notFound();
  }
```

After `requireOwnerAccess()`, include the account row in the parallel fetch:

```ts
  const [locations, activeCount, archivedLocations, account] = await Promise.all([
    getLocationsForAccount(access.accountId),
    getActiveLocationCount(access.accountId),
    getArchivedLocationsForAccount(access.accountId),
    sql<{ subscription_tier: string; subscription_status: string }[]>`
      SELECT subscription_tier, subscription_status
      FROM accounts
      WHERE id = ${access.accountId}::uuid
      LIMIT 1
    `.then((rows) => rows[0] ?? null),
  ]);
```

Add state computation before the return:

```ts
  const canAddLocation = canAddLocationForAccount(
    featureEnabled,
    account?.subscription_tier ?? '',
    account?.subscription_status ?? '',
  );

  const addLocationState: AddLocationState = canAddLocation
    ? { kind: 'enabled' }
    : account?.subscription_tier === 'basic'
      ? {
          kind: 'locked',
          title: 'Upgrade to add locations',
          description: 'Basic includes one location. Upgrade to Standard or Premium to add more.',
          ctaHref: '/settings#subscription-billing',
          ctaLabel: 'View plan options',
        }
      : {
          kind: 'locked',
          title: 'Location additions unavailable',
          description: 'Your subscription must be active before adding another location.',
          ctaHref: '/settings#subscription-billing',
          ctaLabel: 'Review billing',
        };
```

Pass `addLocationState` into `LocationsClient`.

- [ ] **Step 6: Run LocationsPanel tests**

Run:

```bash
pnpm exec vitest run src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Run Settings/location helper tests together**

Run:

```bash
pnpm exec vitest run src/lib/locations/__tests__/multi-location-mode.test.ts src/components/dashboard/__tests__/SettingsTabs.test.tsx src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit Locations page changes**

```bash
git add "src/app/(authenticated)/settings/locations/page.tsx" "src/app/(authenticated)/settings/locations/LocationsClient.tsx" src/components/dashboard/settings/LocationsPanel.tsx src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx
git commit -m "fix: show locked and active location management states"
```

---

### Task 6: Correct Add-Location Billing Preview

**Files:**
- Modify: `src/lib/accounts/quota.ts`
- Modify: `src/lib/accounts/__tests__/quota.test.ts`
- Modify: `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx`
- Modify: `src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts`

- [ ] **Step 1: Add failing `BillingSnapshot` field assertions**

In `src/lib/accounts/__tests__/quota.test.ts`, add `includedLocations` assertions in the existing `currentBillingSnapshot` tests:

```ts
    expect(snapshot.includedLocations).toBe(1);
```

for standard, basic, and founders tests, and:

```ts
    expect(snapshot.includedLocations).toBe(5);
```

for the premium test.

- [ ] **Step 2: Run quota tests to verify they fail**

Run:

```bash
pnpm exec vitest run src/lib/accounts/__tests__/quota.test.ts
```

Expected: FAIL because `BillingSnapshot` does not expose `includedLocations`.

- [ ] **Step 3: Add `includedLocations` to `BillingSnapshot`**

In `src/lib/accounts/quota.ts`, update the interface:

```ts
export interface BillingSnapshot {
  /** Monthly base price in cents. */
  basePriceCents: number;
  /** Number of locations included in the base price for this tier. */
  includedLocations: number;
  /** Per-location overage price in cents (0 for basic tier). */
  overagePriceCents: number;
  /** Number of overage units (max(0, activeLocations - included)). */
  overageUnits: number;
  /** Total monthly cost in cents = basePriceCents + overageUnits * overagePriceCents. */
  totalCents: number;
}
```

Add `includedLocations: config.included` to both return objects in `currentBillingSnapshot`.

- [ ] **Step 4: Run quota tests**

Run:

```bash
pnpm exec vitest run src/lib/accounts/__tests__/quota.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing preview math tests**

In `src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts`, import `computeNextLocationBillingPreview`:

```ts
import {
  buildAddLocationPayload,
  computeNextLocationBillingPreview,
  computeProration,
  hasStep1LocationDetails,
} from '../AddLocationWizard';
```

Add:

```ts
describe('computeNextLocationBillingPreview', () => {
  it('does not add premium overage while below included locations', () => {
    const result = computeNextLocationBillingPreview({
      activeLocationCount: 3,
      billingSnapshot: {
        basePriceCents: 19900,
        includedLocations: 5,
        overagePriceCents: 2000,
        overageUnits: 0,
        totalCents: 19900,
      },
    });

    expect(result.nextOverageUnits).toBe(0);
    expect(result.additionalLocationMonthlyCents).toBe(0);
    expect(result.newMonthlyTotalCents).toBe(19900);
  });

  it('adds one standard overage when adding a second location', () => {
    const result = computeNextLocationBillingPreview({
      activeLocationCount: 1,
      billingSnapshot: {
        basePriceCents: 7900,
        includedLocations: 1,
        overagePriceCents: 2500,
        overageUnits: 0,
        totalCents: 7900,
      },
    });

    expect(result.nextOverageUnits).toBe(1);
    expect(result.additionalLocationMonthlyCents).toBe(2500);
    expect(result.newMonthlyTotalCents).toBe(10400);
  });
});
```

- [ ] **Step 6: Run wizard tests to verify they fail**

Run:

```bash
pnpm exec vitest run "src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts"
```

Expected: FAIL because `computeNextLocationBillingPreview` does not exist.

- [ ] **Step 7: Implement billing preview helper**

In `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx`, add after `computeProration`:

```ts
export function computeNextLocationBillingPreview({
  activeLocationCount,
  billingSnapshot,
}: {
  activeLocationCount: number;
  billingSnapshot: BillingSnapshot;
}): {
  nextOverageUnits: number;
  additionalLocationMonthlyCents: number;
  newMonthlyTotalCents: number;
} {
  const nextActiveLocations = activeLocationCount + 1;
  const nextOverageUnits = Math.max(
    0,
    nextActiveLocations - billingSnapshot.includedLocations,
  );
  const additionalOverageUnits = Math.max(
    0,
    nextOverageUnits - billingSnapshot.overageUnits,
  );
  const additionalLocationMonthlyCents =
    additionalOverageUnits * billingSnapshot.overagePriceCents;

  return {
    nextOverageUnits,
    additionalLocationMonthlyCents,
    newMonthlyTotalCents:
      billingSnapshot.basePriceCents +
      nextOverageUnits * billingSnapshot.overagePriceCents,
  };
}
```

Replace the current computed billing block:

```ts
  const proration = computeProration(billingSnapshot.overagePriceCents);
  const newOverageUnits = billingSnapshot.overageUnits + 1;
  const newMonthlyTotalCents =
    billingSnapshot.basePriceCents +
    newOverageUnits * billingSnapshot.overagePriceCents;
```

with:

```ts
  const billingPreview = computeNextLocationBillingPreview({
    activeLocationCount,
    billingSnapshot,
  });
  const proration = computeProration(
    billingPreview.additionalLocationMonthlyCents,
  );
  const newMonthlyTotalCents = billingPreview.newMonthlyTotalCents;
```

In the billing summary JSX, replace the additional-location row value logic with:

```tsx
                  <span>
                    + Additional location
                    {billingPreview.additionalLocationMonthlyCents > 0 && (
                      <span className="wizard-billing-note">
                        {' '}(${(billingPreview.additionalLocationMonthlyCents / 100).toFixed(2)}/mo)
                      </span>
                    )}
                  </span>
                  <span>
                    {billingPreview.additionalLocationMonthlyCents > 0
                      ? `$${(billingPreview.additionalLocationMonthlyCents / 100).toFixed(2)}/mo`
                      : 'Included'}
                  </span>
```

Replace the proration guard:

```tsx
                {billingSnapshot.overagePriceCents > 0 && proration.daysRemaining > 0 && (
```

with:

```tsx
                {billingPreview.additionalLocationMonthlyCents > 0 && proration.daysRemaining > 0 && (
```

- [ ] **Step 8: Run quota and wizard tests**

Run:

```bash
pnpm exec vitest run src/lib/accounts/__tests__/quota.test.ts "src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts"
```

Expected: PASS.

- [ ] **Step 9: Commit billing preview changes**

```bash
git add src/lib/accounts/quota.ts src/lib/accounts/__tests__/quota.test.ts "src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx" "src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts"
git commit -m "fix: compute add-location billing preview from included quota"
```

---

### Task 7: Full Focused Verification

**Files:**
- No source edits unless verification finds failures.

- [ ] **Step 1: Run all focused unit/component suites**

Run:

```bash
pnpm exec vitest run src/app/onboarding/pay/__tests__/plan-options.test.ts src/app/onboarding/pay/__tests__/PlanPickerClient.test.tsx src/lib/shared/__tests__/select-plan-schema.test.ts src/app/api/onboarding/__tests__/select-plan.test.ts src/lib/locations/__tests__/multi-location-mode.test.ts src/components/dashboard/__tests__/SettingsTabs.test.tsx src/components/dashboard/settings/__tests__/LocationsPanel.render.test.tsx src/lib/accounts/__tests__/quota.test.ts "src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts"
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git diff --stat HEAD
```

Expected: no unexpected unrelated files. The pre-existing untracked file `docs/superpowers/plans/2026-05-21-security-dependency-hardening.md` may still appear in `git status`; do not include it.

- [ ] **Step 4: Handle verification failures**

If Step 1 or Step 2 fails, return to the task that owns the failing area and
repeat that task's test, implementation, and commit loop. Do not create a
catch-all verification commit. If both commands pass, do not create an empty
commit.
