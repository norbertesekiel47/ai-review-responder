# Billing Tiers and Locations UX Design

## Purpose

RepWorth currently presents inconsistent subscription tiers across onboarding,
pricing, admin setup, and billing logic. The canonical billing model supports
four tiers: `founders`, `basic`, `standard`, and `premium`. The onboarding
payment page exposes only three tiers and carries stale prices.

The app also supports multi-location billing for `founders`, `standard`, and
`premium`, but the normal UI hides location-management entry points until the
account already has more than one RepWorth location. This makes a newly paid
Standard or Premium account look unable to add another location.

This design makes tier display consistent and makes Settings the primary place
to discover and manage location capability.

## Decisions

- Use the canonical application tier names: `founders`, `basic`, `standard`,
  and `premium`.
- Display the customer-facing name "Founding Member" for the internal
  `founders` tier.
- Include Basic on the onboarding payment page.
- Use canonical tier configuration for onboarding prices instead of hardcoded
  stale plan prices.
- Treat dashboard location switching and location-add capability as separate
  concepts.
- Keep the sidebar/header location picker as a switcher only after the account
  has at least two active RepWorth locations.
- Make `/settings/locations` available whenever `MULTI_LOCATION_ENABLED=true`.
- Show Basic accounts a locked upgrade state on `/settings/locations`.
- Show working Add Location actions to active `founders`, `standard`, and
  `premium` accounts.
- Keep the add-location wizard at `/dashboard/add-location`.

## In Scope

- Add Basic to onboarding plan selection.
- Update onboarding plan validation to accept Basic.
- Align onboarding plan prices with `TIER_CONFIG`.
- Update location Settings visibility so the Locations tab/page appears when
  the feature flag is enabled, even for accounts with one location.
- Add a locked Basic state to the Locations page.
- Show Add Location from the Locations page for eligible tiers.
- Fix add-location billing preview to compute overage from
  `activeLocations + 1` against the tier's included location count.
- Add focused tests for plan rendering, plan validation, location tab gating,
  Basic locked state, eligible Add Location state, and overage preview math.

## Out of Scope

- Adding a dedicated top-level Locations navigation item.
- Adding Add Location into the sidebar/header picker for one-location accounts.
- Changing Stripe price IDs or subscription products.
- Changing backend quota policy: Basic remains single-location; `founders`,
  `standard`, and `premium` remain multi-location eligible.
- Reworking the full public pricing page design.
- Reworking admin onboarding beyond any narrow changes needed to prevent tier
  mismatch regressions.

## Concepts

**Multi-location mode** means the account has more than one active RepWorth
location. This controls dashboard scope behavior such as "All Locations" and
the location switcher.

**Location capability** means the account can manage or add locations. This is
controlled by `MULTI_LOCATION_ENABLED`, subscription status, and subscription
tier.

The current bug comes from using multi-location mode as a proxy for location
capability. The new behavior keeps those checks separate.

## User Experience

### Onboarding Payment

The onboarding payment page shows four plans:

- Founding Member
- Basic
- Standard
- Premium

Each plan displays the canonical monthly base price from `TIER_CONFIG`.
Selecting any valid tier posts that tier to `/api/onboarding/select-plan`.
Invalid tier strings remain rejected by schema validation.

### Settings Navigation

When `MULTI_LOCATION_ENABLED=false`, Settings keeps the existing
single-location layout.

When `MULTI_LOCATION_ENABLED=true`, Settings uses the account-oriented tab set,
including the Locations tab, regardless of whether the account currently has
one active location or multiple active locations.

### Locations Page

For eligible tiers (`founders`, `standard`, `premium`) with an active
subscription, `/settings/locations` shows:

- active locations
- archived locations when present
- primary-location controls
- display-label controls
- Add Location CTA linking to `/dashboard/add-location`

For Basic, `/settings/locations` shows:

- current location information when available
- a locked state explaining that Basic includes one location
- an upgrade action that points users toward the existing plan-change surface

The locked state must not call the add-location API and must not link directly
to `/dashboard/add-location`.

### Add-Location Wizard

The wizard stays behind the existing server/API enforcement. Eligible tiers can
add locations; Basic remains blocked by backend quota checks.

The Step 4 billing preview calculates:

```ts
nextActiveLocations = activeLocations + 1
nextOverageUnits = max(0, nextActiveLocations - includedLocations)
nextMonthlyTotal = basePrice + nextOverageUnits * overagePrice
```

This prevents Premium from showing overage charges while the account is still
within its five included locations.

## Data Flow

1. `TIER_CONFIG` remains the source of truth for base price, included
   locations, overage price, and multi-location eligibility.
2. Onboarding plan metadata derives price display from `TIER_CONFIG`.
3. `/api/onboarding/select-plan` validates against the canonical tier enum.
4. Settings page loads account subscription and active location count.
5. Settings tab selection uses feature-flag capability, not
   `activeLocationCount > 1`, when deciding whether to expose Locations.
6. `/settings/locations` determines locked versus active controls from account
   subscription tier/status.
7. `/api/locations/add` continues to enforce `assertCanAddLocation`.

## Error Handling

- If checkout is unavailable, onboarding keeps the existing checkout error
  behavior.
- If account data fails to load in Settings, the page shows the existing
  account-data error state.
- If Basic users navigate directly to `/dashboard/add-location`, backend quota
  checks continue to reject the add attempt.
- If `MULTI_LOCATION_ENABLED=false`, multi-location Settings surfaces remain
  hidden or unavailable.

## Testing

Add or update focused tests for:

- onboarding plan picker renders all four canonical tiers
- onboarding plan picker displays canonical prices
- `SelectPlanSchema` accepts `basic` and rejects invalid tiers
- Settings shows the Locations tab when `MULTI_LOCATION_ENABLED=true` and the
  account has one active location
- `/settings/locations` renders a locked state for Basic
- `/settings/locations` renders Add Location for eligible tiers
- add-location preview has zero overage for Premium accounts below the included
  location count
- add-location preview shows one overage for Standard when adding a second
  active location

## Verification

Run the narrowest relevant Vitest suites for onboarding plan selection,
location settings, and add-location preview behavior. Because this changes
customer-facing app behavior, run `pnpm build` before calling the work complete.
