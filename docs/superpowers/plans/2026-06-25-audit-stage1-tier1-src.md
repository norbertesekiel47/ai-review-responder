# Stage 1 (src-side) — Tier-1 Audit Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a pure `resolveCallbackDestination` redirect resolver from the auth-callback route, single-source `src/`-side response-status READ/DISPLAY group literals onto the canonical `response-status.ts` groups via a DB-adjacent SQL helper, and add a `src/`-scoped TypeScript-AST CI audit that flags multi-value response-status group literals.

**Architecture:** Three independent, behavior-preserving deliverables in one branch (`refactor/audit-stage1-tier1`), all UI-only / `src/`-only, zero worker files. (1) The redirect decision logic moves out of the Next.js route handler into a pure, unit-testable function in `src/lib/shared/auth-flow.ts` that owns ALL redirect-safety logic (the single source of truth for `next` sanitization + role allowlists). The route keeps only Supabase I/O and dispatches on a discriminated-union result. (2) READ/COUNT/DISPLAY SQL predicates that hardcode a status group are switched to `status = ANY(${statusArraySql(GROUP)})`, where `statusArraySql` lives in a new DB-adjacent module `src/lib/shared/response-status-sql.ts` (so `response-status.ts` stays a zero-import pure const module). (3) A new `scripts/ci/response-status-audit.ts` mirrors `static-policy-audit.ts` structure, walks `src/**` TS files via the TypeScript compiler API, and flags array/IN-list literals containing 2+ canonical status values, honoring `// status-audit-ignore` per-line pragmas.

**Tech Stack:** TypeScript (strict), Next.js 16 route handlers, Postgres.js v3 (`sql` template tags, `${arr as string[]}::text[]` array binding convention), Vitest (unit + `TEST_DATABASE_POOL_URL`-gated integration), `tsx`-run CI audit scripts, TypeScript compiler API (`typescript` package, already a devDependency).

---

## Scope (locked — do NOT exceed)

In scope (src-side + UI-only, straight to main, zero worker files):
1. Auth-callback resolver extraction (UI-only).
2. Response-status migration of `src/` **counting/display/READ** group callsites only.
3. AST audit scoped to `src/`.

Explicitly OUT of scope — do NOT touch: any `worker/**` file; any state-transition UPDATE/INSERT status site even within `src/` (leave inline); single-status equality comparisons (`status === 'approved'`); config/flags/publisher-seam/LLM (other stages).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/shared/auth-flow.ts` | Add pure `resolveCallbackDestination` (single source of truth for redirect safety). | Modify |
| `src/lib/shared/__tests__/auth-flow.test.ts` | Decision-table + hostile-`next` tests for the resolver. | Create |
| `src/app/api/auth/callback/route.ts` | Keep only Supabase I/O; dispatch on resolver result; collapse the 5× cookie-copy loop. | Modify |
| `src/lib/shared/response-status-sql.ts` | DB-adjacent `statusArraySql` fragment helper (imports `sql` + const groups). | Create |
| `src/lib/shared/__tests__/response-status-sql.test.ts` | Pure unit test of fragment shape + integration test gated on `TEST_DATABASE_POOL_URL`. | Create |
| `src/lib/dashboard/aggregate-service.ts` | Migrate `ANY(ARRAY['approved','posted','edited','awaiting_owner_connect']::text[])` → `ANY(${statusArraySql(HANDLED_STATUSES)})`. | Modify |
| `src/app/api/dashboard/past-replies/draft/route.ts` | Migrate `IN (...)` NON_TERMINAL list → `ANY(${statusArraySql(NON_TERMINAL_STATUSES)})`. | Modify |
| `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts` | Same NON_TERMINAL migration. | Modify |
| `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts` | Same NON_TERMINAL migration. | Modify |
| `src/app/api/dashboard/past-replies/draft-status/route.ts` | NO-MATCH 3-value subset → leave inline + `// status-audit-ignore` pragma. | Modify |
| `scripts/ci/response-status-audit.ts` | TypeScript-AST audit flagging `src/` multi-value status-group literals. | Create |
| `scripts/ci/__tests__/response-status-audit.test.ts` | Pure unit tests of the audit's `scanSource` predicate. | Create |
| `package.json` | Add `ci:response-status` script. | Modify |
| `.github/workflows/ci.yml` | Wire the audit into the `lint` job (same pattern as the others). | Modify |

---

## Callsite classification (locked from the audit)

### (A) READ/COUNT/DISPLAY group-literals → MIGRATE to `statusArraySql(GROUP)`

| File:line | Current literal | Group const | Context |
|---|---|---|---|
| `src/lib/dashboard/aggregate-service.ts:313` | `ANY(ARRAY['approved', 'posted', 'edited', 'awaiting_owner_connect']::text[])` | `HANDLED_STATUSES` | COUNT (response-rate metric) |
| `src/app/api/dashboard/past-replies/draft/route.ts:134` | `status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')` | `NON_TERMINAL_STATUSES` | SELECT (existing-draft read) |
| `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts:107` | `status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')` | `NON_TERMINAL_STATUSES` | SELECT (non-terminal sibling check) |
| `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts:124` | `status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')` | `NON_TERMINAL_STATUSES` | SELECT (non-terminal sibling check) |

