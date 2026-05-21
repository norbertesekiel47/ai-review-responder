# Phase 4 — Owner Channel Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/settings/channels` page that lets owners self-serve enroll/disconnect their Telegram chat as an extra approval-notification channel beyond email, with SMS and WhatsApp shown as "Coming soon."

**Architecture:** Extract a pure `enrollmentReducer` + thin `useEnrollment` React hook from the existing admin `TelegramEnrollmentWidget`, refactor admin Telegram and WhatsApp widgets to use it, build owner-scoped `/api/dashboard/channels/*` routes that call shared transaction helpers, restructure `/settings/page.tsx` from client-only to server+client split with a tab strip, and enforce one mobile channel per business via migration 027 partial unique index.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Postgres.js (`sql.begin`), Vitest (node only — no jsdom), Playwright, pnpm. Spec at `docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md`.

---

## Conventions used in this plan

- **Imports:** all paths use the `@/` alias (`tsconfig.json` maps `@/*` → `src/*`).
- **Test command:** `pnpm test -- <pattern>` runs Vitest filtered by file/test name.
- **Type-check:** `pnpm tsc --noEmit` (strict mode is on).
- **Lint:** `pnpm lint`.
- **E2E:** `pnpm test:e2e` (skips gracefully without `TEST_DATABASE_POOL_URL`).
- **Migrations:** the user runs SQL migrations manually in the Supabase SQL editor (per CLAUDE.md feedback memory). Tasks emit the exact SQL to run; do NOT attempt to apply it via `mcp__supabase__apply_migration` without explicit user instruction.
- **Commit format:** Conventional Commits (`feat:`, `refactor:`, `test:`, `chore:`). Co-author tag required per repo convention; example block included in the first commit step and reused throughout.

---

## File map

| Path | Purpose | Status |
| --- | --- | --- |
| `supabase/migrations/027_one_mobile_channel_per_business.sql` | Partial unique index enforcing one pending/verified mobile channel per business | NEW |
| `src/lib/notifications/channels/constants.ts` | `TOKEN_TTL_MS`, `STATUS_POLL_INTERVAL_MS`, `TTL_TICK_INTERVAL_MS` | NEW |
| `src/lib/channels/unique-violation.ts` | `MultipleMobileChannelsError`, `EnrollmentDatabaseError`, `isMultipleMobileChannelsError` | NEW |
| `src/lib/channels/__tests__/unique-violation.test.ts` | Unit tests for the detector | NEW |
| `src/app/api/admin/businesses/[id]/channels/route.ts` | Add `verification_token_expires_at AS expires_at` to SELECT | MODIFIED (additive) |
| `src/lib/notifications/channels/enrollment-reducer.ts` | Pure state machine for QR/deep-link enrollment | NEW |
| `src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts` | Exhaustive reducer unit tests | NEW |
| `src/lib/notifications/channels/use-enrollment.ts` | React hook wiring reducer to fetch + polling + AbortController | NEW |
| `src/lib/channels/telegram-enrollment.ts` | Shared `start`/`cancel`/`disable` transaction helpers | NEW |
| `src/lib/channels/__tests__/telegram-enrollment.test.ts` | Helper unit tests with mocked `tx` queue | NEW |
| `src/app/api/admin/channels/telegram/start/route.ts` | Use shared helper + 23505 → 409 | MODIFIED |
| `src/app/api/admin/channels/telegram/cancel/route.ts` | Use shared helper | MODIFIED |
| `src/app/api/admin/channels/telegram/disable/route.ts` | Use shared helper | MODIFIED |
| `src/app/api/admin/channels/sms/verify/route.ts` | 23505 catch inside `withSmsEnrollmentLock` | MODIFIED |
| `src/app/api/admin/channels/whatsapp/start/route.ts` | 23505 catch | MODIFIED |
| `src/components/admin/TelegramEnrollmentWidget.tsx` | Refactor to use hook | MODIFIED |
| `src/components/admin/WhatsAppEnrollmentWidget.tsx` | Refactor to use hook | MODIFIED |
| `src/app/api/dashboard/channels/route.ts` | Owner status endpoint | NEW |
| `src/app/api/dashboard/channels/telegram/start/route.ts` | Owner start endpoint | NEW |
| `src/app/api/dashboard/channels/telegram/cancel/route.ts` | Owner cancel endpoint | NEW |
| `src/app/api/dashboard/channels/telegram/disable/route.ts` | Owner disable endpoint | NEW |
| `src/components/dashboard/OwnerTelegramWidget.tsx` | Thin shell using the hook | NEW |
| `src/components/dashboard/ComingSoonChannelRow.tsx` | Static row for SMS/WA | NEW |
| `src/components/dashboard/SettingsTabs.tsx` | Tab strip server component | NEW |
| `src/app/(authenticated)/settings/SettingsGeneralForm.tsx` | Extracted client form | NEW |
| `src/app/(authenticated)/settings/page.tsx` | Convert to server component shell | MODIFIED |
| `src/app/(authenticated)/settings/channels/page.tsx` | Server component | NEW |
| `src/app/(authenticated)/settings/channels/ChannelsClient.tsx` | Client wrapper | NEW |
| `e2e/helpers/telegram-test-ingress.ts` | Synthesizes a valid Telegram webhook update | NEW |
| `e2e/owner-channels.spec.ts` | Owner E2E flow | NEW |
| `e2e/admin-channels-refactor.spec.ts` | Admin regression | NEW |

---

## Task 0: Pre-flight audit + commit baseline

**Goal:** Verify production data does not already violate migration 027 before any code changes land.

- [ ] **Step 0.1: Run the pre-flight audit query**

In the Supabase SQL editor, execute:

```sql
SELECT business_id, COUNT(*) AS active_mobile_count
FROM channel_enrollments
WHERE channel IN ('sms','telegram','whatsapp')
  AND status IN ('pending_verification','verified')
  AND archived_at IS NULL
GROUP BY business_id
HAVING COUNT(*) > 1;
```

Expected: zero rows. If any rows return, STOP — investigate which businesses have multiple active mobile channels and resolve manually before proceeding (cancel the older `pending_verification` rows or disable the older `verified` rows).

- [ ] **Step 0.2: Confirm a clean working tree**

Run:

```bash
git status
```

Expected: `nothing to commit, working tree clean` (or pre-existing local changes you intend to keep). If unrelated changes exist, stash them with `git stash push -m "pre-phase4"` before starting.

---

## Task 1: Migration 027 — partial unique index

**Files:**
- Create: `supabase/migrations/027_one_mobile_channel_per_business.sql`

- [ ] **Step 1.1: Write migration SQL**

Create `supabase/migrations/027_one_mobile_channel_per_business.sql`:

```sql
-- supabase/migrations/027_one_mobile_channel_per_business.sql
--
-- Phase 4: enforce "at most one pending/verified mobile channel per business"
-- at the DB level. The UI also gates this client-side; the index is
-- defense-in-depth so a buggy client or future API path can't enroll
-- multiple mobile channels for the same business.
--
-- Predicate exclusions are intentional:
--  - 'disabled' / 'unsubscribed' rows are NOT covered, so an owner's
--    enrollment history (e.g., previously-verified Telegram now disabled)
--    can coexist with a freshly-pending different mobile channel.
--  - 'archived_at IS NULL' mirrors the partial-uniqueness pattern from
--    migration 022 (channel_enrollments_business_channel_active_key).
--
-- Surface area: any INSERT/UPDATE that lands a (business_id, channel,
-- status, archived_at) tuple matching the predicate twice will hit
-- Postgres error 23505 with constraint_name='channel_enrollments_one_mobile_per_biz'.
-- Routes catch this and return 409 with body { error: 'multiple_mobile_channels' }.
--
-- See docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §6.2.

CREATE UNIQUE INDEX channel_enrollments_one_mobile_per_biz
  ON channel_enrollments (business_id)
  WHERE channel IN ('sms','telegram','whatsapp')
    AND status IN ('pending_verification','verified')
    AND archived_at IS NULL;
```

- [ ] **Step 1.2: Tell the user to run the migration**

Output to the user:

> "Migration 027 SQL ready at `supabase/migrations/027_one_mobile_channel_per_business.sql`. Please run the audit query from Task 0.1 again immediately followed by the CREATE INDEX in the SAME SQL editor session, then confirm here so I can proceed."

**Do NOT** call `mcp__supabase__apply_migration` — the user runs migrations manually per CLAUDE.md.

- [ ] **Step 1.3: Wait for user confirmation, then commit**

After the user confirms the migration applied:

```bash
git add supabase/migrations/027_one_mobile_channel_per_business.sql
git commit -m "$(cat <<'EOF'
feat(channels): migration 027 — one mobile channel per business

Adds partial unique index enforcing at most one pending/verified mobile
channel (sms/telegram/whatsapp) per business. Predicate intentionally
excludes disabled/unsubscribed rows so enrollment history is preserved
across switches. Surface area is migration-027 throw → 409 in all four
mobile-enrollment writers (admin telegram/sms/whatsapp + owner telegram).

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Constants module

**Files:**
- Create: `src/lib/notifications/channels/constants.ts`

- [ ] **Step 2.1: Write the constants file**

Create `src/lib/notifications/channels/constants.ts`:

```ts
// src/lib/notifications/channels/constants.ts
//
// Shared constants for channel enrollment flows. Used by both the React hook
// (use-enrollment.ts) and the route handlers (telegram start/cancel/disable).
// Keeping these co-located prevents the polling interval and TTL from drifting
// out of sync between client and server.

/** Verification token TTL — 1 hour. Matches the existing admin telegram start route. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

/** Polling interval for the status endpoint while in `awaiting_scan` state. */
export const STATUS_POLL_INTERVAL_MS = 3_000;

/** TTL countdown tick interval (drives `awaiting_scan` → `expired` transition). */
export const TTL_TICK_INTERVAL_MS = 1_000;
```

- [ ] **Step 2.2: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS (no new errors).

- [ ] **Step 2.3: Commit**

```bash
git add src/lib/notifications/channels/constants.ts
git commit -m "$(cat <<'EOF'
feat(channels): shared constants for enrollment flows

TOKEN_TTL_MS, STATUS_POLL_INTERVAL_MS, TTL_TICK_INTERVAL_MS — used by
both the upcoming useEnrollment hook and the route handlers so polling
interval and TTL cannot drift between client and server.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Unique-violation detector + typed errors

**Files:**
- Create: `src/lib/channels/unique-violation.ts`
- Create: `src/lib/channels/__tests__/unique-violation.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `src/lib/channels/__tests__/unique-violation.test.ts`:

```ts
// src/lib/channels/__tests__/unique-violation.test.ts
import { describe, it, expect } from 'vitest';
import {
  MultipleMobileChannelsError,
  EnrollmentDatabaseError,
  isMultipleMobileChannelsError,
  classifyEnrollmentError,
} from '../unique-violation';

const PG_UNIQUE_VIOLATION = '23505';
const PARTIAL_INDEX = 'channel_enrollments_one_mobile_per_biz';

function pgError(code: string, constraintName?: string): Error {
  // Postgres.js attaches `code` and `constraint_name` directly on Error
  // instances. Tests synthesize the same shape.
  const err = new Error(`duplicate key violates ${constraintName ?? 'some_constraint'}`) as Error & {
    code: string;
    constraint_name?: string;
  };
  err.code = code;
  if (constraintName) err.constraint_name = constraintName;
  return err;
}

describe('isMultipleMobileChannelsError', () => {
  it('returns true for 23505 + matching constraint name', () => {
    expect(isMultipleMobileChannelsError(pgError(PG_UNIQUE_VIOLATION, PARTIAL_INDEX))).toBe(true);
  });

  it('returns false for 23505 + different constraint name', () => {
    expect(isMultipleMobileChannelsError(pgError(PG_UNIQUE_VIOLATION, 'some_other_index'))).toBe(false);
  });

  it('returns false for 23505 with no constraint name', () => {
    expect(isMultipleMobileChannelsError(pgError(PG_UNIQUE_VIOLATION))).toBe(false);
  });

  it('returns false for non-23505 errors', () => {
    expect(isMultipleMobileChannelsError(pgError('40001', PARTIAL_INDEX))).toBe(false);
  });

  it('returns false for plain Error', () => {
    expect(isMultipleMobileChannelsError(new Error('boom'))).toBe(false);
  });

  it('returns false for null / undefined / non-objects', () => {
    expect(isMultipleMobileChannelsError(null)).toBe(false);
    expect(isMultipleMobileChannelsError(undefined)).toBe(false);
    expect(isMultipleMobileChannelsError('string')).toBe(false);
    expect(isMultipleMobileChannelsError(42)).toBe(false);
  });
});

describe('classifyEnrollmentError', () => {
  it('throws MultipleMobileChannelsError on 23505 + matching constraint', () => {
    expect(() => classifyEnrollmentError(pgError(PG_UNIQUE_VIOLATION, PARTIAL_INDEX)))
      .toThrow(MultipleMobileChannelsError);
  });

  it('throws EnrollmentDatabaseError on 23505 + other constraint', () => {
    expect(() => classifyEnrollmentError(pgError(PG_UNIQUE_VIOLATION, 'some_other_index')))
      .toThrow(EnrollmentDatabaseError);
  });

  it('rethrows non-23505 errors unchanged', () => {
    const original = pgError('40001', PARTIAL_INDEX);
    expect(() => classifyEnrollmentError(original)).toThrow(original);
  });

  it('rethrows non-Error values unchanged', () => {
    expect(() => classifyEnrollmentError('not an error')).toThrow('not an error');
  });

  it('EnrollmentDatabaseError message scrubs the original message', () => {
    try {
      classifyEnrollmentError(pgError(PG_UNIQUE_VIOLATION, 'leak_constraint_name'));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnrollmentDatabaseError);
      expect((err as Error).message).not.toContain('leak_constraint_name');
    }
  });
});
```

- [ ] **Step 3.2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/channels/__tests__/unique-violation.test.ts`

