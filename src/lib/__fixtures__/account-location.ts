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
  base_price_cents: number;
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

  let base_price_cents = overrides.base_price_cents;

  if (base_price_cents === undefined) {
    switch (tier) {
      case 'basic': base_price_cents = 2900; break;
      case 'standard': base_price_cents = 7900; break;
      case 'premium': base_price_cents = 19900; break;
      case 'founders': base_price_cents = 1900; break;
      default: base_price_cents = 7900;
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
    base_price_cents,
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
  google_place_address: string | null;
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
    google_place_address: overrides.google_place_address ?? null,
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

// ── Zernio connection row factory ──────────────────────────────────────────

export interface ZernioConnectionRow {
  id: string;
  business_id: string;
  account_id: string;
  profile_id: string;
  location_id: string | null;
  access_token: string;
  refresh_token: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const ZERNIO_COUNTER = { value: 0 };

export function createZernioConnectionRow(
  overrides: Partial<ZernioConnectionRow> = {},
): ZernioConnectionRow {
  ZERNIO_COUNTER.value += 1;
  const seq = String(ZERNIO_COUNTER.value).padStart(12, '0');

  return {
    id: overrides.id ?? `zzzzzzzz-0000-0000-0000-${seq.slice(0, 12)}`,
    business_id: overrides.business_id ?? 'bbbbbbbb-0000-0000-0000-000000000001',
    account_id: overrides.account_id ?? 'aaaaaaaa-0000-0000-0000-000000000001',
    profile_id: overrides.profile_id ?? `gmb-profile-${seq.slice(0, 8)}`,
    location_id: overrides.location_id ?? null,
    access_token: overrides.access_token ?? 'at_mock_zernio_token',
    refresh_token: overrides.refresh_token ?? 'rt_mock_zernio_token',
    status: overrides.status ?? 'active',
    created_at: overrides.created_at ?? new Date('2026-01-15'),
    updated_at: overrides.updated_at ?? new Date('2026-01-15'),
  };
}

// ── Channel enrollment row factory ─────────────────────────────────────────

export interface ChannelEnrollmentRow {
  id: string;
  account_id: string;
  business_id: string;
  location_id: string | null;
  channel: string;
  handle: string | null;
  status: string;
  unsubscribed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const CHANNEL_COUNTER = { value: 0 };

export function createChannelEnrollmentRow(
  overrides: Partial<ChannelEnrollmentRow> = {},
): ChannelEnrollmentRow {
  CHANNEL_COUNTER.value += 1;
  const seq = String(CHANNEL_COUNTER.value).padStart(12, '0');

  return {
    id: overrides.id ?? `cccccccc-0000-0000-0000-${seq.slice(0, 12)}`,
    account_id: overrides.account_id ?? 'aaaaaaaa-0000-0000-0000-000000000001',
    business_id: overrides.business_id ?? 'bbbbbbbb-0000-0000-0000-000000000001',
    location_id: overrides.location_id ?? null,
    channel: overrides.channel ?? 'telegram',
    handle: overrides.handle !== undefined ? overrides.handle : '@testbot',
    status: overrides.status ?? 'verified',
    unsubscribed_at: overrides.unsubscribed_at ?? null,
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    updated_at: overrides.updated_at ?? new Date('2026-01-01'),
  };
}

// ── Audit log row factory ──────────────────────────────────────────────────

export interface AuditLogRow {
  id: string;
  account_id: string;
  location_id: string | null;
  event_type: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

const AUDIT_COUNTER = { value: 0 };

export function createAuditLogRow(
  overrides: Partial<AuditLogRow> = {},
): AuditLogRow {
  AUDIT_COUNTER.value += 1;
  const seq = String(AUDIT_COUNTER.value).padStart(12, '0');

  return {
    id: overrides.id ?? `dddddddd-0000-0000-0000-${seq.slice(0, 12)}`,
    account_id: overrides.account_id ?? 'aaaaaaaa-0000-0000-0000-000000000001',
    location_id: overrides.location_id ?? null,
    event_type: overrides.event_type ?? 'location_created',
    actor_user_id: overrides.actor_user_id ?? null,
    payload: overrides.payload ?? {},
    created_at: overrides.created_at ?? new Date('2026-01-01'),
  };
}

// ── Reset counters (use in beforeEach) ──────────────────────────────────────

export function resetFixtureCounters(): void {
  ACCOUNT_COUNTER.value = 0;
  LOCATION_COUNTER.value = 0;
  ZERNIO_COUNTER.value = 0;
  CHANNEL_COUNTER.value = 0;
  AUDIT_COUNTER.value = 0;
}
