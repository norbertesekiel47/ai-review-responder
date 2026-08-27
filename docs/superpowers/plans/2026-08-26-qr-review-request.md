# QR Review Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
> (recommended) or executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-location printable Review QR that resolves through the
RepWorth-owned QR redirect (`/q/<businessId>`) to that location's Google
write-review link, with every successful redirect counted as a
`qr_scan_redirected` analytics event.

**Architecture:** One new deep module `src/lib/locations/review-qr.ts` owns
resolution and eligibility; a thin public route (`/q/[businessId]`, modeled on
`/r/google/[responseId]`) and a new settings section are its two callers. The
scan event rides the existing durable-analytics seam (`analytics_events` +
`AnalyticsDispatchPoller`), which requires migration 115 to widen the
`event_name` CHECK. No new dependency (`qrcode` is already installed), no
worker changes, no new env var or flag.

**Tech Stack:** Next.js 16 route handlers + server components, Postgres.js,
`qrcode` (installed), vitest.

**Authority:** Intake contract
`docs/superpowers/plans/feat-qr-review-request-intake.json` (signed off
2026-08-26). Glossary: `CONTEXT.md` → "Review QR" / "QR redirect". Roadmap
lock: the forward-roadmap Phase 0 pull-forward (owner decision 2026-08-26;
the roadmap folder lives uncommitted in the parent checkout — another
session's work, deliberately not absorbed into this branch).

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/115_qr_scan_analytics_event.sql` (create) | Widen `analytics_events_event_name_check` with `qr_scan_redirected` |
| `.claude/reference/migrations-log.md` (modify) | Head bump 115/116 + LOCAL-ONLY entry |
| `src/lib/analytics/events.ts` (modify) | Register `qr_scan_redirected` (server-only, NOT client-enqueueable) |
| `src/lib/shared/subscription-status.ts` (modify) | New predicate `subscriptionAllowsQrRedirect` |
| `src/lib/locations/review-qr.ts` (create) | Deep module: `buildWriteReviewUrl`, `resolveQrRedirect`, `getOwnerReviewQrLocations` |
| `src/app/q/[businessId]/route.ts` (create) | Public QR redirect route (thin orchestrator) |
| `src/app/(authenticated)/settings/review-qr/page.tsx` (create) | Settings section server component |
| `src/app/(authenticated)/settings/review-qr/ReviewQrClient.tsx` (create) | Cards: preview, PNG download, print link |
| `src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx` (create) | Print view server component |
| `src/app/(authenticated)/settings/review-qr/PrintButton.tsx` (create) | `window.print()` client button |
| `src/components/dashboard/settings/SettingsSidebar.tsx` (modify) | Nav entry |
| `docs/directory.md` (modify) | Row for `src/lib/locations/review-qr.ts` |
| Tests | `src/lib/shared/__tests__/subscription-status.test.ts` (modify), `src/lib/locations/__tests__/review-qr.test.ts` (create), `src/app/q/[businessId]/__tests__/route.test.ts` (create) |

Blocking edges: Task 1 first (eval). Task 2 ∥ Task 3 (disjoint). Task 4 needs
Task 3. Task 5 needs Tasks 2+4. Task 6 needs Task 4. Tasks 5 ∥ 6 (disjoint
files). Task 1 runs ALONE (first-task enforcement spot check).

Shared constants used below:

```ts
const CANONICAL_PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const HEX_CID = '0x89c259af336b3341:0x66df8e2a5b7cdb51';
const BUSINESS_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec603';
const ACCOUNT_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec604';
```

---

### Task 1: Eval task — the spec as failing tests

**Files:**
- Modify: `src/lib/shared/__tests__/subscription-status.test.ts`
- Create: `src/lib/locations/__tests__/review-qr.test.ts`
- Create: `src/app/q/[businessId]/__tests__/route.test.ts`

All ten `tests_to_add` titles land VERBATIM (the gate's `promised-tests` row
checks byte-for-byte). Everything fails or is `.todo` until its
implementation task lands.

- [ ] **Step 1: Extend the subscription-status test**

Append to the existing file (add `subscriptionAllowsQrRedirect` to its
existing import from `../subscription-status`):

```ts
describe('subscriptionAllowsQrRedirect', () => {
  it('subscriptionAllowsQrRedirect admits active, trialing and past_due only', () => {
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.ACTIVE)).toBe(true);
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.TRIALING)).toBe(true);
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.PAST_DUE)).toBe(true);
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.PENDING_PAYMENT)).toBe(false);
    expect(subscriptionAllowsQrRedirect(SubscriptionStatus.CANCELLED)).toBe(false);
    expect(subscriptionAllowsQrRedirect('nonsense')).toBe(false);
  });
});
```

- [ ] **Step 2: Create the module test**

`src/lib/locations/__tests__/review-qr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildWriteReviewUrl,
  getOwnerReviewQrLocations,
  resolveQrRedirect,
} from '../review-qr';

