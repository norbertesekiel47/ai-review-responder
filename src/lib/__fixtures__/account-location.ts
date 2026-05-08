// src/lib/__fixtures__/account-location.ts
//
// Test factories for account + location rows. Used across unit tests for
// quota checks, add-location flows, and billing snapshots.
//
// These are pure data factories — they return plain objects matching the
// shape of database rows, suitable for mocking `sql` return values.

import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import type { SubscriptionStatusValue } from '@/lib/shared/subscription-status';

// ── Account row factory ────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  owner_user_id: string;
  display_name: string;
  subscription_tier: SubscriptionTierValue;
  subscription_status: SubscriptionStatusValue;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: Date | null;
  subscription_activated_at: Date | null;
  locations_included: number;
  locations_paid: number;
  locations_overage_price_cents: number;
  flags: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const ACCOUNT_COUNTER = { value: 0 };

function nextAccountId(): string {
  ACCOUNT_COUNTER.value += 1;
  // Generate deterministic UUID-like strings for test readability
  const seq = String(ACCOUNT_COUNTER.value).padStart(12, '0');
  return `aaaaaaaa-0000-0000-0000-${seq.slice(0, 12)}`;
}

export function createAccountRow(
  overrides: Partial<AccountRow> = {},
): AccountRow {
  const id = overrides.id ?? nextAccountId();
  const tier = overrides.subscription_tier ?? 'standard';
  const status = overrides.subscription_status ?? 'active';

  // Derive quota fields from tier config when not explicitly provided
  let locations_included = overrides.locations_included;
  let locations_overage_price_cents = overrides.locations_overage_price_cents;

  if (locations_included === undefined) {
    switch (tier) {
      case 'basic': locations_included = 1; break;
      case 'standard': locations_included = 1; break;
      case 'premium': locations_included = 5; break;
      case 'founders': locations_included = 1; break;
      default: locations_included = 1;
    }
  }

  if (locations_overage_price_cents === undefined) {
    switch (tier) {
      case 'basic': locations_overage_price_cents = 0; break;
      case 'standard': locations_overage_price_cents = 2500; break;
      case 'premium': locations_overage_price_cents = 2000; break;
      case 'founders': locations_overage_price_cents = 2500; break;
      default: locations_overage_price_cents = 0;
    }
  }

  return {
    id,
    owner_user_id: overrides.owner_user_id ?? 'owner-aaaaaaaa-0000-0000-0000-000000000001',
    display_name: overrides.display_name ?? `Test Account ${id.slice(-4)}`,
    subscription_tier: tier,
    subscription_status: status,
    stripe_customer_id: overrides.stripe_customer_id ?? 'cus_test123',
    stripe_subscription_id: overrides.stripe_subscription_id ?? 'sub_test123',
    trial_ends_at: overrides.trial_ends_at ?? null,
    subscription_activated_at: overrides.subscription_activated_at ?? new Date('2026-01-01'),
    locations_included,
    locations_paid: overrides.locations_paid ?? 0,
    locations_overage_price_cents,
    flags: overrides.flags ?? {},
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    updated_at: overrides.updated_at ?? new Date('2026-01-01'),
  };
}

// ── Location (businesses) row factory ──────────────────────────────────────

export interface LocationRow {
  id: string;
  account_id: string;
  name: string;
  display_label: string | null;
  is_primary: boolean;
  archived_at: Date | null;
  google_place_id: string | null;
  created_at: Date;
}

const LOCATION_COUNTER = { value: 0 };

function nextLocationId(): string {
  LOCATION_COUNTER.value += 1;
  const seq = String(LOCATION_COUNTER.value).padStart(12, '0');
  return `bbbbbbbb-0000-0000-0000-${seq.slice(0, 12)}`;
}

export function createLocationRow(
  overrides: Partial<LocationRow> = {},
): LocationRow {
  const id = overrides.id ?? nextLocationId();
  const isPrimary = overrides.is_primary ?? false;

  return {
    id,
    account_id: overrides.account_id ?? 'aaaaaaaa-0000-0000-0000-000000000001',
    name: overrides.name ?? `Test Location ${id.slice(-4)}`,
    display_label: overrides.display_label ?? null,
    is_primary: isPrimary,
    archived_at: overrides.archived_at ?? null,
    google_place_id: overrides.google_place_id ?? null,
    created_at: overrides.created_at ?? (isPrimary
      ? new Date('2026-01-01')
      : new Date('2026-03-01')),
  };
}

// ── Convenience: account with N active locations ───────────────────────────

/**
 * Creates an account row and N location rows for testing.
 * The first location is marked as primary.
 */
export function createAccountWithLocations(
  accountOverrides: Partial<AccountRow> = {},
  locationCount: number,
): {
  account: AccountRow;
  locations: LocationRow[];
} {
  const account = createAccountRow(accountOverrides);
  const locations: LocationRow[] = [];

  for (let i = 0; i < locationCount; i++) {
    locations.push(
      createLocationRow({
        account_id: account.id,
        is_primary: i === 0,
        name: `Location ${i + 1}`,
        display_label: i === 0 ? 'Primary Location' : `Branch ${i}`,
      }),
    );
  }

  return { account, locations };
}

// ── Reset counters (use in beforeEach) ──────────────────────────────────────

export function resetFixtureCounters(): void {
  ACCOUNT_COUNTER.value = 0;
  LOCATION_COUNTER.value = 0;
}