Expected: FAIL (module not found, or all tests fail).

- [ ] **Step 3.3: Implement the detector + errors**

Create `src/lib/channels/unique-violation.ts`:

```ts
// src/lib/channels/unique-violation.ts
//
// Typed errors + Postgres 23505 detector for the multi-channel enrollment
// surface (Phase 4, migration 027). The shared transaction helpers and route
// handlers use `classifyEnrollmentError(err)` to convert raw Postgres errors
// into typed exceptions:
//
//   - 23505 + constraint_name='channel_enrollments_one_mobile_per_biz'
//     → MultipleMobileChannelsError (route maps to 409)
//   - 23505 + ANY other constraint name → EnrollmentDatabaseError (route
//     maps to 500 with no body leakage of constraint_name)
//   - Anything else → re-thrown unchanged
//
// See docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §6.1 row 13.

const PG_UNIQUE_VIOLATION = '23505';
const ONE_MOBILE_CONSTRAINT = 'channel_enrollments_one_mobile_per_biz';

export class MultipleMobileChannelsError extends Error {
  constructor() {
    super('Another mobile channel is already pending or verified for this business.');
    this.name = 'MultipleMobileChannelsError';
  }
}

export class EnrollmentDatabaseError extends Error {
  constructor() {
    // Deliberately generic — never echoes the underlying Postgres message
    // (which would leak constraint_name).
    super('Database error during enrollment.');
    this.name = 'EnrollmentDatabaseError';
  }
}

interface PostgresErrorShape {
  code?: unknown;
  constraint_name?: unknown;
}

function asPostgresError(err: unknown): PostgresErrorShape | null {
  if (err === null || typeof err !== 'object') return null;
  return err as PostgresErrorShape;
}

export function isMultipleMobileChannelsError(err: unknown): boolean {
  const pg = asPostgresError(err);
  if (!pg) return false;
  return pg.code === PG_UNIQUE_VIOLATION && pg.constraint_name === ONE_MOBILE_CONSTRAINT;
}

/**
 * Inspect a thrown value, classify it, and throw a typed error in its place.
 * Always throws — never returns.
 */
export function classifyEnrollmentError(err: unknown): never {
  const pg = asPostgresError(err);
  if (pg && pg.code === PG_UNIQUE_VIOLATION) {
    if (pg.constraint_name === ONE_MOBILE_CONSTRAINT) {
      throw new MultipleMobileChannelsError();
    }
    throw new EnrollmentDatabaseError();
  }
  throw err;
}
```

- [ ] **Step 3.4: Run the test to verify it passes**

Run: `pnpm test -- src/lib/channels/__tests__/unique-violation.test.ts`

Expected: all 11 tests PASS.

- [ ] **Step 3.5: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: both PASS.

- [ ] **Step 3.6: Commit**

```bash
git add src/lib/channels/unique-violation.ts src/lib/channels/__tests__/unique-violation.test.ts
git commit -m "$(cat <<'EOF'
feat(channels): typed errors + 23505 classifier for migration 027

MultipleMobileChannelsError (→ 409) and EnrollmentDatabaseError
(→ 500, scrubs constraint_name from message). classifyEnrollmentError
is the single classifier used by all four mobile-enrollment write paths
in the upcoming refactor.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend admin endpoint to emit `expires_at`

**Files:**
- Modify: `src/app/api/admin/businesses/[id]/channels/route.ts`

This is additive — no existing admin client reads `expires_at` from this payload (admin widgets get `expiresAt` from the start-route response). Adding it now lets the refactored hook source the field uniformly from the status payload.

- [ ] **Step 4.1: Read the current file**

Read `src/app/api/admin/businesses/[id]/channels/route.ts` to confirm the current SELECT shape (it should have 8 columns ending with `last_activity_at`).

- [ ] **Step 4.2: Add `expires_at` to the SELECT**

Edit `src/app/api/admin/businesses/[id]/channels/route.ts`. Find the `SELECT ... FROM channel_enrollments e ... ORDER BY e.created_at ASC` query. Add `e.verification_token_expires_at AS expires_at` to the SELECT list and to the row type.

The result type changes from:

```ts
const rows = await sql<{
  channel: string;
  handle: string | null;
  status: string;
  verified_at: Date | null;
  disabled_at: Date | null;
  unsubscribed_at: Date | null;
  unsubscribed_reason: string | null;
  last_activity_at: Date | null;
}[]>`
  SELECT
    e.channel, e.handle, e.status,
    e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
    (SELECT MAX(COALESCE(nd.delivered_at, nd.sent_at))
       FROM notification_deliveries nd
       WHERE nd.business_id = e.business_id
         AND nd.channel = e.channel) AS last_activity_at
  FROM channel_enrollments e
  WHERE e.business_id = ${businessId}
    AND e.archived_at IS NULL
  ORDER BY e.created_at ASC
`;
```

To:

```ts
const rows = await sql<{
  channel: string;
  handle: string | null;
  status: string;
  verified_at: Date | null;
  disabled_at: Date | null;
  unsubscribed_at: Date | null;
  unsubscribed_reason: string | null;
  expires_at: Date | null;
  last_activity_at: Date | null;
}[]>`
  SELECT
    e.channel, e.handle, e.status,
    e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
    e.verification_token_expires_at AS expires_at,
    (SELECT MAX(COALESCE(nd.delivered_at, nd.sent_at))
       FROM notification_deliveries nd
       WHERE nd.business_id = e.business_id
         AND nd.channel = e.channel) AS last_activity_at
  FROM channel_enrollments e
  WHERE e.business_id = ${businessId}
    AND e.archived_at IS NULL
  ORDER BY e.created_at ASC
`;
```

The `maskHandle` mapping below the query passes through with `...r,` spread — `expires_at` propagates automatically.

- [ ] **Step 4.3: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS.

- [ ] **Step 4.4: Smoke-test against existing tests**

Run: `pnpm test -- src/app/api/admin/businesses` (if any tests exist for this route)

Expected: PASS or "no tests found." Either is acceptable — this is an additive shape change.

- [ ] **Step 4.5: Commit**

```bash
git add src/app/api/admin/businesses/\[id\]/channels/route.ts
git commit -m "$(cat <<'EOF'
feat(api): admin channels endpoint also emits expires_at

Additive change — adds e.verification_token_expires_at AS expires_at to
the SELECT so the upcoming useEnrollment hook can source the QR
countdown timestamp from a single canonical payload shape across admin
and owner. No existing admin client reads expires_at, so no breakage.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Pure enrollment reducer

**Files:**
- Create: `src/lib/notifications/channels/enrollment-reducer.ts`
- Create: `src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts`

The reducer is a pure `(state, action) => state` function. No I/O, no `Date.now()`, no array filtering — every input lives in the action.

- [ ] **Step 5.1: Write the failing test (initial state + simple transitions)**

Create `src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts`:

```ts
// src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts
import { describe, it, expect } from 'vitest';
import {
  enrollmentReducer,
  initialEnrollment,
  type EnrollmentSnapshot,
  type EnrollmentAction,
  type ChannelEnrollmentRow,
} from '../enrollment-reducer';

const verifiedRow = (overrides: Partial<ChannelEnrollmentRow> = {}): ChannelEnrollmentRow => ({
  channel: 'telegram',
  handle: '••• 1234',
  status: 'verified',
  verified_at: '2026-04-28T12:00:00.000Z',
  disabled_at: null,
  unsubscribed_at: null,
  unsubscribed_reason: null,
  expires_at: null,
  ...overrides,
});

const pendingRow = (expiresAtIso = '2026-04-28T13:00:00.000Z'): ChannelEnrollmentRow =>
  verifiedRow({ status: 'pending_verification', handle: null, verified_at: null, expires_at: expiresAtIso });

describe('initialEnrollment', () => {
  it('starts in idle with all fields null', () => {
    expect(initialEnrollment).toEqual({
      state: 'idle',
      handle: null,
      deepLink: null,
      qrDataUrl: null,
      expiresAt: null,
      unsubscribedReason: null,
      errorMessage: null,
    });
  });
});

describe('enrollmentReducer — CONNECT_REQUESTED', () => {
  it('idle → generating', () => {
    const next = enrollmentReducer(initialEnrollment, { type: 'CONNECT_REQUESTED' });
    expect(next.state).toBe('generating');
  });

  it('disabled → generating', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'disabled' },
      { type: 'CONNECT_REQUESTED' },
    );
    expect(next.state).toBe('generating');
  });
});

describe('enrollmentReducer — CONNECT_SUCCEEDED', () => {
  it('generating → awaiting_scan with deepLink/qr/expiresAt', () => {
    const start: EnrollmentSnapshot = { ...initialEnrollment, state: 'generating' };
    const next = enrollmentReducer(start, {
      type: 'CONNECT_SUCCEEDED',
      deepLink: 'https://t.me/RepWorthBot?start=abc',
      qrDataUrl: 'data:image/png;base64,FAKE',
      expiresAt: 1735000000000,
    });
    expect(next.state).toBe('awaiting_scan');
    expect(next.deepLink).toBe('https://t.me/RepWorthBot?start=abc');
    expect(next.qrDataUrl).toBe('data:image/png;base64,FAKE');
    expect(next.expiresAt).toBe(1735000000000);
    expect(next.errorMessage).toBeNull();
  });
});

describe('enrollmentReducer — CONNECT_FAILED error classification', () => {
  it('401 → error / Session expired', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 401, message: 'unauthorized' },
    );
    expect(next.state).toBe('error');
    expect(next.errorMessage).toBe('Session expired — please sign in again.');
  });

  it('403 → error / Session expired', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 403, message: 'forbidden' },
    );
    expect(next.errorMessage).toBe('Session expired — please sign in again.');
  });

  it('404 → error / channel disabled', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 404, message: 'not_found' },
    );
    expect(next.errorMessage).toBe('Telegram is currently unavailable.');
  });

  it('503 → error / service unavailable', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 503, message: 'env_not_ready' },
    );
    expect(next.errorMessage).toBe('Service temporarily unavailable. Please try again.');
  });

  it('409 (multiple_mobile_channels) → error with switch-channel message', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 409, message: 'multiple_mobile_channels' },
    );
    expect(next.errorMessage).toBe('Disconnect your current channel before connecting another.');
  });

  it('other status → error with generic message', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 500, message: 'boom' },
    );
    expect(next.state).toBe('error');
    expect(next.errorMessage).toContain('500');
  });
});

describe('enrollmentReducer — STATUS_FETCHED transition table', () => {
  const awaitingState: EnrollmentSnapshot = {
    ...initialEnrollment,
    state: 'awaiting_scan',
    deepLink: 'https://t.me/RepWorthBot?start=abc',
    qrDataUrl: 'data:image/png;base64,FAKE',
    expiresAt: 1735000000000,
  };

  it('awaiting_scan + null row → no-op (preserves expiresAt + qrDataUrl)', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: null,
      nowMs: 1734999000000,
    });
    expect(next).toBe(awaitingState); // identity-equal — strict no-op
  });

  it('awaiting_scan + pending_verification → no-op (preserves cached expiresAt)', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: pendingRow('2026-99-99T00:00:00.000Z'), // intentionally different from cached expiresAt
      nowMs: 1734999000000,
    });
    expect(next).toBe(awaitingState);
  });

  it('awaiting_scan + verified → verified', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: verifiedRow(),
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('verified');
    expect(next.handle).toBe('••• 1234');
  });

  it('awaiting_scan + disabled → disabled (admin or webhook killed mid-flow)', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: verifiedRow({ status: 'disabled', handle: null }),
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('disabled');
  });

  it('awaiting_scan + unsubscribed → unsubscribed with reason', () => {
    const next = enrollmentReducer(awaitingState, {
      type: 'STATUS_FETCHED',
      row: verifiedRow({ status: 'unsubscribed', handle: null, unsubscribed_reason: 'telegram_blocked' }),
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('unsubscribed');
    expect(next.unsubscribedReason).toBe('telegram_blocked');
  });

  it('idle + verified → verified (take row authoritatively)', () => {
    const next = enrollmentReducer(initialEnrollment, {
      type: 'STATUS_FETCHED',
      row: verifiedRow(),
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('verified');
    expect(next.handle).toBe('••• 1234');
  });

  it('idle + null → idle (no change)', () => {
    const next = enrollmentReducer(initialEnrollment, {
      type: 'STATUS_FETCHED',
      row: null,
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('idle');
  });

  it('verified + null row → idle (row gone)', () => {
    const verified: EnrollmentSnapshot = { ...initialEnrollment, state: 'verified', handle: '••• 1234' };
    const next = enrollmentReducer(verified, {
      type: 'STATUS_FETCHED',
      row: null,
      nowMs: 1734999000000,
    });
    expect(next.state).toBe('idle');
    expect(next.handle).toBeNull();
  });

  it('generating + any row → no-op (wait for CONNECT_SUCCEEDED/FAILED)', () => {
    const generating: EnrollmentSnapshot = { ...initialEnrollment, state: 'generating' };
    const next = enrollmentReducer(generating, {
      type: 'STATUS_FETCHED',
      row: verifiedRow(),
      nowMs: 1734999000000,
    });
    expect(next).toBe(generating);
  });
});

describe('enrollmentReducer — TICK', () => {
  const awaitingState: EnrollmentSnapshot = {
    ...initialEnrollment,
    state: 'awaiting_scan',
    expiresAt: 1735000000000,
  };

  it('TICK with nowMs < expiresAt → unchanged', () => {
    const next = enrollmentReducer(awaitingState, { type: 'TICK', nowMs: 1734999999999 });
    expect(next).toBe(awaitingState);
  });

  it('TICK with nowMs === expiresAt → expired', () => {
    const next = enrollmentReducer(awaitingState, { type: 'TICK', nowMs: 1735000000000 });
    expect(next.state).toBe('expired');
  });

  it('TICK with nowMs > expiresAt → expired', () => {
    const next = enrollmentReducer(awaitingState, { type: 'TICK', nowMs: 1735000001000 });
    expect(next.state).toBe('expired');
  });

  it('TICK in non-awaiting_scan states → no-op', () => {
    const verified: EnrollmentSnapshot = { ...initialEnrollment, state: 'verified', handle: '••• 1234' };
    const next = enrollmentReducer(verified, { type: 'TICK', nowMs: 9999999999999 });
    expect(next).toBe(verified);
  });
});

describe('enrollmentReducer — CANCEL_SUCCEEDED + DISABLE_SUCCEEDED + DISMISS_ERROR', () => {
  it('CANCEL_SUCCEEDED from awaiting_scan → idle (clears qr/deepLink/expiresAt)', () => {
    const awaiting: EnrollmentSnapshot = {
      ...initialEnrollment,
      state: 'awaiting_scan',
      deepLink: 'x',
      qrDataUrl: 'y',
      expiresAt: 123,
    };
    const next = enrollmentReducer(awaiting, { type: 'CANCEL_SUCCEEDED' });
    expect(next.state).toBe('idle');
    expect(next.deepLink).toBeNull();
    expect(next.qrDataUrl).toBeNull();
    expect(next.expiresAt).toBeNull();
  });

  it('DISABLE_SUCCEEDED from verified → disabled (clears handle)', () => {
    const verified: EnrollmentSnapshot = { ...initialEnrollment, state: 'verified', handle: '••• 1234' };
    const next = enrollmentReducer(verified, { type: 'DISABLE_SUCCEEDED' });
    expect(next.state).toBe('disabled');
    expect(next.handle).toBeNull();
  });

  it('DISMISS_ERROR from error → idle (clears errorMessage)', () => {
    const errored: EnrollmentSnapshot = { ...initialEnrollment, state: 'error', errorMessage: 'boom' };
    const next = enrollmentReducer(errored, { type: 'DISMISS_ERROR' });
    expect(next.state).toBe('idle');
    expect(next.errorMessage).toBeNull();
  });
});

describe('enrollmentReducer — pure-function invariant', () => {
  it('does not call Date.now() (state independent of wall clock)', () => {
    // Run the same action twice with no clock change; identical result by reference equality.
    const action: EnrollmentAction = { type: 'CONNECT_REQUESTED' };
    const a = enrollmentReducer(initialEnrollment, action);
    const b = enrollmentReducer(initialEnrollment, action);
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 5.2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts`