These four produce byte-for-byte the same generated SQL: `status = ANY($1::text[])` with the same value array (order within `ANY` is irrelevant to the predicate). Behavior-preserving.

### (B) NO-EXACT-MATCH read subset → LEAVE INLINE + pragma

| File:line | Literal | Why inline |
|---|---|---|
| `src/app/api/dashboard/past-replies/draft-status/route.ts:111` | `status IN ('pending_approval', 'approved', 'edited')` | 3-value subset of `NON_TERMINAL_STATUSES` (missing `awaiting_owner_connect`). No existing group matches exactly; not a genuinely-reusable grouping (this poll deliberately excludes the parked `awaiting_owner_connect` state). Inventing a one-caller group would add a name without reducing reader burden. Annotate `// status-audit-ignore` + reason. |

### (C) STATE-TRANSITION WRITE group-literals → LEAVE INLINE + pragma (out of scope to migrate)

| File:line | Literal | Why inline |
|---|---|---|
| `src/lib/publishing/zernio-publisher.ts:209` | `WHERE id = ... AND status IN ('approved', 'edited', 'awaiting_owner_connect')` guarding `UPDATE ... SET status='awaiting_owner_connect'` | State-transition UPDATE guard — `response-status.ts` header reserves these as intentionally-inline narrow lists. |
| `src/lib/approval/http-routes.ts:168` | `r.status NOT IN ('superseded', 'failed')` in an approval-action guard | State-transition guard; also a subset, not a group. |
| `src/lib/reviews/process-review.ts:269` | `status NOT IN ('superseded', 'failed')` in a `SELECT ... FOR UPDATE` content-change transition | State-transition guard; subset, not a group. |

The audit MUST flag (A) sites until migrated, MUST flag (B) and (C) sites unless pragma'd. (B) and (C) get `// status-audit-ignore` pragmas so CI passes while the literal stays inline.