const CANONICAL_PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const HEX_CID = '0x89c259af336b3341:0x66df8e2a5b7cdb51';
const ACCOUNT_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec604';
const BUSINESS_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec603';

// postgres.js template-tag fake: records each call, returns queued rows.
function fakeSql(rowsPerCall: unknown[][]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return rowsPerCall.shift() ?? [];
  };
  return { sql: Object.assign(fn, { json: (v: unknown) => v }) as never, calls };
}

describe('buildWriteReviewUrl', () => {
  it('refuses to build a review link for a non-canonical place id', () => {
    expect(buildWriteReviewUrl(HEX_CID)).toBeNull();
    expect(buildWriteReviewUrl(null)).toBeNull();
    expect(buildWriteReviewUrl('   ')).toBeNull();
    expect(buildWriteReviewUrl('short')).toBeNull();
  });

  it('builds the Google write-review URL for a canonical place id', () => {
    expect(buildWriteReviewUrl(CANONICAL_PLACE_ID)).toBe(
      `https://search.google.com/local/writereview?placeid=${CANONICAL_PLACE_ID}`,
    );
  });
});

function resolveRow(overrides: Record<string, unknown> = {}) {
  return {
    google_place_id: CANONICAL_PLACE_ID,
    archived_at: null,
    account_id: ACCOUNT_UUID,
    subscription_status: 'active',
    ...overrides,
  };
}

describe('resolveQrRedirect', () => {
  it('resolves a live location to a redirect carrying the account id', async () => {
    const { sql } = fakeSql([[resolveRow()]]);
    const result = await resolveQrRedirect(sql, BUSINESS_UUID);
    expect(result).toEqual({
      kind: 'redirect',
      url: `https://search.google.com/local/writereview?placeid=${CANONICAL_PLACE_ID}`,
      accountId: ACCOUNT_UUID,
    });
  });

  it('returns not_found for an unknown business id', async () => {
    const { sql } = fakeSql([[]]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'not_found',
    });
  });

  it('returns archived before consulting the subscription', async () => {
    const { sql } = fakeSql([
      [resolveRow({ archived_at: new Date('2026-08-01T00:00:00Z'), subscription_status: 'cancelled' })],
    ]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'archived',
    });
  });

  it('returns subscription for a status outside the QR gate', async () => {
    const { sql } = fakeSql([[resolveRow({ subscription_status: 'pending_payment' })]]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'subscription',
    });
  });

  it('returns bad_place_id for a legacy hex CID', async () => {
    const { sql } = fakeSql([[resolveRow({ google_place_id: HEX_CID })]]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'bad_place_id',
    });
  });
});