Expected: FAIL (module not found).

- [ ] **Step 5.3: Implement the reducer**

Create `src/lib/notifications/channels/enrollment-reducer.ts`:

```ts
// src/lib/notifications/channels/enrollment-reducer.ts
//
// Pure state machine for QR/deep-link channel enrollment (Telegram, WhatsApp,
// future Discord/Slack). Used by `useEnrollment` (the React hook) which
// dispatches actions in response to fetch results and timer ticks.
//
// PURE: (state, action) => state. No I/O, no Date.now(), no array filtering.
// Every input is in the action. Tests run in node without jsdom.
//
// State transitions are documented in
// docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §2.

export type EnrollmentState =
  | 'idle'
  | 'generating'
  | 'awaiting_scan'
  | 'verified'
  | 'disabled'
  | 'unsubscribed'
  | 'expired'
  | 'error';

export interface ChannelEnrollmentRow {
  channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
  handle: string | null;
  status: 'verified' | 'pending_verification' | 'disabled' | 'unsubscribed';
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  expires_at: string | null;
}

export interface EnrollmentSnapshot {
  state: EnrollmentState;
  handle: string | null;
  deepLink: string | null;
  qrDataUrl: string | null;
  expiresAt: number | null;       // epoch ms — easier to test than Date
  unsubscribedReason: string | null;
  errorMessage: string | null;
}

export type EnrollmentAction =
  | { type: 'CONNECT_REQUESTED' }
  | { type: 'CONNECT_SUCCEEDED'; deepLink: string; qrDataUrl: string; expiresAt: number }
  | { type: 'CONNECT_FAILED'; status: number; message: string }
  | { type: 'STATUS_FETCHED'; row: ChannelEnrollmentRow | null; nowMs: number }
  | { type: 'CANCEL_SUCCEEDED' }
  | { type: 'DISABLE_SUCCEEDED' }
  | { type: 'TICK'; nowMs: number }
  | { type: 'DISMISS_ERROR' };

export const initialEnrollment: EnrollmentSnapshot = {
  state: 'idle',
  handle: null,
  deepLink: null,
  qrDataUrl: null,
  expiresAt: null,
  unsubscribedReason: null,
  errorMessage: null,
};

function classifyConnectError(status: number): string {
  if (status === 401 || status === 403) return 'Session expired — please sign in again.';
  if (status === 404) return 'Telegram is currently unavailable.';
  if (status === 503) return 'Service temporarily unavailable. Please try again.';
  if (status === 409) return 'Disconnect your current channel before connecting another.';
  return `Could not connect (${status}).`;
}

function rowToSnapshot(row: ChannelEnrollmentRow): EnrollmentSnapshot {
  if (row.status === 'verified') {
    return {
      ...initialEnrollment,
      state: 'verified',
      handle: row.handle,
    };
  }
  if (row.status === 'disabled') {
    return { ...initialEnrollment, state: 'disabled' };
  }
  if (row.status === 'unsubscribed') {
    return {
      ...initialEnrollment,
      state: 'unsubscribed',
      unsubscribedReason: row.unsubscribed_reason,
    };
  }
  // pending_verification — only reachable from non-awaiting_scan paths
  // (awaiting_scan + pending is a no-op upstream). Treat as idle since
  // we lack the deepLink/qrDataUrl to display the QR.
  return { ...initialEnrollment, state: 'idle' };
}

export function enrollmentReducer(
  state: EnrollmentSnapshot,
  action: EnrollmentAction,
): EnrollmentSnapshot {
  switch (action.type) {
    case 'CONNECT_REQUESTED':
      return { ...state, state: 'generating', errorMessage: null };

    case 'CONNECT_SUCCEEDED':
      return {
        ...state,
        state: 'awaiting_scan',
        deepLink: action.deepLink,
        qrDataUrl: action.qrDataUrl,
        expiresAt: action.expiresAt,
        errorMessage: null,
      };

    case 'CONNECT_FAILED':
      return {
        ...state,
        state: 'error',
        errorMessage: classifyConnectError(action.status),
      };

    case 'STATUS_FETCHED': {
      // `generating` is a transient state — wait for the explicit
      // CONNECT_SUCCEEDED / CONNECT_FAILED action.
      if (state.state === 'generating') return state;

      // `awaiting_scan` is the most subtle — see §2 transition table.
      if (state.state === 'awaiting_scan') {
        if (!action.row) return state;
        if (action.row.status === 'pending_verification') return state;
        // verified / disabled / unsubscribed → take row's state
        return rowToSnapshot(action.row);
      }

      // All other states: take the row authoritatively (or idle if no row).
      if (!action.row) return { ...initialEnrollment, state: 'idle' };
      return rowToSnapshot(action.row);
    }

    case 'CANCEL_SUCCEEDED':
      return {
        ...state,
        state: 'idle',
        deepLink: null,
        qrDataUrl: null,
        expiresAt: null,
        errorMessage: null,
      };

    case 'DISABLE_SUCCEEDED':
      return {
        ...state,
        state: 'disabled',
        handle: null,
        errorMessage: null,
      };

    case 'TICK': {
      if (state.state !== 'awaiting_scan') return state;
      if (state.expiresAt === null) return state;
      if (action.nowMs >= state.expiresAt) {
        return {
          ...state,
          state: 'expired',
          deepLink: null,
          qrDataUrl: null,
          expiresAt: null,
        };
      }
      return state;
    }

    case 'DISMISS_ERROR':
      return { ...state, state: 'idle', errorMessage: null };
  }
}
```

- [ ] **Step 5.4: Run the test to verify it passes**

Run: `pnpm test -- src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts`

Expected: all tests PASS (count: ~28 tests).

- [ ] **Step 5.5: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: both PASS.

- [ ] **Step 5.6: Commit**

```bash
git add src/lib/notifications/channels/enrollment-reducer.ts src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts
git commit -m "$(cat <<'EOF'
feat(channels): pure enrollment reducer for QR/deep-link flows

(state, action) => state state machine extracted from the existing
admin TelegramEnrollmentWidget. Owns: 8-state machine, STATUS_FETCHED
transition table from spec §2 (awaiting_scan no-op rules + expiresAt
preservation), TICK→expired, error classification.

No React, no fetch, no Date.now() — runs in vitest node environment.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `useEnrollment` React hook

**Files:**
- Create: `src/lib/notifications/channels/use-enrollment.ts`

The hook is the React glue — it owns fetch, polling, AbortController, and dispatches actions to the reducer. No unit tests in vitest (would need jsdom); covered by Playwright in Task 16.

- [ ] **Step 6.1: Implement the hook**

Create `src/lib/notifications/channels/use-enrollment.ts`:

```ts
// src/lib/notifications/channels/use-enrollment.ts
//
// React hook wiring the pure enrollmentReducer to:
//   - fetch calls (start / cancel / disable / status)
//   - filtering the canonical { enrollments: [...] } status payload by channel
//   - 3s polling loop while awaiting_scan, with AbortController cleanup
//   - 1s TTL tick dispatching TICK actions
//   - HTTP error classification → CONNECT_FAILED actions
//
// Tested via Playwright E2E (the hook needs a real React + browser environment).
// All logic that can be unit-tested in node lives in enrollment-reducer.ts.

'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  enrollmentReducer,
  initialEnrollment,
  type ChannelEnrollmentRow,
  type EnrollmentSnapshot,
} from './enrollment-reducer';
import { STATUS_POLL_INTERVAL_MS, TTL_TICK_INTERVAL_MS } from './constants';

export interface EnrollmentEndpoints {
  start: string;
  cancel: string;
  disable: string;
  status: string;
}

export interface UseEnrollmentOptions {
  channel: 'telegram' | 'whatsapp';
  endpoints: EnrollmentEndpoints;
  /** Body to send on POSTs. Admin sends { businessId }; owner sends {}. */
  postBody?: Record<string, unknown>;
  pollIntervalMs?: number;
  /** Optional initial snapshot for SSR hydration (skips first fetch). */
  initialSnapshot?: EnrollmentSnapshot;
}

export interface UseEnrollmentReturn {
  snapshot: EnrollmentSnapshot;
  actions: {
    connect: () => Promise<void>;
    cancel: () => Promise<void>;
    disable: () => Promise<void>;
    refresh: () => Promise<void>;
    dismissError: () => void;
  };
  ttl: { secondsRemaining: number | null };
}

interface StartResponse {
  deepLink: string;
  qrDataUrl: string;
  expiresAt: string; // ISO
}

interface StatusResponse {
  enrollments: ChannelEnrollmentRow[];
}

export function useEnrollment(options: UseEnrollmentOptions): UseEnrollmentReturn {
  const { channel, endpoints, postBody = {}, pollIntervalMs = STATUS_POLL_INTERVAL_MS, initialSnapshot } = options;

  const [snapshot, dispatch] = useReducer(enrollmentReducer, initialSnapshot ?? initialEnrollment);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  // Mounted ref so async fetches that resolve after unmount don't dispatch.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const safeDispatch: typeof dispatch = useCallback((action) => {
    if (mountedRef.current) dispatch(action);
  }, []);

  // ---- Status fetch + polling ---------------------------------------------

  const fetchStatus = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const res = await fetch(endpoints.status, { signal });
      if (signal?.aborted) return;
      // 401/403 surface as a CONNECT_FAILED-shaped action so the reducer can
      // classify them — but only when triggered by an explicit action, not
      // by background polling. During background polls we drop these
      // silently (the next manual action will surface them).
      if (!res.ok) return;
      const data = (await res.json()) as StatusResponse;
      const row = data.enrollments.find((e) => e.channel === channel) ?? null;
      safeDispatch({ type: 'STATUS_FETCHED', row, nowMs: Date.now() });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError') return;
      // Network failure during polling → silent. Manual refresh will surface.
    }
  }, [channel, endpoints.status, safeDispatch]);

  // Initial fetch on mount, unless caller passed an initialSnapshot.
  useEffect(() => {
    if (initialSnapshot) return;
    const controller = new AbortController();
    void fetchStatus(controller.signal);
    return () => controller.abort();
  }, [fetchStatus, initialSnapshot]);

  // Poll every pollIntervalMs while awaiting_scan.
  useEffect(() => {
    if (snapshot.state !== 'awaiting_scan') return;
    const controller = new AbortController();
    const interval = setInterval(() => {
      void fetchStatus(controller.signal);
    }, pollIntervalMs);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [snapshot.state, fetchStatus, pollIntervalMs]);

  // ---- TTL countdown ------------------------------------------------------

  useEffect(() => {
    if (snapshot.state !== 'awaiting_scan' || snapshot.expiresAt === null) {
      setSecondsRemaining(null);
      return;
    }
    const tick = () => {
      const now = Date.now();
      const remainingMs = (snapshot.expiresAt ?? 0) - now;
      setSecondsRemaining(Math.max(0, Math.floor(remainingMs / 1000)));
      safeDispatch({ type: 'TICK', nowMs: now });
    };
    tick();
    const interval = setInterval(tick, TTL_TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [snapshot.state, snapshot.expiresAt, safeDispatch]);

  // ---- Action helpers -----------------------------------------------------

  const postJson = useCallback(async (url: string): Promise<Response> => {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody),
    });
  }, [postBody]);

  const connect = useCallback(async (): Promise<void> => {
    safeDispatch({ type: 'CONNECT_REQUESTED' });
    try {
      const res = await postJson(endpoints.start);
      if (!res.ok) {
        let message = 'request_failed';
        try {
          const body = await res.json();
          if (typeof body?.error === 'string') message = body.error;
        } catch {
          /* ignore */
        }
        safeDispatch({ type: 'CONNECT_FAILED', status: res.status, message });
        return;
      }
      const data = (await res.json()) as StartResponse;
      safeDispatch({
        type: 'CONNECT_SUCCEEDED',
        deepLink: data.deepLink,
        qrDataUrl: data.qrDataUrl,
        expiresAt: new Date(data.expiresAt).getTime(),
      });
    } catch {
      safeDispatch({ type: 'CONNECT_FAILED', status: 0, message: 'network' });
    }
  }, [endpoints.start, postJson, safeDispatch]);

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await postJson(endpoints.cancel);
    } catch {
      /* ignore — cancel is fire-and-forget; refresh will reconcile */
    }
    safeDispatch({ type: 'CANCEL_SUCCEEDED' });
  }, [endpoints.cancel, postJson, safeDispatch]);

  const disable = useCallback(async (): Promise<void> => {
    try {
      const res = await postJson(endpoints.disable);
      if (!res.ok) {
        safeDispatch({ type: 'CONNECT_FAILED', status: res.status, message: 'disable_failed' });
        return;
      }
      safeDispatch({ type: 'DISABLE_SUCCEEDED' });
    } catch {
      safeDispatch({ type: 'CONNECT_FAILED', status: 0, message: 'network' });
    }
  }, [endpoints.disable, postJson, safeDispatch]);

  const refresh = useCallback(async (): Promise<void> => {
    await fetchStatus();
  }, [fetchStatus]);

  const dismissError = useCallback(() => {
    safeDispatch({ type: 'DISMISS_ERROR' });
  }, [safeDispatch]);

  return {
    snapshot,
    actions: { connect, cancel, disable, refresh, dismissError },
    ttl: { secondsRemaining },
  };
}
```

- [ ] **Step 6.2: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: both PASS.

- [ ] **Step 6.3: Commit**

```bash
git add src/lib/notifications/channels/use-enrollment.ts
git commit -m "$(cat <<'EOF'
feat(channels): useEnrollment React hook