> Note on (C): the `NOT IN ('superseded','failed')` sites are 2-value literals of canonical statuses, so the AST audit (which counts canonical-status string literals in an array/IN-list) WILL flag them. They must carry the pragma. The `zernio-publisher.ts` 3-value `IN` likewise. This is intentional: the audit is value-count-based, not context-aware, and the pragma is the reviewed escape hatch (mirrors `static-policy-audit`'s allowlist philosophy).

### (D) Already-using-const (no work) — for reference

`src/app/api/admin/overview/route.ts` (123,152,166), `src/lib/admin/business-detail/queries.ts` (206,219), `src/lib/dashboard/service.ts` (93,144,284,298,344), `src/lib/kpi/service.ts` (85,120,167,208) — all already use `${[...HANDLED_STATUSES] as string[]}::text[]` / `${HANDLED}::text[]` / `${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]`. These will NOT be flagged by the audit because they contain ZERO canonical-status STRING LITERALS (they interpolate a const identifier). No migration needed; they are the proof the audit's "literal-only" predicate is correct.

---

## The `statusArraySql` helper — signature + rationale

```ts
// src/lib/shared/response-status-sql.ts
import { sql } from '@/lib/db/server';

/**
 * Binds a response-status group as a Postgres `text[]` array fragment for use
 * in `status = ANY(${statusArraySql(GROUP)})` read predicates. Returns a
 * Postgres.js Fragment that interpolates to `$N::text[]` — byte-for-byte the
 * codebase's existing `${[...GROUP] as string[]}::text[]` convention, never an
 * `IN (${...})` list (Postgres.js v3 would expand that into one bind per value
 * and break the partial-index-aware predicate shape).
 *
 * Lives in this DB-adjacent module (NOT response-status.ts) so the canonical
 * const module stays a zero-dependency pure module that every TS importer can
 * pull in without a transitive `sql` / DB import.
 */
export function statusArraySql(statuses: readonly string[]) {
  return sql`${[...statuses] as string[]}::text[]`;
}
```

Rationale for `sql\`${arr}::text[]\`` over `sql.array(arr, 25)`: it reproduces the exact existing convention already proven across `src/lib/dashboard/service.ts`, `src/lib/kpi/service.ts`, and the worker, so the generated SQL is identical and the change is provably behavior-preserving. The return type is inferred (Postgres.js `PendingQuery`/`Fragment`) — no `any`.

---

## `resolveCallbackDestination` — signature + decision table

```ts
// added to src/lib/shared/auth-flow.ts
export type CallbackResolution =
  | { kind: 'redirect'; destination: string }
  | { kind: 'signout-redirect'; destination: string }
  | { kind: 'finish'; destination: string };

export function resolveCallbackDestination(input: {
  role: string | null;
  rawNext: string;
  flow: AuthFlow | undefined;
}): CallbackResolution;
```

`destination` is ALWAYS a same-origin internal path (starts with a single `/`). Callers pass the RAW `next` param; sanitization happens INSIDE.

Internal logic (same order as today's route):
1. `loginUrl = loginUrlForFlow(flow)` (`/login` for owner, `/admin/login` otherwise).
2. Sanitize: `nextIsSafe = rawNext.startsWith('/') && !rawNext.startsWith('//')`; `requestedNext = nextIsSafe ? rawNext : ''`.
3. Google-signup finish edge: `role === null && requestedNext === '/signup/finish'` → `{ kind: 'finish', destination: '/signup/finish' }`.
4. No users row (any other case): `role === null` → `{ kind: 'signout-redirect', destination: \`${loginUrl}?error=account_incomplete\` }`.
5. Unsupported role: `role !== 'owner' && role !== 'admin'` → `{ kind: 'signout-redirect', destination: \`${loginUrl}?error=account_incomplete\` }`.
6. Reset-password passthrough: `requestedNext === '/reset-password' || requestedNext === '/admin/reset-password'` → `{ kind: 'redirect', destination: requestedNext }`.
7. Role-aware home: `nextIsAdmin = requestedNext.startsWith('/admin')`; `nextIsOwner = requestedNext.startsWith('/dashboard') || requestedNext.startsWith('/settings') || requestedNext.startsWith('/onboarding')`. If `role === 'owner'` → `destination = nextIsOwner ? requestedNext : '/dashboard'`; else (`admin`) → `destination = nextIsAdmin ? requestedNext : '/admin/overview'`. Both as `{ kind: 'redirect', destination }`.

Decision table (the test matrix):

| role | rawNext | flow | → kind | → destination |
|---|---|---|---|---|
| `null` | `/signup/finish` | `owner` | finish | `/signup/finish` |
| `null` | `/dashboard` | `owner` | signout-redirect | `/login?error=account_incomplete` |
| `null` | `` | `admin` | signout-redirect | `/admin/login?error=account_incomplete` |
| `null` | `/signup/finish` | `admin` | finish | `/signup/finish` (next-driven, role-agnostic — parity with today) |
| `viewer` | `/dashboard` | `owner` | signout-redirect | `/login?error=account_incomplete` |
| `owner` | `/reset-password` | `owner` | redirect | `/reset-password` |
| `admin` | `/admin/reset-password` | `admin` | redirect | `/admin/reset-password` |
| `owner` | `/settings/billing` | `owner` | redirect | `/settings/billing` |
| `owner` | `/admin/overview` | `owner` | redirect | `/dashboard` (cross-role next rejected) |
| `owner` | `` | `owner` | redirect | `/dashboard` |
| `admin` | `/admin/overview` | `admin` | redirect | `/admin/overview` |
| `admin` | `/dashboard` | `admin` | redirect | `/admin/overview` (cross-role next rejected) |
| `admin` | `` | `undefined` | redirect | `/admin/overview` |
| `owner` | `//evil.com` | `owner` | redirect | `/dashboard` (hostile next stripped) |
| `owner` | `https://evil.com` | `owner` | redirect | `/dashboard` (not `/`-prefixed → stripped) |
| `owner` | `/\evil.com` | `owner` | redirect | `/dashboard` (starts `/\`, but `requestedNext='/\evil.com'` is not an owner path → falls to `/dashboard`) |
| `owner` | `/%2F%2Fevil.com` | `owner` | redirect | `/dashboard` (encoded; not an owner-prefix path → `/dashboard`) |
| `admin` | `//evil.com` | `admin` | redirect | `/admin/overview` |

Hostile-`next` invariant asserted by tests: for EVERY resolution, `destination.startsWith('/') && !destination.startsWith('//')` (same-origin internal path, never an absolute/protocol-relative URL).

The route handler keeps: token exchange (`verifyOtp` for `token_hash`, `exchangeCodeForSession` for `code`), the `users.role` lookup (incl. PGRST116 handling), the Supabase client construction + cookie jar, and `supabase.auth.signOut()` for the `signout-redirect` kind. It builds ONE final `NextResponse.redirect(new URL(destination, origin))` and copies cookies once.

---

## The audit predicate

`scripts/ci/response-status-audit.ts` (TypeScript compiler API): for each `.ts`/`.tsx` file under `src/` (skipping `__tests__/`, `.test.`, `.spec.`, `.d.ts`, and the two exempt modules `response-status.ts` + `response-status-sql.ts`), parse to a SourceFile and walk the AST. Flag a node when it is a **collection of 2+ canonical response-status STRING LITERALS**:
- an `ArrayLiteralExpression` whose elements include ≥2 distinct `StringLiteral`s from the canonical set, OR
- a SQL `IN (...)` / `ANY(ARRAY[...])` list inside a template literal whose raw text contains ≥2 canonical-status quoted literals on the relevant span.

Because Postgres.js SQL lives in template literals (not array nodes), the audit scans `NoSubstitutionTemplateLiteral` + `TemplateExpression` cooked/raw text for the regex `'(status)'` count too. The predicate is value-COUNT-based: ≥2 canonical-status quoted literals co-located (same array node, or same `IN (...)`/`ARRAY[...]` parenthetical) → finding. A node/line is exempt when its line (or the line above, matching `static-policy` ergonomics) carries `// status-audit-ignore`. Single-status equalities (`=== 'approved'`, one literal) are never flagged. Exit non-zero with `file:line [response-status-group] detail` on any finding; exit 0 with a scanned-count summary otherwise.

CI wiring: add `"ci:response-status": "tsx scripts/ci/response-status-audit.ts"` to `package.json`, and add a `- name: Run response-status audit` / `run: pnpm ci:response-status` step to the `lint` job in `.github/workflows/ci.yml`, immediately after the static-policy audit step (exact same pattern as the existing audit steps).

---

## Test list

- `auth-flow.test.ts`: every row of the decision table above (19 rows) + the universal same-origin invariant assertion looped over a hostile-`next` array (`//evil.com`, `https://evil.com`, `http://evil.com`, `/\evil`, `\\evil`, `%2F%2Fevil`, `javascript:alert(1)`, ` /\t/evil`).
- `response-status-sql.test.ts`:
  - pure: `statusArraySql(HANDLED_STATUSES)` returns a Postgres.js fragment whose serialized form binds the array as `::text[]` (assert via the fragment's structure — it is a `PendingQuery`; assert it is not a string and composes inside a `sql` template without throwing). Assert it never produces an `IN (` expansion.
  - integration (gated `if (!process.env.TEST_DATABASE_POOL_URL) it.skip`): run `SELECT 'approved'::text = ANY(${statusArraySql(HANDLED_STATUSES)}) AS hit` against the real DB and assert `hit === true`, and `'pending_approval'::text = ANY(${statusArraySql(HANDLED_STATUSES)})` is `false` — proving the fragment binds correctly against the actual `responses.status` (text) column domain.
- `response-status-audit.test.ts`: pure tests of `scanSource(fileName, text)`:
  - flags a 2+ array literal `['approved','edited']`.
  - flags a SQL `IN ('approved','edited','posted')`.
  - flags `ANY(ARRAY['approved','posted'])`.
  - does NOT flag a single literal `status === 'approved'`.
  - does NOT flag a const-interpolated `ANY(${[...HANDLED_STATUSES] as string[]}::text[])` (zero string literals).
  - honors `// status-audit-ignore` on the same line and the line above.
  - does NOT scan `response-status.ts` / `response-status-sql.ts` (exempt).

---

## Task 1: `resolveCallbackDestination` resolver (TDD: tests FIRST)

**Files:**
- Create: `src/lib/shared/__tests__/auth-flow.test.ts`
- Modify: `src/lib/shared/auth-flow.ts`
- Modify: `src/app/api/auth/callback/route.ts`

- [ ] **Step 1: Write the failing decision-table + hostile-next tests**

```ts
// src/lib/shared/__tests__/auth-flow.test.ts
import { describe, it, expect } from 'vitest';
import { resolveCallbackDestination, type CallbackResolution } from '../auth-flow';

const cases: Array<{
  name: string;
  role: string | null;
  rawNext: string;
  flow: 'owner' | 'admin' | undefined;
  expected: CallbackResolution;
}> = [
  { name: 'google-signup finish (owner)', role: null, rawNext: '/signup/finish', flow: 'owner',
    expected: { kind: 'finish', destination: '/signup/finish' } },
  { name: 'no-users-row owner → signout', role: null, rawNext: '/dashboard', flow: 'owner',
    expected: { kind: 'signout-redirect', destination: '/login?error=account_incomplete' } },
  { name: 'no-users-row admin empty next → signout', role: null, rawNext: '', flow: 'admin',
    expected: { kind: 'signout-redirect', destination: '/admin/login?error=account_incomplete' } },
  { name: 'google-signup finish (admin flow, next-driven)', role: null, rawNext: '/signup/finish', flow: 'admin',
    expected: { kind: 'finish', destination: '/signup/finish' } },
  { name: 'unsupported role → signout', role: 'viewer', rawNext: '/dashboard', flow: 'owner',
    expected: { kind: 'signout-redirect', destination: '/login?error=account_incomplete' } },
  { name: 'owner reset-password passthrough', role: 'owner', rawNext: '/reset-password', flow: 'owner',
    expected: { kind: 'redirect', destination: '/reset-password' } },
  { name: 'admin reset-password passthrough', role: 'admin', rawNext: '/admin/reset-password', flow: 'admin',
    expected: { kind: 'redirect', destination: '/admin/reset-password' } },
  { name: 'owner honored owner next', role: 'owner', rawNext: '/settings/billing', flow: 'owner',
    expected: { kind: 'redirect', destination: '/settings/billing' } },
  { name: 'owner cross-role next rejected → /dashboard', role: 'owner', rawNext: '/admin/overview', flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' } },
  { name: 'owner empty next → /dashboard', role: 'owner', rawNext: '', flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' } },
  { name: 'admin honored admin next', role: 'admin', rawNext: '/admin/overview', flow: 'admin',
    expected: { kind: 'redirect', destination: '/admin/overview' } },
  { name: 'admin cross-role next rejected → /admin/overview', role: 'admin', rawNext: '/dashboard', flow: 'admin',
    expected: { kind: 'redirect', destination: '/admin/overview' } },
  { name: 'admin undefined flow empty next → /admin/overview', role: 'admin', rawNext: '', flow: undefined,
    expected: { kind: 'redirect', destination: '/admin/overview' } },
  { name: 'hostile // owner → /dashboard', role: 'owner', rawNext: '//evil.com', flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' } },
  { name: 'hostile absolute owner → /dashboard', role: 'owner', rawNext: 'https://evil.com', flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' } },
  { name: 'hostile backslash owner → /dashboard', role: 'owner', rawNext: '/\\evil.com', flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' } },
  { name: 'hostile encoded owner → /dashboard', role: 'owner', rawNext: '/%2F%2Fevil.com', flow: 'owner',
    expected: { kind: 'redirect', destination: '/dashboard' } },
  { name: 'hostile // admin → /admin/overview', role: 'admin', rawNext: '//evil.com', flow: 'admin',
    expected: { kind: 'redirect', destination: '/admin/overview' } },
];

describe('resolveCallbackDestination', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(resolveCallbackDestination({ role: c.role, rawNext: c.rawNext, flow: c.flow })).toEqual(c.expected);
    });
  }

  it('never escapes same-origin for hostile next values', () => {
    const hostile = ['//evil.com', 'https://evil.com', 'http://evil.com', '/\\evil', '\\\\evil', '%2F%2Fevil', 'javascript:alert(1)', ' /\t/evil'];
    for (const rawNext of hostile) {
      for (const role of ['owner', 'admin', null] as const) {
        for (const flow of ['owner', 'admin', undefined] as const) {
          const r = resolveCallbackDestination({ role, rawNext, flow });
          expect(r.destination.startsWith('/')).toBe(true);
          expect(r.destination.startsWith('//')).toBe(false);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/auth-flow.test.ts`
Expected: FAIL — `resolveCallbackDestination is not a function` / export missing.

- [ ] **Step 3: Implement `resolveCallbackDestination` in `auth-flow.ts`**

Append to `src/lib/shared/auth-flow.ts`:

```ts
export type CallbackResolution =
  | { kind: 'redirect'; destination: string }
  | { kind: 'signout-redirect'; destination: string }
  | { kind: 'finish'; destination: string };

/**
 * Single source of truth for post-auth-callback redirect safety. Callers pass
 * the RAW `next` query param; this function sanitizes it (same-origin internal
 * paths only) and applies the role/path allowlists. `destination` is always an
 * internal path beginning with a single `/`.
 */
export function resolveCallbackDestination(input: {
  role: string | null;
  rawNext: string;
  flow: AuthFlow | undefined;
}): CallbackResolution {
  const { role, rawNext, flow } = input;
  const loginUrl = loginUrlForFlow(flow);
  const nextIsSafe = rawNext.startsWith('/') && !rawNext.startsWith('//');
  const requestedNext = nextIsSafe ? rawNext : '';

  if (role === null && requestedNext === '/signup/finish') {
    return { kind: 'finish', destination: '/signup/finish' };
  }
  if (role === null) {
    return { kind: 'signout-redirect', destination: `${loginUrl}?error=account_incomplete` };
  }
  if (role !== 'owner' && role !== 'admin') {
    return { kind: 'signout-redirect', destination: `${loginUrl}?error=account_incomplete` };
  }
  if (requestedNext === '/reset-password' || requestedNext === '/admin/reset-password') {
    return { kind: 'redirect', destination: requestedNext };
  }

  const nextIsAdmin = requestedNext.startsWith('/admin');
  const nextIsOwner =
    requestedNext.startsWith('/dashboard') ||
    requestedNext.startsWith('/settings') ||
    requestedNext.startsWith('/onboarding');

  const destination =
    role === 'owner'
      ? nextIsOwner ? requestedNext : '/dashboard'
      : nextIsAdmin ? requestedNext : '/admin/overview';
  return { kind: 'redirect', destination };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/shared/__tests__/auth-flow.test.ts`
Expected: PASS (all rows + invariant).

- [ ] **Step 5: Refactor `route.ts` to dispatch on the resolver**

In `src/app/api/auth/callback/route.ts`: import `resolveCallbackDestination`; delete the inline `nextIsSafe`/`requestedNext` computation and the four hand-written redirect/signout blocks + their cookie-copy loops; after the role lookup, compute `const resolution = resolveCallbackDestination({ role, rawNext, flow });` then:

```ts
import {
  isAuthFlow,
  loginUrlForFlow,
  resolveCallbackDestination,
  type AuthFlow,
} from '@/lib/shared/auth-flow';
```

```ts
  // ... after role lookup ...
  const resolution = resolveCallbackDestination({ role, rawNext, flow });
  if (resolution.kind === 'signout-redirect') {
    await supabase.auth.signOut();
  }
  const finalResponse = NextResponse.redirect(new URL(resolution.destination, origin));
  for (const cookie of response.cookies.getAll()) {
    finalResponse.cookies.set(cookie);
  }
  return finalResponse;
```

Keep `rawNext` as `searchParams.get('next') ?? ''` but REMOVE the `nextIsSafe`/`requestedNext` lines (sanitization now lives in the resolver). Keep `loginUrl` only where still used (the early `!code && !tokenHash` redirect and the token-exchange error redirects). Keep token exchange + role lookup verbatim.

- [ ] **Step 6: Run the full suite + typecheck + lint to confirm route parity**

Run: `pnpm vitest run src/lib/shared/__tests__/auth-flow.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS. (If a route-level callback test exists it must still pass — run `pnpm vitest run src/app/api/auth` too.)

- [ ] **Step 7: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-audit-stage1-tier1
git add src/lib/shared/auth-flow.ts src/lib/shared/__tests__/auth-flow.test.ts src/app/api/auth/callback/route.ts
git commit -m "refactor(auth): extract resolveCallbackDestination from callback route"
```

---

## Task 2: `statusArraySql` helper + tests (TDD: tests FIRST)

**Files:**
- Create: `src/lib/shared/__tests__/response-status-sql.test.ts`
- Create: `src/lib/shared/response-status-sql.ts`

- [ ] **Step 1: Write the failing pure + gated-integration tests**

```ts
// src/lib/shared/__tests__/response-status-sql.test.ts
import { describe, it, expect } from 'vitest';
import { statusArraySql } from '../response-status-sql';
import { HANDLED_STATUSES } from '../response-status';

describe('statusArraySql (pure shape)', () => {
  it('returns a Postgres.js fragment, not a raw string', () => {
    const frag = statusArraySql(HANDLED_STATUSES);
    expect(typeof frag).not.toBe('string');
    expect(frag).toBeTypeOf('object');
  });
});

const dbIt = process.env.TEST_DATABASE_POOL_URL ? it : it.skip;

describe('statusArraySql (integration against responses.status text domain)', () => {
  dbIt('binds the group so ANY(...) matches in-group and rejects out-of-group', async () => {
    const { sql } = await import('@/lib/db/server');
    const [row] = await sql<{ hit: boolean; miss: boolean }[]>`
      SELECT 'approved'::text = ANY(${statusArraySql(HANDLED_STATUSES)}) AS hit,
             'pending_approval'::text = ANY(${statusArraySql(HANDLED_STATUSES)}) AS miss
    `;
    expect(row?.hit).toBe(true);
    expect(row?.miss).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/response-status-sql.test.ts`
Expected: FAIL — module `../response-status-sql` not found.

- [ ] **Step 3: Implement the helper**

```ts
// src/lib/shared/response-status-sql.ts
import { sql } from '@/lib/db/server';

/**
 * Binds a response-status group as a Postgres `text[]` array fragment for
 * `status = ANY(${statusArraySql(GROUP)})` READ predicates. Reproduces the
 * codebase's `${[...GROUP] as string[]}::text[]` convention exactly — never an
 * `IN (${...})` list (Postgres.js v3 would expand that to one bind per value).
 * Lives here (not response-status.ts) to keep that const module zero-import.
 */
export function statusArraySql(statuses: readonly string[]) {
  return sql`${[...statuses] as string[]}::text[]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/shared/__tests__/response-status-sql.test.ts`
Expected: PASS (pure test passes; integration test SKIPs locally without `TEST_DATABASE_POOL_URL`, RUNs+passes in CI's Postgres service).

- [ ] **Step 5: Migrate the four READ callsites**

`src/lib/dashboard/aggregate-service.ts` — add import `import { statusArraySql } from '@/lib/shared/response-status-sql';` and `import { HANDLED_STATUSES } from '@/lib/shared/response-status';` (check existing imports first; reuse if present), then replace line 313:
```
      AND resp.status = ANY(ARRAY['approved', 'posted', 'edited', 'awaiting_owner_connect']::text[])
```
with:
```
      AND resp.status = ANY(${statusArraySql(HANDLED_STATUSES)})
```

`src/app/api/dashboard/past-replies/draft/route.ts` — add the two imports, replace line 134:
```
          AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')
```
with:
```
          AND status = ANY(${statusArraySql(NON_TERMINAL_STATUSES)})
```
(import `NON_TERMINAL_STATUSES` from `@/lib/shared/response-status`.)

`src/app/api/dashboard/past-replies/[responseId]/retry/route.ts` — same two imports, replace line 107 (`AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')`) with `AND status = ANY(${statusArraySql(NON_TERMINAL_STATUSES)})`. Note this query uses the `tx` tag inside `sql.begin` — `statusArraySql` uses the module `sql`, which composes fine as a fragment inside a `tx` template (Postgres.js fragments are tag-agnostic). Verify by typecheck.

`src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts` — same, replace line 124 identically.

- [ ] **Step 6: Add the leave-inline pragmas**

`src/app/api/dashboard/past-replies/draft-status/route.ts` line 111 — append an inline pragma on that line:
```
          AND status IN ('pending_approval', 'approved', 'edited') -- status-audit-ignore: 3-value poll subset (excludes awaiting_owner_connect); no exact group match, not reusable
```

`src/lib/publishing/zernio-publisher.ts` line 209 — append on that line:
```
        ... status IN ('approved', 'edited', 'awaiting_owner_connect') -- status-audit-ignore: state-transition UPDATE guard, intentionally inline per response-status.ts header
```
(preserve the existing surrounding SQL exactly; only append the trailing comment.)

`src/lib/approval/http-routes.ts` line 168 — append `-- status-audit-ignore: state-transition guard subset`.

`src/lib/reviews/process-review.ts` line 269 — append `-- status-audit-ignore: state-transition SELECT FOR UPDATE guard subset`.

- [ ] **Step 7: Run typecheck + lint + affected tests**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run src/lib/dashboard src/app/api/dashboard/past-replies`
Expected: PASS (behavior-preserving — same generated SQL).

- [ ] **Step 8: Commit (defer — combine with Task 3 per the single status commit)**

Do NOT commit yet; the status migration + audit land in ONE commit (Task 3 step). Proceed to Task 3.

---

## Task 3: `response-status-audit.ts` AST audit + CI wiring (TDD: tests FIRST)

**Files:**
- Create: `scripts/ci/__tests__/response-status-audit.test.ts`
- Create: `scripts/ci/response-status-audit.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing audit unit tests**

```ts
// scripts/ci/__tests__/response-status-audit.test.ts
import { describe, it, expect } from 'vitest';
import { scanSource } from '../response-status-audit';

describe('response-status-audit scanSource', () => {
  it('flags a 2+ array literal of canonical statuses', () => {
    const f = scanSource('src/x.ts', `const g = ['approved','edited'];`);
    expect(f.length).toBe(1);
    expect(f[0]?.rule).toBe('response-status-group');
  });

  it('flags a SQL IN (...) list of 3 canonical statuses', () => {
    const f = scanSource('src/x.ts', "const q = sql`SELECT 1 WHERE status IN ('approved','edited','posted')`;");
    expect(f.length).toBeGreaterThanOrEqual(1);
  });

  it('flags ANY(ARRAY[...]) of canonical statuses', () => {
    const f = scanSource('src/x.ts', "const q = sql`WHERE status = ANY(ARRAY['approved','posted']::text[])`;");
    expect(f.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a single-status equality', () => {
    expect(scanSource('src/x.ts', `if (status === 'approved') {}`)).toEqual([]);
  });

  it('does NOT flag const-interpolated group usage (zero string literals)', () => {
    const src = "const q = sql`WHERE status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])`;";
    expect(scanSource('src/lib/dashboard/service.ts', src)).toEqual([]);
  });

  it('honors // status-audit-ignore on the same line', () => {
    const src = "const q = sql`WHERE status IN ('approved','edited')`; // status-audit-ignore: reason";
    expect(scanSource('src/x.ts', src)).toEqual([]);
  });

  it('honors // status-audit-ignore on the preceding line', () => {
    const src = "// status-audit-ignore: reason\nconst g = ['approved','edited'];";
    expect(scanSource('src/x.ts', src)).toEqual([]);
  });

  it('does not scan the exempt modules', () => {
    const src = `export const X = ['approved','edited'];`;
    expect(scanSource('src/lib/shared/response-status.ts', src)).toEqual([]);
    expect(scanSource('src/lib/shared/response-status-sql.ts', src)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/ci/__tests__/response-status-audit.test.ts`
Expected: FAIL — module `../response-status-audit` not found.

- [ ] **Step 3: Implement the audit**

```ts
// scripts/ci/response-status-audit.ts
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/**
 * Flags hardcoded response-status GROUP literals (2+ canonical status values
 * co-located in an array literal or a SQL IN(...)/ANY(ARRAY[...]) list) in TS
 * files under src/, outside the two exempt modules. Counting/display READ
 * callsites must import the groups from response-status.ts and bind them via
 * statusArraySql(); state-transition writes and one-off subsets that must stay
 * inline carry a per-line `// status-audit-ignore` pragma.
 *
 * Mirrors static-policy-audit.ts: pure `scanSource` (unit-tested) + a thin
 * filesystem `main`. Whole `src/` tree; not worker/ (other stages).
 */

const SCAN_DIR = 'src';
const SCAN_EXT = /\.(?:ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage']);
const SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;
const EXEMPT = new Set([
  'src/lib/shared/response-status.ts',
  'src/lib/shared/response-status-sql.ts',
]);
const IGNORE_PRAGMA = 'status-audit-ignore';

const CANONICAL_STATUSES = new Set([
  'pending_approval',
  'approved',
  'edited',
  'superseded',
  'awaiting_owner_connect',
  'posted',
  'failed',
]);

export type ResponseStatusRule = 'response-status-group';

export interface ResponseStatusFinding {
  file: string;
  line: number;
  rule: ResponseStatusRule;
  detail: string;
}

function normalizePath(file: string): string {
  return file.split(sep).join('/');
}

// A quoted canonical-status literal, e.g. 'approved' or "posted".
const STATUS_LITERAL_RE = /(['"])(pending_approval|approved|edited|superseded|awaiting_owner_connect|posted|failed)\1/g;

// One IN(...)/ARRAY[...] parenthetical or bracket group span.
const SQL_GROUP_RE = /\b(?:in|array)\s*[([][^)\]]*[)\]]/gi;

function countCanonicalLiterals(text: string): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(STATUS_LITERAL_RE)) {
    if (m[2]) seen.add(m[2]);
  }
  return seen.size;
}

function lineHasPragma(lines: string[], lineIndex: number): boolean {
  const current = lines[lineIndex] ?? '';
  const previous = lineIndex > 0 ? lines[lineIndex - 1] ?? '' : '';
  return current.includes(IGNORE_PRAGMA) || previous.includes(IGNORE_PRAGMA);
}

/** Pure scan of one file's text. Exported for tests. */
export function scanSource(file: string, text: string): ResponseStatusFinding[] {
  const normalized = normalizePath(file);
  if (EXEMPT.has(normalized)) return [];

  const findings: ResponseStatusFinding[] = [];
  const lines = text.split('\n');
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const flag = (node: ts.Node, snippet: string): void => {
    if (countCanonicalLiterals(snippet) < 2) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (lineHasPragma(lines, line)) return;
    findings.push({
      file: normalized,
      line: line + 1,
      rule: 'response-status-group',
      detail:
        'hardcoded response-status group literal (2+ canonical status values) — ' +
        'import the group from @/lib/shared/response-status and bind it via ' +
        'statusArraySql() for READ predicates. State-transition writes / one-off ' +
        'subsets that must stay inline need a `// status-audit-ignore` pragma.',
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      const literals = node.elements.filter(
        (el): el is ts.StringLiteral =>
          ts.isStringLiteral(el) && CANONICAL_STATUSES.has(el.text),
      );
      if (new Set(literals.map((l) => l.text)).size >= 2) {
        flag(node, node.getText(source));
      }
    } else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const raw = node.getText(source);
      for (const m of raw.matchAll(SQL_GROUP_RE)) {
        // Re-anchor the matched group's start to its own line for the pragma check.
        const start = node.getStart(source) + (m.index ?? 0);
        if (countCanonicalLiterals(m[0]) < 2) continue;
        const line = source.getLineAndCharacterOfPosition(start).line;
        if (lineHasPragma(lines, line)) continue;
        findings.push({
          file: normalized,
          line: line + 1,
          rule: 'response-status-group',
          detail:
            'hardcoded response-status group in a SQL IN()/ANY(ARRAY[]) list — ' +
            'import the group from @/lib/shared/response-status and bind via ' +
            'statusArraySql(); add `// status-audit-ignore` for inline write guards.',
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return findings;
}

async function collectFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(join(dir, entry.name), root, out);
    } else if (entry.isFile() && SCAN_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(normalizePath(relative(root, join(dir, entry.name))));
    }
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const files: string[] = [];
  await collectFiles(resolve(root, SCAN_DIR), root, files);

  const findings: ResponseStatusFinding[] = [];
  for (const file of files.sort()) {
    findings.push(...scanSource(file, await readFile(resolve(root, file), 'utf8')));
  }

  if (findings.length > 0) {
    console.error('response-status-audit: failed');
    for (const f of findings) {
      console.error(`${f.file}:${f.line} [${f.rule}] ${f.detail}`);
    }
    process.exit(1);
  }
  console.log(`response-status-audit: passed (${files.length} files scanned)`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('response-status-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the audit unit tests to verify they pass**

Run: `pnpm vitest run scripts/ci/__tests__/response-status-audit.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Add the npm script**

In `package.json` scripts, after `"ci:static-policy": ...`, add:
```json
    "ci:response-status": "tsx scripts/ci/response-status-audit.ts",
```

- [ ] **Step 6: Run the audit against the real tree to confirm it is GREEN**

Run: `pnpm ci:response-status`
Expected: `response-status-audit: passed (...)`. (All Task-2 migrations done + pragmas placed → zero findings.) If it FAILS, the printed `file:line` is either an un-migrated READ site (migrate it) or a write/subset site missing a pragma (add one) — do NOT weaken the audit.

- [ ] **Step 7: Wire into CI lint job**

In `.github/workflows/ci.yml`, in the `lint` job steps, immediately after:
```yaml
      - name: Run static policy audit
        run: pnpm ci:static-policy
```
add:
```yaml
      - name: Run response-status audit
        run: pnpm ci:response-status
```

- [ ] **Step 8: Full verify gate**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-audit-stage1-tier1
pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:response-status
```
Expected: all PASS.

- [ ] **Step 9: Commit the status migration + audit together**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-audit-stage1-tier1
git add src/lib/shared/response-status-sql.ts src/lib/shared/__tests__/response-status-sql.test.ts \
  src/lib/dashboard/aggregate-service.ts \
  src/app/api/dashboard/past-replies/draft/route.ts \
  src/app/api/dashboard/past-replies/[responseId]/retry/route.ts \
  src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts \
  src/app/api/dashboard/past-replies/draft-status/route.ts \
  src/lib/publishing/zernio-publisher.ts \
  src/lib/approval/http-routes.ts \
  src/lib/reviews/process-review.ts \
  scripts/ci/response-status-audit.ts scripts/ci/__tests__/response-status-audit.test.ts \
  package.json .github/workflows/ci.yml
git commit -m "refactor(status): single-source response-status groups across src + add CI audit"
```

---

## Self-Review

- **Spec coverage:** Deliverable 0 (this plan) ✓; Deliverable 1 (resolver, TDD, route refactor) → Task 1 ✓; Deliverable 2 (status single-sourcing, `statusArraySql` DB-adjacent helper, leave-inline pragmas, AST audit, npm script + CI wiring, pure + gated-integration tests) → Tasks 2+3 ✓. Verify gate → Task 3 Step 8 ✓.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code; the resolver, helper, and audit are fully specified.
- **Type consistency:** `CallbackResolution` discriminated union used identically in test, resolver, and route; `statusArraySql(readonly string[])` signature consistent; `scanSource(file, text)` signature consistent across audit + tests; group const names (`HANDLED_STATUSES`, `NON_TERMINAL_STATUSES`) match `response-status.ts`.
- **Behavior-preservation:** the four migrated READ predicates generate identical SQL (`status = ANY($1::text[])`); the resolver replicates today's branch order exactly; the route refactor only collapses repeated cookie-copy loops.

## Open risks (for reviewer)

- The AST audit is value-COUNT-based, not context-aware: it flags WRITE-guard group literals too (zernio-publisher, http-routes, process-review). These are pragma'd. This is intentional (mirrors static-policy's allowlist philosophy) but means the pragma is load-bearing — a future writer dropping a 2+ status literal without a pragma will (correctly) fail CI.
- The `retry`/`restore-original` routes interpolate `statusArraySql` (module `sql`) inside a `tx` template. Postgres.js fragments are tag-agnostic and compose, but this is verified only by typecheck + the existing route tests; if a route test exercises the SQL string shape, confirm it still matches.