describe('getOwnerReviewQrLocations', () => {
  it("returns only the caller's account locations from getOwnerReviewQrLocations", async () => {
    const { sql, calls } = fakeSql([
      [
        { id: BUSINESS_UUID, name: 'Acme', display_label: null, google_place_id: CANONICAL_PLACE_ID },
        { id: ACCOUNT_UUID, name: 'Acme Two', display_label: 'Downtown', google_place_id: HEX_CID },
      ],
    ]);
    const locations = await getOwnerReviewQrLocations(sql, ACCOUNT_UUID, 'https://app.example.com/');

    // Tenant scope: the one query binds the caller's account id.
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('account_id');
    expect(calls[0].values).toContain(ACCOUNT_UUID);
    expect(calls[0].text).toContain('archived_at IS NULL');

    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({
      businessId: BUSINESS_UUID,
      displayName: 'Acme',
      qrTargetUrl: `https://app.example.com/q/${BUSINESS_UUID}`,
      ineligibleReason: null,
    });
    expect(locations[0].qrDataUrl).toMatch(/^data:image\/png/);
    expect(locations[1]).toMatchObject({
      displayName: 'Downtown',
      qrDataUrl: null,
      ineligibleReason: 'bad_place_id',
    });
  });

  it('throws when appUrl is empty — a QR encoding a relative URL is a config defect', async () => {
    const { sql } = fakeSql([[]]);
    await expect(getOwnerReviewQrLocations(sql, ACCOUNT_UUID, '')).rejects.toThrow(/appUrl/);
  });
});
```

- [ ] **Step 3: Create the route test**

`src/app/q/[businessId]/__tests__/route.test.ts` — the
`src/app/r/google/[responseId]/__tests__/route.test.ts` pattern (`vi.hoisted`
+ `vi.mock('@/lib/db/server')`), but the fake is call-indexed: call 0 is the
resolve SELECT, call 1 is the analytics INSERT. The real module and the real
`enqueueAnalyticsEvent` run against the fake.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db } = vi.hoisted(() => {
  const state = {
    rowsPerCall: [] as unknown[][],
    calls: [] as { text: string; values: unknown[] }[],
    failOnCall: -1,
  };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const index = state.calls.length;
    state.calls.push({ text: strings.join('?'), values });
    if (index === state.failOnCall) throw new Error('insert failed');
    return state.rowsPerCall[index] ?? [];
  };
  return { db: { state, sql: Object.assign(fn, { json: (v: unknown) => v }) } };
});

vi.mock('@/lib/db/server', () => ({ sql: db.sql }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

import { GET } from '../route';

const BUSINESS_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec603';
const ACCOUNT_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec604';
const CANONICAL_PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const HEX_CID = '0x89c259af336b3341:0x66df8e2a5b7cdb51';
const WRITE_REVIEW_URL = `https://search.google.com/local/writereview?placeid=${CANONICAL_PLACE_ID}`;

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    google_place_id: CANONICAL_PLACE_ID,
    archived_at: null,
    account_id: ACCOUNT_UUID,
    subscription_status: 'active',
    ...overrides,
  };
}

function call(businessId: string) {
  return GET({} as never, { params: Promise.resolve({ businessId }) });
}

beforeEach(() => {
  db.state.rowsPerCall = [];
  db.state.calls = [];
  db.state.failOnCall = -1;
});