Thin React shell wiring the pure enrollmentReducer to fetch, polling,
AbortController, and TTL tick. Filters the canonical { enrollments: [] }
status payload by channel name; classifies HTTP errors into actions.
Optionally hydrates from initialSnapshot for SSR-driven mount.

Tested via Playwright E2E (vitest stays node-only).

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Shared transaction helpers (`telegram-enrollment.ts`)

**Files:**
- Create: `src/lib/channels/telegram-enrollment.ts`
- Create: `src/lib/channels/__tests__/telegram-enrollment.test.ts`

- [ ] **Step 7.1: Write the failing test**

Create `src/lib/channels/__tests__/telegram-enrollment.test.ts`:

```ts
// src/lib/channels/__tests__/telegram-enrollment.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-under-test imports go below the mock.
const mockTx = vi.fn();
function makeTx(): typeof mockTx {
  // Postgres.js's tagged-template-callable signature: tx(strings, ...values) → Promise<rows>.
  return Object.assign(vi.fn(), {});
}

describe('startTelegramEnrollment', () => {
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    tx = makeTx();
  });

  it('inserts a new row when no enrollment exists', async () => {
    tx.mockResolvedValueOnce([]); // SELECT existing → none
    tx.mockResolvedValueOnce([]); // INSERT
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const expiresAt = new Date('2026-04-28T13:00:00.000Z');
    const result = await startTelegramEnrollment(
      tx as never,
      'biz-123',
      'a'.repeat(64),
      expiresAt,
    );
    expect(result.kind).toBe('ok');
    expect(tx).toHaveBeenCalledTimes(2);
  });

  it('updates an existing pending row to a fresh hash', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'pending_verification' }]);
    tx.mockResolvedValueOnce([]); // UPDATE
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'b'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('updates an unsubscribed row to pending', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'unsubscribed' }]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'c'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('updates a disabled row to pending', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'disabled' }]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'd'.repeat(64), new Date());
    expect(result.kind).toBe('ok');
  });

  it('returns already_verified when row.status is verified', async () => {
    tx.mockResolvedValueOnce([{ id: 'row-1', status: 'verified' }]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await startTelegramEnrollment(tx as never, 'biz-123', 'e'.repeat(64), new Date());
    expect(result.kind).toBe('already_verified');
    expect(tx).toHaveBeenCalledTimes(1); // only the SELECT, no UPDATE
  });

  it('throws MultipleMobileChannelsError on 23505 + matching constraint', async () => {
    const err = new Error('duplicate key') as Error & { code: string; constraint_name: string };
    err.code = '23505';
    err.constraint_name = 'channel_enrollments_one_mobile_per_biz';
    tx.mockResolvedValueOnce([]); // SELECT
    tx.mockRejectedValueOnce(err); // INSERT throws
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const { MultipleMobileChannelsError } = await import('../unique-violation');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'f'.repeat(64), new Date()),
    ).rejects.toThrow(MultipleMobileChannelsError);
  });

  it('throws EnrollmentDatabaseError on 23505 + other constraint', async () => {
    const err = new Error('duplicate key') as Error & { code: string; constraint_name: string };
    err.code = '23505';
    err.constraint_name = 'some_other_index';
    tx.mockResolvedValueOnce([]);
    tx.mockRejectedValueOnce(err);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    const { EnrollmentDatabaseError } = await import('../unique-violation');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'g'.repeat(64), new Date()),
    ).rejects.toThrow(EnrollmentDatabaseError);
  });

  it('rethrows non-23505 errors unchanged', async () => {
    const err = new Error('serialization failure') as Error & { code: string };
    err.code = '40001';
    tx.mockResolvedValueOnce([]);
    tx.mockRejectedValueOnce(err);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await expect(
      startTelegramEnrollment(tx as never, 'biz-123', 'h'.repeat(64), new Date()),
    ).rejects.toThrow('serialization failure');
  });

  it('does NOT emit pg_advisory_xact_lock SQL (caller responsibility)', async () => {
    tx.mockResolvedValueOnce([]);
    tx.mockResolvedValueOnce([]);
    const { startTelegramEnrollment } = await import('../telegram-enrollment');
    await startTelegramEnrollment(tx as never, 'biz-123', 'i'.repeat(64), new Date());
    // Inspect the SQL templates passed to tx — concatenate the strings array
    // from each call and assert no pg_advisory.
    const allSql = tx.mock.calls
      .map((call) => (call[0] as TemplateStringsArray | undefined)?.join('?') ?? '')
      .join('\n');
    expect(allSql).not.toContain('pg_advisory_xact_lock');
  });
});

describe('cancelTelegramEnrollment', () => {
  it('returns ok when UPDATE affects rows', async () => {
    const sql = vi.fn().mockResolvedValue([{ id: 'row-1' }]);
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await cancelTelegramEnrollment(sql as never, 'biz-123');
    expect(result.kind).toBe('ok');
  });

  it('returns not_found when UPDATE affects 0 rows', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await cancelTelegramEnrollment(sql as never, 'biz-123');
    expect(result.kind).toBe('not_found');
  });

  it('does NOT open sql.begin (single-statement)', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    // sql does not have a `begin` method on the mock — if the helper called
    // sql.begin, the test would throw TypeError. Verify by attempting
    // a plain call afterward.
    const { cancelTelegramEnrollment } = await import('../telegram-enrollment');
    await expect(cancelTelegramEnrollment(sql as never, 'biz-123')).resolves.toBeDefined();
  });
});

describe('disableTelegramEnrollment', () => {
  it('returns ok when UPDATE affects rows', async () => {
    const sql = vi.fn().mockResolvedValue([{ id: 'row-1' }]);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await disableTelegramEnrollment(sql as never, 'biz-123');
    expect(result.kind).toBe('ok');
  });

  it('returns not_found when UPDATE affects 0 rows', async () => {
    const sql = vi.fn().mockResolvedValue([]);
    const { disableTelegramEnrollment } = await import('../telegram-enrollment');
    const result = await disableTelegramEnrollment(sql as never, 'biz-123');
    expect(result.kind).toBe('not_found');
  });
});
```

- [ ] **Step 7.2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/channels/__tests__/telegram-enrollment.test.ts`

Expected: FAIL (module not found).

- [ ] **Step 7.3: Implement the helpers**

Create `src/lib/channels/telegram-enrollment.ts`:

```ts
// src/lib/channels/telegram-enrollment.ts
//
// Shared transaction helpers for Telegram channel enrollment, used by both
// admin and owner routes. The route handlers own:
//   - rawToken generation (returned to client)
//   - tokenHash + expiresAt computation
//   - sql.begin opening
//   - advisory lock acquisition (inside the tx)
//   - QR generation (after tx commits)
//
// These helpers own the state-machine SELECT + INSERT/UPDATE inside the tx,
// and the 23505 → typed-error mapping.
//
// See docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §4.2-4.4.

import { v7 as uuidv7 } from 'uuid';
import { classifyEnrollmentError } from './unique-violation';

// Postgres.js TransactionSql / Sql types are inferred from the inner callback;
// we accept `any` here because vitest mocks supply a vi.fn() and the runtime
// signature is the same tagged-template-callable shape. The type alias keeps
// call sites readable.
type TxLike = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export type StartTelegramResult = { kind: 'ok' } | { kind: 'already_verified' };

/**
 * Insert/update a Telegram enrollment row to `pending_verification` with a
 * fresh hash + expiry. Caller MUST:
 *   - Open `sql.begin(async (tx) => {...})` and pass `tx` here.
 *   - Acquire the advisory lock inside the same tx BEFORE calling this.
 *   - Generate `rawToken` outside the tx and pass `tokenHash = sha256(rawToken)`
 *     and `expiresAt = new Date(Date.now() + TOKEN_TTL_MS)`.
 *   - Generate the QR data URL AFTER the tx commits.
 */
export async function startTelegramEnrollment(
  tx: TxLike,
  businessId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<StartTelegramResult> {
  const existing = (await tx`
    SELECT id, status FROM channel_enrollments
    WHERE business_id = ${businessId} AND channel = 'telegram' AND archived_at IS NULL
  `) as Array<{ id: string; status: string }>;
  const existingRow = existing[0];

  if (existingRow?.status === 'verified') {
    return { kind: 'already_verified' };
  }

  try {
    if (existingRow) {
      await tx`
        UPDATE channel_enrollments
        SET status                       = 'pending_verification',
            handle                       = NULL,
            verification_token_hash      = ${tokenHash},
            verification_token_expires_at = ${expiresAt},
            disabled_at                  = NULL,
            unsubscribed_at              = NULL,
            unsubscribed_reason          = NULL,
            updated_at                   = NOW()
        WHERE id = ${existingRow.id}
      `;
    } else {
      await tx`
        INSERT INTO channel_enrollments
          (id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
        VALUES
          (${uuidv7()}, ${businessId}, 'telegram', 'pending_verification', ${tokenHash}, ${expiresAt})
      `;
    }
  } catch (err) {
    classifyEnrollmentError(err); // always throws
  }

  return { kind: 'ok' };
}

/**
 * Idempotent — single UPDATE; concurrent cancel + cancel produces the same end state.
 * Does NOT open sql.begin, does NOT take an advisory lock.
 */
export async function cancelTelegramEnrollment(
  sql: TxLike,
  businessId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'telegram'
      AND status = 'pending_verification'
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}

/**
 * Owner-initiated disconnect. Flips verified → disabled, clears handle.
 * Does NOT open sql.begin, does NOT take an advisory lock. Returns
 * `not_found` if no verified row matched (UI prevents this case via the
 * Disconnect-button-only-in-verified rule from spec §3).
 */
export async function disableTelegramEnrollment(
  sql: TxLike,
  businessId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET status = 'disabled',
        handle = NULL,
        disabled_at = NOW(),
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'telegram'
      AND status = 'verified'
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
```

- [ ] **Step 7.4: Run the test to verify it passes**

Run: `pnpm test -- src/lib/channels/__tests__/telegram-enrollment.test.ts`

Expected: all tests PASS.

- [ ] **Step 7.5: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: both PASS.

- [ ] **Step 7.6: Commit**

```bash
git add src/lib/channels/telegram-enrollment.ts src/lib/channels/__tests__/telegram-enrollment.test.ts
git commit -m "$(cat <<'EOF'
feat(channels): shared telegram enrollment transaction helpers

startTelegramEnrollment(tx, businessId, tokenHash, expiresAt) extracts
the state-machine SELECT + INSERT/UPDATE that admin and owner routes
both need. Caller owns rawToken generation, sql.begin, advisory lock,
and post-tx QR generation. 23505 → MultipleMobileChannelsError or
EnrollmentDatabaseError via classifyEnrollmentError.

cancelTelegramEnrollment + disableTelegramEnrollment are single-
statement helpers — no advisory lock, no sql.begin. Idempotent.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Refactor admin Telegram routes to use the helpers

**Files:**
- Modify: `src/app/api/admin/channels/telegram/start/route.ts`
- Modify: `src/app/api/admin/channels/telegram/cancel/route.ts`
- Modify: `src/app/api/admin/channels/telegram/disable/route.ts`

- [ ] **Step 8.1: Refactor `start/route.ts`**

Replace the contents of `src/app/api/admin/channels/telegram/start/route.ts` with:

```ts
// src/app/api/admin/channels/telegram/start/route.ts
//
// POST /api/admin/channels/telegram/start — admin generates a one-time Telegram
// verification deep link + QR for owner scan.
//
// Handler order: flag → env → auth → businessId → subscription → advisory lock → state-machine upsert.
//
// State machine logic lives in src/lib/channels/telegram-enrollment.ts and is
// shared with the owner route at /api/dashboard/channels/telegram/start.
// 23505 from migration 027 → MultipleMobileChannelsError → 409.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { startTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  try {
    await requireRole(req, 'admin', 'sales_partner');
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const businessRows = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status FROM businesses WHERE id = ${businessId}
  `;
  const business = businessRows[0];
  if (!business) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (business.subscription_status !== 'active') {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  // Generate token + hash + expiresAt OUTSIDE the tx so the secret doesn't
  // depend on a possibly-rolled-back transaction.
  const lockKey = createHash('sha256')
    .update(`telegram_enroll:${businessId}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  const noStore = { 'Cache-Control': 'no-store, private' };

  let result: Awaited<ReturnType<typeof startTelegramEnrollment>>;
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;
      return startTelegramEnrollment(tx, businessId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: noStore });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[telegram/start] enrollment db error', err);
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: noStore });
    }
    throw err;
  }

  if (result.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: noStore });
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'RepWorthBot';
  const deepLink = `https://t.me/${botUsername}?start=${rawToken}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: noStore },
  );
}
```

- [ ] **Step 8.2: Refactor `cancel/route.ts`**

Replace `src/app/api/admin/channels/telegram/cancel/route.ts`:

```ts
// src/app/api/admin/channels/telegram/cancel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { cancelTelegramEnrollment } from '@/lib/channels/telegram-enrollment';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  try {
    await requireRole(req, 'admin', 'sales_partner');
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  await cancelTelegramEnrollment(sql, businessId);

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}
```

- [ ] **Step 8.3: Refactor `disable/route.ts`**

Replace `src/app/api/admin/channels/telegram/disable/route.ts`:

```ts
// src/app/api/admin/channels/telegram/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { disableTelegramEnrollment } from '@/lib/channels/telegram-enrollment';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  try {
    await requireRole(req, 'admin', 'sales_partner');
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const result = await disableTelegramEnrollment(sql, businessId);

  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}
