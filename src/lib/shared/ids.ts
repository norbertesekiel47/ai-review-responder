// src/lib/shared/ids.ts
//
// Branded ID types for compile-time safety. Prevents accidental assignment
// of a bare string or a LocationId to an AccountId parameter (and vice versa).
//
// Usage at API boundaries:
//   const accountId = rawString as AccountId;
//   const locationId = rawString as LocationId;
//
// Validation contract: VAL-AUTH-030, VAL-AUTH-031, VAL-AUTH-032.

// ── Branded type helpers ─────────────────────────────────────────────────────

// Phantom brand type — the brand parameter exists only at compile time
// to prevent accidental mixing of ID types. The parameter is intentionally
// unused at runtime (that's the point of a phantom type).
type Brand<T, B extends string> = T & { __brand: B };

// ── Account ID ───────────────────────────────────────────────────────────────
// Identifies a row in the `accounts` table (the "parent org" concept).
// A user's account_id is stored in users.account_id (NOT users.business_id,
// which was dropped in migration 034).

export type AccountId = Brand<string, 'AccountId'>;

// ── Location ID ───────────────────────────────────────────────────────────────
// Identifies a row in the `businesses` table (one Google Business Profile
// location). In the multi-location model, each location belongs to an account.
// Naming convention: "location" in owner-facing UI, "businesses" in the DB.

export type LocationId = Brand<string, 'LocationId'>;

// ── BusinessId alias ─────────────────────────────────────────────────────────
// Backward compatibility: existing code references BusinessId. It is
// semantically equivalent to LocationId (both identify a businesses row).

export type BusinessId = LocationId;

// ── Runtime validation helpers ───────────────────────────────────────────────

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true when `value` looks like a UUID (v4 format). Not cryptographically authoritative. */
export function isValidUuid(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/** Cast a validated string to AccountId. Caller is responsible for ensuring the input is a valid account UUID. */
export function asAccountId(value: string): AccountId {
  return value as AccountId;
}

/** Cast a validated string to LocationId. Caller is responsible for ensuring the input is a valid location UUID. */
export function asLocationId(value: string): LocationId {
  return value as LocationId;
}

/** Cast a LocationId to the backward-compatible BusinessId alias. Zero-cost at runtime. */
export function asBusinessId(id: LocationId): BusinessId {
  return id;
}