describe('GET /q/[businessId]', () => {
  it('redirects an active-subscription location with a canonical place id to the Google write-review URL', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(WRITE_REVIEW_URL);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns the unavailable page for a cancelled or pending_payment account', async () => {
    for (const status of ['cancelled', 'pending_payment']) {
      db.state.rowsPerCall = [[liveRow({ subscription_status: status })]];
      db.state.calls = [];
      const res = await call(BUSINESS_UUID);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('Review link unavailable');
    }
  });

  it('returns the unavailable page for an archived location', async () => {
    db.state.rowsPerCall = [[liveRow({ archived_at: new Date('2026-08-01T00:00:00Z') })]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('returns the unavailable page when google_place_id is a legacy hex CID', async () => {
    db.state.rowsPerCall = [[liveRow({ google_place_id: HEX_CID })]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('returns the unavailable page for a malformed or unknown business id', async () => {
    const malformed = await call('not-a-uuid');
    expect(malformed.status).toBe(200);
    expect(db.state.calls).toHaveLength(0); // no DB touch on a malformed id

    db.state.rowsPerCall = [[]];
    const unknown = await call(BUSINESS_UUID);
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get('location')).toBeNull();
  });

  it('still redirects when the analytics insert fails', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    db.state.failOnCall = 1; // the INSERT
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(WRITE_REVIEW_URL);
  });

  it('records a qr_scan_redirected analytics event on a successful redirect', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(302);
    expect(db.state.calls).toHaveLength(2);
    const insert = db.state.calls[1];
    expect(insert.text).toContain('analytics_events');
    expect(insert.values).toContain('qr_scan_redirected');
    expect(insert.values).toContain(ACCOUNT_UUID);
    expect(insert.values).toContain(BUSINESS_UUID);
  });

  it('never redirects anywhere but the constructed Google write-review URL', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    const res = await call(BUSINESS_UUID);
    expect(res.headers.get('location')).toMatch(
      /^https:\/\/search\.google\.com\/local\/writereview\?placeid=/,
    );
  });
});
```

- [ ] **Step 4: Run and confirm every new test FAILS**

Run: `pnpm vitest run src/lib/shared/__tests__/subscription-status.test.ts src/lib/locations/__tests__/review-qr.test.ts "src/app/q/[businessId]/__tests__/route.test.ts"`
Expected: FAIL — unresolved imports (`../review-qr`, `../route`) and missing
export `subscriptionAllowsQrRedirect`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/__tests__/subscription-status.test.ts "src/lib/locations/__tests__/review-qr.test.ts" "src/app/q/[businessId]/__tests__/route.test.ts"
git commit -m "test(qr): eval suite for Review QR + QR redirect (failing)"
```

---

### Task 2: Migration 115 + event registry

**Files:**
- Create: `supabase/migrations/115_qr_scan_analytics_event.sql`
- Modify: `src/lib/analytics/events.ts:4-31`
- Modify: `.claude/reference/migrations-log.md` (head line + new entry)

The `ci:analytics-events` audit requires the registry and the latest CHECK
migration to move together — one commit.

- [ ] **Step 1: Write the migration**

Copy migration 106's list EXACTLY (strict superset, same order), append the
new name last:

```sql
-- 115_qr_scan_analytics_event.sql
--
-- Adds 'qr_scan_redirected' to the analytics_events event_name CHECK
-- (feat-qr-review-request; CONTEXT.md "QR redirect" — one event per
-- successful Review QR scan redirect). Constraint-only on the 106 precedent:
-- no SchemaRequirement export, no assertSchemaReady entry, no
-- retention-policy row (analytics_events already carries its posture).

SET lock_timeout = '5s';

ALTER TABLE analytics_events
  DROP CONSTRAINT IF EXISTS analytics_events_event_name_check;

ALTER TABLE analytics_events
  ADD CONSTRAINT analytics_events_event_name_check
  CHECK (
    event_name IN (
      'signup_started',
      'email_verified',
      'sample_demo_started',
      'sample_demo_to_signup',
      'gbp_connect_started',
      'gbp_connect_failed',
      'gbp_connected',
      'first_review_ingested',
      'first_response_drafted',
      'activation_completed',
      'offboarding_started',
      'offboarding_reactivated',
      'offboarding_teardown_completed',
      'offboarding_purged',
      'trial_started',
      'trial_converted',
      'trial_payment_failed',
      'trial_cancelled',
      'competitor_rival_picked',
      'solicitation_consent_recorded',
      'solicitation_consent_upgraded',
      'solicitation_suppressed',
      'solicitation_suppressed_at_dispatch',
      'import_offer_created',
      'import_decision_recorded',
      'checkout_coupon_decision',
      'qr_scan_redirected'
    )
  );
```

- [ ] **Step 2: Register the event name**

In `src/lib/analytics/events.ts`, append to `ANALYTICS_EVENT_NAMES` (after
`'checkout_coupon_decision'`):

```ts
  'checkout_coupon_decision',
  'qr_scan_redirected',
] as const;
```

Do NOT touch `CLIENT_ENQUEUEABLE_EVENT_NAMES` — a scan count is a durable
server-side fact; a client-postable variant would let anyone forge scan
metrics.

- [ ] **Step 3: Migrations-log bookkeeping**

In `.claude/reference/migrations-log.md`: change line 4 to
`Current head: **115** — next migration is **116**`, and add the newest-first
entry:

```md
- **115** — `qr_scan_analytics_event`: widens the `analytics_events`
  `event_name` CHECK with `qr_scan_redirected` (feat-qr-review-request;
  CONTEXT.md "QR redirect"). Constraint-only on the 106 pattern — no
  SchemaRequirement, no assertSchemaReady entry, no retention-policy row.
  **LOCAL-ONLY.**
```

The LOCAL-ONLY marker stays until step-8 promotion (staging first, prod in
lockstep; verify by reading the constraint back from
`information_schema`/`pg_constraint`, never `list_migrations`).

- [ ] **Step 4: Provision + audit**

Run: `pnpm test:db:setup && pnpm ci:analytics-events`
Expected: setup applies through 115; audit PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/115_qr_scan_analytics_event.sql src/lib/analytics/events.ts .claude/reference/migrations-log.md
git commit -m "feat(qr): migration 115 + qr_scan_redirected event registration"
```

---

### Task 3: The QR redirect gate predicate

**Files:**
- Modify: `src/lib/shared/subscription-status.ts` (after `subscriptionAllowsDashboardRead`, line ~76)

- [ ] **Step 1: Implement**

```ts
/**
 * Whether a scan of a location's Review QR may 302 to Google (CONTEXT.md
 * "QR redirect"). `past_due` deliberately stays live so a card failure never
 * kills a printed counter code mid-grace; `pending_payment` and `cancelled`
 * render the scanner-facing unavailable page. Same membership as
 * `subscriptionAllowsDashboardRead` TODAY, deliberately a separate name —
 * the owner's dashboard entitlement and a customer-facing printed code have
 * no reason to move together (owner decision 2026-08-26).
 */
export function subscriptionAllowsQrRedirect(status: string): boolean {
  return (
    subscriptionGrantsFullAccess(status) ||
    status === SubscriptionStatus.PAST_DUE
  );
}
```

- [ ] **Step 2: Run the eval test**

Run: `pnpm vitest run src/lib/shared/__tests__/subscription-status.test.ts`
Expected: PASS (including the Task 1 title).

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/subscription-status.ts
git commit -m "feat(qr): subscriptionAllowsQrRedirect gate predicate"
```

---

### Task 4: The review-qr module

**Files:**
- Create: `src/lib/locations/review-qr.ts`
- Modify: `docs/directory.md` (§ `src/lib/locations/` — one row, same PR rule)

- [ ] **Step 1: Implement the module**

```ts
// src/lib/locations/review-qr.ts
//
// Review QR + QR redirect domain module (CONTEXT.md "Review QR" /
// "QR redirect"). Two callers cross this seam: the public /q/[businessId]
// route (resolveQrRedirect) and the owner settings section
// (getOwnerReviewQrLocations). sql arrives as a parameter (invariant #15).
//
// The write-review prefix is deliberately a third private spelling of the
// format (url-parser.ts RECOGNISES it; solicitation/dispatch.ts builds the
// THROWING variant for the send lane, where an upstream gate guarantees
// canonicality). This builder returns null instead: for a scanner, a
// non-canonical place id is an unavailable page, not an assertion failure —
// nothing upstream guarantees canonicality here.
//
// v1 counts every successful resolve as a scan — HEAD requests and link
// prefetchers included (accepted noise, intake edge case).

import QRCode from 'qrcode';
import type { Sql } from 'postgres';
import { isPlaceId } from '@/lib/reviews/url-parser';
import { subscriptionAllowsQrRedirect } from '@/lib/shared/subscription-status';

const GOOGLE_WRITE_REVIEW_URL_PREFIX =
  'https://search.google.com/local/writereview?placeid=';

/** Print-quality edge length for the downloadable PNG. */
const QR_PNG_WIDTH = 2048;

/**
 * The Google write-review deep link for a place id, or null when the value
 * is not a canonical Place ID (hex CIDs resolve to nothing at Google —
 * migration 007 legacy rows).
 */
export function buildWriteReviewUrl(placeId: string | null): string | null {
  const candidate = placeId?.trim() ?? '';
  if (!isPlaceId(candidate)) return null;
  return `${GOOGLE_WRITE_REVIEW_URL_PREFIX}${encodeURIComponent(candidate)}`;
}

export type QrRedirectResolution =
  | { kind: 'redirect'; url: string; accountId: string }
  | {
      kind: 'unavailable';
      reason: 'not_found' | 'archived' | 'subscription' | 'bad_place_id';
    };

/**
 * Resolve one QR scan. Refusal order: not_found → archived → subscription →
 * bad_place_id (most-specific first). Pure result, no side effects — the
 * route owns the 302, the page, the log line and the analytics insert.
 */
export async function resolveQrRedirect(
  sql: Sql,
  businessId: string,
): Promise<QrRedirectResolution> {
  const [row] = await sql<
    {
      google_place_id: string | null;
      archived_at: Date | null;
      account_id: string;
      subscription_status: string;
    }[]
  >`
    SELECT b.google_place_id, b.archived_at, b.account_id, a.subscription_status
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
    LIMIT 1
  `;
  if (!row) return { kind: 'unavailable', reason: 'not_found' };
  if (row.archived_at !== null) return { kind: 'unavailable', reason: 'archived' };
  if (!subscriptionAllowsQrRedirect(row.subscription_status)) {
    return { kind: 'unavailable', reason: 'subscription' };
  }
  const url = buildWriteReviewUrl(row.google_place_id);
  if (url === null) return { kind: 'unavailable', reason: 'bad_place_id' };
  return { kind: 'redirect', url, accountId: row.account_id };
}

export interface OwnerReviewQrLocation {
  businessId: string;
  displayName: string;
  /** The URL the QR encodes — the QR redirect hop, never the Google URL. */
  qrTargetUrl: string;
  /** PNG data URL (2048px), null when the location is not QR-eligible. */
  qrDataUrl: string | null;
  /** null when eligible; the only v1 ineligibility is a non-canonical place id. */
  ineligibleReason: 'bad_place_id' | null;
}

/**
 * Every non-archived location of ONE account, with its QR (or the reason it
 * has none). appUrl is passed in by the composition root — this module never
 * reads env (invariant #15 posture).
 */
export async function getOwnerReviewQrLocations(
  sql: Sql,
  accountId: string,
  appUrl: string,
): Promise<OwnerReviewQrLocation[]> {
  const base = appUrl.replace(/\/+$/, '');
  if (base === '') {
    throw new Error('review-qr: appUrl is required to build QR target URLs');
  }
  const rows = await sql<
    {
      id: string;
      name: string;
      display_label: string | null;
      google_place_id: string | null;
    }[]
  >`
    SELECT id, name, display_label, google_place_id
    FROM businesses
    WHERE account_id = ${accountId}
      AND archived_at IS NULL
    ORDER BY is_primary DESC, created_at ASC
  `;
  const locations: OwnerReviewQrLocation[] = [];
  // Sequential on purpose: ci:pool-fanout forbids Promise combinators over
  // src/lib/locations, and N is small.
  for (const row of rows) {
    const qrTargetUrl = `${base}/q/${row.id}`;
    const eligible = buildWriteReviewUrl(row.google_place_id) !== null;
    locations.push({
      businessId: row.id,
      displayName: row.display_label ?? row.name,
      qrTargetUrl,
      qrDataUrl: eligible
        ? await QRCode.toDataURL(qrTargetUrl, { margin: 1, width: QR_PNG_WIDTH })
        : null,
      ineligibleReason: eligible ? null : 'bad_place_id',
    });
  }
  return locations;
}
```

- [ ] **Step 2: Run the eval tests**

Run: `pnpm vitest run src/lib/locations/__tests__/review-qr.test.ts`
Expected: PASS, all describe blocks.

- [ ] **Step 3: directory.md row**

Add under § `src/lib/locations/`, matching the table shape of its sibling
rows:

```md
| `review-qr.ts` | Review QR + QR redirect module (CONTEXT.md): `resolveQrRedirect` for `/q/[businessId]`, `getOwnerReviewQrLocations` for `/settings/review-qr`; owns the null-returning write-review URL builder + QR PNG data URLs |
```

- [ ] **Step 4: Audits that police this directory**

Run: `pnpm ci:directory-map && pnpm ci:pool-fanout && pnpm ci:db-imports && pnpm ci:tenant-scope`
Expected: all PASS. If `ci:tenant-scope` flags `resolveQrRedirect`'s
by-UUID cross-account read, add the allowlist entry its output names with the
justification "public QR redirect surface — resolves a printed opaque UUID,
returns no tenant data" (the margin-service precedent); record the allowlist
touch in the deviations file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/locations/review-qr.ts docs/directory.md
git commit -m "feat(qr): review-qr domain module"
```

---

### Task 5: The public QR redirect route

**Files:**
- Create: `src/app/q/[businessId]/route.ts`

- [ ] **Step 1: Implement the route**

```ts
// src/app/q/[businessId]/route.ts
//
// Public QR redirect (CONTEXT.md "QR redirect"): resolves a Review QR scan
// server-side and 302s to the location's Google write-review deep link.
// Hardened like src/app/r/google/[responseId]/route.ts, but stronger on the
// destination: the URL is CONSTRUCTED from an isPlaceId-validated place id,
// never read from a stored URL, so no allowlist is needed and no open
// redirect is possible. Every refusal renders the scanner-facing unavailable
// page (200, no-store) with one reason-coded log line — never an error leak.
//
// UI-only per invariant #1: one short DB read + best-effort analytics insert
// + redirect. The insert deliberately runs AFTER resolve, in its own
// try/catch: a scan must reach Google even when analytics is down (the
// best-effort-after-primary-side-effect gotcha).

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import { resolveQrRedirect } from '@/lib/locations/review-qr';
import { createWorkerLogger } from '@/lib/shared/logger';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

// Local on purpose, the /r/google precedent — importing owner-route's
// UUID_RE would drag the owner-auth module chain into a public route.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const logger = createWorkerLogger('q/[businessId]');

function unavailablePage(): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review link unavailable</title>
</head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#111;">
  <div style="max-width:520px;margin:80px auto;padding:32px;background:#fff;border-radius:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <h1 style="font-size:20px;margin:0 0 8px;">Review link unavailable</h1>
    <p style="font-size:15px;color:#555;line-height:1.5;margin:0;">
      This review link isn&#39;t active right now. You can still leave a review
      by searching for the business on Google.
    </p>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> },
): Promise<NextResponse> {
  const { businessId } = await params;
  if (!UUID_RE.test(businessId)) {
    logger.log('qr_redirect_unavailable', { reason: 'bad_id' });
    return unavailablePage();
  }

  const resolution = await resolveQrRedirect(sql, businessId);
  if (resolution.kind === 'unavailable') {
    logger.log('qr_redirect_unavailable', { reason: resolution.reason, businessId });
    return unavailablePage();
  }

  try {
    await enqueueAnalyticsEvent(sql, {
      eventName: 'qr_scan_redirected',
      eventKey: makeAnalyticsEventKey('qr_scan_redirected', [businessId, randomUUID()]),
      distinctId: resolution.accountId,
      accountId: resolution.accountId,
      businessId,
    });
  } catch (err) {
    reportCaughtError('q/[businessId] GET analytics', err, { businessId });
  }

  return new NextResponse(null, {
    status: 302,
    headers: { Location: resolution.url, 'Cache-Control': 'no-store' },
  });
}
```

Notes pinned by the intake: the event key is random per scan (every scan is a
distinct fact — idempotency dedup would UNDERCOUNT); `distinctId` is the
account id (the scanner is anonymous; PostHog groups by the account the code
belongs to).

- [ ] **Step 2: Run the eval tests**

Run: `pnpm vitest run "src/app/q/[businessId]/__tests__/route.test.ts"`
Expected: PASS — all 8, including the five verbatim intake titles.

- [ ] **Step 3: Boundary + policy audits**

Run: `pnpm ci:static-policy && pnpm typecheck && pnpm vitest run src/__tests__/eslint-boundaries.test.ts`
Expected: PASS (route imports no forbidden runtime module).

- [ ] **Step 4: Commit**

```bash
git add "src/app/q/[businessId]/route.ts"
git commit -m "feat(qr): public /q/[businessId] QR redirect route"
```

---

### Task 6: Settings section — Review QR

**Files:**
- Create: `src/app/(authenticated)/settings/review-qr/page.tsx`
- Create: `src/app/(authenticated)/settings/review-qr/ReviewQrClient.tsx`
- Create: `src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx`
- Create: `src/app/(authenticated)/settings/review-qr/PrintButton.tsx`
- Modify: `src/components/dashboard/settings/SettingsSidebar.tsx:8-39`

**The implementing agent MUST invoke the `repworth-brand-design` skill before
writing any TSX** — this is Console-system UI; token/layout rules come from
the skill, and the code below fixes structure and data flow, not visual
styling. Follow `src/app/(authenticated)/settings/channels/page.tsx` for the
page skeleton (TopBar, `requireOwnerAccess(sql)`, plain-JSON handoff to the
client component).

- [ ] **Step 1: Server page**

```tsx
// src/app/(authenticated)/settings/review-qr/page.tsx
//
// Review QR settings section (CONTEXT.md "Review QR"): one card per
// non-archived location. Deliberately NOT behind shouldShowLocationsSettings
// — single-location owners are the launch majority and get their QR here.

