# Channel Route Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 12 mobile-channel enrollment routes (2 portals × 2 channels × 3 actions) one shared runner per action and one **Channel actor** resolver per portal, so the admin/owner chain cannot re-diverge, and close the owner→admin module dependency completely.

**Architecture:** Three runners (`runChannelStart`, `runChannelCancel`, `runChannelDisable`) move from `src/app/api/admin/channels/_shared/` up to the common ancestor `src/app/api/_shared/channels/`, and take a **Channel actor resolver** as their only varying axis. `resolveAdminActor` (body `businessId` behind `requireAdminWithAal2`) and `resolveOwnerActor` (session `locationId` behind `requireRoleOr401` + `resolveWritableAccountForLocation`) are the two adapters at that seam. The per-channel flag/env modules move out of the admin route tree to `src/lib/notifications/channels/`, beside the `flags.ts` they already wrap, so an owner *page* can consume them without importing from an admin API folder. All 12 route files become binding shims over one 4-field config type.

**Tech Stack:** Next.js 16 App Router route handlers, Postgres.js (`postgres`), Vitest, `qrcode`, Supabase auth gates.

**Design of record:** `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §4 (amended by Task 1 of this plan).
**Intake contract:** `docs/superpowers/plans/refactor-channel-route-unification-intake.json` — the drift detector. Every task stays inside its `allowed_edit_surface`.
**Glossary:** `CONTEXT.md` → **Channel actor** (coined by Task 1). Use it verbatim; do not say "principal", "caller identity", or "auth context".

---

## Seam analysis (from the `codebase-design` skill)

| Module | Verdict |
|---|---|
| `src/app/api/_shared/channels/{start,action}.ts` | **Deepened, relocated.** The runners already exist and are already deep; the seam was in the wrong place (inside the admin tree) and the interface carried three fields that never varied per call site. Behaviour behind the interface roughly doubles (6 → 12 call sites) while the config shrinks from 7 fields to 4. |
| `src/app/api/_shared/channels/resolve-actor.ts` | **New interface — the only one.** Justified by the "two adapters means a real seam" test: `resolveAdminActor` and `resolveOwnerActor` both exist on day one. Hides the entire auth + scope + account-resolution difference between the portals behind `(sql, req) => Promise<ChannelActorResult>`. |
| `src/lib/notifications/channels/{telegram,whatsapp}-env.ts` | **Moved, not new.** Same interface, correct home (next to `flags.ts`). |
| `src/lib/notifications/channels/deep-links.ts` | **New, small, exhaustive.** `buildMobileDeepLink(channel, rawToken)` — one owner per channel, shared by both portals, which is what makes the deep-link divergence unspellable (§4.4). |
| `isTelegramEnabled` / `isWhatsAppEnabled` | **Deleted.** Pure pass-throughs to `channelsTelegramEnabled` / `channelsWhatsappEnabled`; they fail the deletion test. `settings/channels/page.tsx` and `api/dashboard/channels/route.ts` already import the `flags.ts` originals for WhatsApp while importing the wrapper for Telegram — deleting the wrappers makes both channels read the same way in the same file. |
| `disconnectChannel`, `resolveWritableAccountForLocation`, `startMobileEnrollment`, `cancelMobileEnrollment` | **Untouched.** Existing deep modules at correct seams. Consume, do not reshape. |

**Interface budget.** One config type serves all three runners:

```ts
interface ChannelRouteConfig {
  channel: MobileChannel;
  isEnabled: () => boolean;
  assertEnvReady: () => NextResponse | null;
  resolveActor: ChannelActorResolver;
}
```

`flagOff` (never varied — all 12 sites passed the same function), `cacheLabel` and `endpoint` (both derivable from `surface` + `channel` + action) and `buildDeepLink` (varies by channel only, and `channel` is already in the config) are **removed** from the config. If a task finds itself adding a fifth field, stop and re-plan.

---

## File structure

**Create**

| File | Responsibility |
|---|---|
| `src/app/api/_shared/channels/resolve-actor.ts` | `ChannelActor`, `ChannelActorResult`, `ChannelActorResolver`, `resolveAdminActor`, `resolveOwnerActor` |
| `src/app/api/_shared/channels/start.ts` | `runChannelStart` + `ChannelRouteConfig` (re-exported from here) |
| `src/app/api/_shared/channels/action.ts` | `runChannelCancel`, `runChannelDisable` |
| `src/app/api/_shared/channels/flag-off.ts` | `flagOff()` — moved verbatim |
| `src/app/api/_shared/channels/__tests__/resolve-actor.test.ts` | Resolver unit tests |
| `src/app/api/_shared/channels/__tests__/runners.test.ts` | Runner transaction protocol, gate ordering, actor pass-through, error mapping (T2b) |
| `src/app/api/admin/channels/__tests__/bindings.test.ts` | Admin route bindings: §4.2 gate posture, `surface`, no-store headers, shared deep link (T2b) |
| `src/lib/notifications/channels/telegram-env.ts` | `assertTelegramEnvReady()` |
| `src/lib/notifications/channels/whatsapp-env.ts` | `missingWhatsAppEnv()`, `whatsappEnvReady()`, `assertWhatsAppEnvReady()` |
| `src/lib/notifications/channels/deep-links.ts` | `buildMobileDeepLink(channel, rawToken)` |
| `src/lib/notifications/channels/__tests__/telegram-env.test.ts` | Moved from `admin/channels/telegram/__tests__/_shared.test.ts`, minus the deleted `isTelegramEnabled` cases |
| `src/lib/notifications/channels/__tests__/whatsapp-env.test.ts` | Moved from `admin/channels/whatsapp/__tests__/_shared.test.ts`, minus the deleted `isWhatsAppEnabled` cases |
| `src/lib/notifications/channels/__tests__/deep-links.test.ts` | Deep-link builder tests |
| `src/app/api/dashboard/channels/telegram/__tests__/cancel.test.ts` | Backfilled owner Telegram cancel suite (§4.5) |

**Delete**

`src/app/api/admin/channels/_shared/{account,start,action,flag-off}.ts`,
`src/app/api/admin/channels/{telegram,whatsapp}/_shared.ts`,
`src/app/api/admin/channels/{telegram,whatsapp}/__tests__/_shared.test.ts`.

**Modify**

12 `route.ts` files under `src/app/api/{admin,dashboard}/channels/`, plus
`src/app/api/dashboard/channels/route.ts`, `src/app/(authenticated)/settings/channels/page.tsx`,
`docs/directory.md`, `CONTEXT.md`, and the §4 spec.

**Must NOT change** (verified by a gate command): the 6 admin route test files
`src/app/api/admin/channels/{telegram,whatsapp}/__tests__/{start,cancel,disable}.test.ts`.
They mock only `@/lib/db/server`, `@/lib/db/auth`, `@supabase/ssr`, `@/lib/auth/mfa` and `qrcode` —
zero `_shared` references — so they are the byte-for-byte regression net for this refactor.
New admin-side coverage therefore goes in the sibling
`src/app/api/admin/channels/__tests__/bindings.test.ts` (T2b), never into those six.

**What that frozen net does NOT cover**, and why T2b exists: it pins statuses and
bodies, not the transaction protocol. The start suites push
`sqlQueue.push([]) // advisory lock` — a comment, not an assertion — and their
`begin: async (fn) => fn(consume)` shares one queue with the bare `sql` calls, so
the lock is indistinguishable from any other statement. The `mobile_enroll:<accountId>`
key, token-minted-outside-the-tx, and lock-before-`startMobileEnrollment` are
pinned by nothing in the repo today.

---

## Task graph

```
T1 (docs+glossary) ──┐
T2  (eval: route + resolver tests) ──┐
T2b (eval: runner protocol + admin bindings) ──┤
                                     └─> T3 (flag/env + deep-links move)
                                          └─> T4 (resolve-actor)
                                               └─> T5 (runners)
                                                    ├─> T6 (admin shims)
                                                    ├─> T7 (owner shims)
                                                    └─> T8 (non-route consumers + doc sweep)
```

- **T1, T2 and T2b may run in parallel** (disjoint files: docs/glossary vs
  `dashboard/channels` + `_shared/channels/__tests__/resolve-actor.test.ts` vs
  `_shared/channels/__tests__/runners.test.ts` + `admin/channels/__tests__/bindings.test.ts`).
- **T3 blocks on T1, T2 AND T2b.** The eval is the definition of done, so no
  implementation task may start before every failing test exists. (Round-1
  review finding: the first draft let T3 start after T1 alone.)
- T3 → T4 → T5 is a strict chain.
- **T6, T7, T8 are mutually independent** once T5 lands (disjoint file sets:
  admin routes / owner routes / the two non-route consumers + docs).
- **T3 runs alone as the first implementation task** (the enforcement spot check).

---

### Task 1: Amend the spec and coin the glossary term

**Files:**
- Modify: `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` (§4.1, §4.4, §4.5)
- Modify: `CONTEXT.md` (add one glossary entry)

No tests — this is the documentation half of the intake's locked decisions. It lands FIRST so every later task reads the amended spec, not the stale one.

- [ ] **Step 1: Amend §4.1's `ChannelActor` type**

In `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md`, the §4.1 table row reading:

```
| `resolve-actor.ts` | `ChannelActor = { businessId, accountId, actorUserId, surface }`; `resolveAdminActor`; `resolveOwnerActor` |
```

becomes:

```
| `resolve-actor.ts` | `ChannelActor = { businessId, accountId, actorUserId, surface: 'admin' \| 'dashboard' }`; `resolveAdminActor`; `resolveOwnerActor` |
```

Then replace the paragraph beginning `` `surface` (`'admin' | 'owner'`) drives `` with:

```markdown
`surface` (`'admin' | 'dashboard'`) drives the `disconnectChannel` audit tag and the
`safeInvalidateChannelCache` label, so `admin.telegram.cancel` and
`dashboard.telegram.cancel` remain distinct. The union deliberately reuses
`disconnectChannel`'s existing two values (`src/lib/channels/disable-enrollment.ts:24`)
rather than `'admin' | 'owner'` as first drafted: an `'owner'` value would need a
translation step to `'dashboard'` at every audit and cache-label site, for no
behavioural gain.

`resolveAdminActor` takes a `requireFullAccess` flag, because §4.2's asymmetry is
real: `start` needs the strict `subscriptionGrantsFullAccess` gate and
`cancel`/`disable` must not gain one. It is one query — the accounts join — with
the gate applied only when the caller asks for it. Admin `cancel`/`disable` move
from `SELECT account_id FROM businesses` to that join; this adds no gate and no
second query.

The per-channel flag/env modules move too. `admin/channels/telegram/_shared.ts`
and `admin/channels/whatsapp/_shared.ts` become
`src/lib/notifications/channels/{telegram,whatsapp}-env.ts`, beside the
`flags.ts` they already wrap. Their consumers are not only routes:
`src/app/(authenticated)/settings/channels/page.tsx` and
`src/app/api/dashboard/channels/route.ts` call `whatsappEnvReady()` for UI
availability, so an `api/_shared/` home would leave a *page* importing from an
API route folder. The pass-throughs `isTelegramEnabled()` / `isWhatsAppEnabled()`
are deleted — both are one-line wrappers over `channelsTelegramEnabled()` /
`channelsWhatsappEnabled()`, which those same two files already import directly
for WhatsApp.

Deep-link construction moves to `src/lib/notifications/channels/deep-links.ts` as
one exhaustive `buildMobileDeepLink(channel, rawToken)`, so a builder cannot be
spelled twice.
```

- [ ] **Step 2: Correct §4.4's structural claim**

Replace the §4.4 bullet list with:

```markdown
- the owner→admin `_shared` import — **both halves**. The runner import in the 6
  owner routes, and the flag/env import in 8 owner-side sites (those 6 routes,
  `api/dashboard/channels/route.ts`, and `(authenticated)/settings/channels/page.tsx`).
  Moving only the runners, as §4.1 first read, would have left the second half
  live and this claim only half-true.
- the Telegram `??` / `||` deep-link divergence — after PR 1 patches it, PR 2 makes
  it unspellable twice
- a **second, unreported deep-link divergence**: admin `whatsapp/start` stripped
  `/^whatsapp:\+?/` while owner `whatsapp/start` stripped `/\D/g`. A
  `TWILIO_WHATSAPP_NUMBER` carrying spaces, dashes or parens produced a broken
  `wa.me` link on the admin side only. The owner's `/\D/g` form wins.
- the `no_account` 404/403 split
- the error-response header split: admin's 400/403/404 lacked the
  `Cache-Control: no-store, private` that owner's `errorResponse()` always sets.
  Unified on always-no-store.
```

- [ ] **Step 3: Sharpen §4.5's regression-net claim**

Replace the first §4.5 bullet with:

```markdown
- The 6 admin route test files (`{telegram,whatsapp}/__tests__/{start,cancel,disable}.test.ts`)
  are the regression net. They mock only `@/lib/db/server`, `@/lib/db/auth`,
  `@supabase/ssr`, `@/lib/auth/mfa` and `qrcode` — they contain **zero** references
  to the `_shared` paths — so they must pass **byte-for-byte unmodified**, which is
  stronger than "unmodified except for import paths". A gate command asserts this
  with `git diff --quiet`; any edit is a signal the refactor changed admin semantics.
- The 2 admin `_shared.test.ts` files are NOT part of that net — they test the
  flag/env modules and move with them to
  `src/lib/notifications/channels/__tests__/{telegram,whatsapp}-env.test.ts`,
  dropping the `isTelegramEnabled` / `isWhatsAppEnabled` cases that
  `src/lib/notifications/channels/__tests__/flags.test.ts` already table-tests.
- There are no existing owner `cancel`/`disable` tests for the `no_account`
  condition, so §4.3's change is covered by **new** tests, not updated ones.
```

- [ ] **Step 4: Coin the glossary term**

Append to the glossary list in `CONTEXT.md`:

```markdown
- **Channel actor**: the resolved identity a mobile-channel enrollment action runs as — `{ businessId, accountId, actorUserId, surface }` (`src/app/api/_shared/channels/resolve-actor.ts`), where `surface ∈ {'admin','dashboard'}` reusing `disconnectChannel`'s existing union. It is the **only axis that varies** between the two portals' 12 enrollment routes, which is why it is the seam: `resolveAdminActor` reads `businessId` from the request **body** behind `requireAdminWithAal2`, `resolveOwnerActor` reads `locationId` from the **session** behind `requireRoleOr401` and never from the body — and that asymmetry is a security boundary, not an implementation detail, so the two resolvers must never be collapsed into one function that accepts either source. The resolver also owns each portal's **gate outcome**: admin `start` applies `subscriptionGrantsFullAccess` (via `requireFullAccess`) while admin `cancel`/`disable` deliberately apply none, and owner applies `resolveWritableAccountForLocation` on all three; the runners consume the outcome and never second-guess it (spec §4.2). `surface` is not decoration — it drives the `disconnectChannel` audit tag and the `safeInvalidateChannelCache` label, so `admin.telegram.cancel` and `dashboard.telegram.cancel` stay distinct in the audit log and the cache. _Avoid_: principal, caller identity, auth context, channel session. *(coined in the PR 2 channel-route unification; spec `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §4.1)*
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md CONTEXT.md
git commit -m "docs(channels): amend spec §4 and coin the Channel actor term"
```

---

### Task 2: The eval — author every promised test as a failing test

**Files:**
- Create: `src/app/api/_shared/channels/__tests__/resolve-actor.test.ts`
- Create: `src/lib/notifications/channels/__tests__/deep-links.test.ts`
- Create: `src/app/api/dashboard/channels/telegram/__tests__/cancel.test.ts`
- Modify: `src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts`
- Modify: `src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts`
- Modify: `src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts`

This is the spec in executable form. Every one of the intake's 21 `tests_to_add`
titles must appear **verbatim** — the gate greps for the exact string. Tests
against modules that do not exist yet are written normally and will fail on
import; that is the intended red.

**The owner suites use a queue-based `sql` mock**: each `sqlQueue.push([...])` is
consumed by the next query the route issues, in order. Changing the number or
order of queries silently mis-aligns the queue and produces a *passing* test
asserting the wrong thing. `resolveOwnerActor` must issue exactly the one
`resolveWritableAccountForLocation` query the routes issue today — one
`sqlQueue.push` for the accounts lookup, then one per statement inside
`sql.begin`.

- [ ] **Step 1: Write the resolver test suite**

Create `src/app/api/_shared/channels/__tests__/resolve-actor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/admin-mfa-gate', () => ({
  requireAdminWithAal2: (...a: unknown[]) => requireAdminMock(...(a as [])),
}));

const requireRoleMock = vi.fn();
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));

const resolveWritableMock = vi.fn();
vi.mock('@/lib/shared/writable-subscription', () => ({
  resolveWritableAccountForLocation: (...a: unknown[]) => resolveWritableMock(...(a as [])),
}));

import { resolveAdminActor, resolveOwnerActor } from '../resolve-actor';

/** Queue-backed sql double: each push is consumed by the next query, in order. */
function mkSql(rows: unknown[][]) {
  const queue = [...rows];
  const calls: Array<{ raw: string; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ raw: strings.join('?'), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  return { sql: sql as never, calls };
}

function mkReq(body: unknown, url = 'http://localhost/api/admin/channels/telegram/start') {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  }) as never;
}

beforeEach(() => {
  requireAdminMock.mockReset();
  requireRoleMock.mockReset();
  resolveWritableMock.mockReset();
  requireAdminMock.mockResolvedValue({ ok: true, admin: { id: 'admin-1' } });
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', id: 'owner-1', role: 'owner', locationId: 'biz-1' });
});

describe('resolveAdminActor', () => {
  it('resolveAdminActor returns the admin gate response when requireAdminWithAal2 fails', async () => {
    const gateResponse = NextResponse.json({ error: 'mfa_required' }, { status: 401 });
    requireAdminMock.mockResolvedValue({ ok: false, response: gateResponse });
    const { sql } = mkSql([]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'biz-1' }), { requireFullAccess: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response).toBe(gateResponse);
  });

  it('resolveAdminActor returns 400 businessId required when the body has no businessId', async () => {
    const { sql } = mkSql([]);

    const result = await resolveAdminActor(sql, mkReq({}), { requireFullAccess: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: 'businessId required' });
  });

  it('resolveAdminActor returns 404 not_found when the businessId matches no business', async () => {
    const { sql } = mkSql([[]]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'nope' }), { requireFullAccess: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: 'not_found' });
  });

  it('resolveAdminActor returns 403 subscription_not_active when full access is required and the account lacks it', async () => {
    const { sql } = mkSql([[{ id: 'acct-1', subscription_status: 'cancelled' }]]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'biz-1' }), { requireFullAccess: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'subscription_not_active' });
  });

  it('resolveAdminActor resolves the account without a subscription gate when full access is not required', async () => {
    const { sql } = mkSql([[{ id: 'acct-1', subscription_status: 'cancelled' }]]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'biz-1' }), { requireFullAccess: false });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.actor).toEqual({
      businessId: 'biz-1',
      accountId: 'acct-1',
      actorUserId: 'admin-1',
      surface: 'admin',
    });
  });

  it('resolveAdminActor reads businessId from the body and never from the session', async () => {
    requireAdminMock.mockResolvedValue({ ok: true, admin: { id: 'admin-1', locationId: 'session-biz' } });
    const { sql, calls } = mkSql([[{ id: 'acct-1', subscription_status: 'active' }]]);

    const result = await resolveAdminActor(sql, mkReq({ businessId: 'body-biz' }), { requireFullAccess: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.actor.businessId).toBe('body-biz');
    expect(calls[0].values).toContain('body-biz');
    expect(calls[0].values).not.toContain('session-biz');
  });
});

describe('resolveOwnerActor', () => {
  it('resolveOwnerActor returns the role gate response when requireRoleOr401 fails', async () => {
    class AuthErrorStub extends Error { statusCode = 401; }
    requireRoleMock.mockRejectedValue(new AuthErrorStub('Unauthorized'));
    const { sql } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({}));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(401);
  });

  it('resolveOwnerActor returns 403 no_business when the session carries no locationId', async () => {
    requireRoleMock.mockResolvedValue({ userId: 'owner-1', id: 'owner-1', role: 'owner', locationId: null });
    const { sql, calls } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({}));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: 'no_business' });
    expect(calls).toHaveLength(0);
    expect(resolveWritableMock).not.toHaveBeenCalled();
  });

  it('resolveOwnerActor returns 404 not_found when the location has no billing account', async () => {
    resolveWritableMock.mockResolvedValue({ kind: 'no_account' });
    const { sql } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({}));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: 'not_found' });
  });

  it('resolveOwnerActor surfaces a blocked subscription verbatim with its own status', async () => {
    resolveWritableMock.mockResolvedValue({ kind: 'blocked', status: 402, error: 'past_due_read_only' });
    const { sql } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({}));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.response.status).toBe(402);
    expect(await result.response.json()).toEqual({ error: 'past_due_read_only' });
  });

  it('resolveOwnerActor reads locationId from the session and never from the body', async () => {
    requireRoleMock.mockResolvedValue({ userId: 'owner-1', id: 'owner-1', role: 'owner', locationId: 'session-biz' });
    resolveWritableMock.mockResolvedValue({ kind: 'ok', accountId: 'acct-1' });
    const { sql } = mkSql([]);

    const result = await resolveOwnerActor(sql, mkReq({ businessId: 'body-biz', locationId: 'body-biz' }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.actor).toEqual({
      businessId: 'session-biz',
      accountId: 'acct-1',
      actorUserId: 'owner-1',
      surface: 'dashboard',
    });
    expect(resolveWritableMock).toHaveBeenCalledWith('session-biz', expect.anything());
  });
});
```

- [ ] **Step 2: Write the deep-link builder test suite**

Create `src/lib/notifications/channels/__tests__/deep-links.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildMobileDeepLink } from '../deep-links';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
  process.env.TELEGRAM_BOT_USERNAME = 'RepWorthStagingBot';
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('buildMobileDeepLink', () => {
  it('the wa.me deep link strips every non-digit from TWILIO_WHATSAPP_NUMBER', () => {
    process.env.TWILIO_WHATSAPP_NUMBER = '+1 (555) 123-4567';

    expect(buildMobileDeepLink('whatsapp', 'tok-1')).toBe(
      'https://wa.me/15551234567?text=start-tok-1',
    );
  });

  it('admin and owner build the same wa.me deep link for the same token', () => {
    // One builder, one result — the divergence this refactor closes is that the
    // two portals used to own separate copies of this expression.
    process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';

    const first = buildMobileDeepLink('whatsapp', 'tok-2');
    const second = buildMobileDeepLink('whatsapp', 'tok-2');

    expect(first).toBe(second);
    expect(first).toBe('https://wa.me/15551234567?text=start-tok-2');
  });

  it('falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is blank', () => {
    process.env.TELEGRAM_BOT_USERNAME = '   ';

    expect(buildMobileDeepLink('telegram', 'tok-3')).toBe('https://t.me/RepWorthBot?start=tok-3');
  });

  it('uses the configured Telegram bot username when it is set', () => {
    expect(buildMobileDeepLink('telegram', 'tok-4')).toBe(
      'https://t.me/RepWorthStagingBot?start=tok-4',
    );
  });
});
```

- [ ] **Step 3: Backfill the owner Telegram cancel suite**

Create `src/app/api/dashboard/channels/telegram/__tests__/cancel.test.ts`. This
mirrors the existing `whatsapp/__tests__/cancel.test.ts` structure exactly —
follow that precedent, do not invent a new mock shape.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, consume } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => (Array.isArray(q[0]) ? q.shift() : (q.shift(), []));
  return { sqlQueue: q, consume: c };
});
vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(consume) }),
  jsonb: (v: unknown) => v,
}));
const requireRoleMock = vi.fn(async () => ({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' }));
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));
vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return { ...actual, withSameOrigin: () => (h: unknown) => h };
});
vi.mock('@/lib/notifications/resolve-channels', () => ({ safeInvalidateChannelCache: vi.fn(async () => {}) }));

import { POST } from '../cancel/route';

function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/telegram/cancel', {
    method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' });
  process.env.MOCK_EXTERNAL_APIS = 'true';
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
});

describe('POST /api/dashboard/channels/telegram/cancel', () => {
  it('POST /api/dashboard/channels/telegram/cancel returns 404 when the flag is off', async () => {
    expect((await POST(mkReq() as never)).status).toBe(404);
  });

  it('POST /api/dashboard/channels/telegram/cancel cancels a pending enrollment for an active subscription', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([]);                                                 // advisory lock
    sqlQueue.push([{ id: 'e1' }]);                                     // cancel UPDATE RETURNING
    const res = await POST(mkReq() as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('owner telegram cancel returns 404 not_found when the location has no billing account', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([]); // accounts lookup finds no row → no_account
    const res = await POST(mkReq() as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
```