```

- [ ] **Step 8.4: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS.

- [ ] **Step 8.5: Run full test suite**

Run: `pnpm test`

Expected: PASS (no regressions). The shared helpers' tests already cover the state-machine behavior; admin routes are now thin wrappers.

- [ ] **Step 8.6: Commit**

```bash
git add src/app/api/admin/channels/telegram/start/route.ts src/app/api/admin/channels/telegram/cancel/route.ts src/app/api/admin/channels/telegram/disable/route.ts
git commit -m "$(cat <<'EOF'
refactor(api): admin telegram routes use shared enrollment helpers

start/cancel/disable now delegate to src/lib/channels/telegram-enrollment.
Routes own auth, validation, advisory lock, and QR generation; helpers
own the state-machine SELECT + INSERT/UPDATE. Adds 409 on
MultipleMobileChannelsError (migration 027 surface area) and 500 on
EnrollmentDatabaseError (no constraint_name leakage in body).

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add 23505 catch to admin SMS verify + admin WhatsApp start

**Files:**
- Modify: `src/app/api/admin/channels/sms/verify/route.ts`
- Modify: `src/app/api/admin/channels/whatsapp/start/route.ts`

- [ ] **Step 9.1: Wrap the SMS verify INSERT/UPDATE with `classifyEnrollmentError`**

Edit `src/app/api/admin/channels/sms/verify/route.ts`. Find the `if (dbAction === 'insert')` block and wrap the INSERT/UPDATE in a try/catch that calls `classifyEnrollmentError` on failure. The catch goes INSIDE the `withSmsEnrollmentLock(...)` callback so the lock is released cleanly.

At the top of the file, add the import:

```ts
import { classifyEnrollmentError, MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
```

Replace the `if (dbAction === 'insert') { ... } else if (dbAction === 'update') { ... }` block with:

```ts
    try {
      if (dbAction === 'insert') {
        await tx`
          INSERT INTO channel_enrollments (id, business_id, channel, handle, status)
          VALUES (${uuidv7()}, ${businessId}, 'sms', ${twilioPhone}, 'pending_verification')
        `;
      } else if (dbAction === 'update') {
        const updated = await tx<{ id: string }[]>`
          UPDATE channel_enrollments
          SET status = 'pending_verification', updated_at = NOW()
          WHERE business_id = ${businessId} AND channel = 'sms' AND archived_at IS NULL
            AND status = ${row!.status}
          RETURNING id
        `;
        if (updated.length !== 1) return conflict('race_conflict');
      }
      // dbAction === 'noop': re-send code to an already-pending row; no DB write.
    } catch (err) {
      // Classify before letting the error escape the lock callback.
      try {
        classifyEnrollmentError(err);
      } catch (classified) {
        if (classified instanceof MultipleMobileChannelsError) {
          return conflict('multiple_mobile_channels');
        }
        if (classified instanceof EnrollmentDatabaseError) {
          console.error('[sms/verify] enrollment db error', classified);
          return NextResponse.json({ error: 'internal' }, { status: 500 });
        }
        throw classified;
      }
    }
```

Note: `conflict()` is the existing helper that returns a 409 — verify the file imports it from somewhere; if not, replace with `NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409 })`.

- [ ] **Step 9.2: Wrap the WhatsApp start INSERT/UPDATE**

Edit `src/app/api/admin/channels/whatsapp/start/route.ts`. Find the `sql.begin(async (tx) => {...})` callback's `if (existingRow) { UPDATE } else { INSERT }` block. Wrap it in a try/catch that uses `classifyEnrollmentError`.

Add the import at the top:

```ts
import { classifyEnrollmentError, MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
```

Wrap the INSERT/UPDATE inside the `sql.begin` callback. The simplest approach: wrap the entire `sql.begin` call in an outer try/catch around the whole route handler:

Replace the `const result = await sql.begin(async (tx) => {...})` and the subsequent `if (result.kind === 'already_verified')` with:

