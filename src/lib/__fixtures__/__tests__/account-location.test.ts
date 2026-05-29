// src/lib/__fixtures__/__tests__/account-location.test.ts
//
// TDD assertions for shared test fixtures.
// Verifies that factories produce correct shapes, derive quota fields
// from tier config, and support cross-account scenarios.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createAccountRow,
  createLocationRow,
  createAccountWithLocations,
  createZernioConnectionRow,
  createChannelEnrollmentRow,
  createAuditLogRow,
  resetFixtureCounters,
} from '../account-location';

beforeEach(() => {
  resetFixtureCounters();
});

// ── Account row factory ──────────────────────────────────────────────────

describe('createAccountRow', () => {
  it('creates an account with default values', () => {
    const account = createAccountRow();

    expect(account.id).toBeTruthy();
    expect(account.subscription_tier).toBe('standard');
    expect(account.subscription_status).toBe('active');
    expect(account.locations_included).toBe(1); // standard tier
    expect(account.locations_overage_price_cents).toBe(2500); // standard tier
    expect(account.locations_paid).toBe(0);
    expect(account.flags).toEqual({});
  });

  it('derives quota fields from premium tier', () => {
    const account = createAccountRow({ subscription_tier: 'premium' });

    expect(account.locations_included).toBe(5);
    expect(account.locations_overage_price_cents).toBe(2000);
  });

  it('derives quota fields from basic tier', () => {
    const account = createAccountRow({ subscription_tier: 'basic' });

    expect(account.locations_included).toBe(1);
    expect(account.locations_overage_price_cents).toBe(0);
  });

  it('derives quota fields from founders tier', () => {
    const account = createAccountRow({ subscription_tier: 'founders' });

    expect(account.locations_included).toBe(1);
    expect(account.locations_overage_price_cents).toBe(2500);
  });

  it('allows overriding derived quota fields', () => {
    const account = createAccountRow({
      subscription_tier: 'standard',
      locations_included: 10,
      locations_overage_price_cents: 500,
    });

    expect(account.locations_included).toBe(10);
    expect(account.locations_overage_price_cents).toBe(500);
  });

  it('defaults base_price_cents per tier', () => {
    expect(createAccountRow({ subscription_tier: 'basic' }).base_price_cents).toBe(2900);
    expect(createAccountRow({ subscription_tier: 'standard' }).base_price_cents).toBe(7900);
    expect(createAccountRow({ subscription_tier: 'premium' }).base_price_cents).toBe(19900);
    expect(createAccountRow({ subscription_tier: 'founders' }).base_price_cents).toBe(1900);
  });

  it('respects an explicit base_price_cents override', () => {
    expect(createAccountRow({ subscription_tier: 'founders', base_price_cents: 1500 }).base_price_cents).toBe(1500);
  });

  it('generates unique IDs for each account', () => {
    const a1 = createAccountRow();
    const a2 = createAccountRow();

    expect(a1.id).not.toBe(a2.id);
  });
});

// ── Location row factory ──────────────────────────────────────────────────

describe('createLocationRow', () => {
  it('creates a location with default values (non-primary)', () => {
    const location = createLocationRow();

    expect(location.id).toBeTruthy();
    expect(location.is_primary).toBe(false);
    expect(location.archived_at).toBeNull();
    expect(location.display_label).toBeNull();
  });

  it('creates a primary location', () => {
    const location = createLocationRow({ is_primary: true });

    expect(location.is_primary).toBe(true);
  });

  it('creates a location with display_label', () => {
    const location = createLocationRow({ display_label: 'Downtown Cafe' });

    expect(location.display_label).toBe('Downtown Cafe');
  });

  it('creates an archived location', () => {
    const archivedAt = new Date('2026-04-01');
    const location = createLocationRow({ archived_at: archivedAt });

    expect(location.archived_at).toEqual(archivedAt);
  });

  it('generates unique IDs for each location', () => {
    const l1 = createLocationRow();
    const l2 = createLocationRow();

    expect(l1.id).not.toBe(l2.id);
  });
});

// ── Convenience: account with locations ───────────────────────────────────