- [ ] **Step 4: Add the §4.3 404 case to the three existing owner suites**

Append this `it` block inside the existing top-level `describe` of
`src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts`:

```typescript
  it('owner telegram disable returns 404 not_found when the location has no billing account', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([]); // accounts lookup finds no row → no_account
    const res = await POST(mkReq() as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
```

Append to `src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts`:

```typescript
  it('owner whatsapp cancel returns 404 not_found when the location has no billing account', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([]); // accounts lookup finds no row → no_account
    const res = await POST(mkReq() as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
```

Append to `src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts`:

```typescript
  it('owner whatsapp disable returns 404 not_found when the location has no billing account', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([]); // accounts lookup finds no row → no_account
    const res = await POST(mkReq() as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
```

Note: `telegram/__tests__/disable.test.ts` uses the `sqlQueue`/`mockSql` hoisted
pair; `whatsapp/__tests__/cancel.test.ts` and `whatsapp/__tests__/disable.test.ts`
use the `sqlQueue`/`consume` pair. Both expose `sqlQueue`, so the block above is
correct in all three — do not restructure the mocks.

- [ ] **Step 5: Add the two runner/label tests**

Append to `src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts`,
inside the same `describe`:

```typescript
  it('the channel cache label keeps the admin and dashboard surfaces distinct', async () => {
    // disconnectChannel composes `${surface}.${channel}.disable`; the owner route
    // must resolve surface 'dashboard', never 'admin'.
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    sqlQueue.push([{ id: 'e1' }]);
    await POST(mkReq() as never);

    const { safeInvalidateChannelCache } = await import('@/lib/notifications/resolve-channels');
    expect(safeInvalidateChannelCache).toHaveBeenCalledWith(
      expect.anything(),
      'dashboard.telegram.disable',
    );
  });

  it('runChannelStart returns the flag-off 404 without reading the database', async () => {
    // The flag gate precedes auth AND the first query: a disabled channel is
    // indistinguishable from a missing route, for an unauthenticated caller too.
    const { runChannelStart } = await import('@/app/api/_shared/channels/start');
    const neverCallSql = (() => { throw new Error('sql must not be called when the flag is off'); }) as never;

    const res = await runChannelStart(neverCallSql, mkReq() as never, {
      channel: 'telegram',
      isEnabled: () => false,
      assertEnvReady: () => null,
      resolveActor: () => { throw new Error('resolveActor must not be called when the flag is off'); },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
```

- [ ] **Step 6: Run the suites to verify they fail**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
pnpm test src/app/api/_shared/channels src/lib/notifications/channels/__tests__/deep-links.test.ts src/app/api/dashboard/channels 2>&1 | tail -40
```

Expected: the two new files fail at import (`Cannot find module '../resolve-actor'`,
`Cannot find module '../deep-links'`); the owner suites fail their new `404`
assertions with `expected 403 to be 404`; the two appended runner/label tests fail
at `Cannot find module '@/app/api/_shared/channels/start'`.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/_shared/channels/__tests__ src/lib/notifications/channels/__tests__/deep-links.test.ts src/app/api/dashboard/channels
git commit -m "test(channels): failing eval for the channel-route unification"
```

---

### Task 2b: The eval, part 2 — runner protocol and admin bindings

**Blocking edges:** none (parallel with T1 and T2 — disjoint files).

Added after the round-1 adversarial plan review, which found that Task 2's 21
titles could all be green while the refactor was still wrong in six ways. The
governing fact: **the existing admin start suites do not pin the transaction
protocol at all.** They `sqlQueue.push([]) // advisory lock` — a *comment* — and
`begin: async (fn) => fn(consume)` shares one queue with the bare `sql` calls, so
the lock is indistinguishable from any other query. Token-outside-tx, the
`mobile_enroll:<accountId>` key, and lock-before-`startMobileEnrollment` are
currently unpinned by anything in the repo.

**Files:**
- Create: `src/app/api/_shared/channels/__tests__/runners.test.ts`
- Create: `src/app/api/admin/channels/__tests__/bindings.test.ts`

These are NEW files by design. The six admin route suites must stay byte-for-byte
unmodified (that is the refactor's acceptance criterion), so admin-side binding
coverage cannot be added to them — it goes in a sibling file instead, which keeps
the `git diff --quiet` gate command valid.

- [ ] **Step 1: Write the runner protocol suite**

Create `src/app/api/_shared/channels/__tests__/runners.test.ts`. The `sql` double
here is **strict**: it records every query and throws on over-consumption, rather
than silently returning `[]` like the route suites' queue mock.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * `tx.depth` is shared between the sql double and the crypto spy so a test can
 * ask "was the token minted while a transaction was open?".
 *
 * This indirection is load-bearing. Asserting the token HASH SHAPE cannot pin
 * token-outside-tx: a sha256 hex string looks identical whether it was produced
 * before `sql.begin` or inside it, so a regression that moved minting into the
 * transaction would keep such a test green. Only the call-time depth answers it.
 */
const { txState, cryptoCalls } = vi.hoisted(() => ({
  txState: { depth: 0 },
  cryptoCalls: [] as Array<{ fn: 'randomUUID' | 'createHash'; txDepth: number }>,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: (...a: Parameters<typeof actual.randomUUID>) => {
      cryptoCalls.push({ fn: 'randomUUID', txDepth: txState.depth });
      return actual.randomUUID(...a);
    },
    createHash: (...a: Parameters<typeof actual.createHash>) => {
      cryptoCalls.push({ fn: 'createHash', txDepth: txState.depth });
      return actual.createHash(...a);
    },
  };
});

const startEnrollmentMock = vi.fn();
const cancelEnrollmentMock = vi.fn();
vi.mock('@/lib/channels/mobile-enrollment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/channels/mobile-enrollment')>();
  return {
    ...actual,
    startMobileEnrollment: (...a: unknown[]) => startEnrollmentMock(...(a as [])),
    cancelMobileEnrollment: (...a: unknown[]) => cancelEnrollmentMock(...(a as [])),
  };
});

const disconnectMock = vi.fn();
vi.mock('@/lib/channels/disable-enrollment', () => ({
  disconnectChannel: (...a: unknown[]) => disconnectMock(...(a as [])),
}));

const invalidateMock = vi.fn(async () => {});
vi.mock('@/lib/notifications/resolve-channels', () => ({
  safeInvalidateChannelCache: (...a: unknown[]) => invalidateMock(...(a as [])),
}));

const reportMock = vi.fn();
vi.mock('@/lib/shared/report-caught-error', () => ({
  reportCaughtError: (...a: unknown[]) => reportMock(...(a as [])),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') },
}));

import { runChannelStart } from '../start';
import { runChannelCancel, runChannelDisable } from '../action';
import type { ChannelActorResolver } from '../resolve-actor';

/**
 * Recording sql double. `log` captures every statement with its bound values and
 * whether it ran inside sql.begin, so tests assert the COMPLETE statement list —
 * order, nesting and all — rather than probing for the presence of one query.
 *
 * Strictness here comes from exhaustive assertion, not from a fixture queue:
 * every enrollment helper the runners call (startMobileEnrollment,
 * cancelMobileEnrollment, disconnectChannel) is mocked in this suite, so the
 * only statement a runner issues on its own is the advisory lock. That makes the
 * expected log short enough to assert with toEqual, which is what makes an added
 * or reordered statement a failure instead of a silent pass. Do NOT relax these
 * to `toContain` — the exhaustiveness is the point.
 */
function mkSql() {
  const log: Array<{ raw: string; values: unknown[]; inTx: boolean }> = [];
  let beginCount = 0;
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    log.push({
      raw: strings.join('?').replace(/\s+/g, ' ').trim(),
      values,
      inTx: txState.depth > 0,
    });
    return Promise.resolve([]);
  };
  const sql = Object.assign(record, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      beginCount += 1;
      txState.depth += 1;
      try {
        return await fn(Object.assign(record, { json: (v: unknown) => v }));
      } finally {
        txState.depth -= 1;
      }
    },
  });
  return { sql: sql as never, log, beginCount: () => beginCount };
}

/** The one statement a runner issues on its own, with helpers mocked. */
const LOCK_STATEMENT = 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))';
const lockedTx = (accountId = 'acct-1') => ({
  raw: LOCK_STATEMENT,
  values: [`mobile_enroll:${accountId}`],
  inTx: true,
});

function mkReq() {
  return new Request('http://localhost/api/admin/channels/telegram/start', {
    method: 'POST',
    body: JSON.stringify({ businessId: 'biz-1' }),
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  }) as never;
}

const okActor: ChannelActorResolver = async () => ({
  ok: true,
  actor: { businessId: 'biz-1', accountId: 'acct-1', actorUserId: 'admin-1', surface: 'admin' },
});

/** A resolver that fails the test if it is ever reached. */
const neverResolve: ChannelActorResolver = () => {
  throw new Error('resolveActor must not be called — a gate should have short-circuited');
};

function cfg(over: Partial<Parameters<typeof runChannelStart>[2]> = {}) {
  return {
    channel: 'telegram' as const,
    isEnabled: () => true,
    assertEnvReady: () => null,
    resolveActor: okActor,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cryptoCalls.length = 0;
  txState.depth = 0;
  startEnrollmentMock.mockResolvedValue({ kind: 'ok' });
  cancelEnrollmentMock.mockResolvedValue({ kind: 'ok' });
  disconnectMock.mockResolvedValue({ kind: 'ok' });
  process.env.MOCK_EXTERNAL_APIS = 'true';
  process.env.TELEGRAM_BOT_USERNAME = 'RepWorthBot';
});