```ts
  let result: { kind: 'ok' } | { kind: 'already_verified' };
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

      const existing = await tx<{ id: string; status: string }[]>`
        SELECT id, status FROM channel_enrollments
        WHERE business_id = ${businessId} AND channel = 'whatsapp' AND archived_at IS NULL
      `;
      const existingRow = existing[0];

      if (existingRow?.status === 'verified') {
        return { kind: 'already_verified' as const };
      }

      try {
        if (existingRow) {
          await tx`
            UPDATE channel_enrollments
            SET status                        = 'pending_verification',
                handle                        = NULL,
                verification_token_hash       = ${tokenHash},
                verification_token_expires_at = ${expiresAt},
                disabled_at                   = NULL,
                unsubscribed_at               = NULL,
                unsubscribed_reason           = NULL,
                updated_at                    = NOW()
            WHERE id = ${existingRow.id}
          `;
        } else {
          await tx`
            INSERT INTO channel_enrollments
              (id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
            VALUES
              (${uuidv7()}, ${businessId}, 'whatsapp', 'pending_verification', ${tokenHash}, ${expiresAt})
          `;
        }
      } catch (err) {
        classifyEnrollmentError(err); // always throws
      }

      return { kind: 'ok' as const };
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: { 'Cache-Control': 'no-store, private' } });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[whatsapp/start] enrollment db error', err);
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: { 'Cache-Control': 'no-store, private' } });
    }
    throw err;
  }
```

- [ ] **Step 9.3: Type-check + lint + tests**

Run: `pnpm tsc --noEmit && pnpm lint && pnpm test`

Expected: all PASS.

- [ ] **Step 9.4: Commit**

```bash
git add src/app/api/admin/channels/sms/verify/route.ts src/app/api/admin/channels/whatsapp/start/route.ts
git commit -m "$(cat <<'EOF'
feat(api): 23505 catch on admin sms/whatsapp enrollment writes

Migration 027's partial unique index covers sms+telegram+whatsapp, so
admin sms/verify and admin whatsapp/start can also throw 23505 on
multiple-mobile-channels conflict. Both routes now classify via
classifyEnrollmentError and return 409 on MultipleMobileChannelsError
(or 500 with no body leakage on EnrollmentDatabaseError). SMS catch
goes inside withSmsEnrollmentLock so the lock release is preserved.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Refactor admin `TelegramEnrollmentWidget` to use the hook

**Files:**
- Modify: `src/components/admin/TelegramEnrollmentWidget.tsx`

- [ ] **Step 10.1: Replace the widget body**

Replace the entire contents of `src/components/admin/TelegramEnrollmentWidget.tsx` with:

```tsx
'use client';

import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';

function maskChatId(chatId: string | null): string {
  if (!chatId || chatId.length <= 4) return '•••';
  return `••• ${chatId.slice(-4)}`;
}

export function TelegramEnrollmentWidget({ businessId }: { businessId: string }) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: 'telegram',
    endpoints: {
      start: '/api/admin/channels/telegram/start',
      cancel: '/api/admin/channels/telegram/cancel',
      disable: '/api/admin/channels/telegram/disable',
      status: `/api/admin/businesses/${businessId}/channels`,
    },
    postBody: { businessId },
  });

  const onDisable = async () => {
    if (!confirm('Disable Telegram notifications for this business?')) return;
    await actions.disable();
  };

  return (
    <div className="telegram-enrollment-widget border rounded-md p-4 bg-white">
      <h3 className="font-medium mb-2">Telegram</h3>
      {snapshot.state === 'idle' && (
        <button onClick={actions.connect} className="px-3 py-1.5 bg-blue-600 text-white rounded">Connect</button>
      )}
      {snapshot.state === 'generating' && <p>Generating link…</p>}
      {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
        <div>
          <p className="text-sm mb-2">Scan the QR with Telegram or share this link. The owner taps Start to verify.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={snapshot.qrDataUrl} alt="Telegram deep link QR" width={256} height={256} />
          <p className="mt-2"><a href={snapshot.deepLink} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{snapshot.deepLink}</a></p>
          {ttl.secondsRemaining !== null && (
            <p className="text-xs text-gray-500 mt-1">Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s</p>
          )}
          <button onClick={actions.cancel} className="mt-3 px-3 py-1 border rounded">Cancel</button>
          <button onClick={actions.refresh} className="mt-3 ml-2 px-3 py-1 border rounded">Refresh status</button>
        </div>
      )}
      {snapshot.state === 'verified' && (
        <div>
          <p className="text-sm text-green-700">✅ Connected — Telegram chat {maskChatId(snapshot.handle)}</p>
          <button onClick={onDisable} className="mt-2 px-3 py-1 border rounded text-red-600">Disable</button>
        </div>
      )}
      {snapshot.state === 'disabled' && (
        <div>
          <p className="text-sm text-gray-600">Disabled</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Reconnect</button>
        </div>
      )}
      {snapshot.state === 'unsubscribed' && (
        <div>
          <p className="text-sm text-orange-600">Unsubscribed ({snapshot.unsubscribedReason ?? 'unknown'})</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Re-enroll</button>
        </div>
      )}
      {snapshot.state === 'expired' && (
        <div>
          <p className="text-sm text-gray-600">Verification link expired.</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Generate new link</button>
        </div>
      )}
      {snapshot.state === 'error' && (
        <div>
          <p className="text-sm text-red-600">{snapshot.errorMessage ?? 'Something went wrong.'}</p>
          <button onClick={actions.dismissError} className="mt-2 px-3 py-1 border rounded">Back</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 10.2: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: PASS.

- [ ] **Step 10.3: Manually verify the widget renders in dev**

Run: `pnpm dev` (in a separate terminal if not already running). Open `http://localhost:3000/admin/businesses/<some-business-id>` and confirm the Telegram widget renders without console errors. Visual check: idle state shows the Connect button, the layout matches pre-refactor.

If `CHANNELS_TELEGRAM_ENABLED=false` in your local env, the widget will fetch from a 404'd start route — that's expected (the page already gates on the flag).

- [ ] **Step 10.4: Commit**

```bash
git add src/components/admin/TelegramEnrollmentWidget.tsx
git commit -m "$(cat <<'EOF'
refactor(admin): TelegramEnrollmentWidget uses shared useEnrollment hook

State management moves from local useState/useEffect to the
useEnrollment hook + pure enrollmentReducer. Behavior unchanged from
the user's perspective. Visual layout identical. Hook owns polling +
TTL countdown + AbortController; widget owns presentation only.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Refactor admin `WhatsAppEnrollmentWidget` to use the hook

**Files:**
- Modify: `src/components/admin/WhatsAppEnrollmentWidget.tsx`

- [ ] **Step 11.1: Read the current widget**

Run: `cat src/components/admin/WhatsAppEnrollmentWidget.tsx | head -80` to confirm the existing structure (it should mirror the Telegram widget closely).

- [ ] **Step 11.2: Replace the widget body using the same pattern as Task 10**

Replace `src/components/admin/WhatsAppEnrollmentWidget.tsx` with the same shape as the new TelegramEnrollmentWidget but pointed at the WhatsApp endpoints:

```tsx
'use client';

import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';

function maskPhone(phone: string | null): string {
  if (!phone) return '•••';
  if (phone.length <= 4) return phone;
  const hidden = Math.max(0, phone.length - 7);
  return phone.slice(0, 3) + '•'.repeat(hidden) + phone.slice(-4);
}

export function WhatsAppEnrollmentWidget({ businessId }: { businessId: string }) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: 'whatsapp',
    endpoints: {
      start: '/api/admin/channels/whatsapp/start',
      cancel: '/api/admin/channels/whatsapp/cancel',
      disable: '/api/admin/channels/whatsapp/disable',
      status: `/api/admin/businesses/${businessId}/channels`,
    },
    postBody: { businessId },
  });

  const onDisable = async () => {
    if (!confirm('Disable WhatsApp notifications for this business?')) return;
    await actions.disable();
  };

  return (
    <div className="whatsapp-enrollment-widget border rounded-md p-4 bg-white">
      <h3 className="font-medium mb-2">WhatsApp</h3>
      {snapshot.state === 'idle' && (
        <button onClick={actions.connect} className="px-3 py-1.5 bg-green-600 text-white rounded">Connect</button>
      )}
      {snapshot.state === 'generating' && <p>Generating link…</p>}
      {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
        <div>
          <p className="text-sm mb-2">Scan the QR with WhatsApp or share this link. The owner sends the prefilled message to verify.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={snapshot.qrDataUrl} alt="WhatsApp deep link QR" width={256} height={256} />
          <p className="mt-2"><a href={snapshot.deepLink} target="_blank" rel="noreferrer" className="text-green-700 underline break-all">{snapshot.deepLink}</a></p>
          {ttl.secondsRemaining !== null && (
            <p className="text-xs text-gray-500 mt-1">Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s</p>
          )}
          <button onClick={actions.cancel} className="mt-3 px-3 py-1 border rounded">Cancel</button>
          <button onClick={actions.refresh} className="mt-3 ml-2 px-3 py-1 border rounded">Refresh status</button>
        </div>
      )}
      {snapshot.state === 'verified' && (
        <div>
          <p className="text-sm text-green-700">✅ Connected — WhatsApp {maskPhone(snapshot.handle)}</p>
          <button onClick={onDisable} className="mt-2 px-3 py-1 border rounded text-red-600">Disable</button>
        </div>
      )}
      {snapshot.state === 'disabled' && (
        <div>
          <p className="text-sm text-gray-600">Disabled</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Reconnect</button>
        </div>
      )}
      {snapshot.state === 'unsubscribed' && (
        <div>
          <p className="text-sm text-orange-600">Unsubscribed ({snapshot.unsubscribedReason ?? 'unknown'})</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Re-enroll</button>
        </div>
      )}
      {snapshot.state === 'expired' && (
        <div>
          <p className="text-sm text-gray-600">Verification link expired.</p>
          <button onClick={actions.connect} className="mt-2 px-3 py-1 border rounded">Generate new link</button>
        </div>
      )}
      {snapshot.state === 'error' && (
        <div>
          <p className="text-sm text-red-600">{snapshot.errorMessage ?? 'Something went wrong.'}</p>
          <button onClick={actions.dismissError} className="mt-2 px-3 py-1 border rounded">Back</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 11.3: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: PASS.

- [ ] **Step 11.4: Commit**

```bash
git add src/components/admin/WhatsAppEnrollmentWidget.tsx
git commit -m "$(cat <<'EOF'
refactor(admin): WhatsAppEnrollmentWidget uses shared useEnrollment hook

Mirrors the Telegram refactor: state moves to the shared reducer +
React glue. Visual layout unchanged. Phase 4 dedupes the two admin
widgets and unblocks the owner widget in Task 13.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Owner API routes — status + telegram start/cancel/disable

**Files:**
- Create: `src/app/api/dashboard/channels/route.ts`
- Create: `src/app/api/dashboard/channels/telegram/start/route.ts`
- Create: `src/app/api/dashboard/channels/telegram/cancel/route.ts`
- Create: `src/app/api/dashboard/channels/telegram/disable/route.ts`

- [ ] **Step 12.1: Build the status endpoint**

Create `src/app/api/dashboard/channels/route.ts`:

```ts
// src/app/api/dashboard/channels/route.ts
//
// GET /api/dashboard/channels — owner-scoped status endpoint.
// Returns the canonical { enrollments: [...], available, reasons } shape
// consumed by useEnrollment + the channels page.
//
// Auth: requireRole(req, 'owner') — businessId from session, never body.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';

export const dynamic = 'force-dynamic';

function maskHandle(channel: string, handle: string | null): string | null {
  if (handle === null) return null;
  if (channel === 'email') return handle;
  if (channel === 'sms' || channel === 'whatsapp') {
    if (handle.length <= 4) return handle;
    const hidden = Math.max(0, handle.length - 7);
    return handle.slice(0, 3) + '•'.repeat(hidden) + handle.slice(-4);
  }
  if (channel === 'telegram') {
    if (handle.length <= 4) return handle;
    return '••• ' + handle.slice(-4);
  }
  return handle;
}

function smsAvailable(): boolean {
  if (process.env.CHANNELS_SMS_ENABLED !== 'true') return false;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_VERIFY_SERVICE_SID'];
  return required.every((k) => process.env[k] && process.env[k]!.trim().length > 0);
}

function whatsappAvailable(): boolean {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return false;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER', 'WHATSAPP_APPROVAL_TEMPLATE_SID'];
  return required.every((k) => process.env[k] && process.env[k]!.trim().length > 0);
}

function telegramAvailable(): boolean {
  if (!isTelegramEnabled()) return false;
  return assertTelegramEnvReady() === null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!user.businessId) {
    return NextResponse.json({ error: 'no_business' }, { status: 403 });
  }

  // Subscription guard — defense-in-depth (page server component already redirects).
  const businessRows = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status FROM businesses WHERE id = ${user.businessId}
  `;
  const business = businessRows[0];
  if (!business) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (business.subscription_status !== 'active') {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  // verification_token_hash INTENTIONALLY excluded from SELECT — only the
  // expiry timestamp is exposed (so the UI can render a countdown).
  const rows = await sql<{
    channel: string;
    handle: string | null;
    status: string;
    verified_at: Date | null;
    disabled_at: Date | null;
    unsubscribed_at: Date | null;
    unsubscribed_reason: string | null;
    expires_at: Date | null;
  }[]>`
    SELECT
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at
    FROM channel_enrollments e
    WHERE e.business_id = ${user.businessId}
      AND e.archived_at IS NULL
    ORDER BY e.created_at ASC
  `;

  const enrollments = rows.map((r) => ({
    channel: r.channel,
    handle: maskHandle(r.channel, r.handle),
    status: r.status,
    verified_at: r.verified_at?.toISOString() ?? null,
    disabled_at: r.disabled_at?.toISOString() ?? null,
    unsubscribed_at: r.unsubscribed_at?.toISOString() ?? null,
    unsubscribed_reason: r.unsubscribed_reason,
    expires_at: r.expires_at?.toISOString() ?? null,
  }));

  return NextResponse.json(
    {
      enrollments,
      available: {
        telegram: telegramAvailable(),
        sms: smsAvailable(),
        whatsapp: whatsappAvailable(),
      },
      reasons: {
        sms: 'pending_10dlc',
        whatsapp: 'pending_meta_verification',
      },
    },
    { headers: { 'Cache-Control': 'no-store, private' } },
  );
}
```

- [ ] **Step 12.2: Build the owner telegram start route**

Create `src/app/api/dashboard/channels/telegram/start/route.ts`:

```ts
// src/app/api/dashboard/channels/telegram/start/route.ts
//
// POST /api/dashboard/channels/telegram/start — owner-scoped enrollment.
// Mirrors the admin route but reads businessId from session (never body)
// and is wrapped with withSameOrigin() (CSRF protection).

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { startTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const businessId = user.businessId;
  if (!businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const businessRows = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status FROM businesses WHERE id = ${businessId}
  `;
  const business = businessRows[0];
  if (!business) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (business.subscription_status !== 'active') {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  const lockKey = createHash('sha256')
    .update(`telegram_enroll:${businessId}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const noStore = { 'Cache-Control': 'no-store, private' };

  let result: Awaited<ReturnType<typeof startTelegramEnrollment>>;
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;
      return startTelegramEnrollment(tx, businessId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: noStore });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[owner telegram/start] enrollment db error', err);
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: noStore });
    }
    throw err;
  }

  if (result.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: noStore });
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'RepWorthBot';
  const deepLink = `https://t.me/${botUsername}?start=${rawToken}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: noStore },
  );
}

export const POST = withSameOrigin()(handler);
```

- [ ] **Step 12.3: Build the owner cancel route**

Create `src/app/api/dashboard/channels/telegram/cancel/route.ts`:

```ts
// src/app/api/dashboard/channels/telegram/cancel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { cancelTelegramEnrollment } from '@/lib/channels/telegram-enrollment';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!user.businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const businessRows = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status FROM businesses WHERE id = ${user.businessId}
  `;
  if (businessRows[0]?.subscription_status !== 'active') {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  await cancelTelegramEnrollment(sql, user.businessId);

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}

export const POST = withSameOrigin()(handler);
```

- [ ] **Step 12.4: Build the owner disable route**

Create `src/app/api/dashboard/channels/telegram/disable/route.ts`:

```ts
// src/app/api/dashboard/channels/telegram/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { disableTelegramEnrollment } from '@/lib/channels/telegram-enrollment';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!user.businessId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const businessRows = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status FROM businesses WHERE id = ${user.businessId}
  `;
  if (businessRows[0]?.subscription_status !== 'active') {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  const result = await disableTelegramEnrollment(sql, user.businessId);

  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(handler);
```

- [ ] **Step 12.5: Type-check + lint + tests**

Run: `pnpm tsc --noEmit && pnpm lint && pnpm test`

Expected: all PASS.

- [ ] **Step 12.6: Commit**

```bash
git add src/app/api/dashboard/channels/route.ts src/app/api/dashboard/channels/telegram/
git commit -m "$(cat <<'EOF'
feat(api): owner-scoped channel routes under /api/dashboard/channels

GET /api/dashboard/channels — canonical { enrollments, available,
reasons } shape. verification_token_hash deliberately excluded from
SELECT. POST telegram/start|cancel|disable wrapped with withSameOrigin
(owner credentials are CSRF-targetable). All four routes scope by
businessId from session, never body.

start route delegates to shared startTelegramEnrollment helper, returns
409 on MultipleMobileChannelsError.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `OwnerTelegramWidget` thin shell

**Files:**
- Create: `src/components/dashboard/OwnerTelegramWidget.tsx`

- [ ] **Step 13.1: Implement the widget**

Create `src/components/dashboard/OwnerTelegramWidget.tsx`:

```tsx
'use client';

import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';

function maskChatId(chatId: string | null): string {
  if (!chatId || chatId.length <= 4) return '•••';
  return `••• ${chatId.slice(-4)}`;
}

export function OwnerTelegramWidget() {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: 'telegram',
    endpoints: {
      start: '/api/dashboard/channels/telegram/start',
      cancel: '/api/dashboard/channels/telegram/cancel',
      disable: '/api/dashboard/channels/telegram/disable',
      status: '/api/dashboard/channels',
    },
    postBody: {},
  });

  const onDisconnect = async () => {
    if (!confirm('Disconnect Telegram from RepWorth?')) return;
    await actions.disable();
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl" aria-hidden>💬</div>
          <div>
            <div className="font-medium text-slate-100">Telegram</div>
            {snapshot.state === 'idle' && (
              <p className="text-sm text-slate-400">Get approval requests in Telegram.</p>
            )}
            {snapshot.state === 'verified' && (
              <p className="text-sm text-cyan-400">✓ Connected · {maskChatId(snapshot.handle)}</p>
            )}
            {snapshot.state === 'disabled' && (
              <p className="text-sm text-slate-400">Disabled — reconnect to receive approvals.</p>
            )}
            {snapshot.state === 'unsubscribed' && (
              <p className="text-sm text-amber-400">You blocked the bot — start the bot in Telegram, then reconnect.</p>
            )}
            {snapshot.state === 'expired' && (
              <p className="text-sm text-slate-400">QR expired.</p>
            )}
            {snapshot.state === 'error' && (
              <p className="text-sm text-red-400">{snapshot.errorMessage ?? 'Something went wrong.'}</p>
            )}
          </div>
        </div>
        <div>
          {snapshot.state === 'idle' && (
            <button onClick={actions.connect} className="rounded bg-cyan-500 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-cyan-400">Connect</button>
          )}
          {snapshot.state === 'generating' && (
            <span className="text-sm text-slate-400">Generating link…</span>
          )}
          {snapshot.state === 'verified' && (
            <button onClick={onDisconnect} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Disconnect</button>
          )}
          {snapshot.state === 'disabled' && (
            <button onClick={actions.connect} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Reconnect</button>
          )}
          {snapshot.state === 'unsubscribed' && (
            <button onClick={actions.connect} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Reconnect</button>
          )}
          {snapshot.state === 'expired' && (
            <button onClick={actions.connect} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Generate new link</button>
          )}
          {snapshot.state === 'error' && (
            <button onClick={actions.dismissError} className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">Try again</button>
          )}
        </div>
      </div>

      {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
        <div className="mt-4 rounded-md border border-slate-700 bg-slate-950 p-4">
          <p className="text-sm text-slate-300 mb-3">Scan with Telegram, or open the link on your phone:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={snapshot.qrDataUrl} alt="Telegram QR" width={200} height={200} className="mx-auto" />
          <p className="mt-3 break-all text-xs text-cyan-400">
            <a href={snapshot.deepLink} target="_blank" rel="noreferrer">{snapshot.deepLink}</a>
          </p>
          {ttl.secondsRemaining !== null && (
            <p className="mt-2 text-xs text-slate-500">
              Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s
            </p>
          )}
          <button onClick={actions.cancel} className="mt-3 rounded border border-slate-600 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800">Cancel</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 13.2: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: PASS.

- [ ] **Step 13.3: Commit**

```bash
git add src/components/dashboard/OwnerTelegramWidget.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): OwnerTelegramWidget thin shell

~50-line shell using the shared useEnrollment hook with owner
endpoints. Disconnect button only renders in `verified` state per spec
§3 (prevents 404 from /disable on a non-verified row). Cyan accent on
verified state per repworth-brand-design.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: `ComingSoonChannelRow` static row

**Files:**
- Create: `src/components/dashboard/ComingSoonChannelRow.tsx`

- [ ] **Step 14.1: Implement the row**

Create `src/components/dashboard/ComingSoonChannelRow.tsx`:

```tsx
import type { ReactNode } from 'react';

export interface ComingSoonChannelRowProps {
  icon: ReactNode;
  name: string;
  reason: string;
}

export function ComingSoonChannelRow({ icon, name, reason }: ComingSoonChannelRowProps) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 opacity-60">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl" aria-hidden>{icon}</div>
          <div>
            <div className="font-medium text-slate-100">{name}</div>
            <p className="text-sm text-slate-400">{reason}</p>
          </div>
        </div>
        <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-400">Coming soon</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 14.2: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: PASS.

- [ ] **Step 14.3: Commit**

```bash
git add src/components/dashboard/ComingSoonChannelRow.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): ComingSoonChannelRow static placeholder

Pure-presentation row for SMS / WhatsApp until those channels go live.
No button at all — informational only. ~50% opacity per spec §3.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Restructure `/settings` — extract form, convert to server component, add tab strip

**Files:**
- Create: `src/app/(authenticated)/settings/SettingsGeneralForm.tsx`
- Create: `src/components/dashboard/SettingsTabs.tsx`
- Modify: `src/app/(authenticated)/settings/page.tsx`

- [ ] **Step 15.1: Extract the existing form into `SettingsGeneralForm.tsx`**

The current `src/app/(authenticated)/settings/page.tsx` is a 297-line `'use client'` component. Move its entire body into a new client component `src/app/(authenticated)/settings/SettingsGeneralForm.tsx` — this is a copy + rename of the function. The new file:

Create `src/app/(authenticated)/settings/SettingsGeneralForm.tsx` with the same code that currently lives in `page.tsx`, but renamed:

- Change `export default function SettingsPage()` to `export function SettingsGeneralForm()`.
- Keep `'use client'` at the top.
- Keep all imports identical to the current page.tsx.

Use the Read tool first to confirm the current file body, then Write the new file with that body and the renamed export.

- [ ] **Step 15.2: Create `SettingsTabs` server component**

Create `src/components/dashboard/SettingsTabs.tsx`:

```tsx
import Link from 'next/link';

export interface SettingsTabsProps {
  activeTab: 'general' | 'channels';
}

export function SettingsTabs({ activeTab }: SettingsTabsProps) {
  const tab = (key: 'general' | 'channels', label: string, href: string) => {
    const active = activeTab === key;
    return (
      <Link
        href={href}
        className={
          active
            ? 'inline-block border-b-2 border-cyan-400 px-4 py-2 text-sm font-medium text-cyan-400'
            : 'inline-block border-b-2 border-transparent px-4 py-2 text-sm text-slate-400 hover:text-slate-200'
        }
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className="mb-6 border-b border-slate-800" aria-label="Settings sections">
      {tab('general', 'General', '/settings')}
      {tab('channels', 'Notification channels', '/settings/channels')}
    </nav>
  );
}
```

- [ ] **Step 15.3: Convert `/settings/page.tsx` to a server component**

Replace `src/app/(authenticated)/settings/page.tsx` with:

```tsx
// src/app/(authenticated)/settings/page.tsx
//
// Server component shell. Renders the tab strip and the existing
// general settings form. Auth + subscription guard runs server-side.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { SettingsGeneralForm } from './SettingsGeneralForm';

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Server components can't set cookies; middleware handles refresh.
        },
      },
    },
  );

  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  const rows = await sql<{ role: string; subscription_status: string }[]>`
    SELECT u.role, b.subscription_status
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${authUser.id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) redirect('/admin/login');
  if (row.role !== 'owner') redirect('/admin/overview');
  if (row.subscription_status !== 'active') redirect('/onboarding/pay');

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <SettingsTabs activeTab="general" />
      <SettingsGeneralForm />
    </div>
  );
}
```

- [ ] **Step 15.4: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: PASS.

- [ ] **Step 15.5: Smoke-test in dev**

In `pnpm dev`, navigate to `/settings`. Confirm:
- Page renders the tab strip with "General" active and "Notification channels" inactive.
- Existing settings form loads underneath (business profile, notification preferences).
- An unauthenticated request gets redirected to `/admin/login`.

If the page doesn't render, check the console — likely a Supabase server-client misconfiguration or a missing env var.

- [ ] **Step 15.6: Commit**

```bash
git add src/app/\(authenticated\)/settings/page.tsx src/app/\(authenticated\)/settings/SettingsGeneralForm.tsx src/components/dashboard/SettingsTabs.tsx
git commit -m "$(cat <<'EOF'
refactor(settings): convert to server-component shell + tab strip

