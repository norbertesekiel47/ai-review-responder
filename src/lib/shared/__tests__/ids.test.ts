// src/lib/shared/__tests__/ids.test.ts
//
// TDD assertions for branded ID types: AccountId, LocationId, BusinessId.
// Validation contract: VAL-AUTH-030, VAL-AUTH-031, VAL-AUTH-032.

import { describe, it, expect } from 'vitest';
import {
  type AccountId,
  type LocationId,
  type BusinessId,
  asAccountId,
  asLocationId,
  asBusinessId,
  isValidUuid,
} from '../ids';

// ── Branded type compile-time safety ─────────────────────────────────────────
// These tests verify that TypeScript prevents mixing AccountId and LocationId.
// The runtime aspect is that the brand is a phantom type — at runtime these
// are just strings. The value is in the compile-time checking.

describe('branded IDs', () => {
  it('AccountId is a branded string — cannot assign bare string without cast', () => {
    // This would fail to compile if we tried:
    // const a: AccountId = 'some-uuid';  // TS error
    // Explicit cast is required:
    const a: AccountId = asAccountId('some-uuid');
    expect(a).toBe('some-uuid');
    expect(typeof a).toBe('string');
  });

  it('LocationId is a branded string — cannot assign bare string without cast', () => {
    const l: LocationId = asLocationId('some-uuid');
    expect(l).toBe('some-uuid');
    expect(typeof l).toBe('string');
  });

  it('BusinessId is LocationId alias — assignable both ways', () => {
    const locationId: LocationId = asLocationId('loc-123');
    const businessId: BusinessId = locationId; // Should compile: BusinessId = LocationId
    expect(businessId).toBe('loc-123');

    // Reverse direction also works
    const backToLocation: LocationId = businessId;
    expect(backToLocation).toBe('loc-123');
  });

  it('asBusinessId converts LocationId to BusinessId (zero-cost)', () => {
    const locationId: LocationId = asLocationId('loc-456');
    const businessId: BusinessId = asBusinessId(locationId);
    expect(businessId).toBe('loc-456');
  });

  it('AccountId and LocationId are not interchangable at the type level', () => {
    // The following would fail to compile:
    // const a: AccountId = asLocationId('x');  // TS error
    // const l: LocationId = asAccountId('x');  // TS error
    // This test exists to document the compile-time guarantee.
    const accountId: AccountId = asAccountId('acc-789');
    const locationId: LocationId = asLocationId('loc-789');
    // At runtime they're both strings, but TypeScript prevents mixing them
    expect(typeof accountId).toBe('string');
    expect(typeof locationId).toBe('string');
  });
});

// ── Runtime validation helpers ─────────────────────────────────────────────────

describe('isValidUuid', () => {
  it('accepts valid UUID format', () => {
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('550e8400')).toBe(false);
  });

  it('rejects strings with extra whitespace', () => {
    expect(isValidUuid(' 550e8400-e29b-41d4-a716-446655440000 ')).toBe(false);
  });

  it('accepts uppercase UUIDs', () => {
    expect(isValidUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });
});