describe('runChannelStart transaction protocol', () => {
  // WIRING GUARD — run this first. There is no precedent in this repo for
  // mocking a `node:` builtin, so prove the spy actually intercepts the runner's
  // `import { createHash, randomUUID } from 'node:crypto'` before any test
  // relies on it. If this fails, the crypto spy is not wired and the
  // token-timing test below would pass vacuously — see the fallback note under
  // this code block.
  it('the node:crypto spy intercepts the runner token mint', async () => {
    const { sql } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());
    expect(cryptoCalls.length).toBeGreaterThan(0);
  });

  it('runChannelStart mints the enrollment token outside the transaction', async () => {
    const { sql } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());

    // Both randomUUID (the raw token) and createHash (its sha256) must run at
    // txDepth 0. If either moved inside sql.begin, the secret would depend on a
    // transaction that may roll back. Asserting the hash's SHAPE cannot catch
    // that regression — only its call-time depth can.
    expect(cryptoCalls.map((c) => c.fn)).toEqual(['randomUUID', 'createHash']);
    expect(cryptoCalls.every((c) => c.txDepth === 0)).toBe(true);
  });

  it('runChannelStart opens exactly one transaction', async () => {
    const { sql, beginCount } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());
    expect(beginCount()).toBe(1);
  });

  it('runChannelStart takes the account-scoped advisory lock as the first statement in the transaction', async () => {
    const { sql, log } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());

    // Exhaustive: with startMobileEnrollment mocked, the lock is the ONLY
    // statement the runner issues. An added or reordered query fails here.
    expect(log).toEqual([lockedTx()]);
  });

  it('runChannelStart takes the advisory lock before calling startMobileEnrollment', async () => {
    const logAtEnrollment: Array<{ raw: string; values: unknown[]; inTx: boolean }> = [];
    const { sql, log } = mkSql();
    startEnrollmentMock.mockImplementation(async () => {
      logAtEnrollment.push(...log);
      return { kind: 'ok' };
    });

    await runChannelStart(sql, mkReq(), cfg());

    // The lock had already run when startMobileEnrollment was entered, and it
    // was the only thing that had.
    expect(logAtEnrollment).toEqual([lockedTx()]);
  });

  it('runChannelStart passes the same account id to the lock and to startMobileEnrollment', async () => {
    const { sql, log } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());

    const [, channel, businessId, accountId, tokenHash] = startEnrollmentMock.mock.calls[0];
    expect(log[0].values).toEqual([`mobile_enroll:${accountId}`]);
    expect(channel).toBe('telegram');
    expect(businessId).toBe('biz-1');
    expect(accountId).toBe('acct-1');
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runChannelCancel takes the same account-scoped advisory lock before cancelling', async () => {
    const logAtCancel: Array<{ raw: string; values: unknown[]; inTx: boolean }> = [];
    const { sql, log } = mkSql();
    cancelEnrollmentMock.mockImplementation(async () => {
      logAtCancel.push(...log);
      return { kind: 'ok' };
    });

    await runChannelCancel(sql, mkReq(), cfg());

    expect(logAtCancel).toEqual([lockedTx()]);
    expect(log).toEqual([lockedTx()]);
    expect(cancelEnrollmentMock).toHaveBeenCalledWith(expect.anything(), 'telegram', 'acct-1');
  });

  it('runChannelDisable issues no statement of its own and delegates the transaction to disconnectChannel', async () => {
    const { sql, log, beginCount } = mkSql();
    await runChannelDisable(sql, mkReq(), cfg());

    // disconnectChannel owns its own tx, lock-free cascade and audit rows. The
    // runner must not open a second transaction around it.
    expect(log).toEqual([]);
    expect(beginCount()).toBe(0);
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});