Existing client-only form extracted verbatim into SettingsGeneralForm
(no logic change). Page becomes a server component that does auth +
direct subscription_status check (NOT resolveWizardDestination — that
helper redirects already-onboarded owners to /dashboard). Renders the
SettingsTabs nav above the form.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: `/settings/channels` page (server) + `ChannelsClient` (client)

**Files:**
- Create: `src/app/(authenticated)/settings/channels/page.tsx`
- Create: `src/app/(authenticated)/settings/channels/ChannelsClient.tsx`

- [ ] **Step 16.1: Build the server component**

Create `src/app/(authenticated)/settings/channels/page.tsx`:

```tsx
// src/app/(authenticated)/settings/channels/page.tsx
//
// Server component for the owner channel-management page. Auth +
// subscription guard run before any UI renders. Fetches the canonical
// enrollment shape and channel availability for SSR-driven hydration.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { ChannelsClient, type InitialEnrollment } from './ChannelsClient';
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';

function smsAvailable(): boolean {
  if (process.env.CHANNELS_SMS_ENABLED !== 'true') return false;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_VERIFY_SERVICE_SID'];
  return required.every((k) => process.env[k] && process.env[k]!.trim().length > 0);
}

function whatsappAvailable(): boolean {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return false;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER', 'WHATSAPP_APPROVAL_TEMPLATE_SID'];
  return required.every((k) => process.env[k] && process.env[k]!.trim().length > 0);
}

function telegramAvailable(): boolean {
  if (!isTelegramEnabled()) return false;
  return assertTelegramEnvReady() === null;
}

export default async function ChannelsPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          /* server component cannot set cookies */
        },
      },
    },
  );

  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  const rows = await sql<{ role: string; business_id: string; subscription_status: string; owner_email: string }[]>`
    SELECT u.role, b.id AS business_id, b.subscription_status, u.email AS owner_email
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${authUser.id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) redirect('/admin/login');
  if (row.role !== 'owner') redirect('/admin/overview');
  if (row.subscription_status !== 'active') redirect('/onboarding/pay');

  // verification_token_hash INTENTIONALLY excluded from SELECT.
  const enrollmentRows = await sql<{
    channel: string;
    handle: string | null;
    status: string;
    verified_at: Date | null;
    disabled_at: Date | null;
    unsubscribed_at: Date | null;
    unsubscribed_reason: string | null;
    expires_at: Date | null;
  }[]>`
    SELECT
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at
    FROM channel_enrollments e
    WHERE e.business_id = ${row.business_id}
      AND e.archived_at IS NULL
    ORDER BY e.created_at ASC
  `;

  const initialEnrollments: InitialEnrollment[] = enrollmentRows.map((r) => ({
    channel: r.channel,
    handle: r.handle,
    status: r.status,
    verified_at: r.verified_at?.toISOString() ?? null,
    disabled_at: r.disabled_at?.toISOString() ?? null,
    unsubscribed_at: r.unsubscribed_at?.toISOString() ?? null,
    unsubscribed_reason: r.unsubscribed_reason,
    expires_at: r.expires_at?.toISOString() ?? null,
  }));

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <SettingsTabs activeTab="channels" />
      <h1 className="text-2xl font-bold text-slate-100">Notification channels</h1>
      <p className="mt-1 text-sm text-slate-400">Choose where you get review approval requests.</p>
      <div className="mt-6">
        <ChannelsClient
          initialEnrollments={initialEnrollments}
          initialAvailability={{
            telegram: telegramAvailable(),
            sms: smsAvailable(),
            whatsapp: whatsappAvailable(),
          }}
          ownerEmailFallback={row.owner_email}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 16.2: Build the client wrapper**

Create `src/app/(authenticated)/settings/channels/ChannelsClient.tsx`:

```tsx
'use client';

import { OwnerTelegramWidget } from '@/components/dashboard/OwnerTelegramWidget';
import { ComingSoonChannelRow } from '@/components/dashboard/ComingSoonChannelRow';

export interface InitialEnrollment {
  channel: string;
  handle: string | null;
  status: string;
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  expires_at: string | null;
}

export interface ChannelsClientProps {
  initialEnrollments: InitialEnrollment[];
  initialAvailability: { telegram: boolean; sms: boolean; whatsapp: boolean };
  ownerEmailFallback: string;
}

function findChannel(enrollments: InitialEnrollment[], channel: string): InitialEnrollment | null {
  return enrollments.find((e) => e.channel === channel) ?? null;
}

export function ChannelsClient({ initialEnrollments, initialAvailability, ownerEmailFallback }: ChannelsClientProps) {
  const emailRow = findChannel(initialEnrollments, 'email');
  const emailHandle = emailRow?.handle ?? ownerEmailFallback;
  const emailReconciling = !emailRow;

  return (
    <div className="space-y-6">
      {/* Email row — always-on */}
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="text-2xl" aria-hidden>✉️</div>
            <div>
              <div className="font-medium text-slate-100">Email</div>
              <p className="text-sm text-slate-400">{emailHandle}</p>
            </div>
          </div>
          <span className="rounded-full border border-cyan-400 px-3 py-1 text-xs text-cyan-400">
            {emailReconciling ? 'Reconciling…' : 'Always on'}
          </span>
        </div>
      </div>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-xs uppercase tracking-wider text-slate-500">Pick one extra channel</p>
      </div>

      {/* Telegram row — interactive if available, coming-soon otherwise */}
      {initialAvailability.telegram ? (
        <OwnerTelegramWidget />
      ) : (
        <ComingSoonChannelRow
          icon={<span>💬</span>}
          name="Telegram"
          reason="Available once Telegram channel is enabled"
        />
      )}

      {/* SMS — always coming-soon in Phase 4 */}
      {initialAvailability.sms ? (
        <ComingSoonChannelRow
          icon={<span>📱</span>}
          name="SMS"
          reason="SMS owner widget ships in a follow-up phase"
        />
      ) : (
        <ComingSoonChannelRow
          icon={<span>📱</span>}
          name="SMS"
          reason="Available once 10DLC verification clears"
        />
      )}

      {/* WhatsApp — always coming-soon in Phase 4 */}
      {initialAvailability.whatsapp ? (
        <ComingSoonChannelRow
          icon={<span>🟢</span>}
          name="WhatsApp"
          reason="WhatsApp owner widget ships in a follow-up phase"
        />
      ) : (
        <ComingSoonChannelRow
          icon={<span>🟢</span>}
          name="WhatsApp"
          reason="Available once Meta business verification clears"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 16.3: Type-check + lint**

Run: `pnpm tsc --noEmit && pnpm lint`

Expected: PASS.

- [ ] **Step 16.4: Smoke-test in dev**

In `pnpm dev`, navigate to `/settings/channels`. Confirm:
- Page renders the tab strip with "Notification channels" active.
- Email row shows the owner's email.
- Telegram row shows Connect button (if `CHANNELS_TELEGRAM_ENABLED=true`) or Coming Soon.
- SMS + WhatsApp rows show Coming Soon.
- Clicking the "General" tab navigates back to `/settings`.

- [ ] **Step 16.5: Commit**

```bash
git add src/app/\(authenticated\)/settings/channels/
git commit -m "$(cat <<'EOF'
feat(settings): /settings/channels owner-facing page

Server component does auth + direct subscription guard + initial
enrollment fetch (no flash of empty state). Client wrapper composes
the email row + 3 channel rows; OwnerTelegramWidget when
CHANNELS_TELEGRAM_ENABLED + env-ready, ComingSoonChannelRow otherwise.

Email row falls back to users.email when no enrollment row exists yet
(Google-OAuth signup window before EmailChannelReconcilePoller catches up).

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Telegram E2E test ingress helper

**Files:**
- Create: `e2e/helpers/telegram-test-ingress.ts`

> **Repo convention check:** the project's E2E directory is `e2e/` (per `playwright.config.ts:4` `testDir: './e2e'`), NOT `tests/e2e/`. Existing specs (e.g. `e2e/zernio-connect.spec.ts`) gate on `isE2eConfigured` from `e2e/seed.ts` and use `test.fixme` for fully-authenticated flows pending the Supabase admin generateLink harness (see `e2e/README.md` and `signup-google.spec.ts`).

- [ ] **Step 17.1: Inspect the worker's Telegram ingress**

Read `worker/ingress/telegram.ts` to confirm:
- The HMAC verification header name: `X-Telegram-Bot-Api-Secret-Token`.
- The expected request body shape (a Telegram `Update` JSON object with `message.text` of `/start <token>`).
- The base path for the worker (typically `${WORKER_PUBLIC_URL}/ingress/telegram`).

- [ ] **Step 17.2: Build the helper**

Create `e2e/helpers/telegram-test-ingress.ts`:

```ts
// e2e/helpers/telegram-test-ingress.ts
//
// Synthesizes a valid Telegram /start <token> webhook update and POSTs it to
// the worker's ingress endpoint. Used by owner-channels.spec.ts to simulate
// the verification webhook that flips a pending_verification row to verified.
//
// Requires TELEGRAM_WEBHOOK_SECRET + WORKER_PUBLIC_URL in the test env.

interface SimulateOptions {
  rawToken: string;
  chatId?: number;
  workerBaseUrl?: string;
}

export async function simulateTelegramStart(opts: SimulateOptions): Promise<Response> {
  const workerBase = opts.workerBaseUrl ?? process.env.WORKER_PUBLIC_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!workerBase) throw new Error('WORKER_PUBLIC_URL required for telegram test ingress');
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET required for telegram test ingress');

  const update = {
    update_id: Math.floor(Math.random() * 1_000_000_000),
    message: {
      message_id: Math.floor(Math.random() * 1_000_000),
      from: {
        id: opts.chatId ?? 5_555_550_123,
        is_bot: false,
        first_name: 'Test',
        username: 'test_owner',
      },
      chat: {
        id: opts.chatId ?? 5_555_550_123,
        type: 'private',
        first_name: 'Test',
      },
      date: Math.floor(Date.now() / 1000),
      text: `/start ${opts.rawToken}`,
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  };

  return fetch(`${workerBase.replace(/\/$/, '')}/ingress/telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(update),
  });
}
```

- [ ] **Step 17.3: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS.

- [ ] **Step 17.4: Commit**

```bash
git add e2e/helpers/telegram-test-ingress.ts
git commit -m "$(cat <<'EOF'
test(e2e): telegram ingress helper for owner channels spec

