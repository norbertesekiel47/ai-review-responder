# Onboarding Demo Cost Guard

Parallel cost-guard helper for the **pre-pay** onboarding demo lane. Lives at
`src/lib/costs/onboarding-demo-cost-guard.ts`. Distinct from the post-pay
`src/lib/costs/cost-guard.ts` because pre-pay users have neither a `business_id`
nor a `subscription_tier` to scope spend against.

## Usage

```typescript
import {
  reserveOnboardingDemoBudget,
  finalizeOnboardingDemoCost,
  checkCostThreshold,
  withOnboardingDemoCostGuard,
  CostCeilingExceeded,
} from '@/lib/costs/onboarding-demo-cost-guard';

// 1. Reservation pattern (route handler at /api/onboarding/start)
const reservation = await reserveOnboardingDemoBudget();
try {
  // ...do tx, enqueue worker, thread reservation.date into payload...
} catch (err) {
  await reservation.release();
  throw err;
}

// 2. Wrapper pattern
const result = await withOnboardingDemoCostGuard(
  { ipKey: '1.2.3.4' },
  async () => {
    // ...do work...
    return { value: result, actualCostCents: 15 };
  },
);
```

## Key differences from `withCostGuard`

| Aspect | `withCostGuard` (post-pay) | `withOnboardingDemoCostGuard` (pre-pay) |
| --- | --- | --- |
| Scope key | `businessId` + `subscriptionTier` | global daily counter |
| Default ceiling | per-business monthly cap | `$10/day` (`ONBOARDING_DEMO_DAILY_CENTS`) |
| Override | per-business override row | Redis key `cost:onboarding-demo:override:cents` |
| Reconciliation | inline against `api_costs` | worker calls `finalizeOnboardingDemoCost(date, cents)` |

## Reservation/finalize semantics

- `reserveOnboardingDemoBudget` increments the daily counter by **20¢** (a
  pessimistic reserve sized to cover SerpAPI + LLM + headroom). Returns the
  reservation date so the worker can thread it through the BullMQ payload.
- The worker calls `finalizeOnboardingDemoCost(date, actualCostCents)` after a
  successful demo. The function adjusts the daily counter by
  `delta = actualCostCents - 20`. On the failure / subscription-state-changed
  / claim-no-op paths, the worker passes `0` so the full 20¢ is released.

Without the worker reconciliation step, every demo would permanently consume
the full 20¢ reserve and the daily ceiling would burn out ~6.6× faster than
intended (typical actual spend is ~3¢).

## Threshold alerts

```typescript
const { crossed } = await checkCostThreshold(
  'onboarding-demo',
  '2026-05-03',
  [50, 90, 100],
);
for (const t of crossed) {
  Sentry.captureMessage(`onboarding_demo_cost_threshold_${t}`, {
    level: t === 100 ? 'error' : t >= 90 ? 'warning' : 'info',
  });
}
```

Each threshold fires **at most once per day per lane** — implemented via a
Redis `SADD` into a daily set with 25h TTL. Avoids Sentry spam when the
counter sits above a threshold for the rest of the day.