describe('runner gate ordering', () => {
  it.each([
    ['runChannelStart', runChannelStart],
    ['runChannelCancel', runChannelCancel],
    ['runChannelDisable', runChannelDisable],
  ])('%s returns the flag-off 404 before auth and before any query', async (_name, run) => {
    const { sql, log } = mkSql();
    const res = await run(sql, mkReq(), cfg({ isEnabled: () => false, resolveActor: neverResolve }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(log).toHaveLength(0);
  });

  it.each([
    ['runChannelStart', runChannelStart],
    ['runChannelCancel', runChannelCancel],
    ['runChannelDisable', runChannelDisable],
  ])('%s returns the env 503 before auth and before any query', async (_name, run) => {
    const envErr = NextResponse.json({ ok: false, reason: 'telegram_env_not_ready' }, { status: 503 });
    const { sql, log } = mkSql();
    const res = await run(sql, mkReq(), cfg({ assertEnvReady: () => envErr, resolveActor: neverResolve }));

    expect(res.status).toBe(503);
    expect(log).toHaveLength(0);
  });
});

describe('runner actor pass-through', () => {
  it.each([
    ['runChannelCancel', runChannelCancel],
    ['runChannelDisable', runChannelDisable],
  ])('%s surfaces a blocked 402 past_due_read_only rather than mapping it to 404', async (_name, run) => {
    const blocked: ChannelActorResolver = async () => ({
      ok: false,
      response: NextResponse.json({ error: 'past_due_read_only' }, { status: 402 }),
    });
    const { sql } = mkSql();

    const res = await run(sql, mkReq(), cfg({ resolveActor: blocked }));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
  });

  it.each([
    ['runChannelCancel', runChannelCancel],
    ['runChannelDisable', runChannelDisable],
  ])('%s surfaces a blocked 403 subscription_not_active rather than mapping it to 404', async (_name, run) => {
    const blocked: ChannelActorResolver = async () => ({
      ok: false,
      response: NextResponse.json({ error: 'subscription_not_active' }, { status: 403 }),
    });
    const { sql } = mkSql();

    const res = await run(sql, mkReq(), cfg({ resolveActor: blocked }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'subscription_not_active' });
  });

  it('runChannelDisable forwards the resolved surface to disconnectChannel', async () => {
    const { sql } = mkSql();
    await runChannelDisable(sql, mkReq(), cfg());

    expect(disconnectMock).toHaveBeenCalledWith(expect.anything(), {
      channel: 'telegram',
      accountId: 'acct-1',
      actorUserId: 'admin-1',
      surface: 'admin',
    });
  });
});

describe('runChannelStart error mapping', () => {
  it('runChannelStart maps EnrollmentDatabaseError to a no-store 500 internal', async () => {
    const { EnrollmentDatabaseError } = await import('@/lib/channels/unique-violation');
    startEnrollmentMock.mockRejectedValue(new EnrollmentDatabaseError('boom'));
    const { sql } = mkSql();

    const res = await runChannelStart(sql, mkReq(), cfg());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('the EnrollmentDatabaseError report carries no raw token or token hash', async () => {
    const { EnrollmentDatabaseError } = await import('@/lib/channels/unique-violation');
    startEnrollmentMock.mockRejectedValue(new EnrollmentDatabaseError('boom'));
    const { sql } = mkSql();

    await runChannelStart(sql, mkReq(), cfg());

    const [, , context] = reportMock.mock.calls[0];
    const serialized = JSON.stringify(context);
    // Invariant #5 applied to enrollment tokens: neither the raw uuid nor its
    // sha256 hash may reach a log sink.
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(context).toMatchObject({ channel: 'telegram', businessId: 'biz-1', accountId: 'acct-1' });
  });

  it('runChannelStart maps MultipleMobileChannelsError to a no-store 409', async () => {
    const { MultipleMobileChannelsError } = await import('@/lib/channels/unique-violation');
    startEnrollmentMock.mockRejectedValue(new MultipleMobileChannelsError('boom'));
    const { sql } = mkSql();

    const res = await runChannelStart(sql, mkReq(), cfg());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'multiple_mobile_channels' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('runChannelStart rethrows an unrecognised error rather than masking it as a 500', async () => {
    startEnrollmentMock.mockRejectedValue(new Error('something else entirely'));
    const { sql } = mkSql();

    await expect(runChannelStart(sql, mkReq(), cfg())).rejects.toThrow('something else entirely');
  });
});
```

**Fallback if the wiring guard fails.** `vi.mock('node:crypto')` is standard
Vitest, but this repo has no existing instance of mocking a `node:` builtin, so
treat it as unproven until the guard passes. If it does not intercept, do NOT
weaken the token-timing test back to a hash-shape assertion — that is exactly the
vacuous form round 2 rejected. Instead invert the observation: give `mkSql` a
`begin` that **throws before invoking its callback**, and assert that
`runChannelStart` still rejects *after* a full token mint by checking that
`startMobileEnrollment` was never called while the thrown error propagated. A
mint placed inside the transaction cannot complete under that harness, so the two
placements become distinguishable without touching `node:crypto`. Record whichever
route was taken in the deviations file.

- [ ] **Step 2: Write the admin route binding suite**

Create `src/app/api/admin/channels/__tests__/bindings.test.ts`. This proves the
six admin shims bind the right `requireFullAccess` posture, the right `surface`,
and the shared deep-link builder — none of which the resolver unit tests can
prove, because they test the resolver in isolation.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * This suite tests BINDINGS, not SQL: which resolver posture each of the six
 * admin shims wires up, which surface it resolves, and which deep-link builder
 * it reaches. Every enrollment helper is therefore mocked, which means the ONLY
 * query any route issues is the resolver's accounts join — exactly one per
 * request, provably, instead of a hand-counted fixture list that silently
 * absorbs a miscount. Exact SQL protocol is asserted in the runner suite
 * (`src/app/api/_shared/channels/__tests__/runners.test.ts`), which is the right
 * altitude for it; do not duplicate statement assertions here.
 */
const { sqlLog, accountRow } = vi.hoisted(() => ({
  sqlLog: [] as Array<{ raw: string; values: unknown[] }>,
  accountRow: { current: [] as unknown[] },
}));

const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
  sqlLog.push({ raw: strings.join('?').replace(/\s+/g, ' ').trim(), values });
  return Promise.resolve(accountRow.current);
};
vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(record, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(Object.assign(record, { json: (v: unknown) => v })),
  }),
  jsonb: (v: unknown) => v,
}));

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/admin-mfa-gate', () => ({
  requireAdminWithAal2: (...a: unknown[]) => requireAdminMock(...(a as [])),
}));

const startEnrollmentMock = vi.fn(async () => ({ kind: 'ok' as const }));
const cancelEnrollmentMock = vi.fn(async () => ({ kind: 'ok' as const }));
vi.mock('@/lib/channels/mobile-enrollment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/channels/mobile-enrollment')>();
  return {
    ...actual,
    startMobileEnrollment: (...a: unknown[]) => startEnrollmentMock(...(a as [])),
    cancelMobileEnrollment: (...a: unknown[]) => cancelEnrollmentMock(...(a as [])),
  };
});

const disconnectMock = vi.fn(async () => ({ kind: 'ok' as const }));
vi.mock('@/lib/channels/disable-enrollment', () => ({
  disconnectChannel: (...a: unknown[]) => disconnectMock(...(a as [])),
}));

const invalidateMock = vi.fn(async () => {});
vi.mock('@/lib/notifications/resolve-channels', () => ({
  safeInvalidateChannelCache: (...a: unknown[]) => invalidateMock(...(a as [])),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') },
}));

import { POST as tgStart } from '../telegram/start/route';
import { POST as tgCancel } from '../telegram/cancel/route';
import { POST as tgDisable } from '../telegram/disable/route';
import { POST as waStart } from '../whatsapp/start/route';
import { POST as waCancel } from '../whatsapp/cancel/route';
import { POST as waDisable } from '../whatsapp/disable/route';

function mkReq(path: string, body: unknown = { businessId: 'biz-1' }) {
  return new Request(`http://localhost/api/admin/channels/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  }) as never;
}

/** Every route resolves the account through one accounts join; this is its row. */
function seedAccount(subscription_status: string) {
  accountRow.current = [{ id: 'acct-1', subscription_status }];
}
function seedNoAccount() {
  accountRow.current = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlLog.length = 0;
  seedAccount('active');
  requireAdminMock.mockResolvedValue({ ok: true, admin: { id: 'admin-1' } });
  process.env.MOCK_EXTERNAL_APIS = 'true';
  process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
  process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
  process.env.TELEGRAM_BOT_USERNAME = 'RepWorthBot';
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551234567';
});

describe('admin start binds the strict subscription gate (§4.2)', () => {
  it.each([
    ['telegram', tgStart, 'telegram/start'],
    ['whatsapp', waStart, 'whatsapp/start'],
  ])('POST /api/admin/channels/%s/start returns 403 subscription_not_active for a cancelled account', async (_c, handler, path) => {
    seedAccount('cancelled');
    const res = await handler(mkReq(path));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'subscription_not_active' });
    // The gate fired at the resolver: no enrollment was attempted.
    expect(startEnrollmentMock).not.toHaveBeenCalled();
  });
});

describe('admin cancel and disable bind NO subscription gate (§4.2)', () => {
  it.each([
    ['telegram cancel', tgCancel, 'telegram/cancel'],
    ['whatsapp cancel', waCancel, 'whatsapp/cancel'],
  ])('admin %s succeeds on a cancelled account', async (_n, handler, path) => {
    seedAccount('cancelled');
    const res = await handler(mkReq(path));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Positive proof the mutation was reached, not merely that no 403 came back.
    expect(cancelEnrollmentMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['telegram disable', tgDisable, 'telegram/disable'],
    ['whatsapp disable', waDisable, 'whatsapp/disable'],
  ])('admin %s reaches the disconnect on a cancelled account', async (_n, handler, path) => {
    seedAccount('cancelled');
    const res = await handler(mkReq(path));
    expect(res.status).toBe(200);
    // Positive proof, not `not.toBe(403)`: an accidental full-access binding
    // would short-circuit before disconnectChannel was ever called.
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});

describe('admin routes resolve the admin surface', () => {
  it('the channel cache label keeps the admin and dashboard surfaces distinct', async () => {
    await tgCancel(mkReq('telegram/cancel'));
    expect(invalidateMock).toHaveBeenCalledWith(expect.anything(), 'admin.telegram.cancel');
  });

  it('admin disable forwards surface admin to disconnectChannel', async () => {
    await tgDisable(mkReq('telegram/disable'));
    expect(disconnectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: 'admin', actorUserId: 'admin-1' }),
    );
  });
});

describe('admin routes issue exactly one query before their mutation', () => {
  it.each([
    ['telegram start', tgStart, 'telegram/start'],
    ['telegram cancel', tgCancel, 'telegram/cancel'],
    ['telegram disable', tgDisable, 'telegram/disable'],
  ])('admin %s resolves the actor with a single accounts join', async (_n, handler, path) => {
    await handler(mkReq(path));

    // With every enrollment helper mocked, the resolver's accounts join plus (for
    // start/cancel) the advisory lock are the only statements. #773: at most one
    // query in flight per request chain, and never a second account lookup.
    const accountJoins = sqlLog.filter((s) => s.raw.includes('FROM accounts a'));
    expect(accountJoins).toHaveLength(1);
    expect(accountJoins[0].values).toEqual(['biz-1']);
  });
});

describe('admin start failure responses carry the no-store headers', () => {
  it.each([
    ['missing businessId', 400, () => seedAccount('active'), {}],
    ['unknown business', 404, seedNoAccount, { businessId: 'nope' }],
    ['inactive subscription', 403, () => seedAccount('cancelled'), { businessId: 'biz-1' }],
  ])('admin telegram start %s response sets Cache-Control: no-store, private', async (_n, status, seed, body) => {
    seed();
    const res = await tgStart(mkReq('telegram/start', body));
    expect(res.status).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });
});

describe('admin whatsapp start uses the shared deep-link builder', () => {
  it('the wa.me deep link strips every non-digit from TWILIO_WHATSAPP_NUMBER', async () => {
    // The pre-refactor admin builder stripped only /^whatsapp:\+?/ and would
    // leave the spaces and parens in the wa.me path.
    process.env.TWILIO_WHATSAPP_NUMBER = '+1 (555) 123-4567';

    const res = await waStart(mkReq('whatsapp/start'));
    const body = (await res.json()) as { deepLink?: string };

    expect(res.status).toBe(200);
    expect(body.deepLink).toMatch(/^https:\/\/wa\.me\/15551234567\?text=start-/);
  });
});
```

- [ ] **Step 3: Run both suites to verify they fail**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
pnpm test src/app/api/_shared/channels/__tests__/runners.test.ts src/app/api/admin/channels/__tests__/bindings.test.ts 2>&1 | tail -30
```

Expected: `runners.test.ts` fails at import (`Cannot find module '../start'`).
`bindings.test.ts` fails on the admin gate/label/deep-link assertions — the
routes still exist but bind the old modules, so `admin cancel succeeds on a
cancelled account` passes today (no gate today either) while
`admin telegram start … no-store` and the formatted-number deep link fail.

Record in the deviations file which `bindings.test.ts` cases are already green
before the refactor — a case that is green in both states pins existing
behaviour rather than new behaviour, and that is a legitimate and intended role
for it here (§4.2 says admin cancel/disable must not *change*).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/_shared/channels/__tests__/runners.test.ts src/app/api/admin/channels/__tests__/bindings.test.ts
git commit -m "test(channels): pin the runner transaction protocol and admin route bindings"
```

---

### Task 3: Move the flag/env modules and add the deep-link builder

**Blocking edges:** T1, T2, T2b — the full eval must exist and be red before any
implementation starts. **Runs alone** — this is the first implementation task and
its completion triggers the enforcement spot check.

**Files:**
- Create: `src/lib/notifications/channels/telegram-env.ts`
- Create: `src/lib/notifications/channels/whatsapp-env.ts`
- Create: `src/lib/notifications/channels/deep-links.ts`
- Create: `src/app/api/_shared/channels/flag-off.ts`
- Create: `src/lib/notifications/channels/__tests__/telegram-env.test.ts`
- Create: `src/lib/notifications/channels/__tests__/whatsapp-env.test.ts`
- Delete: `src/app/api/admin/channels/{telegram,whatsapp}/_shared.ts`
- Delete: `src/app/api/admin/channels/{telegram,whatsapp}/__tests__/_shared.test.ts`
- Delete: `src/app/api/admin/channels/_shared/flag-off.ts`

Use `git mv` where the file genuinely moves so the diff reads as a rename.

- [ ] **Step 1: Create the Telegram env module**

Create `src/lib/notifications/channels/telegram-env.ts`:

```typescript
// src/lib/notifications/channels/telegram-env.ts
//
// Telegram enrollment env-readiness gate. Lives beside flags.ts — the flag it
// pairs with (CHANNELS_TELEGRAM_ENABLED, read via channelsTelegramEnabled) is
// already owned there. It was previously api/admin/channels/telegram/_shared.ts,
// which forced every owner surface — including the settings PAGE — to import
// from an admin route folder.
//
// Server-only: reads process.env and returns a NextResponse. Never imported by
// a client component (invariant #13 — flag state stays server-authoritative).

import { NextResponse } from 'next/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

const TELEGRAM_REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'] as const;

/**
 * Returns a 503 NextResponse if CHANNELS_TELEGRAM_ENABLED=true but the required
 * Telegram env vars are missing. Returns null if env is ready (caller should
 * proceed). Mirrors the worker-side startup assertion pattern.
 *
 * MOCK_EXTERNAL_APIS=true bypasses this check (local dev).
 */
export function assertTelegramEnvReady(): NextResponse | null {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return null;
  const missing = TELEGRAM_REQUIRED_ENV.filter(
    (k) => !process.env[k] || process.env[k]!.trim().length === 0,
  );
  if (missing.length === 0) return null;
  reportCaughtError(
    'telegram-admin',
    new Error('CHANNELS_TELEGRAM_ENABLED=true but required env vars are missing'),
    { missingEnvVars: missing },
  );
  return NextResponse.json({ ok: false, reason: 'telegram_env_not_ready', missing }, { status: 503 });
}
```

The `'telegram-admin'` Sentry tag is preserved verbatim — it is the existing
value and nothing consumes a new one.

- [ ] **Step 2: Create the WhatsApp env module**

Create `src/lib/notifications/channels/whatsapp-env.ts` with the body of the
deleted `api/admin/channels/whatsapp/_shared.ts` minus `isWhatsAppEnabled` and
the `flagOff` re-export:

```typescript
// src/lib/notifications/channels/whatsapp-env.ts
//
// WhatsApp enrollment env-readiness gate. Sibling of telegram-env.ts; see that
// file for why these live beside flags.ts rather than under an admin route.
//
// whatsappEnvReady() has a non-route consumer by design: the owner settings page
// and GET /api/dashboard/channels call it so the UI never renders a Connect
// button the start route would 503.

import { NextResponse } from 'next/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

const WHATSAPP_REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER',
  'WHATSAPP_APPROVAL_TEMPLATE_SID',
  'WHATSAPP_APPROVAL_URL_BASE',
] as const;

/** Vars from WHATSAPP_REQUIRED_ENV that are unset/blank. */
export function missingWhatsAppEnv(): string[] {
  return WHATSAPP_REQUIRED_ENV.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
}

/**
 * Single source of truth for "is the WhatsApp send/enrollment env ready?".
 * Used by the route guard AND the UI availability checks so the UI never
 * renders a Connect button that the start route would 503.
 * MOCK_EXTERNAL_APIS=true bypasses (local dev).
 */
export function whatsappEnvReady(): boolean {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  return missingWhatsAppEnv().length === 0;
}

/**
 * Returns a 503 NextResponse if CHANNELS_WHATSAPP_ENABLED=true but required
 * env vars are missing. Returns null if env is ready (caller should proceed).
 * Mirrors the worker-side startup assertion pattern.
 *
 * MOCK_EXTERNAL_APIS=true bypasses this check (local dev).
 */
export function assertWhatsAppEnvReady(): NextResponse | null {
  if (whatsappEnvReady()) return null;
  const missing = missingWhatsAppEnv();
  reportCaughtError(
    'whatsapp-admin',
    new Error('CHANNELS_WHATSAPP_ENABLED=true but required env vars are missing'),
    { missingEnvVars: missing },
  );
  return NextResponse.json({ ok: false, reason: 'whatsapp_env_not_ready', missing }, { status: 503 });
}
```

- [ ] **Step 3: Create the deep-link builder**

Create `src/lib/notifications/channels/deep-links.ts`:

```typescript
// src/lib/notifications/channels/deep-links.ts
//
// Single owner of the mobile-channel enrollment deep link. Both portals and both
// channels resolve through buildMobileDeepLink, which is what makes a per-portal
// copy of these expressions unspellable — the bug class this exists to close.
// The per-portal copies diverged twice historically: Telegram's blank-username
// fallback (`??` vs `||`) — already closed in PR 1, which is why both current
// routes agree — and WhatsApp's number normalisation (`/^whatsapp:\+?/` vs
// `/\D/g`), still open at the time of writing and closed here.
//
// The Record<MobileChannel, …> makes this exhaustive: adding a mobile channel
// forces a deep-link decision at THIS one site.

import type { MobileChannel } from '@/lib/channels/mobile-enrollment';
import { getServerConfig } from '@/lib/config/server';

const BUILDERS: Record<MobileChannel, (rawToken: string) => string> = {
  telegram: (rawToken) => {
    // `||` (not `??`) so a blank TELEGRAM_BOT_USERNAME falls back too. The var is
    // declared `rawOpt` (src/lib/config/server.ts), which preserves ''/'   '
    // byte-for-byte, so `??` would emit a broken https://t.me/?start=... link.
    const botUsername = getServerConfig().TELEGRAM_BOT_USERNAME?.trim() || 'RepWorthBot';
    return `https://t.me/${botUsername}?start=${rawToken}`;
  },
  whatsapp: (rawToken) => {
    // wa.me requires digits only — strip every non-digit (the whatsapp: prefix,
    // a leading +, and any spaces/dashes/parens the env value may carry). The
    // narrower /^whatsapp:\+?/ form the admin route used left formatting in the
    // path and produced a broken link.
    const digits = getServerConfig().TWILIO_WHATSAPP_NUMBER!.replace(/\D/g, '');
    const prefilled = encodeURIComponent(`start-${rawToken}`);
    return `https://wa.me/${digits}?text=${prefilled}`;
  },
};

export function buildMobileDeepLink(channel: MobileChannel, rawToken: string): string {
  return BUILDERS[channel](rawToken);
}
```

- [ ] **Step 4: Move `flag-off.ts` to the new shared home**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
mkdir -p src/app/api/_shared/channels
git mv src/app/api/admin/channels/_shared/flag-off.ts src/app/api/_shared/channels/flag-off.ts
```

Then edit `src/app/api/_shared/channels/flag-off.ts` so its header comment reads:

```typescript
// src/app/api/_shared/channels/flag-off.ts
//
// Single source for the "channel disabled" response. When a channel's feature
// flag is off, every channel route — both portals, both channels — returns the
// same 404 not_found, so a disabled channel is indistinguishable from a missing
// route. The three runners call this directly; it is deliberately NOT a config
// field, because it never varied across the 12 call sites.
```

The function body is unchanged: `NextResponse.json({ error: 'not_found' }, { status: 404 })`,
with **no** no-store header — the existing flag-off tests assert that shape.

- [ ] **Step 5: Move the two flag/env test files**

```bash
git mv src/app/api/admin/channels/telegram/__tests__/_shared.test.ts src/lib/notifications/channels/__tests__/telegram-env.test.ts
git mv src/app/api/admin/channels/whatsapp/__tests__/_shared.test.ts src/lib/notifications/channels/__tests__/whatsapp-env.test.ts
```

In `telegram-env.test.ts`: change the import to
`import { assertTelegramEnvReady } from '../telegram-env';` plus
`import { flagOff } from '@/app/api/_shared/channels/flag-off';`, and **delete**
the two `isTelegramEnabled` cases (`isTelegramEnabled returns false by default`,
`isTelegramEnabled returns true when flag is set`) — `src/lib/notifications/channels/__tests__/flags.test.ts`
already table-tests `CHANNELS_TELEGRAM_ENABLED` against `channelsTelegramEnabled`.

In `whatsapp-env.test.ts`: change the import to
`import { assertWhatsAppEnvReady, whatsappEnvReady, missingWhatsAppEnv } from '../whatsapp-env';`
plus `import { flagOff } from '@/app/api/_shared/channels/flag-off';`, and delete
the `describe('isWhatsAppEnabled', …)` block for the same reason.

- [ ] **Step 6: Delete the old per-channel `_shared.ts` modules**

```bash
git rm src/app/api/admin/channels/telegram/_shared.ts src/app/api/admin/channels/whatsapp/_shared.ts
```

This breaks 14 importers. Tasks 6, 7 and 8 repair them; typecheck is red until
Task 8 lands, which is expected and is why those three tasks are the fan-out.

- [ ] **Step 7: Run the moved and new suites**

```bash
pnpm test src/lib/notifications/channels 2>&1 | tail -20
```

Expected: `telegram-env.test.ts`, `whatsapp-env.test.ts`, `deep-links.test.ts`
and the pre-existing `flags.test.ts` all PASS. `deep-links.test.ts` turns green
here — it was the red from Task 2 Step 2.

- [ ] **Step 8: Commit**

```bash
git add -A src/lib/notifications/channels src/app/api/_shared/channels src/app/api/admin/channels
git commit -m "refactor(channels): move flag/env modules to lib and add the single deep-link owner"
```

---

### Task 4: The Channel actor resolvers

**Blocking edges:** T3.

**Files:**
- Create: `src/app/api/_shared/channels/resolve-actor.ts`
- Delete: `src/app/api/admin/channels/_shared/account.ts`

- [ ] **Step 1: Write the resolver module**

Create `src/app/api/_shared/channels/resolve-actor.ts`:

```typescript
// src/app/api/_shared/channels/resolve-actor.ts
//
// The Channel actor seam (CONTEXT.md → "Channel actor"). Resolving WHO an
// enrollment action runs as is the only axis that varies between the admin and
// owner portals' 12 channel routes; everything after it — flag gate, env gate,
// token mint, advisory lock, enrollment mutation, cache invalidation — is
// identical, and lives in ./start.ts and ./action.ts.
//
// The two resolvers are deliberately SEPARATE functions, not one function with a
// source parameter: resolveAdminActor reads businessId from the request BODY
// behind the admin MFA gate, resolveOwnerActor reads locationId from the SESSION
// and never from the body. That asymmetry is a tenant-isolation boundary
// (invariant #8), so a single code path able to accept either source would make
// the boundary a runtime branch instead of a structural fact.
//
// Each resolver also owns its portal's gate outcome (spec §4.2): admin start
// applies subscriptionGrantsFullAccess, admin cancel/disable apply none, owner
// applies resolveWritableAccountForLocation on all three. The runners consume
// the outcome and never second-guess it.

import { NextRequest, NextResponse } from 'next/server';
import type postgres from 'postgres';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { requireRoleOr401, errorResponse } from '@/lib/auth/route-helpers';
import { resolveWritableAccountForLocation } from '@/lib/shared/writable-subscription';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';

/**
 * `surface` reuses disconnectChannel's existing union
 * (src/lib/channels/disable-enrollment.ts) rather than 'admin' | 'owner', so the
 * audit tag and the `${surface}.${channel}.${action}` cache label need no
 * translation step.
 */
export interface ChannelActor {
  businessId: string;
  accountId: string;
  actorUserId: string | null;
  surface: 'admin' | 'dashboard';
}

export type ChannelActorResult =
  | { ok: true; actor: ChannelActor }
  | { ok: false; response: NextResponse };

export type ChannelActorResolver = (
  sql: postgres.Sql,
  req: NextRequest,
) => Promise<ChannelActorResult>;

export interface AdminActorOptions {
  /**
   * Whether the account must currently grant full access. TRUE for `start`
   * (enrollment is a paid mutation); FALSE for `cancel`/`disable`, which have
   * deliberately never carried a subscription gate — an admin must be able to
   * tear down an enrollment on a lapsed account. Spec §4.2.
   */
  requireFullAccess: boolean;
}

/**
 * Admin actor: MFA-gated admin auth → `businessId` from the JSON body → the
 * owning account, with the subscription gate applied only when the caller asks.
 * One query serves both postures.
 */
export async function resolveAdminActor(
  sql: postgres.Sql,
  req: NextRequest,
  options: AdminActorOptions,
): Promise<ChannelActorResult> {
  const gate = await requireAdminWithAal2(req);
  if (!gate.ok) return { ok: false, response: gate.response };
  const actorUserId = gate.admin.id;

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  // errorResponse() (not a bare NextResponse.json) so every admin failure carries
  // Cache-Control: no-store, private — the intake's admin header change. The old
  // admin resolver hand-wrote these three and set no headers at all.
  if (!businessId) {
    return { ok: false, response: errorResponse('businessId required', 400) };
  }

  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ id: string; subscription_status: string }[]>`
    SELECT a.id, a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${businessId}
  `;
  if (!accountRow) {
    return { ok: false, response: errorResponse('not_found', 404) };
  }
  if (options.requireFullAccess && !subscriptionGrantsFullAccess(accountRow.subscription_status)) {
    return { ok: false, response: errorResponse('subscription_not_active', 403) };
  }

  return {
    ok: true,
    actor: { businessId, accountId: accountRow.id, actorUserId, surface: 'admin' },
  };
}

/**
 * Owner actor: owner-role auth → `locationId` from the SESSION → the writable
 * billing account for that location.
 *
 * `no_account` maps to 404 not_found on all three actions (spec §4.3). Before
 * this refactor `start` returned 404 while `cancel`/`disable` returned
 * 403 subscription_not_active for the identical condition, which made "no
 * account row exists" indistinguishable from "the account is not writable".
 * `blocked` still surfaces its own status verbatim (402 past_due_read_only,
 * 403 subscription_not_active, 403 account_offboarding_blocked).
 */
export async function resolveOwnerActor(
  sql: postgres.Sql,
  req: NextRequest,
): Promise<ChannelActorResult> {
  const auth = await requireRoleOr401(req, 'owner');
  if (!auth.ok) return { ok: false, response: auth.response };
  const user = auth.user;

  const locationId = user.locationId;
  if (!locationId) return { ok: false, response: errorResponse('no_business', 403) };

  const gate = await resolveWritableAccountForLocation(locationId, sql);
  if (gate.kind === 'no_account') return { ok: false, response: errorResponse('not_found', 404) };
  if (gate.kind === 'blocked') {
    return { ok: false, response: errorResponse(gate.error, gate.status) };
  }

  return {
    ok: true,
    actor: {
      businessId: locationId,
      accountId: gate.accountId,
      actorUserId: user.id,
      surface: 'dashboard',
    },
  };
}
```

- [ ] **Step 2: Delete the superseded admin account resolver**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
git rm src/app/api/admin/channels/_shared/account.ts
```

- [ ] **Step 3: Run the resolver suite**

```bash
pnpm test src/app/api/_shared/channels/__tests__/resolve-actor.test.ts 2>&1 | tail -20
```

Expected: all 11 tests PASS. These were the red from Task 2 Step 1.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/_shared/channels/resolve-actor.ts src/app/api/admin/channels/_shared/account.ts
git commit -m "feat(channels): add the Channel actor resolvers for both portals"
```

---

### Task 5: The three shared runners

**Blocking edges:** T3, T4.

**Files:**
- Create: `src/app/api/_shared/channels/start.ts`
- Create: `src/app/api/_shared/channels/action.ts`
- Delete: `src/app/api/admin/channels/_shared/{start,action}.ts`

- [ ] **Step 1: Write the start runner**

Create `src/app/api/_shared/channels/start.ts`:

```typescript
// src/app/api/_shared/channels/start.ts
//
// Shared mobile-channel enrollment-start handler for BOTH portals. All four
// start routes (2 portals × 2 channels) run the identical chain — flag gate →
// env gate → Channel actor resolve → token mint → advisory-locked enrollment
// upsert → cache invalidate → QR/deep-link response — differing only in the
// resolver they bind (./resolve-actor.ts) and the channel they name.
//
// Config is deliberately 4 fields. flagOff never varied across the 12 call sites
// (called directly below); cacheLabel and the Sentry endpoint tag are derived
// from surface + channel; the deep link is derived from channel
// (@/lib/notifications/channels/deep-links). If this grows a fifth field, the
// seam is wrong — re-plan rather than widen it.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type postgres from 'postgres';
import { startMobileEnrollment, type MobileChannel } from '@/lib/channels/mobile-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';
import { buildMobileDeepLink } from '@/lib/notifications/channels/deep-links';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { flagOff } from './flag-off';
import type { ChannelActorResolver } from './resolve-actor';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export interface ChannelRouteConfig {
  channel: MobileChannel;
  isEnabled: () => boolean;
  assertEnvReady: () => NextResponse | null;
  resolveActor: ChannelActorResolver;
}

export async function runChannelStart(
  sql: postgres.Sql,
  req: NextRequest,
  config: ChannelRouteConfig,
): Promise<NextResponse> {
  if (!config.isEnabled()) return flagOff();

  const envErr = config.assertEnvReady();
  if (envErr) return envErr;

  const resolved = await config.resolveActor(sql, req);
  if (!resolved.ok) return resolved.response;
  const { businessId, accountId, surface } = resolved.actor;

  // Generate token + hash + expiresAt OUTSIDE the tx so the secret doesn't
  // depend on a possibly-rolled-back transaction.
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  let result: { kind: 'ok' } | { kind: 'already_verified' };
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
      return startMobileEnrollment(tx, config.channel, businessId, accountId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: NO_STORE });
    }
    if (err instanceof EnrollmentDatabaseError) {
      // Never log rawToken or tokenHash — invariant #5 applied to enrollment tokens.
      reportCaughtError(`${surface}/channels/${config.channel}/start`, err, {
        failure: 'enrollment_db_error',
        channel: config.channel,
        businessId,
        accountId,
      });
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: NO_STORE });
    }
    throw err;
  }

  if (result.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: NO_STORE });
  }

  // Invalidate channel cache — the enrollment state change affects which
  // channels are available for dispatch. Best-effort: a Redis failure should not
  // block the response.
  await safeInvalidateChannelCache(asAccountId(accountId), `${surface}.${config.channel}.start`);

  const deepLink = buildMobileDeepLink(config.channel, rawToken);
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: NO_STORE },
  );
}
```

- [ ] **Step 2: Write the cancel/disable runner**

Create `src/app/api/_shared/channels/action.ts`:

```typescript
// src/app/api/_shared/channels/action.ts
//
// Shared mobile-channel cancel + disable handlers for BOTH portals. The eight
// cancel/disable routes (2 portals × 2 channels × 2 actions) run the identical
// chain — flag gate → env gate → Channel actor resolve → channel mutation →
// no-store JSON response. Sibling of runChannelStart (./start.ts), which owns
// the heavier enrollment-start flow and exports the shared ChannelRouteConfig.

import { NextRequest, NextResponse } from 'next/server';
import type postgres from 'postgres';
import { cancelMobileEnrollment } from '@/lib/channels/mobile-enrollment';
import { disconnectChannel } from '@/lib/channels/disable-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { flagOff } from './flag-off';
import type { ChannelActorResult } from './resolve-actor';
import type { ChannelRouteConfig } from './start';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

/** Flag gate → env gate → Channel actor resolve. */
async function gateAndResolveActor(
  sql: postgres.Sql,
  req: NextRequest,
  config: ChannelRouteConfig,
): Promise<ChannelActorResult> {
  if (!config.isEnabled()) return { ok: false, response: flagOff() };

  const envErr = config.assertEnvReady();
  if (envErr) return { ok: false, response: envErr };

  return config.resolveActor(sql, req);
}

/**
 * Cancels a pending verification, clearing the token hash + expiry. Idempotent:
 * if no pending_verification row matches, the UPDATE silently affects 0 rows (no
 * error — the task is already done).
 *
 * The status flip releases the migration 027 partial-unique-index slot
 * immediately, allowing a fresh mobile channel enrollment. The advisory lock uses
 * the account-scoped mobile_enroll key — matching the start runner — so a cancel
 * and a concurrent start on the same account mutually exclude and the start
 * cannot overwrite this cancel's 'disabled' transition back to
 * 'pending_verification'.
 */
export async function runChannelCancel(
  sql: postgres.Sql,
  req: NextRequest,
  config: ChannelRouteConfig,
): Promise<NextResponse> {
  const resolved = await gateAndResolveActor(sql, req, config);
  if (!resolved.ok) return resolved.response;
  const { accountId, surface } = resolved.actor;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
    return cancelMobileEnrollment(tx, config.channel, accountId);
  });

  // Invalidate channel cache — the cancelled verification changes which channels
  // are available for dispatch.
  await safeInvalidateChannelCache(asAccountId(accountId), `${surface}.${config.channel}.cancel`);

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

/**
 * Disables a verified enrollment. Returns 404 if no verified row and no live
 * override matches (user-facing signal that there's nothing to disable).
 * disconnectChannel owns the tx, the override cascade, audit rows, and the
 * post-commit cache invalidation — including its own
 * `${surface}.${channel}.disable` label, which is why this function does not
 * invalidate the cache itself.
 */
export async function runChannelDisable(
  sql: postgres.Sql,
  req: NextRequest,
  config: ChannelRouteConfig,
): Promise<NextResponse> {
  const resolved = await gateAndResolveActor(sql, req, config);
  if (!resolved.ok) return resolved.response;

  const result = await disconnectChannel(sql, {
    channel: config.channel,
    accountId: resolved.actor.accountId,
    actorUserId: resolved.actor.actorUserId,
    surface: resolved.actor.surface,
  });

  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
```

- [ ] **Step 3: Delete the superseded admin runners**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
git rm src/app/api/admin/channels/_shared/start.ts src/app/api/admin/channels/_shared/action.ts
rmdir src/app/api/admin/channels/_shared 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
git add -A src/app/api/_shared/channels src/app/api/admin/channels
git commit -m "feat(channels): unify the three route runners across both portals"
```

Typecheck is still red here — the 12 routes import the deleted modules. Tasks 6
and 7 close that.

---

### Task 6: Rebind the 6 admin routes

**Blocking edges:** T5. **Mutually independent with T7 and T8.**

**Files (modify all 6):**
- `src/app/api/admin/channels/telegram/{start,cancel,disable}/route.ts`
- `src/app/api/admin/channels/whatsapp/{start,cancel,disable}/route.ts`

**Do not touch** `src/app/api/admin/channels/{telegram,whatsapp}/__tests__/{start,cancel,disable}.test.ts`.
They must pass byte-for-byte unmodified; that is the acceptance criterion for
this task.

- [ ] **Step 1: Rewrite `admin/channels/telegram/start/route.ts`**

```typescript
// src/app/api/admin/channels/telegram/start/route.ts
//
// POST /api/admin/channels/telegram/start — admin generates a one-time Telegram
// verification deep link + QR for owner scan.
//
// The full handler lives in the shared runChannelStart
// (@/app/api/_shared/channels/start); this route supplies only the Telegram +
// admin bindings. The owner equivalent at /api/dashboard/channels/telegram/start
// binds the same runner with resolveOwnerActor.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsTelegramEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { runChannelStart } from '@/app/api/_shared/channels/start';
import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelStart(sql, req, {
    channel: 'telegram',
    isEnabled: channelsTelegramEnabled,
    assertEnvReady: assertTelegramEnvReady,
    // Enrollment is a paid mutation — admin start keeps its strict gate (§4.2).
    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: true }),
  }),
);
```

- [ ] **Step 2: Rewrite `admin/channels/telegram/cancel/route.ts`**

```typescript
// src/app/api/admin/channels/telegram/cancel/route.ts
//
// POST /api/admin/channels/telegram/cancel — admin cancels a pending Telegram
// verification. Handler: runChannelCancel (@/app/api/_shared/channels/action).

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsTelegramEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { runChannelCancel } from '@/app/api/_shared/channels/action';
import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelCancel(sql, req, {
    channel: 'telegram',
    isEnabled: channelsTelegramEnabled,
    assertEnvReady: assertTelegramEnvReady,
    // No subscription gate: an admin must be able to tear down an enrollment on
    // a lapsed account (§4.2).
    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: false }),
  }),
);
```

- [ ] **Step 3: Rewrite `admin/channels/telegram/disable/route.ts`**

Identical to Step 2 with `runChannelDisable` in place of `runChannelCancel`,
imported from the same `@/app/api/_shared/channels/action`, and the header
comment reading `admin disables an active Telegram enrollment`.

```typescript
// src/app/api/admin/channels/telegram/disable/route.ts
//
// POST /api/admin/channels/telegram/disable — admin disables an active Telegram
// enrollment. Handler: runChannelDisable (@/app/api/_shared/channels/action).

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsTelegramEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { runChannelDisable } from '@/app/api/_shared/channels/action';
import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelDisable(sql, req, {
    channel: 'telegram',
    isEnabled: channelsTelegramEnabled,
    assertEnvReady: assertTelegramEnvReady,
    // No subscription gate: an admin must be able to tear down an enrollment on
    // a lapsed account (§4.2).
    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: false }),
  }),
);
```

- [ ] **Step 4: Rewrite the three WhatsApp admin routes**

Byte-identical to Steps 1–3 with these substitutions: `telegram` → `whatsapp`,
`channelsTelegramEnabled` → `channelsWhatsappEnabled`, `assertTelegramEnvReady`
→ `assertWhatsAppEnvReady`, and the env import path
`@/lib/notifications/channels/telegram-env` →
`@/lib/notifications/channels/whatsapp-env`. Keep the `start` route's existing
subscription-gate comment:

```typescript
// src/app/api/admin/channels/whatsapp/start/route.ts
//
// POST /api/admin/channels/whatsapp/start — admin generates a one-time WhatsApp
// verification deep link + QR for owner scan via wa.me click-to-chat.
//
// The full handler lives in the shared runChannelStart
// (@/app/api/_shared/channels/start); this route supplies only the WhatsApp +
// admin bindings.
//
// Subscription gate: strict full-access status. Dispatcher honors past_due grace
// at send time; admin enrollment mutations during grace require explicit active.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertWhatsAppEnvReady } from '@/lib/notifications/channels/whatsapp-env';
import { runChannelStart } from '@/app/api/_shared/channels/start';
import { resolveAdminActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelStart(sql, req, {
    channel: 'whatsapp',
    isEnabled: channelsWhatsappEnabled,
    assertEnvReady: assertWhatsAppEnvReady,
    resolveActor: (db, request) => resolveAdminActor(db, request, { requireFullAccess: true }),
  }),
);
```

- [ ] **Step 5: Run the admin regression net**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
pnpm test src/app/api/admin/channels 2>&1 | tail -20
git diff --stat HEAD -- src/app/api/admin/channels/telegram/__tests__ src/app/api/admin/channels/whatsapp/__tests__
```

