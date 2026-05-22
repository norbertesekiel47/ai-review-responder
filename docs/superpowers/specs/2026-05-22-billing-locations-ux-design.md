# Billing Tiers and Locations UX Design

## Purpose

RepWorth currently presents inconsistent subscription tiers across onboarding,
pricing, admin setup, and billing logic. The canonical application model
supports four tiers: `founders`, `basic`, `standard`, and `premium`. The
onboarding payment page exposes only three tiers and carries stale prices.

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
- Treat Stripe Price IDs as the source of truth for the amount actually charged.
- Display onboarding prices from canonical local billing config only after
  verifying those values match the configured Stripe Prices.
- Treat dashboard location switching and location-add capability as separate
  concepts.
- Keep the sidebar/header location picker as a switcher only after the account
  has at least two active RepWorth locations.
- Make `/settings/locations` available whenever `MULTI_LOCATION_ENABLED=true`.
- Keep multi-location variants of Voice and Notifications gated by true
  multi-location mode, not by the mere presence of the feature flag.
- Show Basic accounts a locked upgrade state on `/settings/locations`.
- Show working Add Location actions to active `founders`, `standard`, and
  `premium` accounts.
- Keep the add-location wizard at `/dashboard/add-location`.

## In Scope

- Add Basic to onboarding plan selection.
- Widen the onboarding plan picker tier type, selection state, and click handler
  to include Basic.
- Update onboarding plan validation and route comments to accept Basic.
- Verify configured Stripe Price amounts before changing visible price display.
- Align onboarding plan prices with verified canonical billing values.
- Introduce separate Settings/location helpers so location-settings visibility,
  multi-location mode, and add-location eligibility do not share one boolean.
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
- Making `/settings/voice` reachable for one-location accounts solely because
  the Locations tab is visible.

## Concepts

**Multi-location mode** means the account has more than one active RepWorth
location. This controls dashboard scope behavior such as "All Locations" and
the location switcher. It also controls multi-location-specific Voice and
Notifications settings.

**Locations settings visibility** means the account can see the Locations tab
and `/settings/locations`. This is controlled by `MULTI_LOCATION_ENABLED`.

**Add-location eligibility** means the account can start the add-location flow.
This is controlled by `MULTI_LOCATION_ENABLED`, subscription status, and
subscription tier.

The current bug comes from using multi-location mode as a proxy for location
capability. The new behavior keeps those checks separate.

## Price Verification

The amount charged in checkout comes from Stripe Price IDs resolved in
`create-checkout-session.ts`, not from `TIER_CONFIG.baseCents`.
`TIER_CONFIG` is local billing metadata used by quota, billing snapshots, and
display logic.

The configured Stripe Prices were verified on 2026-05-22 through the Stripe
connector against the Price IDs in `.env.local`:

| Tier | Stripe amount | `TIER_CONFIG` amount | Result |
| --- | ---: | ---: | --- |
| Founding Member | $19/mo | $19/mo | Match |
| Basic | $29/mo | $29/mo | Match |
| Standard | $79/mo | $79/mo | Match |
| Premium | $199/mo | $199/mo | Match |
| Founding overage | $25/mo | $25/mo | Match |
| Standard overage | $25/mo | $25/mo | Match |
| Premium overage | $20/mo | $20/mo | Match |

Because the configured Stripe Prices match `TIER_CONFIG`, onboarding can display
the local canonical amounts in this implementation. If a future environment
points at different Stripe Price IDs, price display must be re-verified before
shipping.

## User Experience

### Onboarding Payment

The onboarding payment page shows four plans:

- Founding Member
- Basic
- Standard
- Premium

Each plan displays the verified canonical monthly base price.
Selecting any valid tier posts that tier to `/api/onboarding/select-plan`.
Invalid tier strings remain rejected by schema validation.

### Settings Navigation

When `MULTI_LOCATION_ENABLED=false`, Settings keeps the existing
single-location layout.

When `MULTI_LOCATION_ENABLED=true` and the account has one active location,
Settings keeps the single-location layout but adds a Locations tab. The Brand
Voice tab continues to point at the existing single-page brand voice section,
not `/settings/voice`.

When `MULTI_LOCATION_ENABLED=true` and the account has more than one active
location, Settings uses the existing multi-location tab set: Account,
Locations, Voice, and Notifications.

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

1. Stripe Price IDs remain the source of truth for actual checkout charges.
2. `TIER_CONFIG` remains the source of truth for local base price display,
   included locations, overage price display, snapshots, and multi-location
   eligibility after Stripe Price verification passes.
3. Onboarding plan metadata derives price display from verified local billing
   config.
4. `/api/onboarding/select-plan` validates against the canonical tier enum.
5. Settings page loads account subscription and active location count.
6. Settings tab selection uses a dedicated locations-visibility check when
   deciding whether to expose Locations.
7. Multi-location variants of Voice, Notifications, dashboard scope, and the
   sidebar switcher continue using true multi-location mode.
8. `/settings/locations` determines locked versus active controls from account
   subscription tier/status.
9. `/api/locations/add` continues to enforce `assertCanAddLocation`.

## Error Handling

- If checkout is unavailable, onboarding keeps the existing checkout error
  behavior.
- If configured Stripe Prices do not match local billing config in a future
  environment, stop before changing visible price display and reconcile the
  mismatch.
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
- one-location Settings with the feature flag enabled keeps single-location
  Voice behavior and does not route Brand Voice through `/settings/voice`
- `/settings/locations` renders a locked state for Basic
- `/settings/locations` renders Add Location for eligible tiers
- add-location preview has zero overage for Premium accounts below the included
  location count
- add-location preview shows one overage for Standard when adding a second
  active location

## Verification

Verify configured Stripe Price amounts against the current environment before
changing visible price display. Run the narrowest relevant Vitest suites for
onboarding plan selection, location settings, and add-location preview behavior.
Because this changes customer-facing app behavior, run `pnpm build` before
calling the work complete.
