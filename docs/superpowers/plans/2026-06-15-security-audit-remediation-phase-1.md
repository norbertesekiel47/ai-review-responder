# Security-Audit Remediation — Phase 1 Implementation Plan (Mechanical Hardening)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the seven preview-lane, no/low-behavior-change findings from the 2026-06-15 audit (F-2, F-3, F-6, F-22, F-24, F-25, F-26) as one reviewable PR.

**Architecture:** Each finding is an independent, self-contained change. Two touch DB-write code paths (F-2 voice route, F-6 settings route) and migrate the affected Vitest suites onto the codebase's fragment-aware `sql` mock. One (F-24) extracts a small testable validation module. One (F-26) makes proxy path-protection case-insensitive via a single authoritative `normalizePath`.

**Tech Stack:** Next.js 16 App Router (route handlers), Postgres.js v3 (dynamic-identifier/column helpers), Zod 4, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-1-design.md`

**Branch:** `security/audit-remediation-phase-1` (already created; spec + audit-cleanup already committed).

---

## File Structure

**Created:**
- `src/app/api/approve/[token]/edit/validation.ts` — pure edit-body validator (Zod schema + `validateApproveEdit`). One responsibility: turn an unknown body into `{ ok, editedText }` or `{ ok, error }`. Testable without invoking the route.
- `src/app/api/approve/[token]/edit/__tests__/validation.test.ts` — unit tests for the validator.

**Modified:**
- `package.json` — add `pnpm.overrides.esbuild` (F-3).
- `.gitignore` — broaden env-file ignore (F-22).
- `src/app/api/settings/voice/route.ts:159-192` — replace `sql.unsafe` string-build with the `sql(updates)` dynamic-column helper (F-2).
- `src/app/api/settings/voice/__tests__/route.test.ts` — migrate the DB mock from `mockSql`/`mockSqlUnsafe` to the fragment-aware `mockSqlQuery`; add field→column coverage (F-2).
- `src/app/api/settings/route.ts:59-82,134-146` — add `accountScope` to `runScopedUpdate`; pass it on the businesses call (F-6).
- `src/app/api/settings/__tests__/route.test.ts` — add an account_id-scoping assertion (F-6).
- `src/components/places/PlaceAutocomplete.tsx:124` — `innerHTML = ''` → `replaceChildren()` (F-25).
- `src/app/api/approve/[token]/edit/route.ts` — use `validateApproveEdit`; drop inline checks (F-24).
- `src/lib/shared/protected-routes.ts:26-41` — `normalizePath` lowercases + is exported (F-26).
- `src/lib/shared/__tests__/protected-routes.test.ts` — case-insensitivity cases + `normalizePath` direct tests (F-26).
- `src/proxy.ts:20-37,112-255` — derive `routePath = normalizePath(pathname)` and use it for all protection/branch decisions (F-26).

---

## Task 1: F-3 — Pin esbuild ≥ 0.28.1 (config-only)

> **DEFERRED to 2026-06-18 — NOT in this PR.** Two corrections discovered at
> implementation time: (1) overrides live in `pnpm-workspace.yaml` (next to the
> existing `postcss: 8.5.15`), **not** `package.json`; (2) `pnpm-workspace.yaml`
> enforces `minimumReleaseAge: 10080` (7-day supply-chain gate). esbuild `0.28.1`
> (the first fixed version) was published ~2026-06-11, so it cannot resolve until
> **2026-06-18** without adding a `minimumReleaseAgeExclude` for esbuild — i.e.
> weakening a security control. We chose NOT to weaken the gate; F-3 lands as a
> standalone follow-up on/after 2026-06-18 using the corrected steps below.
> (Alternative, if you want it today: add `minimumReleaseAgeExclude: [esbuild,
> "@esbuild/*"]`, install, ship, then remove the exclude once 0.28.1 has aged
> past the threshold.)

**Files (corrected):**
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Add the pnpm override (on/after 2026-06-18)**

In `pnpm-workspace.yaml`, add `esbuild` to the existing `overrides:` block:

```yaml
overrides:
  postcss: 8.5.15
  esbuild: ">=0.28.1"