Expected: all admin channel suites PASS, and `git diff --stat` prints **nothing**
for the `__tests__` paths. A non-empty diff there means the refactor changed
admin semantics — STOP and report rather than editing the test.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/channels
git commit -m "refactor(channels): bind the 6 admin routes to the unified runners"
```

---

### Task 7: Rebind the 6 owner routes

**Blocking edges:** T5. **Mutually independent with T6 and T8.**

**Files (modify all 6):**
- `src/app/api/dashboard/channels/telegram/{start,cancel,disable}/route.ts`
- `src/app/api/dashboard/channels/whatsapp/{start,cancel,disable}/route.ts`

- [ ] **Step 1: Rewrite `dashboard/channels/telegram/start/route.ts`**

```typescript
// src/app/api/dashboard/channels/telegram/start/route.ts
//
// POST /api/dashboard/channels/telegram/start — owner-scoped enrollment.
// Same runner as the admin route; the only difference is resolveOwnerActor,
// which reads locationId from the SESSION and never from the body.

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsTelegramEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { runChannelStart } from '@/app/api/_shared/channels/start';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelStart(sql, req, {
    channel: 'telegram',
    isEnabled: channelsTelegramEnabled,
    assertEnvReady: assertTelegramEnvReady,
    resolveActor: resolveOwnerActor,
  }),
);
```

- [ ] **Step 2: Rewrite the other five owner routes**

Identical shape. Substitutions per file:

| File | Runner | Import path | Channel | Flag | Env assert |
|---|---|---|---|---|---|
| `telegram/cancel/route.ts` | `runChannelCancel` | `_shared/channels/action` | `telegram` | `channelsTelegramEnabled` | `assertTelegramEnvReady` |
| `telegram/disable/route.ts` | `runChannelDisable` | `_shared/channels/action` | `telegram` | `channelsTelegramEnabled` | `assertTelegramEnvReady` |
| `whatsapp/start/route.ts` | `runChannelStart` | `_shared/channels/start` | `whatsapp` | `channelsWhatsappEnabled` | `assertWhatsAppEnvReady` |
| `whatsapp/cancel/route.ts` | `runChannelCancel` | `_shared/channels/action` | `whatsapp` | `channelsWhatsappEnabled` | `assertWhatsAppEnvReady` |
| `whatsapp/disable/route.ts` | `runChannelDisable` | `_shared/channels/action` | `whatsapp` | `channelsWhatsappEnabled` | `assertWhatsAppEnvReady` |

Every one binds `resolveActor: resolveOwnerActor` with no options object — the
owner gate is unconditional. For example,
`src/app/api/dashboard/channels/whatsapp/disable/route.ts`:

```typescript
// src/app/api/dashboard/channels/whatsapp/disable/route.ts
//
// POST /api/dashboard/channels/whatsapp/disable — owner-scoped disconnect.
// Handler: runChannelDisable (@/app/api/_shared/channels/action).

