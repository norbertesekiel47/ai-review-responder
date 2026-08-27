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
| `src/lib/locations/repo.ts` (modify) | New reader `getQrRedirectRow` — repo.ts owns every location query (codex R3 #7) |
| `src/app/q/[businessId]/route.ts` (create) | Public QR redirect route (thin orchestrator) |
| `src/app/(authenticated)/settings/review-qr/page.tsx` (create) | Settings section server component |
| `src/app/(authenticated)/settings/review-qr/ReviewQrClient.tsx` (create) | Cards: preview, PNG download, print link |
| `src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx` (create) | Print view server component |
| `src/app/(authenticated)/settings/review-qr/PrintButton.tsx` (create) | `window.print()` client button |
| `src/components/dashboard/settings/SettingsSidebar.tsx` (modify) | Nav entry |
| `docs/analytics/events.md` (modify) | `qr_scan_redirected` row (`ci:analytics-events` reads this doc) |
| `scripts/ci/tenant-scope-allowlist.ts` (modify) | One `pre-auth-token` entry for the redirect resolver (amendment #2) |
| `docs/directory.md` (modify) | Row for `src/lib/locations/review-qr.ts` |
| Tests | `src/lib/shared/__tests__/subscription-status.test.ts` (modify), `src/lib/analytics/__tests__/events.test.ts` (modify), `src/lib/locations/__tests__/review-qr.test.ts` + `review-qr.integration.test.ts` (create), `src/app/q/[businessId]/__tests__/route.test.ts` (create), `src/lib/shared/__tests__/migration-115-qr-scan-analytics-event.integration.test.ts` (create) + `migration-106-…integration.test.ts` (modify, drift-guard handover) |

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
- Create: `src/lib/locations/__tests__/review-qr.integration.test.ts`
- Create: `src/app/q/[businessId]/__tests__/route.test.ts`

Every intake `tests_to_add` title lands VERBATIM (18 after the R2 additions;
the gate's `promised-tests` row checks byte-for-byte) — fifteen in this
task's files, three UI titles authored test-first inside Task 6 (they need
that task's components to exist as files). Everything fails or is `.todo`
until its implementation task lands.

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
import { describe, it, expect, vi } from 'vitest';
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

  it('returns bad_place_id for a missing google_place_id', async () => {
    const { sql } = fakeSql([[resolveRow({ google_place_id: null })]]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'bad_place_id',
    });
  });

  it('admits trialing and past_due through the named predicate', async () => {
    for (const status of ['trialing', 'past_due']) {
      const { sql } = fakeSql([[resolveRow({ subscription_status: status })]]);
      const result = await resolveQrRedirect(sql, BUSINESS_UUID);
      expect(result.kind).toBe('redirect');
    }
  });

  it('reads the subscription from the accounts JOIN, not the deprecated businesses column', async () => {
    // Text-level guard (codex R1 M5); the LIVE proof is in
    // review-qr.integration.test.ts, where the two columns diverge.
    const { sql, calls } = fakeSql([[resolveRow()]]);
    await resolveQrRedirect(sql, BUSINESS_UUID);
    expect(calls[0].text).toContain('a.subscription_status');
    expect(calls[0].text).toContain('JOIN accounts a');
  });

  it('gates through subscriptionAllowsQrRedirect, never a raw comparison', async () => {
    // Invariant #11 made mechanical (codex R2 on M9): a re-spelled
    // status === 'active' || … would pass every membership test above.
    // Requires a PASSTHROUGH mock at the top of this test file (a local TS
    // module with named exports — this shape typechecks, unlike the
    // rejected qrcode variant):
    //
    //   vi.mock('@/lib/shared/subscription-status', async (importOriginal) => {
    //     const actual = await importOriginal<typeof import('@/lib/shared/subscription-status')>();
    //     return { ...actual, subscriptionAllowsQrRedirect: vi.fn(actual.subscriptionAllowsQrRedirect) };
    //   });
    //   import { subscriptionAllowsQrRedirect } from '@/lib/shared/subscription-status';
    const { sql } = fakeSql([[resolveRow()]]);
    vi.mocked(subscriptionAllowsQrRedirect).mockClear();
    await resolveQrRedirect(sql, BUSINESS_UUID);
    expect(subscriptionAllowsQrRedirect).toHaveBeenCalledWith('active');
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

// Codex R1 M16 / R2 fix: prove the ENCODED PAYLOAD and print size with NO
// mock at all — QR encoding and PNG serialization are deterministic for a
// fixed input + options, so generate the EXPECTED data URL independently
// with the same library and compare byte-for-byte. (The R1 passthrough mock
// failed typecheck: `typeof import('qrcode')` has no `default` under
// @types/qrcode — codex R2 ran tsc and proved it.) Add
// `import QRCode from 'qrcode';` to the test file's imports.

describe('QR encoding parameters', () => {
  it('encodes the /q/<businessId> URL at print width', async () => {
    const { sql } = fakeSql([
      [{ id: BUSINESS_UUID, name: 'Acme', display_label: null, google_place_id: CANONICAL_PLACE_ID }],
    ]);
    const locations = await getOwnerReviewQrLocations(sql, ACCOUNT_UUID, 'https://app.example.com');
    const expected = await QRCode.toDataURL(`https://app.example.com/q/${BUSINESS_UUID}`, {
      margin: 1,
      width: 2048,
    });
    // Index access stays possibly-undefined under noUncheckedIndexedAccess
    // (codex R3 #1) — optional chaining keeps the assertion type-clean.
    expect(locations[0]?.qrDataUrl).toBe(expected);
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

const { loggerFake } = vi.hoisted(() => ({ loggerFake: { log: vi.fn() } }));
vi.mock('@/lib/shared/logger', () => ({ createWorkerLogger: () => loggerFake }));

import { GET } from '../route';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

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
  loggerFake.log.mockClear();
  vi.mocked(reportCaughtError).mockClear();
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

  it('redirects trialing and past_due subscriptions and an uppercase UUID', async () => {
    for (const status of ['trialing', 'past_due']) {
      db.state.rowsPerCall = [[liveRow({ subscription_status: status })]];
      db.state.calls = [];
      expect((await call(BUSINESS_UUID.toUpperCase())).status).toBe(302);
    }
  });

  it('two scans of the same QR produce distinct analytics event keys', async () => {
    // Codex R1 M7: a deterministic per-business key would dedupe on
    // ON CONFLICT (event_key) and silently UNDERCOUNT repeat scans.
    const keys: string[] = [];
    for (let scan = 0; scan < 2; scan += 1) {
      db.state.rowsPerCall = [[liveRow()]];
      db.state.calls = [];
      await call(BUSINESS_UUID);
      const insert = db.state.calls[1];
      const key = insert.values.find(
        (value) => typeof value === 'string' && value.startsWith('qr_scan_redirected:'),
      );
      expect(key).toBeDefined();
      keys.push(key as string);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('ships account_id and business_id in the analytics event properties', async () => {
    // Codex R1 M3/M4: AnalyticsDispatchPoller forwards ONLY the properties
    // JSON (plus $insert_id) to PostHog — the DB columns never reach it.
    db.state.rowsPerCall = [[liveRow()]];
    await call(BUSINESS_UUID);
    const insert = db.state.calls[1];
    const properties = insert.values.find(
      (value) => typeof value === 'object' && value !== null && !(value instanceof Date),
    ) as Record<string, unknown>;
    expect(properties).toMatchObject({
      account_id: ACCOUNT_UUID,
      business_id: BUSINESS_UUID,
    });
  });

  it('returns unavailable for a missing google_place_id without recording analytics', async () => {
    db.state.rowsPerCall = [[liveRow({ google_place_id: null })]];
    const res = await call(BUSINESS_UUID);
    expect(res.status).toBe(200);
    expect(db.state.calls).toHaveLength(1); // the resolve SELECT only — no INSERT
  });

  it('serves one identical no-store unavailable page for every refusal, reason-coded in the log only', async () => {
    // Codex R1 M11–M13: the page must not leak WHICH refusal fired (that
    // distinction belongs to the log line), and every response is no-store.
    const bodies: string[] = [];
    const refusals: Array<[Record<string, unknown> | null, string]> = [
      [null, 'not_found'],
      [liveRow({ subscription_status: 'cancelled' }), 'subscription'],
      [liveRow({ archived_at: new Date('2026-08-01T00:00:00Z') }), 'archived'],
      [liveRow({ google_place_id: HEX_CID }), 'bad_place_id'],
      [liveRow({ google_place_id: null }), 'bad_place_id'],
    ];
    for (const [row, reason] of refusals) {
      db.state.rowsPerCall = [row === null ? [] : [row]];
      db.state.calls = [];
      loggerFake.log.mockClear();
      const res = await call(BUSINESS_UUID);
      expect(res.headers.get('cache-control')).toBe('no-store');
      bodies.push(await res.text());
      expect(loggerFake.log).toHaveBeenCalledWith(
        'qr_redirect_unavailable',
        expect.objectContaining({ reason }),
      );
    }
    // The malformed-id leg refuses BEFORE the DB and must be
    // indistinguishable from every other refusal (codex R2).
    loggerFake.log.mockClear();
    const malformed = await call('not-a-uuid');
    expect(malformed.headers.get('cache-control')).toBe('no-store');
    bodies.push(await malformed.text());
    expect(loggerFake.log).toHaveBeenCalledWith(
      'qr_redirect_unavailable',
      expect.objectContaining({ reason: 'bad_id' }),
    );
    expect(new Set(bodies).size).toBe(1); // byte-identical across ALL refusals
  });

  it('reports the analytics failure when the insert throws', async () => {
    db.state.rowsPerCall = [[liveRow()]];
    db.state.failOnCall = 1;
    await call(BUSINESS_UUID);
    expect(reportCaughtError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3b: Create the live-DB eval suite**

`src/lib/locations/__tests__/review-qr.integration.test.ts` — codex R1 M5/M6:
a mocked `sql` tag can prove the template was interpolated; only a live DB
proves the exclusion predicate and the authoritative-column JOIN. Copy the
HARNESS verbatim from `add-location-tx.integration.test.ts` (the
`describeWithDb` gate, `assertSchemaReady`, teardown) and the seed helpers
from `src/lib/shared/__tests__/live-db-tenant.ts` (`seedTenantAccount`,
`seedLocation`, `cleanupTenantAccount`, `cleanupLocation` — match their real
signatures, do not invent overrides). Live-DB conventions apply: suite named
`*.integration.test.ts`, NO run-time DDL, self-skips without
`TEST_DATABASE_POOL_URL`. The two test bodies:

```ts
it("excludes another account's locations and the caller's archived locations", async () => {
  // Seed: account A with one eligible location (canonical place id) and one
  // ARCHIVED location; account B with one eligible location.
  // Assert: getOwnerReviewQrLocations(db, accountA.id, 'https://app.example.com')
  // returns EXACTLY the one eligible A location — B's location and the
  // archived one are absent, and the returned qrTargetUrl ends with the A
  // location's id.
});

it('reads the subscription gate from accounts.subscription_status, not the deprecated businesses column', async () => {
  // Seed: account C with accounts.subscription_status = 'cancelled' whose
  // location row carries the DEPRECATED businesses.subscription_status =
  // 'active' and a canonical google_place_id.
  // Assert: resolveQrRedirect(db, location.id) → { kind: 'unavailable',
  // reason: 'subscription' }.
  // Then flip: accounts.subscription_status = 'active', deprecated column
  // 'cancelled' → resolveQrRedirect returns kind 'redirect'.
  // Only accounts.subscription_status may decide.
});
```

- [ ] **Step 4: Run and confirm every new test FAILS**

Run: `pnpm vitest run src/lib/shared/__tests__/subscription-status.test.ts src/lib/locations/__tests__/review-qr.test.ts src/lib/locations/__tests__/review-qr.integration.test.ts "src/app/q/[businessId]/__tests__/route.test.ts"`
Expected: FAIL — unresolved imports (`../review-qr`, `../route`) and missing
export `subscriptionAllowsQrRedirect`. (The integration suite fails at
import too; once the module exists it self-skips without
`TEST_DATABASE_POOL_URL` and runs in the gate's live lane.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/__tests__/subscription-status.test.ts "src/lib/locations/__tests__/review-qr.test.ts" "src/lib/locations/__tests__/review-qr.integration.test.ts" "src/app/q/[businessId]/__tests__/route.test.ts"
git commit -m "test(qr): eval suite for Review QR + QR redirect (failing)"
```

---

### Task 2: Migration 115 + event registry

**Files:**
- Create: `supabase/migrations/115_qr_scan_analytics_event.sql`
- Modify: `src/lib/analytics/events.ts:4-31`
- Modify: `docs/analytics/events.md` (new event row — `ci:analytics-events`
  compares the registry to THIS document, codex R1 finding 2)
- Modify: `src/lib/analytics/__tests__/events.test.ts` (exact-list assertion
  at line 12 + the never-client-enqueueable test)
- Create: `src/lib/shared/__tests__/migration-115-qr-scan-analytics-event.integration.test.ts`
- Modify: `src/lib/shared/__tests__/migration-106-checkout-coupon-analytics-event.integration.test.ts`
  (drift-guard handover)
- Modify: `.claude/reference/migrations-log.md` (head line + new entry)

Everything above moves in ONE commit — the audit, the exact-list test, and
the drift guard each fail on a partial landing. The `new-migration` skill
checklist was applied at plan time (constraint-only: no UUIDv7/RLS/retention
decisions apply; `lock_timeout` set; verify-by-introspection at promotion).

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

- [ ] **Step 2b: Update the registry tests + add the client-enqueueable guard**

In `src/lib/analytics/__tests__/events.test.ts`: append
`'qr_scan_redirected'` to the exact-list `toEqual` assertion (line 12), and
add:

```ts
it('qr_scan_redirected is never client-enqueueable', () => {
  expect(isClientEnqueueableEventName('qr_scan_redirected')).toBe(false);
});
```

(`isClientEnqueueableEventName` is already exported; extend the file's
existing import.)

- [ ] **Step 2c: Move the live drift guard 106 → 115**

Create
`src/lib/shared/__tests__/migration-115-qr-scan-analytics-event.integration.test.ts`
modeled STRUCTURALLY on the 106 suite (same five text-shape assertions + the
one live rejection), with: `MIGRATION_115 = 'supabase/migrations/115_qr_scan_analytics_event.sql'`,
`previous` = migration 106, `NEW_EVENT_NAMES = ['qr_scan_redirected']`. The
suite carries the superset assertion (106's full list is a prefix of 115's),
the "admits qr_scan_redirected" assertion, the lock_timeout and idempotent
constraint-swap assertions, the ANALYTICS_EVENT_NAMES drift-guard (subset
direction), and TWO live assertions (codex R2 on M3): the rejection (an
INSERT with an unregistered name is refused by the CHECK) and the ADMIT (an
INSERT with `qr_scan_redirected` succeeds — then delete the row) — together
they prove the constraint is live AND admits the name the route will insert.

Then DEMOTE the 106 suite exactly the way the 102 suite was demoted when 106
took over (diff the two files and mirror the change): 106 stops holding the
LIVE `ANALYTICS_EVENT_NAMES` drift guard — its remaining assertions pin the
frozen historical list. Update its header comment the way 102's header
records the handover.

- [ ] **Step 2d: Document the event**

Append to `docs/analytics/events.md`, following the `checkout_coupon_decision`
row shape exactly:

```md
### `qr_scan_redirected`
- **Status:** live
- **Description:** One successful **QR redirect** (CONTEXT.md): a customer scanned a location's **Review QR** and was 302-redirected to that location's Google write-review page. Counted AFTER the resolve gates pass (existence, not archived, `subscriptionAllowsQrRedirect`, canonical place id) and never on a refusal — an unavailable-page serve emits nothing (it is a log line, not a metric). v1 counts every successful resolve, HEAD requests and prefetchers included (accepted noise, intake edge case). The name is registered in the `analytics_events.event_name` CHECK by **migration 115** — the DB CHECK, not the TS allowlist, is what admits the name.
- **Owner:** `GET /q/[businessId]` (`src/app/q/[businessId]/route.ts`), best-effort AFTER resolve, own `try`/`catch` (`reportCaughtError`, then swallow) — a scan must reach Google even when analytics is down.
- **Source:** server-side (durable; **not** client-postable — a client-postable variant would let anyone forge scan metrics).
- **Distinct ID:** account ID (the scanner is anonymous; the event belongs to the account whose code was scanned).
- **Event key:** `qr_scan_redirected:<business_id>:<randomUUID>` — deliberately random per scan: every scan is a distinct fact, and a deterministic key would dedupe on `ON CONFLICT (event_key) DO NOTHING` and silently undercount repeat scans.
- **Required properties:** `account_id`, `business_id` — duplicated INTO properties because `AnalyticsDispatchPoller` forwards only the properties JSON (plus `$insert_id`) to PostHog; the DB columns never reach it.
- **Optional properties:** none
- **Privacy notes:** IDs only — no scanner identity exists (nothing is collected from the scanner), no user agent, no IP.
```

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

Run: `pnpm test:db:setup && pnpm ci:analytics-events && pnpm vitest run src/lib/analytics/__tests__/events.test.ts src/lib/shared/__tests__/migration-115-qr-scan-analytics-event.integration.test.ts src/lib/shared/__tests__/migration-106-checkout-coupon-analytics-event.integration.test.ts`
Expected: setup applies through 115; audit PASS; all three suites PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/115_qr_scan_analytics_event.sql src/lib/analytics/events.ts src/lib/analytics/__tests__/events.test.ts docs/analytics/events.md src/lib/shared/__tests__/migration-115-qr-scan-analytics-event.integration.test.ts src/lib/shared/__tests__/migration-106-checkout-coupon-analytics-event.integration.test.ts .claude/reference/migrations-log.md
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
- Modify: `src/lib/locations/repo.ts` (new reader `getQrRedirectRow` + header Exports line)
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (one statement-granular `pre-auth-token` entry)
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
 * route owns the 302, the page, the log line and the analytics insert. The
 * read itself lives in repo.ts (getQrRedirectRow) — that module owns every
 * location query, and the tenant-scope allowlist is STATEMENT-granular, so
 * placing it there exempts nothing else (codex R3 #7).
 */
export async function resolveQrRedirect(
  sql: Sql,
  businessId: string,
): Promise<QrRedirectResolution> {
  const row = await getQrRedirectRow(sql, businessId);
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
 * has none). Reads through repo.ts's getLocationsForAccount — that module
 * owns location reads (codex R1 finding 15); re-spelling its query here
 * would be a second owner. appUrl is passed in by the composition root —
 * this module never reads env (invariant #15 posture).
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
  const rows = await getLocationsForAccount(sql, accountId);
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

(Add `import { getLocationsForAccount, getQrRedirectRow } from './repo';` to
the module's imports. `getLocationsForAccount` already filters `archived_at IS NULL`,
scopes by `account_id`, and orders `is_primary DESC, created_at ASC` —
`src/lib/locations/repo.ts:63-85`. The module-test text assertions on
`account_id`/`archived_at` keep working because the repo's REAL query runs
against the fake tag.)

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

**The resolver read lives in repo.ts (codex R3 #7 — my R2 file-granularity
claim was wrong: the allowlist is keyed by file + table + normalized SQL, so
one entry exempts ONE statement, nothing else).** Add to
`src/lib/locations/repo.ts` (amendment #3 file), honoring its "every
location query lives here" header:

```ts
export interface QrRedirectRow {
  google_place_id: string | null;
  archived_at: Date | null;
  account_id: string;
  subscription_status: string;
}

/**
 * Pre-auth read for the public QR redirect (CONTEXT.md "QR redirect"): by
 * business UUID, JOINs accounts for the AUTHORITATIVE subscription status,
 * deliberately UNSCOPED — the scanner is anonymous and tenant scope is
 * unknowable before this read. Allowlisted statement-granular in
 * scripts/ci/tenant-scope-allowlist.ts (category 'pre-auth-token').
 */
export async function getQrRedirectRow(
  sql: Sql,
  businessId: string,
): Promise<QrRedirectRow | null> {
  const [row] = await sql<QrRedirectRow[]>`
    SELECT b.google_place_id, b.archived_at, b.account_id, a.subscription_status
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
    LIMIT 1
  `;
  return row ?? null;
}
```

Also update repo.ts's header Exports list with the new function (match its
one-line-per-export shape).

Then add the allowlist entry: in `scripts/ci/tenant-scope-allowlist.ts`, one
statement-granular entry for `src/lib/locations/repo.ts` /
`getQrRedirectRow`'s query, category `'pre-auth-token'` — match the file's
existing entry shape exactly, justification: "public QR redirect resolves a
printed opaque business UUID before any tenant scope is knowable; returns no
tenant data".

Run: `pnpm ci:directory-map && pnpm ci:pool-fanout && pnpm ci:db-imports && pnpm ci:tenant-scope`
Expected: all PASS. Any OTHER file the tenant-scope audit flags is a real
defect — fix the query, never widen the allowlist.

- [ ] **Step 5: Commit**

```bash
git add src/lib/locations/review-qr.ts src/lib/locations/repo.ts scripts/ci/tenant-scope-allowlist.ts docs/directory.md
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
      // Duplicated INTO properties on purpose: AnalyticsDispatchPoller
      // forwards only the properties JSON (plus $insert_id) to PostHog —
      // the DB columns never reach it (codex R1 M3/M4).
      properties: { account_id: resolution.accountId, business_id: businessId },
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
Expected: PASS — the full route suite, including every verbatim intake title
it carries.

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
- Create: `src/app/(authenticated)/settings/review-qr/__tests__/ReviewQrClient.test.tsx`
- Create: `src/app/(authenticated)/settings/review-qr/__tests__/PrintButton.test.tsx`
- Modify: `src/components/dashboard/settings/SettingsSidebar.tsx:8-39`
- Modify: `src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx`

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
// requireOwnerAccess redirects pending_payment owners to /onboarding/pay —
// the STANDARD settings posture (intake edge case corrected in codex R1);
// the customer-facing redirect is gated independently by
// subscriptionAllowsQrRedirect.

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

- [ ] **Step 4b: Component tests (house standard — codex R2 reversed the
  R1 rejection: `ChannelsClient.test.tsx` / `ProfileClient.test.tsx` are the
  precedents)**

`__tests__/ReviewQrClient.test.tsx`, modeled on
`src/app/(authenticated)/settings/channels/__tests__/ChannelsClient.test.tsx`
(same render harness and query style). Required titles VERBATIM:

```ts
it('offers download and print only for eligible locations', () => {
  // Render with one eligible location (qrDataUrl set) and one ineligible
  // (qrDataUrl null, ineligibleReason 'bad_place_id').
  // Eligible card: an <a> with download === `review-qr-${businessId}.png`
  // and href === the data URL, plus a print link to
  // `/settings/review-qr/print/${businessId}`.
  // Ineligible card: the explanatory copy, NO download anchor, NO print
  // link, NO <img>.
});
```

`__tests__/PrintButton.test.tsx`:

```ts
it('PrintButton invokes window.print once', () => {
  // vi.spyOn(window, 'print').mockImplementation(() => {});
  // render + click → expect(window.print).toHaveBeenCalledTimes(1).
});
```

Extend `src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx`
(it already asserts rendered settings links — follow its existing assertion
shape) with, VERBATIM:

```ts
it('renders a Review QR entry in the settings navigation', () => {
  // Assert a link labeled 'Review QR' with href '/settings/review-qr'
  // renders, using the file's existing render + query helpers.
});
```

These three titles are in the intake's `tests_to_add` — the gate's
`promised-tests` row checks them byte-for-byte. Author them as FAILING tests
in Task 1 order? No — they depend on components this task creates; author
them in THIS task, test-first within the task (write test, see it fail,
implement, see it pass).

- [ ] **Step 5: Build + verify**

Run: `pnpm typecheck && pnpm vitest run "src/app/(authenticated)/settings/review-qr" src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx && pnpm build`
Expected: PASS. (SURFACE includes ui, so the gate runs `pnpm build` anyway —
this catches it early.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(authenticated)/settings/review-qr" src/components/dashboard/settings/SettingsSidebar.tsx src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx
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
staging ride, per the user-global CLAUDE.md § Design work rule.

### Step-8 staging smoke (RISK=high lane; specified here per codex R2 M15)

Against the staging URL, with a staging location's business UUID `<id>`:

0. Publish and VERIFY an ENFORCING GET/HEAD rate-limit rule covering `/q/*`
   per `docs/runbooks/vercel-waf-rate-limiting.md` — BEFORE any printed QR
   is exposed; verify on staging with a curl burst (expect 429s past the
   threshold). The route writes a durable analytics row per scan; /q/* is
   outside the runbook's current enforcing coverage (adversarial R1 A2,
   accepted as an ops gate).
1. `curl -sI https://<staging>/q/<id>` → `302`, `location:` is the Google
   write-review URL, `cache-control: no-store`.
2. `curl -sI -X HEAD https://<staging>/q/<ID-UPPERCASED>` → same `302`
   headers, empty body — this is the framework-level HEAD + uppercase-UUID
   proof unit tests cannot give.
3. `curl -sI https://<staging>/q/00000000-0000-7000-8000-000000000000` →
   `200` (unavailable page), `cache-control: no-store`.
4. Staging Supabase: `SELECT count(*) FROM analytics_events WHERE event_name
   = 'qr_scan_redirected' AND business_id = '<id>'` increased by the number
   of 302s served (HEAD included).
5. Scan the downloaded PNG with a phone camera → lands on the Google
   write-review page for that location.
6. Screenshots of `/settings/review-qr` + print view at 390px and 1440px →
   `docs/reviews/feat-qr-review-request/` (before the merge-approval pause).

## Review appendix

### Codex round 1 (VERDICT: REVISE; the codex session id is recorded in
`docs/superpowers/plans/feat-qr-review-request-handoff.md`)

Full log: `.feature/logs/codex-plan-r1.log` + `-r1b.log`. Disposition:

ACCEPTED (all folded into the tasks above): F1 pending_payment settings
redirect (edge case corrected); F2 `docs/analytics/events.md` row; F3
registry-test updates + 106→115 drift-guard handover; F4 ids duplicated into
event properties; F5+F6 live integration suite (authoritative column +
tenant exclusion); F7 distinct-keys test; F8 client-enqueueable guard; F9
trialing/past_due + null-place-id tests; F10 identical no-store page +
reason-coded log + reportCaughtError assertions; F12 qrcode passthrough-mock
encode test; F15 reuse `getLocationsForAccount`; F16 allowlist entry made an
owner-approved surface amendment; F17 new-migration skill noted.

REJECTED (with reasoning): M15 framework-level HEAD test — Next.js derives
HEAD from GET; covered by the staging smoke, not unit-testable without a
server harness. M17–M19 UI component tests — no house precedent for
page-component tests; build + staging screenshots cover. M20 nav-visibility
test — the sidebar renders entries unconditionally; a constant cannot
regress. `feature-surface` RED — fails BY DESIGN until the surface's files
exist (#867). "Missing skills" citation — `subagent-driven-development` /
`executing-plans` are harness skills, present in this session's registry.

### Codex round 2 (verification-only; VERDICT: REVISE; log `.feature/logs/codex-plan-r2.log`)

Confirmed fix-introduced defects, all folded in: the qrcode passthrough mock
failed typecheck (codex ran tsc) → replaced with a no-mock deterministic
data-URL comparison; the refusal matrix omitted `bad_id` and null-place →
both legs added; stale "ten/8" counts fixed.

R1 rejections REVERSED on codex's evidence (my verification confirmed all
three): M17–M19 — settings client-component tests ARE house standard
(`ChannelsClient.test.tsx`, `ProfileClient.test.tsx`) → `ReviewQrClient` +
`PrintButton` tests added to Task 6; M20 — `SettingsSidebar.test.tsx` exists
→ extended with the Review QR entry; both under amendment #3 (repo.ts header
+ sidebar test file, auto-approved category, deviations log). R2 #15
(repo.ts ownership): resolved as a DOCUMENTED EXCEPTION — the tenant-scope
allowlist is file-granular, and moving the unscoped pre-auth read into
repo.ts would exempt its five scoped readers from the audit; exception
recorded in repo.ts's header. R2 #9 → predicate-call passthrough-mock test
added. R2 #3/M15 → live ADMIT assertion added to the 115 suite; staging
smoke now specified as a numbered checklist under Verification.

REJECTIONS STANDING after R2: framework HEAD/uppercase behavior stays a
staging-smoke item (now step 2 of the checklist, not an unit test); the
roadmap authority stays a prose reference (deliberately-uncommitted parent
checkout work, not this branch's to absorb); the harness-skill citation
(skills live in the session registry, not on-disk — codex cannot see them).

### Codex round 3 (final verification; VERDICT: REVISE on 3 of 8; log `.feature/logs/codex-plan-r3.log`)

VERIFIED: refusal matrix (#2), 115 live ADMIT (#4), staging smoke (#5),
Task 6 component tests + verbatim titles (#6), amendment #3 in both intake
copies, byte-identical (#8).

STILL-OPEN at verdict time, ALL ACCEPTED and fixed in this revision — each
proven by codex running real tooling: (#1) `const [location]` fails
`noUncheckedIndexedAccess` → optional chaining; (#3) the module test's
vitest import lacked `vi` → added; (#7) my R2 claim that the tenant-scope
allowlist is file-granular was WRONG (it keys on file + table + normalized
SQL) → the resolver read moves into repo.ts as `getQrRedirectRow`, honoring
its every-location-query-lives-here header, with a statement-granular
allowlist entry.

Round cap reached (3). Per the /feature protocol the loop ends here: the
three accepted fixes are applied above, and the OWNER's sign-off substitutes
for a codex APPROVED verdict.