import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { getOwnerReviewQrLocations } from '@/lib/locations/review-qr';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { ReviewQrClient } from './ReviewQrClient';

export default async function ReviewQrPage() {
  const access = await requireOwnerAccess(sql);
  const locations = await getOwnerReviewQrLocations(
    sql,
    access.accountId,
    process.env.NEXT_PUBLIC_APP_URL ?? '',
  );
  return (
    <>
      <TopBar title="Review QR" />
      <ReviewQrClient locations={locations} />
    </>
  );
}
```

(`OwnerReviewQrLocation` is already plain JSON — strings and nulls only, no
Dates — so it crosses the server/client boundary as-is. Check `TopBar`'s
actual props against the channels page and match them.)

- [ ] **Step 2: Client component**

`ReviewQrClient.tsx` (`'use client'`): map `locations` to cards. Per eligible
location: `<img src={qrDataUrl} alt="Review QR for {displayName}">` preview
(CSS-constrained, e.g. 160px), the `qrTargetUrl` as copyable text,
`<a download={`review-qr-${businessId}.png`} href={qrDataUrl}>Download PNG</a>`,
and a `<Link href={`/settings/review-qr/print/${businessId}`}>Print</Link>`.
Per ineligible location: the explanatory card — "This location needs a
canonical Google Place ID before it can have a review QR." — and NO QR/actions.
Empty state (zero locations): one sentence pointing at Locations settings.
Exact styling: `repworth-brand-design` (Console).

- [ ] **Step 3: Print view + button**

`print/[businessId]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { getOwnerReviewQrLocations } from '@/lib/locations/review-qr';
import { PrintButton } from '../../PrintButton';