simulateTelegramStart() POSTs a synthetic Telegram /start <token>
update to the worker with the correct X-Telegram-Bot-Api-Secret-Token
header. Used by owner-channels.spec.ts to drive the verified
transition without involving a real Telegram client.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: E2E spec — `owner-channels.spec.ts`

**Files:**
- Create: `e2e/owner-channels.spec.ts`

The repo's E2E pattern (per `e2e/zernio-connect.spec.ts`, `e2e/signup-google.spec.ts`):

- Tests gate on `isE2eConfigured` from `e2e/seed.ts` (ties to `TEST_DATABASE_POOL_URL`).
- **Unauthenticated paths** are tested directly (e.g., redirect-to-login assertions).
- **Authenticated paths** use `test.fixme(...)` and are documented as deferred until the Supabase admin generateLink + session-cookie injection harness is wired (see `e2e/README.md`).
- Phase 4 follows the same convention: ship the unauthenticated assertions now; mark the authenticated flows as `test.fixme` so they're documented but don't block the merge.

- [ ] **Step 18.1: Confirm `isE2eConfigured` is exported from `e2e/seed.ts`**

Run: `grep -n "isE2eConfigured" e2e/seed.ts`

Expected: a named export. If the export name differs in the repo, adapt the import in step 18.2 accordingly.

- [ ] **Step 18.2: Build the owner E2E spec**

Create `e2e/owner-channels.spec.ts`:

```ts
// e2e/owner-channels.spec.ts
//
// Owner channels page E2E.
//
// Mirrors the established pattern from e2e/zernio-connect.spec.ts:
//   - Unauthenticated assertions run today.
//   - Authenticated flows are test.fixme until the Supabase admin
//     generateLink harness lands (see e2e/README.md). When that lands,
//     un-fixme each authenticated test and supply the magic-link login.
//
// The simulateTelegramStart helper is already plan-built (Task 17) so
// the verified-flip step is ready as soon as the auth harness exists.

import { test, expect } from '@playwright/test';
import { isE2eConfigured } from './seed';
import { simulateTelegramStart } from './helpers/telegram-test-ingress';

test.describe('Owner /settings/channels — unauthenticated', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set — skipping E2E channels tests');

  test('unauthenticated /settings/channels redirects to login', async ({ page }) => {
    await page.goto('/settings/channels');
    await expect(page).toHaveURL(/\/admin\/login/, { timeout: 10_000 });
  });
});

test.describe('Owner /settings/channels — authenticated (deferred)', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  // Each test below is fixme'd until the auth harness is wired. The
  // assertion bodies are concrete so the implementer can un-fixme them
  // one at a time as the harness comes online.

  test.fixme(
    'renders email + telegram + 2 coming-soon rows',
    async ({ page }) => {
      // After signin via auth harness:
      await page.goto('/settings/channels');
      await expect(page.getByRole('heading', { name: 'Notification channels' })).toBeVisible();
      await expect(page.getByText('Email')).toBeVisible();
      await expect(page.getByText('Always on')).toBeVisible();
      await expect(page.getByText('Telegram')).toBeVisible();
      await expect(page.getByText('SMS')).toBeVisible();
      await expect(page.getByText('WhatsApp')).toBeVisible();
    },
  );

  test.fixme(
    'connect Telegram → simulated webhook → verified',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_TELEGRAM_ENABLED !== 'true', 'Telegram disabled');
      await page.goto('/settings/channels');

      const telegramRow = page.getByText('Telegram').locator('xpath=ancestor::*[contains(@class,"rounded-lg")]').first();
      await telegramRow.getByRole('button', { name: 'Connect' }).click();

      await expect(page.locator('img[alt="Telegram QR"]')).toBeVisible();
      const linkLocator = page.locator('a[href^="https://t.me/"]');
      const deepLink = await linkLocator.getAttribute('href');
      expect(deepLink).toMatch(/^https:\/\/t\.me\/.+\?start=.+$/);
      const rawToken = new URL(deepLink!).searchParams.get('start');
      expect(rawToken).toBeTruthy();

      const ingressRes = await simulateTelegramStart({ rawToken: rawToken! });
      expect(ingressRes.status).toBeLessThan(400);

      await expect(page.getByText(/✓ Connected/)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    },
  );

  test.fixme(
    'disconnect verified Telegram → idle',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_TELEGRAM_ENABLED !== 'true', 'Telegram disabled');
      await page.goto('/settings/channels');
      page.on('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Disconnect' }).click();
      await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible({ timeout: 10_000 });
    },
  );

  test.fixme(
    'non-active subscription owner is redirected to /onboarding/pay',
    async ({ page }) => {
      // Requires a pending_payment owner fixture in seed.ts.
      await page.goto('/settings/channels');
      await expect(page).toHaveURL(/\/onboarding\/pay/);
    },
  );

  test.fixme(
    'tab strip navigates between General and Notification channels',
    async ({ page }) => {
      await page.goto('/settings/channels');
      await page.getByRole('link', { name: 'General' }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await page.getByRole('link', { name: 'Notification channels' }).click();
      await expect(page).toHaveURL(/\/settings\/channels$/);
    },
  );

  test.fixme(
    'coming-soon rows have no button',
    async ({ page }) => {
      await page.goto('/settings/channels');
      const smsRow = page.getByText('SMS').locator('xpath=ancestor::*[contains(@class,"rounded-lg")]');
      await expect(smsRow.getByRole('button')).toHaveCount(0);
    },
  );
});
```

- [ ] **Step 18.3: Run E2E (smoke)**

Run: `pnpm test:e2e -- --grep "/settings/channels"`

Expected: the unauthenticated test PASSES; fixme'd tests are reported as skipped/expected-to-fail. If `isE2eConfigured` is false, the whole describe block skips.

- [ ] **Step 18.4: Commit**

```bash
git add e2e/owner-channels.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): owner-channels.spec.ts covering /settings/channels flow

Unauthenticated redirect-to-login assertion runs today. Authenticated
flows (render, connect, simulated webhook → verified, disconnect, tab
nav, coming-soon-no-button) are test.fixme'd until the Supabase admin
generateLink harness lands (matches the convention in zernio-connect
.spec.ts and signup-google.spec.ts). simulateTelegramStart helper
already in place from Task 17.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: E2E spec — `admin-channels-refactor.spec.ts`

**Files:**
- Create: `e2e/admin-channels-refactor.spec.ts`

Same pattern as Task 18: ship the unauthenticated assertion now, mark authenticated tests as `test.fixme` per repo convention.

- [ ] **Step 19.1: Build the admin regression spec**

Create `e2e/admin-channels-refactor.spec.ts`:

```ts
// e2e/admin-channels-refactor.spec.ts
//
// Regression coverage for the Phase 4 useEnrollment hook extraction.
// Asserts the admin Telegram + WhatsApp widgets behave identically
// after the refactor.
//
// Authenticated flows are test.fixme until the admin signin harness is
// wired (matching e2e/zernio-connect.spec.ts).

import { test, expect } from '@playwright/test';
import { isE2eConfigured } from './seed';

test.describe('Admin business detail — unauthenticated', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  test('unauthenticated /admin/businesses/:id redirects to login', async ({ page }) => {
    await page.goto('/admin/businesses/00000000-0000-0000-0000-000000000000');
    await expect(page).toHaveURL(/\/admin\/login/, { timeout: 10_000 });
  });
});

test.describe('Admin TelegramEnrollmentWidget (post-refactor, deferred)', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  test.fixme(
    'idle state shows Connect button',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_TELEGRAM_ENABLED !== 'true', 'Telegram disabled');
      await page.goto(`/admin/businesses/${process.env.E2E_ADMIN_TEST_BUSINESS_ID}`);
      const widget = page.locator('.telegram-enrollment-widget');
      await expect(widget).toBeVisible();
      await expect(widget.getByRole('heading', { name: 'Telegram' })).toBeVisible();
      await expect(widget.getByRole('button', { name: 'Connect' })).toBeVisible();
    },
  );

  test.fixme(
    'clicking Connect shows QR + deep link',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_TELEGRAM_ENABLED !== 'true', 'Telegram disabled');
      await page.goto(`/admin/businesses/${process.env.E2E_ADMIN_TEST_BUSINESS_ID}`);
      const widget = page.locator('.telegram-enrollment-widget');
      await widget.getByRole('button', { name: 'Connect' }).click();
      await expect(widget.locator('img[alt="Telegram deep link QR"]')).toBeVisible();
      await expect(widget.locator('a[href^="https://t.me/"]')).toBeVisible();
      await expect(widget.getByRole('button', { name: 'Cancel' })).toBeVisible();
    },
  );
});

test.describe('Admin WhatsAppEnrollmentWidget (post-refactor, deferred)', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  test.fixme(
    'idle state shows Connect button',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_WHATSAPP_ENABLED !== 'true', 'WhatsApp disabled');
      await page.goto(`/admin/businesses/${process.env.E2E_ADMIN_TEST_BUSINESS_ID}`);
      const widget = page.locator('.whatsapp-enrollment-widget');
      await expect(widget).toBeVisible();
      await expect(widget.getByRole('heading', { name: 'WhatsApp' })).toBeVisible();
      await expect(widget.getByRole('button', { name: 'Connect' })).toBeVisible();
    },
  );

  test.fixme(
    'clicking Connect shows QR + deep link',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_WHATSAPP_ENABLED !== 'true', 'WhatsApp disabled');
      await page.goto(`/admin/businesses/${process.env.E2E_ADMIN_TEST_BUSINESS_ID}`);
      const widget = page.locator('.whatsapp-enrollment-widget');
      await widget.getByRole('button', { name: 'Connect' }).click();
      await expect(widget.locator('img[alt="WhatsApp deep link QR"]')).toBeVisible();
      await expect(widget.locator('a[href^="https://wa.me/"]')).toBeVisible();
      await expect(widget.getByRole('button', { name: 'Cancel' })).toBeVisible();
    },
  );
});
```

- [ ] **Step 19.2: Run admin E2E**

Run: `pnpm test:e2e -- --grep "post-refactor|Admin business detail"`

Expected: unauthenticated redirect test PASSES; fixme'd tests are reported as expected-to-fail.

- [ ] **Step 19.3: Commit**

```bash
git add e2e/admin-channels-refactor.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): admin telegram/whatsapp widget regression after hook refactor

Unauthenticated /admin/businesses redirect-to-login runs today.
Authenticated assertions (idle + Connect → QR/deep-link for both
widgets) are test.fixme'd pending the admin signin harness.

Asserts visible text + button labels per state, not pixel snapshots.

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Manual ship-gate checklist on staging

This task is a checklist — no code changes. Run AFTER everything above is merged to a deploy branch.

- [ ] **Step 20.1: Deploy to staging**

Push the branch and ensure staging Vercel + Railway deploys complete green.

- [ ] **Step 20.2: Run the manual ship gate**

On the staging owner test account:

1. Sign in → navigate to `/settings/channels`. Confirm email + telegram (Connect) + 2 Coming Soon rows render.
2. Click Connect on Telegram → QR + deep link appear → countdown ticks.
3. Scan QR with the staging `@RepWorthBot` (or paste deep link in Telegram). Confirm widget flips to ✓ Connected within 3-6 seconds.
4. Trigger a real review-approval notification (existing dev flow). Confirm Telegram message arrives with Approve / Regenerate / Edit buttons.
5. Tap Approve in Telegram. Confirm dashboard shows the response flipped to `approved`.
6. Click Disconnect on `/settings/channels`. Confirm row reverts to Connect.
7. (Optional) Block `@RepWorthBot` in Telegram, then trigger another notification. Confirm the next page load shows `unsubscribed` with telegram_blocked reason.
8. Click "General" tab → confirm settings form renders. Click "Notification channels" → confirm channels page returns.
9. Open a new private window, sign in as a `pending_payment` owner, navigate to `/settings/channels`. Confirm redirect to `/onboarding/pay`.

- [ ] **Step 20.3: Run code-reviewer subagent**

If using subagent-driven development, dispatch `superpowers:code-reviewer` against the merged PR before flag flip.

Expected: zero blocking issues.

---

## Spec coverage cross-check

- §1 file inventory → Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 cover every NEW + MODIFIED file.
- §2 reducer + hook → Tasks 5, 6.
- §3 page UI + state machine + coming-soon row + Disconnect-only-in-verified rule → Tasks 13, 14, 16.
- §4 API routes (4 owner routes + 23505 catch on admin SMS/WA) → Tasks 9, 12.
- §4.7 same-origin asymmetry → Task 12 wraps owner routes only with `withSameOrigin()`; admin routes intentionally untouched.
- §5 server-component restructure + email fallback + env-readiness → Tasks 15, 16.
- §6 edge cases (16 rows) → mitigations are baked into the relevant code (advisory lock in Task 8, 23505 catch in Tasks 8/9/12, `archived_at IS NULL` filter in Task 12, no-store headers throughout, etc.). The reducer's STATUS_FETCHED transition table is verified by Task 5's tests.
- §6.2 migration 027 + predicate rationale → Task 1.
- §7 testing strategy → reducer + helper + detector unit tests in Tasks 3, 5, 7; E2E in Tasks 18, 19; manual in Task 20.
- §9 risks (audit query, multi-tab polling, etc.) → Task 0 audit, Task 1 migration, Task 20 manual smoke.
- Appendix A 20-step order → followed exactly.