```

- [ ] **Step 2: Re-lock**

Run: `pnpm install`
Expected: completes; `pnpm-lock.yaml` updated. Confirm the bump:
Run: `grep -oE 'esbuild@[0-9]+\.[0-9]+\.[0-9]+' pnpm-lock.yaml | sort -u`
Expected: a single line `esbuild@0.28.1` (or higher), **not** `0.28.0`.

- [ ] **Step 3: Verify the CVE is cleared**

Run: `pnpm audit --prod`
Expected: `No known vulnerabilities found` OR at minimum **0 high** (the prior `GHSA-gv7w-rqvm-qjhr` high is gone). The Windows-only low (`N/A` on darwin/Linux) may remain — that is acceptable.

- [ ] **Step 4: Verify the build still works**

Run: `pnpm build`
Expected: build completes successfully (confirms the Sentry → webpack → terser-webpack-plugin → esbuild chain tolerates the bump).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "fix(deps): pin esbuild >=0.28.1 to clear GHSA-gv7w-rqvm-qjhr (F-3)"
```

---

## Task 2: F-22 — Broaden `.gitignore` env coverage (config-only)

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Replace the env-ignore line**

In `.gitignore`, find the `# local env files` block:

```
# local env files
.env*.local
```

Replace the `.env*.local` line so the block reads:

```
# local env files
.env*
!.env.example
```

- [ ] **Step 2: Verify the right files are ignored / kept**

Run: `git check-ignore -v .env.production .env.staging .env.local .env.staging.local; echo "---"; git check-ignore .env.example || echo ".env.example NOT ignored (correct)"`
Expected: `.env.production`, `.env.staging`, `.env.local`, `.env.staging.local` all print as ignored (matched by `.env*`); the final line prints `.env.example NOT ignored (correct)`.

- [ ] **Step 3: Verify the tracked example file is unaffected**

Run: `git status --short .env.example`
Expected: no output (still tracked, unchanged — gitignore never untracks an already-tracked file).

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): ignore all .env* except .env.example (F-22)"
```

---

## Task 3: F-25 — PlaceAutocomplete `replaceChildren()` (trivial refactor)

**Files:**
- Modify: `src/components/places/PlaceAutocomplete.tsx:124`

- [ ] **Step 1: Swap the clear call**

Replace line 124:

```ts
        containerRef.current.innerHTML = '';
```

with:

```ts
        containerRef.current.replaceChildren();
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both pass (no type or lint errors).

- [ ] **Step 3: Run any existing PlaceAutocomplete tests**

Run: `pnpm test -- PlaceAutocomplete`
Expected: PASS, or `No test files found` (the component has no dedicated test — behavior is identical, so no new test is warranted: `replaceChildren()` with no args is the exact, parser-free equivalent of `innerHTML = ''`).

- [ ] **Step 4: Commit**

```bash
git add src/components/places/PlaceAutocomplete.tsx
git commit -m "refactor(places): clear via replaceChildren() instead of innerHTML (F-25)"
```

---

## Task 4: F-2 — Voice route: remove `sql.unsafe`, use the dynamic-column helper

This task is TDD: rewrite the test suite to express the new (fragment-aware) DB behavior first — it goes red because the route still calls `sql.unsafe` (now undefined on the mock) — then change the route to green.

**Files:**
- Test: `src/app/api/settings/voice/__tests__/route.test.ts` (full rewrite)
- Modify: `src/app/api/settings/voice/route.ts:159-192`

- [ ] **Step 1: Rewrite the test file to the fragment-aware `sql` mock**