export default async function ReviewQrPrintPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const access = await requireOwnerAccess(sql);
  const locations = await getOwnerReviewQrLocations(
    sql,
    access.accountId,
    process.env.NEXT_PUBLIC_APP_URL ?? '',
  );
  const location = locations.find((entry) => entry.businessId === businessId);
  if (!location || location.qrDataUrl === null) notFound();
  return (
    <main>
      <h1>{location.displayName}</h1>
      <p>Scan to leave us a review</p>
      <img src={location.qrDataUrl} alt={`Review QR for ${location.displayName}`} />
      <PrintButton />
    </main>
  );
}
```

Tenant scope is structural: the lookup happens INSIDE the caller's account
list, so a foreign businessId is `notFound()`, never data. Print CSS
(`@media print`) hides the button and any chrome; the QR fills most of a
portrait A4/Letter page. `PrintButton.tsx` is a 10-line `'use client'`
component calling `window.print()`.

- [ ] **Step 4: Sidebar entry**

In `SettingsSidebar.tsx` `NAV_GROUPS`, Account group, directly after
Locations:

```ts
      { label: 'Review QR', href: '/settings/review-qr', icon: 'location' },
```

(`icon` must be an existing `IconName` — confirm `'location'` against
`@/components/dashboard/shell/Icon` and pick the closest if it differs.)

- [ ] **Step 5: Build + verify**

Run: `pnpm typecheck && pnpm build`
Expected: PASS. (SURFACE includes ui, so the gate runs `pnpm build` anyway —
this catches it early.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(authenticated)/settings/review-qr" src/components/dashboard/settings/SettingsSidebar.tsx
git commit -m "feat(qr): Review QR settings section + print view"
```

---

## Out of scope (locked non-goals — do not add)

No contact capture, no interstitial/sentiment page, no token column, no PDF
dependency, no admin surface, no vanity domain, no campaign variants, no new
env var/flag, no rate limiting on the route, no worker changes.

## Verification (step 5 of /feature)

`scripts/verify-gate.sh` from the worktree root with
`TEST_DATABASE_POOL_URL` + `DATABASE_POOL_URL` exported (db_touching: the
gate provisions the test DB itself). Final pre-review run:
`scripts/verify-gate.sh --review`. Screenshots (390px/1440px) of
`/settings/review-qr` and the print view are produced during the step-8
staging ride, per the design acceptance rule.

## Review appendix

(filled by step 3 review rounds)