import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertWhatsAppEnvReady } from '@/lib/notifications/channels/whatsapp-env';
import { runChannelDisable } from '@/app/api/_shared/channels/action';
import { resolveOwnerActor } from '@/app/api/_shared/channels/resolve-actor';

export const POST = withSameOrigin()((req: NextRequest) =>
  runChannelDisable(sql, req, {
    channel: 'whatsapp',
    isEnabled: channelsWhatsappEnabled,
    assertEnvReady: assertWhatsAppEnvReady,
    resolveActor: resolveOwnerActor,
  }),
);
```

- [ ] **Step 3: Run the owner suites**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
pnpm test src/app/api/dashboard/channels 2>&1 | tail -30
```

Expected: every owner suite PASSES, including the four new `404 not_found`
cases from Task 2 and the backfilled `telegram/cancel` suite.

If a pre-existing owner test fails on a *query-order* mismatch rather than a
status, the queue-based mock has been mis-aligned — `resolveOwnerActor` must
issue exactly one query where the old inline code issued one. Do not add a
`sqlQueue.push` to paper over it; fix the query count.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/dashboard/channels
git commit -m "refactor(channels): bind the 6 owner routes to the unified runners"
```

---

### Task 8: Repair the non-route consumers and sweep the docs

**Blocking edges:** T3. **Mutually independent with T6 and T7.**

**Files:**
- Modify: `src/app/api/dashboard/channels/route.ts`
- Modify: `src/app/(authenticated)/settings/channels/page.tsx`
- Modify: `docs/directory.md`

- [ ] **Step 1: Repair `api/dashboard/channels/route.ts`**

Replace lines 13–15:

```typescript
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { whatsappEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
```

with:

```typescript
import { channelsTelegramEnabled, channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { whatsappEnvReady } from '@/lib/notifications/channels/whatsapp-env';
```

and change the call at line 28 from `if (!isTelegramEnabled()) return false;` to
`if (!channelsTelegramEnabled()) return false;`. Both channels now read their
flag the same way in this file.

- [ ] **Step 2: Repair `(authenticated)/settings/channels/page.tsx`**

Replace lines 20–22:

```typescript
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { whatsappEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
```

with:

```typescript
import { channelsTelegramEnabled, channelsWhatsappEnabled } from '@/lib/notifications/channels/flags';
import { assertTelegramEnvReady } from '@/lib/notifications/channels/telegram-env';
import { whatsappEnvReady } from '@/lib/notifications/channels/whatsapp-env';
```

and change line 38 from `if (!isTelegramEnabled()) return false;` to
`if (!channelsTelegramEnabled()) return false;`.

- [ ] **Step 3: Update `docs/directory.md`**

Delete the two rows describing the moved per-channel modules:

```
| `channels/telegram/_shared.ts` | `isTelegramEnabled()`, `flagOff()`, `assertTelegramEnvReady()` — shared by all Telegram admin routes. |
| `channels/whatsapp/_shared.ts` | `isWhatsAppEnabled()`, `flagOff()`, `assertWhatsAppEnvReady()` — shared by all WhatsApp admin routes. |
```

Add a `src/app/api/_shared/channels/` block to the `src/app/api/` section:

```markdown
### `src/app/api/_shared/channels/`

Shared by BOTH portals' channel routes — placed at the common ancestor of
`api/admin/channels/*` and `api/dashboard/channels/*` per the `_shared`
convention. All 12 enrollment routes are binding shims over these.

| File | Purpose |
|---|---|
| `resolve-actor.ts` | The **Channel actor** seam: `resolveAdminActor` (body `businessId` + admin MFA gate, optional full-access check) and `resolveOwnerActor` (session `locationId` + `resolveWritableAccountForLocation`). The only axis that varies between the portals. |
| `start.ts` | `runChannelStart` + the shared 4-field `ChannelRouteConfig`. Token mint → advisory-locked enrollment upsert → cache invalidate → QR/deep-link response. |
| `action.ts` | `runChannelCancel`, `runChannelDisable`. |
| `flag-off.ts` | `flagOff()` — the single "channel disabled" 404. Called by the runners directly, never a config field. |
```

Add the three new `src/lib/notifications/channels/` rows to that section's table:

```markdown
| `telegram-env.ts` | `assertTelegramEnvReady()` — 503 when `CHANNELS_TELEGRAM_ENABLED=true` but Telegram env is incomplete. `MOCK_EXTERNAL_APIS=true` bypasses. |
| `whatsapp-env.ts` | `missingWhatsAppEnv()`, `whatsappEnvReady()`, `assertWhatsAppEnvReady()`. `whatsappEnvReady()` is also read by the owner settings page and `GET /api/dashboard/channels` so the UI never offers a Connect button the start route would 503. |
| `deep-links.ts` | `buildMobileDeepLink(channel, rawToken)` — the single owner of the `t.me` / `wa.me` enrollment deep link, exhaustive over `MobileChannel`. Two per-portal copies had diverged twice before this. |
```

- [ ] **Step 4: Verify no owner→admin import remains**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
if rg -l 'app/api/admin/channels' src/app/api/dashboard src/lib 'src/app/(authenticated)'; then
  echo 'FAIL: an owner surface still imports an admin channel module'; exit 1
else
  echo 'PASS: no owner->admin channel import remains'
fi
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/channels/route.ts 'src/app/(authenticated)/settings/channels/page.tsx' docs/directory.md
git commit -m "refactor(channels): repair the non-route consumers and sweep directory.md"
```

---

### Task 9: Full gate

**Blocking edges:** T6, T7, T8.

- [ ] **Step 1: Run the verify gate**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification
bash scripts/verify-gate.sh 2>&1 | tail -30
```

Expected: every row PASS. Read only the failing rows' log tails from
`.feature/logs/`, never a full log.

- [ ] **Step 2: Run the live-DB integration suite (spec §7 mandate)**

```bash
TEST_DATABASE_POOL_URL="${TEST_DATABASE_POOL_URL:?set it — an existing-but-not-run suite is how #520 shipped}" \
  pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts 2>&1 | tail -20
```

Expected: PASS. A `SKIP` here is not acceptable for this branch — it is the only
end-to-end proof of the owner start path.

- [ ] **Step 3: Commit any gate-driven fixes, then re-run the gate**

The gate must be green before step 6 (deviations read-back) and step 7 (review).

---

## Self-review

**Spec coverage (§4):**

| Spec item | Task |
|---|---|
| §4.1 move `_shared` to the common ancestor | T3 (flag-off), T4 (resolve-actor), T5 (runners) |
| §4.1 `resolveAdminActor` / `resolveOwnerActor` | T4 |
| §4.1 all 12 routes become binding shims | T6, T7 |
| §4.1 `surface` drives audit tag + cache label | T4 (`ChannelActor.surface`), T5 (label composition), T2 Step 5 (test) |
| §4.2 subscription policy preserved, not merged | T4 (`requireFullAccess`), T6 (per-route binding), T2 Step 1 (tests) |
| §4.3 `no_account` → 404 on owner cancel/disable | T4 (`resolveOwnerActor`), T2 Steps 3–4 (tests) |
| §4.4 closes the owner→admin import | T3 (flag/env), T5 (runners), T8 Step 4 (mechanical check) |
| §4.4 deep-link divergence unspellable | T3 Step 3 (`deep-links.ts`), T2 Step 2 (tests) |
| §4.5 admin tests unmodified | T6 Step 5 + the intake's `git diff --quiet` gate command |
| §4.5 backfill owner telegram cancel test | T2 Step 3 |
| §4.5 new resolver unit tests | T2 Step 1 |
| §4.5 owner cancel/disable 404 tests | T2 Step 4 |
| §7 run `enroll-e2e.integration.test.ts` explicitly | T9 Step 2 |
| Transaction protocol (lock key, ordering, token-outside-tx) | T2b Step 1 |
| §4.2 gate posture proven at the *binding*, not just the resolver | T2b Step 2 |
| Admin no-store failure headers | T4 (`errorResponse`), T2b Step 2 (test) |
| `blocked` not over-applied as 404 | T2b Step 1 |
| Flag/env gate precedes auth on all three runners | T2b Step 1 |
| Enrollment token absent from `reportCaughtError` context | T2b Step 1 |

**Round-1 adversarial review** (`docs/reviews/refactor-channel-route-unification/plan-review-round-1.md`,
`VERDICT: REVISE`) returned 4 High + 6 Medium, all accepted. Every one was an
"eval can be green while the feature is wrong" finding rather than a prose
objection. Resolutions: High 1 → `resolveAdminActor` now returns `errorResponse()`
(T4); High 2 → admin-side cache-label test (T2b); High 3 → the whole runner
protocol suite (T2b); High 4 → the new owner-cancel suite uses a strict queue and
T2b's runner suite asserts exact statement text/order (partial accept — the five
pre-existing owner suites keep their lossy queue rather than being rewritten,
since the protocol is now pinned at the runner instead); Medium 1–5 → T2b;
Medium 6 → the T2/T2b → T3 blocking edge. The low-confidence note on the Telegram
`??`/`||` wording is also applied.

**Round-2 verification** (`plan-review-round-2.md`, `VERDICT: REVISE`) confirmed 8
of 10 closed but correctly rejected two, and found two defects the round-1 fixes
had introduced. All four accepted:

- **High 3 was only nominally closed.** The token test asserted the hash's
  *shape* (`/^[0-9a-f]{64}$/`), which is identical whether minting happened
  before `sql.begin` or inside it — a regression that moved it into the
  transaction would have kept the test green. Now `node:crypto`'s `randomUUID`
  and `createHash` are spied and record the **transaction depth at call time**;
  the assertion is `txDepth === 0` for both.
- **High 4's `mkSql` was not strict** — it recorded and returned `[]` for any
  unexpected query. Now every enrollment helper is mocked, which reduces each
  runner's own SQL to a single advisory lock, so the tests assert the
  **complete** log with `toEqual([lockedTx()])`. Added or reordered statements
  fail. Do not relax these to `toContain`.
- **`bindings.test.ts` fixtures undercounted** the real query sequences
  (`startMobileEnrollment` issues its own `SELECT … FOR UPDATE` + upsert;
  `disconnectChannel` issues the cascade + audit writes), so missing rows were
  absorbed as implicit `[]`. Resolved by taking round 2's own suggestion: the
  binding suite mocks the enrollment helpers and asserts **bindings**, leaving
  exact SQL to the runner suite. One accounts join per request, asserted.
- Two vacuous assertions replaced with positive proof: `not.toBe(403)` became
  `expect(disconnectMock).toHaveBeenCalledTimes(1)`, and the cancel case now
  asserts `cancelEnrollmentMock` was reached.

Round 2 also confirmed four implementation details this plan depends on:
`mkSql`'s tagged-template shape matches Postgres.js as the runners use it;
`startMobileEnrollment` argument index 4 is `tokenHash`; the `importOriginal`
mock is safe because `MobileChannel` is imported type-only; and Vitest 4 accepts
an `it.each` tuple carrying a function value with `%s` bound to the first field.

**Placeholder scan:** no `TBD`, no "similar to Task N" without repeated code, no
"add error handling". Task 6 Step 4 and Task 7 Step 2 use substitution tables
*plus* a full worked example, so a worker reading out of order still has complete
code.

**Type consistency:** `ChannelActor`, `ChannelActorResult`, `ChannelActorResolver`,
`AdminActorOptions`, `ChannelRouteConfig`, `runChannelStart`, `runChannelCancel`,
`runChannelDisable`, `resolveAdminActor`, `resolveOwnerActor`,
`buildMobileDeepLink`, `assertTelegramEnvReady`, `assertWhatsAppEnvReady`,
`whatsappEnvReady`, `missingWhatsAppEnv`, `flagOff` — each defined in exactly one
task and referenced with the same name and signature everywhere after.
`ChannelRouteConfig` is defined in `start.ts` and imported by `action.ts` as a
type-only import, so there is one definition, not two.