describe('createAccountWithLocations', () => {
  it('creates account with N locations where first is primary', () => {
    const { account, locations } = createAccountWithLocations({}, 3);

    expect(locations).toHaveLength(3);
    expect(locations[0]!.is_primary).toBe(true);
    expect(locations[1]!.is_primary).toBe(false);
    expect(locations[2]!.is_primary).toBe(false);

    // All locations belong to the account
    for (const loc of locations) {
      expect(loc.account_id).toBe(account.id);
    }
  });

  it('creates account with single location (primary)', () => {
    const { account, locations } = createAccountWithLocations({}, 1);

    expect(locations).toHaveLength(1);
    expect(locations[0]!.is_primary).toBe(true);
  });

  it('first location has display_label, others have branch labels', () => {
    const { locations } = createAccountWithLocations({}, 3);

    expect(locations[0]!.display_label).toBe('Primary Location');
    expect(locations[1]!.display_label).toBe('Branch 1');
    expect(locations[2]!.display_label).toBe('Branch 2');
  });

  it('respects account overrides', () => {
    const { account } = createAccountWithLocations({ subscription_tier: 'premium' }, 2);

    expect(account.subscription_tier).toBe('premium');
    expect(account.locations_included).toBe(5);
  });
});

// ── Zernio connection row factory ─────────────────────────────────────────

describe('createZernioConnectionRow', () => {
  it('creates a Zernio connection with default values', () => {
    const conn = createZernioConnectionRow();

    expect(conn.id).toBeTruthy();
    expect(conn.business_id).toBeTruthy();
    expect(conn.account_id).toBeTruthy();
    expect(conn.status).toBe('active');
    expect(conn.location_id).toBeNull();
  });

  it('creates a connection for a specific location', () => {
    const locationId = 'loc-123-456';
    const conn = createZernioConnectionRow({ location_id: locationId });

    expect(conn.location_id).toBe(locationId);
  });

  it('generates unique IDs for each connection', () => {
    const c1 = createZernioConnectionRow();
    const c2 = createZernioConnectionRow();

    expect(c1.id).not.toBe(c2.id);
  });
});

// ── Channel enrollment row factory ───────────────────────────────────────

describe('createChannelEnrollmentRow', () => {
  it('creates a channel enrollment with default values (telegram)', () => {
    const enrollment = createChannelEnrollmentRow();

    expect(enrollment.id).toBeTruthy();
    expect(enrollment.channel).toBe('telegram');
    expect(enrollment.status).toBe('verified');
    expect(enrollment.location_id).toBeNull();
  });

  it('creates a per-location override enrollment', () => {
    const enrollment = createChannelEnrollmentRow({
      location_id: 'loc-override-123',
      handle: '@location_bot',
    });

    expect(enrollment.location_id).toBe('loc-override-123');
    expect(enrollment.handle).toBe('@location_bot');
  });

  it('creates an email channel enrollment', () => {
    const enrollment = createChannelEnrollmentRow({
      channel: 'email',
      handle: null,
    });

    expect(enrollment.channel).toBe('email');
    // Email channels don't have handles — set to null explicitly
    expect(enrollment.handle).toBeNull();
  });
});

// ── Audit log row factory ────────────────────────────────────────────────

describe('createAuditLogRow', () => {
  it('creates an audit log entry with default values', () => {
    const log = createAuditLogRow();

    expect(log.id).toBeTruthy();
    expect(log.event_type).toBe('location_created');
    expect(log.payload).toEqual({});
  });

  it('creates an audit log with specific event type', () => {
    const log = createAuditLogRow({
      event_type: 'location_archived',
      payload: { reason: 'owner_request' },
    });

    expect(log.event_type).toBe('location_archived');
    expect(log.payload).toEqual({ reason: 'owner_request' });
  });
});

// ── Reset counters ───────────────────────────────────────────────────────

describe('resetFixtureCounters', () => {
  it('resets all counter sequences', () => {
    const a1 = createAccountRow();
    resetFixtureCounters();
    const a2 = createAccountRow();

    // After reset, the counter starts from 0 again
    expect(a1.id).toBe(a2.id);
  });
});