Replace the **entire** contents of `src/app/api/settings/voice/__tests__/route.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────
//
// The route builds its UPDATE with the Postgres.js dynamic-column helper:
//   sql`UPDATE businesses SET ${sql(updates)}, updated_at = NOW() WHERE ...`
// The mock sql mirrors the real dispatch: a tagged-template call routes to
// mockSqlQuery(strings, ...values); a helper call (the column-value object
// from sql(updates)) returns a { __helper } marker that shows up among the
// bound values — so tests assert bound values + the updates object instead of
// assembled SQL strings. (Same dialect as the settings route test.)

const {
  mockRequireRole,
  mockSqlQuery,
  mockGetLocationsForAccount,
  mockAssertWritableSubscriptionForAccount,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlQuery: vi.fn(),
  mockGetLocationsForAccount: vi.fn(),
  mockAssertWritableSubscriptionForAccount: vi.fn(),
}));

function isTemplate(arg: unknown): arg is TemplateStringsArray {
  return Array.isArray(arg) && Object.prototype.hasOwnProperty.call(arg, 'raw');
}

// ── Mock Auth ───────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

// ── Mock DB ─────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => {
  const sql = (...args: unknown[]) => {
    if (isTemplate(args[0])) {
      return mockSqlQuery(args[0], ...args.slice(1));
    }
    // sql(updates) dynamic-column helper → opaque marker
    return { __helper: args[0] };
  };
  return { sql };
});

// ── Mock locations repo ─────────────────────────────────────────────

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: (...args: unknown[]) => mockGetLocationsForAccount(...args),
  getActiveLocationCount: vi.fn().mockResolvedValue(2),
}));

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritableSubscriptionForAccount(...args),
}));

// Import AFTER mocks
import { GET, PUT } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID_1 = 'b1111111-0000-4000-8000-000000000001';
const LOCATION_ID_2 = 'b2222222-0000-4000-8000-000000000002';
const APP_URL = 'http://localhost:3000';

function ownerUser() {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID_1,
  };
}

function makeGetRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/settings/voice');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url.toString());
}

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/voice', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

// Returns the UPDATE template call (and its bound args), or undefined.
function updateCall(): unknown[] | undefined {
  return mockSqlQuery.mock.calls.find(
    (c) => isTemplate(c[0]) && (c[0] as unknown as string[]).join(' ').includes('UPDATE businesses'),
  ) as unknown[] | undefined;
}

function updatesMarkerOf(call: unknown[] | undefined): Record<string, unknown> | undefined {
  const marker = call?.find(
    (a) => a !== null && typeof a === 'object' && '__helper' in (a as object),
  ) as { __helper: Record<string, unknown> } | undefined;
  return marker?.__helper;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/settings/voice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns voice config for a specific location', async () => {
    mockSqlQuery.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
      tone: 'professional',
      products_services: 'Coffee and pastries',
      avoid_facts: ['No discounts'],
      sample_responses: ['Thanks for the review!'],
    }]);

    const res = await GET(makeGetRequest({ locationId: LOCATION_ID_1 }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.locationId).toBe(LOCATION_ID_1);
    expect(body.tone).toBe('professional');
    expect(body.productsServices).toBe('Coffee and pastries');
    expect(body.avoidFacts).toEqual(['No discounts']);
    expect(body.sampleResponses).toEqual(['Thanks for the review!']);
    expect(body.displayName).toBe('Downtown Cafe');
  });

  it('returns voice config for all locations', async () => {
    mockGetLocationsForAccount.mockResolvedValue([
      { id: LOCATION_ID_1, name: 'Downtown Cafe', display_label: 'Downtown Cafe', is_primary: true, archived_at: null, google_place_id: null, created_at: new Date(), account_id: ACCOUNT_ID },
      { id: LOCATION_ID_2, name: 'Westside Bakery', display_label: 'Westside Bakery', is_primary: false, archived_at: null, google_place_id: null, created_at: new Date(), account_id: ACCOUNT_ID },
    ]);

    mockSqlQuery.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Downtown Cafe',
      display_label: 'Downtown Cafe',
      tone: 'professional',
      products_services: 'Coffee',
      avoid_facts: null,
      sample_responses: null,
      is_primary: true,
    }, {
      id: LOCATION_ID_2,
      name: 'Westside Bakery',
      display_label: 'Westside Bakery',
      tone: 'warm, friendly',
      products_services: 'Baked goods',
      avoid_facts: ['No delivery'],
      sample_responses: null,
      is_primary: false,
    }]);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.locations).toHaveLength(2);
    expect(body.locations[0].locationId).toBe(LOCATION_ID_1);
    expect(body.locations[0].isPrimary).toBe(true);
    expect(body.locations[1].locationId).toBe(LOCATION_ID_2);
  });

  it('returns 404 when location not found', async () => {
    mockSqlQuery.mockResolvedValueOnce([]);

    const res = await GET(makeGetRequest({ locationId: '99999999-0000-4000-8000-000000000001' }));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns defaults for null voice fields', async () => {
    mockSqlQuery.mockResolvedValueOnce([{
      id: LOCATION_ID_1,
      name: 'Test',
      display_label: null,
      tone: null,
      products_services: null,
      avoid_facts: null,
      sample_responses: null,
    }]);

    const res = await GET(makeGetRequest({ locationId: LOCATION_ID_1 }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tone).toBe('');
    expect(body.productsServices).toBe('');
    expect(body.avoidFacts).toEqual([]);
    expect(body.sampleResponses).toEqual([]);
    expect(body.displayName).toBe('Test');
  });
});

describe('PUT /api/settings/voice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser());
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('updates tone for a specific location', async () => {
    mockSqlQuery
      .mockResolvedValueOnce([{ id: LOCATION_ID_1 }]) // location-validation SELECT
      .mockResolvedValueOnce({ count: 1 });           // UPDATE

    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      tone: 'warm, friendly',
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('returns 404 when location not found or not accessible', async () => {
    mockSqlQuery.mockResolvedValueOnce([]); // SELECT finds nothing

    const res = await PUT(makePutRequest({
      locationId: '99999999-0000-4000-8000-000000000001',
      tone: 'warm',
    }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when no voice fields provided', async () => {
    const res = await PUT(makePutRequest({ locationId: LOCATION_ID_1 }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when user has no account', async () => {
    mockRequireRole.mockResolvedValue({ ...ownerUser(), accountId: null });

    const res = await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'warm' }));
    expect(res.status).toBe(403);
  });

  it('returns 402 without updating when the account is past-due read-only', async () => {
    mockAssertWritableSubscriptionForAccount.mockResolvedValueOnce({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const res = await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'warm' }));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockAssertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(mockSqlQuery).not.toHaveBeenCalled();
  });

  it('validates avoidFacts max length (500 chars)', async () => {
    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      avoidFacts: ['a'.repeat(501)],
    }));
    expect(res.status).toBe(400);
  });

  it('validates sampleResponses max count (10)', async () => {
    const res = await PUT(makePutRequest({
      locationId: LOCATION_ID_1,
      sampleResponses: Array(11).fill('test'),
    }));
    expect(res.status).toBe(400);
  });

  it('scopes the UPDATE by account_id (no sql.unsafe / no string interpolation)', async () => {
    mockSqlQuery
      .mockResolvedValueOnce([{ id: LOCATION_ID_1 }])
      .mockResolvedValueOnce({ count: 1 });

    await PUT(makePutRequest({ locationId: LOCATION_ID_1, tone: 'professional' }));

    const call = updateCall();
    expect(call).toBeDefined();
    const strings = call![0] as unknown as string[];
    expect(strings.join(' ')).toContain('account_id');
    // accountId is a bound value, not interpolated text
    expect(call).toContain(ACCOUNT_ID);
  });

  it.each([
    ['tone', 'tone', 'casual'],
    ['productsServices', 'products_services', 'Coffee'],
    ['avoidFacts', 'avoid_facts', ['no refunds']],
    ['sampleResponses', 'sample_responses', ['Thanks!']],
  ] as const)('maps schema field %s → column %s', async (field, column, value) => {
    mockSqlQuery
      .mockResolvedValueOnce([{ id: LOCATION_ID_1 }])
      .mockResolvedValueOnce({ count: 1 });

    await PUT(makePutRequest({ locationId: LOCATION_ID_1, [field]: value }));

    expect(updatesMarkerOf(updateCall())).toEqual({ [column]: value });
  });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `pnpm test -- src/app/api/settings/voice`
Expected: FAIL. The route still calls `sql.unsafe`, which no longer exists on the mock (the new mock provides only the callable `sql`), so PUT success/scope/map tests throw (e.g. `sql.unsafe is not a function`).

- [ ] **Step 3: Rewrite the route's UPDATE**

In `src/app/api/settings/voice/route.ts`, replace the block from line 165 (`// Build dynamic UPDATE query`) through the end of the PUT `catch` (line 192) with:

```ts
  // Map validated fields → columns and let Postgres.js parameterize both the
  // identifiers and values via the dynamic-column helper. No string
  // interpolation — mirrors runScopedUpdate in ../route.ts.
  const updates: Record<string, string | string[] | null> = {};
  for (const field of fields) {
    updates[VOICE_FIELD_TO_COLUMN[field]] =
      (voiceFields[field] ?? null) as string | string[] | null;
  }

  try {
    const result = await sql`
      UPDATE businesses
      SET ${sql(updates)}, updated_at = NOW()
      WHERE id = ${locationId}::uuid
        AND account_id = ${user.accountId}::uuid
        AND archived_at IS NULL
    `;

    if (result.count === 0) {
      return jsonResponse({ error: 'Location not found or not updated' }, 404);
    }

    return jsonResponse({ success: true });
  } catch (error) {
    reportCaughtError('api/settings/voice PUT', error, { locationId });
    return jsonResponse({ error: 'Failed to update voice config' }, 500);
  }
```

The lines being removed are the `setClauses`/`values`/`query` build and the `sql.unsafe(query, values)` call. Keep everything above line 165 (the `fields`/`fields.length === 0` guard) unchanged.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `pnpm test -- src/app/api/settings/voice`
Expected: PASS (all GET + PUT tests, including the account_id-scope and field→column map tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no `sql.unsafe` references remain; `updates` is correctly typed).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/settings/voice/route.ts src/app/api/settings/voice/__tests__/route.test.ts
git commit -m "fix(settings/voice): replace sql.unsafe with sql(updates) dynamic helper (F-2)"
```

---

## Task 5: F-6 — Settings `businesses` UPDATE: redundant account_id scope

TDD: add the failing assertion first, then add the scope.

**Files:**
- Test: `src/app/api/settings/__tests__/route.test.ts` (add one test)
- Modify: `src/app/api/settings/route.ts:59-82` (helper signature + query) and `:134-146` (businesses call)

- [ ] **Step 1: Add the failing test**

In `src/app/api/settings/__tests__/route.test.ts`, add this test inside the `describe('PUT /api/settings', ...)` block (e.g. right after the existing `'returns 200 for updating tone ...'` test):

```ts
  it('scopes the businesses UPDATE by account_id (defense-in-depth)', async () => {
    mockRequireRole.mockResolvedValue(ownerUser());

    const res = await PUT(makeRequest({ tone: 'professional' }));
    expect(res.status).toBe(200);

    const call = txQueryCall(0);
    expect(tableOf(call)).toBe('businesses');
    expect(queryText(call)).toContain('account_id');
    // accountId is bound as a value alongside the locationId
    expect(call).toContain(ACCOUNT_ID);
    expect(idOf(call)).toBe(BUSINESS_ID);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/app/api/settings/__tests__/route.test.ts`
Expected: the new test FAILS — `queryText(call)` does not contain `account_id` and `call` does not contain `ACCOUNT_ID` (the businesses UPDATE is currently scoped by `id` only). All other settings tests still pass.

- [ ] **Step 3: Add `accountScope` to `runScopedUpdate`**

In `src/app/api/settings/route.ts`, replace the `runScopedUpdate` function (lines 59-82) with:

```ts
async function runScopedUpdate<Field extends string>(
  tx: postgres.TransactionSql,
  options: {
    table: 'businesses' | 'accounts';
    idValue: string;
    accountScope?: string;
    fieldMap: Record<Field, string>;
    fields: Field[];
    data: Partial<Record<Field, unknown>>;
  },
): Promise<number> {
  const { table, idValue, accountScope, fieldMap, fields, data } = options;

  const updates: Record<string, ColumnValue> = {};
  for (const field of fields) {
    updates[fieldMap[field]] = (data[field] ?? null) as ColumnValue;
  }

  // Defense-in-depth: businesses rows are account-scoped, so constrain by
  // account_id too. accounts rows are keyed by their own PK (idValue IS the
  // account id), so they need no extra scope. Branch the whole statement
  // rather than splicing a conditional fragment — a nested tagged template
  // would be a second query call.
  const result = accountScope
    ? await tx`
        UPDATE ${tx(table)}
        SET ${tx(updates)}, updated_at = NOW()
        WHERE id = ${idValue} AND account_id = ${accountScope}
      `
    : await tx`
        UPDATE ${tx(table)}
        SET ${tx(updates)}, updated_at = NOW()
        WHERE id = ${idValue}
      `;
  return result.count;
}
```

- [ ] **Step 4: Pass `accountScope` on the businesses call**

In the same file, in `putSettings`, update the businesses `runScopedUpdate` call (currently lines 135-141) to add `accountScope: accountId`:

```ts
        const matched = await runScopedUpdate(tx, {
          table: 'businesses',
          idValue: locationId,
          accountScope: accountId,
          fieldMap: BUSINESS_FIELD_TO_COLUMN,
          fields: businessFields,
          data,
        });
```

Leave the `accounts` call (lines ~149-157) unchanged — it must NOT get `accountScope`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- src/app/api/settings/__tests__/route.test.ts`
Expected: PASS — the new account_id test passes, and all pre-existing tests stay green (the businesses-call assertions read `call[1..3]`, which are unchanged; the new `accountScope` is bound at `call[4]`).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/settings/route.ts src/app/api/settings/__tests__/route.test.ts
git commit -m "fix(settings): scope businesses UPDATE by account_id (F-6)"
```

---

## Task 6: F-24 — Approve-edit route: extract a Zod validator

TDD: write the validator's tests first, then the validator, then wire the route.

**Files:**
- Create: `src/app/api/approve/[token]/edit/validation.ts`
- Test: `src/app/api/approve/[token]/edit/__tests__/validation.test.ts`
- Modify: `src/app/api/approve/[token]/edit/route.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/approve/[token]/edit/__tests__/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateApproveEdit, MAX_EDIT_LENGTH } from '../validation';

describe('validateApproveEdit', () => {
  it('accepts a clean string and returns it sanitized', () => {
    const result = validateApproveEdit({ editedText: 'Thanks for visiting!' });
    expect(result).toEqual({ ok: true, editedText: 'Thanks for visiting!' });
  });

  it('rejects a missing editedText with the legacy message', () => {
    expect(validateApproveEdit({})).toEqual({ ok: false, error: 'editedText is required' });
  });

  it('rejects a non-string editedText with the legacy message', () => {
    expect(validateApproveEdit({ editedText: 123 })).toEqual({ ok: false, error: 'editedText is required' });
  });

  it('rejects an over-length editedText with the legacy message', () => {
    const result = validateApproveEdit({ editedText: 'a'.repeat(MAX_EDIT_LENGTH + 1) });
    expect(result).toEqual({ ok: false, error: `editedText exceeds ${MAX_EDIT_LENGTH} characters` });
  });

  it('rejects text that sanitizes to empty (only zero-width/bidi chars)', () => {
    // U+200B zero-width space + U+202E right-to-left override → stripped → empty
    const result = validateApproveEdit({ editedText: '​‮' });
    expect(result).toEqual({ ok: false, error: 'editedText is required' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/app/api/approve/[token]/edit`
Expected: FAIL — `../validation` does not exist (module-not-found / import error).

- [ ] **Step 3: Write the validator**

Create `src/app/api/approve/[token]/edit/validation.ts`:

```ts
import { z } from 'zod';
import { sanitizePublicResponseText } from '@/lib/shared/sanitize';

export const MAX_EDIT_LENGTH = 2000;

const editSchema = z.object({
  editedText: z
    .string('editedText is required')
    .max(MAX_EDIT_LENGTH, `editedText exceeds ${MAX_EDIT_LENGTH} characters`)
    .transform((value) => sanitizePublicResponseText(value))
    .refine((value) => value.length > 0, 'editedText is required'),
});

export type ApproveEditResult =
  | { ok: true; editedText: string }
  | { ok: false; error: string };

export function validateApproveEdit(body: unknown): ApproveEditResult {
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'editedText is required' };
  }
  return { ok: true, editedText: parsed.data.editedText };
}
```

> Note: `z.string('msg')`, `.max(n, 'msg')`, and `.refine(fn, 'msg')` are the Zod 4 positional-message forms (the codebase already uses `.max(20, 'Maximum 20 avoid facts')`). If Step 4 shows the missing/non-string case returns Zod's default message instead of `'editedText is required'`, switch `z.string('editedText is required')` to `z.string({ error: 'editedText is required' })` and re-run.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/app/api/approve/[token]/edit`
Expected: PASS (all 5 validator tests).

- [ ] **Step 5: Wire the route to the validator**

Replace the **entire** contents of `src/app/api/approve/[token]/edit/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { runTokenApprovalAction } from '@/lib/approval/http-routes';
import { edit } from '@/lib/approval/service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { validateApproveEdit } from './validation';

type TokenRouteContext = {
  params: Promise<{ token: string }>;
};

export async function POST(
  request: NextRequest,
  { params }: TokenRouteContext,
): Promise<NextResponse> {
  const { token } = await params;

  return runTokenApprovalAction<string>(
    request,
    token,
    'edit',
    { success: true, message: "Response approved with your edits! We'll post it to Google shortly." },
    ({ tx, link, deviceCookieHash, audit, correlationId, prepared }) => (
      edit(tx, link, prepared, deviceCookieHash, audit, correlationId)
    ),
    {
      prepare: async () => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: NO_STORE_HEADERS });
        }

        const result = validateApproveEdit(body);
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400, headers: NO_STORE_HEADERS });
        }

        return result.editedText;
      },
    },
  );
}
```

- [ ] **Step 6: Verify route typecheck + existing approve tests**

Run: `pnpm typecheck && pnpm test -- src/app/api/approve`
Expected: PASS — typecheck clean; the existing approve tests (`correlation.test.ts`) and the new `validation.test.ts` all pass. The 400 response shape/messages are byte-identical to before, so no client contract changes.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/approve/[token]/edit/route.ts" "src/app/api/approve/[token]/edit/validation.ts" "src/app/api/approve/[token]/edit/__tests__/validation.test.ts"
git commit -m "refactor(approve): extract Zod edit-body validator, preserve 400 messages (F-24)"
```

---

## Task 7: F-26 — Proxy path case-normalization (single authoritative normalizer)

TDD: add case-insensitivity tests against `protected-routes`, watch them fail, then lowercase `normalizePath`, export it, and route `proxy.ts` decisions through it.

**Files:**
- Test: `src/lib/shared/__tests__/protected-routes.test.ts` (add cases)
- Modify: `src/lib/shared/protected-routes.ts:26-41`
- Modify: `src/proxy.ts`

- [ ] **Step 1: Add the failing tests**

In `src/lib/shared/__tests__/protected-routes.test.ts`, add `normalizePath` to the import (line 2-6):

```ts
import {
  isProtectedMixedRoleApiRoute,
  isProtectedOwnerApiRoute,
  isProtectedRoute,
  normalizePath,
} from '../protected-routes';
```

Then add this `describe` block at the end of the file (after the `'protected API route roles'` block):

```ts
describe('case-insensitive path normalization (F-26)', () => {
  it('normalizePath lowercases and strips trailing slashes', () => {
    expect(normalizePath('/ADMIN/')).toBe('/admin');
    expect(normalizePath('/API/Dashboard')).toBe('/api/dashboard');
    expect(normalizePath('/')).toBe('/');
  });

  it('protects uppercase variants of protected prefixes', () => {
    expect(isProtectedRoute('/ADMIN/secret')).toBe(true);
    expect(isProtectedRoute('/API/ADMIN/businesses')).toBe(true);
    expect(isProtectedRoute('/Dashboard')).toBe(true);
    expect(isProtectedOwnerApiRoute('/API/Dashboard')).toBe(true);
  });

  it('still exempts the public auth surfaces case-insensitively', () => {
    expect(isProtectedRoute('/ADMIN/LOGIN')).toBe(false);
    expect(isProtectedRoute('/Admin/Forgot-Password')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/lib/shared/__tests__/protected-routes.test.ts`
Expected: FAIL — `normalizePath` is not exported (import error) and the uppercase cases would return the wrong booleans.

- [ ] **Step 3: Lowercase and export `normalizePath`**

In `src/lib/shared/protected-routes.ts`, replace the `normalizePath` function (lines 26-41) with:

```ts
export function normalizePath(pathname: string): string {
  // Normalize case AND trailing slash before any comparison.
  //
  // Case: App Router routes are case-sensitive (so /ADMIN/x would 404), but
  // the proxy's protection check must not be bypassable by casing — lowercase
  // here so /ADMIN, /Api/Admin, etc. still match the protected prefixes.
  //
  // Trailing slash: Next.js's default `trailingSlash: false` redirects
  // `/x/` → `/x`, but that redirect runs AFTER proxy sees the path. Without
  // normalization here, `/admin/login/` would fail the exact-match exemption
  // AND match the protected `startsWith('/admin/')` branch, locking
  // legitimate users out of the public login surface.
  //
  // Preserve `/` (the root) — it's both the public landing page and the only
  // path where the trailing slash IS the path.
  const lowered = pathname.toLowerCase();
  return lowered.length > 1 && lowered.endsWith('/')
    ? lowered.replace(/\/+$/, '')
    : lowered;
}
```

(Only two changes vs. the original: the function is now `export`ed, and it lowercases via the `lowered` local before the trailing-slash logic.)

- [ ] **Step 4: Run to verify the protected-routes tests pass**

Run: `pnpm test -- src/lib/shared/__tests__/protected-routes.test.ts`
Expected: PASS — the new case-insensitive cases pass, and every pre-existing PUBLIC/PROTECTED/trailing-slash case still passes (all those literals are already lowercase, so lowercasing is a no-op for them).

- [ ] **Step 5: Route `proxy.ts` decisions through `normalizePath`**

In `src/proxy.ts`:

(a) Add `normalizePath` to the import from `@/lib/shared/protected-routes` (currently lines 3-7):

```ts
import {
  isProtectedMixedRoleApiRoute,
  isProtectedOwnerApiRoute,
  isProtectedRoute,
  normalizePath,
} from '@/lib/shared/protected-routes';
```

(b) Immediately after `const { pathname } = request.nextUrl;` (line 22), add:

```ts
  // Case/slash-normalized copy used ONLY for protection + branch decisions.
  // The raw `pathname` is still forwarded downstream (REQUEST_PATHNAME_HEADER)
  // and used for redirect `next=`/`from=` params, preserving original casing.
  const routePath = normalizePath(pathname);
```

(c) Replace each protection/branch decision that reads `pathname` with `routePath`. Specifically:

- Line 37: `if (!isProtectedRoute(routePath)) {`
- The admin pages branch (lines 113-118):

```ts
  if (
    routePath.startsWith('/admin') &&
    routePath !== '/admin/login' &&
    routePath !== '/admin/forgot-password' &&
    routePath !== '/admin/reset-password'
  ) {
```

- Line 133: `if (routePath.startsWith('/api/admin')) {`
- Line 148: `if (isProtectedMixedRoleApiRoute(routePath)) {`
- Line 170: `if (isProtectedOwnerApiRoute(routePath)) {`
- The owner pages branch (lines 188-192):

```ts
  if (
    routePath.startsWith('/dashboard') ||
    routePath.startsWith('/settings') ||
    routePath.startsWith('/account')
  ) {
```

- Line 209: `if (routePath === '/mfa' || routePath.startsWith('/mfa/')) {`
- The onboarding branch (line 234): `if (routePath === '/onboarding' || routePath.startsWith('/onboarding/')) {`

Do **NOT** change:
- `createDownstreamRequest()` — it must keep setting `REQUEST_PATHNAME_HEADER` to the raw `pathname` (line 33).
- `redirectToMfaChallenge` / `redirectToLogin` — they already read `request.nextUrl.pathname`/`.search` directly (raw), which is correct for post-login `next=`.

- [ ] **Step 6: Typecheck + full proxy/shared suite**

Run: `pnpm typecheck && pnpm test -- src/lib/shared src/proxy`
Expected: PASS (typecheck clean; protected-routes tests green; any existing proxy tests green).

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/protected-routes.ts src/lib/shared/__tests__/protected-routes.test.ts src/proxy.ts
git commit -m "fix(proxy): case-insensitive route protection via single normalizePath (F-26)"
```

---

## Task 8: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Lint + typecheck + full test suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS.

- [ ] **Step 2: DB-write audits (F-2, F-6 touched tenant-scoped writes)**

Run: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
Expected: both PASS.

- [ ] **Step 3: Static-policy audit (no new NEXT_PUBLIC_*, no crypto-js, no client auto_approval_policies access)**

Run: `pnpm ci:static-policy`
Expected: PASS.

- [ ] **Step 4: Dependency + build re-confirm**

Run: `pnpm audit --prod; pnpm build`
Expected: build succeeds. NOTE: `pnpm audit --prod` will still report the
single esbuild high (`GHSA-gv7w-rqvm-qjhr`) because **F-3 is deferred to
2026-06-18** (age-gate, see Task 1) — that one known high is expected and is
NOT a blocker for this PR. No other highs should appear.

- [ ] **Step 5: Confirm the working tree is clean and the branch is ready**

Run: `git status --short && git log --oneline origin/main..HEAD`
Expected: clean tree; the log shows the spec/cleanup commits plus the 7 Phase-1 commits (F-3, F-22, F-25, F-2, F-6, F-24, F-26).

- [ ] **Step 6: Open the PR**

Hand off to `superpowers:finishing-a-development-branch` (or open directly):

```bash
git push -u origin security/audit-remediation-phase-1
gh pr create --base main --title "Security audit Phase 1: mechanical hardening (F-2/3/6/22/24/25/26)" --body "Implements Phase 1 of docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-1-design.md. Preview-lane, no/low behavior change. See the spec for the full 7-phase roadmap."
```

Expected: 4 CI checks (lint, typecheck, test, build) go green before merge.

---

## Self-Review

**Spec coverage:** F-2 (Task 4) ✓, F-3 (Task 1) ✓, F-6 (Task 5) ✓, F-22 (Task 2) ✓, F-24 (Task 6) ✓, F-25 (Task 3) ✓, F-26 (Task 7) ✓. Spec's "verification plan" → Task 8 ✓. Spec's map-sync regression test (F-2) → realized as behavioral field→column coverage (Task 4 Step 1), since `route.ts` has no precedent for exporting internals.

**Placeholder scan:** No TBD/TODO; every code/test step shows complete code; every command has expected output. The one contingency note (Zod message form, Task 6 Step 3) gives the exact fallback, not a placeholder.

**Type consistency:** `validateApproveEdit`/`MAX_EDIT_LENGTH`/`ApproveEditResult` names match between `validation.ts` and its test. `normalizePath` signature matches between `protected-routes.ts`, its test, and `proxy.ts`. `runScopedUpdate`'s new `accountScope?: string` option is consistent between definition and the businesses call. Voice test's `mockSqlQuery`/`isTemplate`/`updateCall`/`updatesMarkerOf` helpers are all defined before use.
