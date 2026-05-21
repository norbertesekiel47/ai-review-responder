# Phase 4 — Owner Self-Service Channel Dashboard

_Design spec — RepWorth — 2026-04-28_

## Goal

Ship Phase 4 of the multi-channel notification system: an owner-facing settings page where the owner can manage their own approval-notification channels without sales-partner intervention.

The owner is **always** enrolled in email. They can pick **one** extra mobile channel — Telegram, SMS, or WhatsApp — to receive review-approval requests on. Only Telegram is implemented today; SMS is gated behind 10DLC, WhatsApp is gated behind Meta Business verification. Both render as "Coming soon" rows in this phase.

## Product context

- The architecture for multi-channel notifications was shipped in Phases 0–3 (`docs/adding-communication-channels.md`). All admin enrollment widgets (`TelegramEnrollmentWidget`, `SmsEnrollmentWidget`, `WhatsAppEnrollmentWidget`) already exist in `src/components/admin/`.
- Phase 4 was scoped in the original spec as the owner-facing dashboard. The original spec proposed routes under `/api/owner/...` and a page at `/dashboard/settings/channels`.
- This design **diverges from the original spec** in two ways, both motivated by codebase conventions established after the original spec was written:
  1. The page lives at `/settings/channels` (not `/dashboard/settings/channels`) because the existing settings page is at `/settings`, not `/dashboard/settings`.
  2. Owner API routes live under `/api/dashboard/channels/...` (not `/api/owner/channels/...`) to match the existing dashboard convention (`/api/dashboard/route.ts`, `/api/settings/route.ts`).

## Decisions (from brainstorming)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Page location | **`/settings/channels`** as a sub-page of the existing `/settings` page, with a tab strip at the top of `/settings` |
| 2 | Page layout | **Stacked rows** — email row (always-on), then a vertical list of the 3 extra channels |
| 3 | Widget architecture | **Extract `useEnrollment` hook** — refactor admin Telegram + WhatsApp widgets to use it, build owner widget on top |
| 4 | Channel switching UX | **Two-step (explicit)** — owner must disconnect current channel before connecting a new one |
| 5 | Pending-payment owners | **Hard redirect** via direct `subscription_status === 'active'` check in the server component (NOT `resolveWizardDestination` — that helper is wizard-specific and redirects already-onboarded owners to `/dashboard`) |
| 6 | Multi-channel enforcement | **DB-enforced** via migration 027 partial unique index, in addition to UI gating. All mobile-enrollment write paths (admin + owner) catch `23505` and return `409`. |

---

## 1. Scope & file inventory

### In scope

- New owner-facing page at `/settings/channels`
- Tab strip on `/settings` separating "General" (existing form) from "Notification channels" (new page)
- Extract `useEnrollment` hook from the existing admin `TelegramEnrollmentWidget`
- Refactor admin `TelegramEnrollmentWidget` AND admin `WhatsAppEnrollmentWidget` to use the hook
- New owner-facing thin Telegram widget (~50 lines) reusing the same hook
- 4 new owner API routes under `/api/dashboard/channels/`: status, telegram start/cancel/disable
- Migration 027: partial unique index enforcing one mobile channel per business
- SMS and WhatsApp render as static "Coming soon" rows — no widget required for Phase 4

### Out of scope

- SMS widget refactor (different state machine — phone+OTP, not QR/deep-link). Stays untouched.
- Owner SMS / WhatsApp widgets. Will be added when those channels become available — each is a ~30-line shell using the same hook.
- Settings page redesign. We add a tab strip; the existing form is unchanged.
- Supabase Realtime subscription for enrollment state. Polling (3s) is sufficient and matches the admin pattern.

### File inventory

```
NEW:
  supabase/migrations/027_one_mobile_channel_per_business.sql
  src/lib/notifications/channels/use-enrollment.ts            ← React hook (thin)
  src/lib/notifications/channels/enrollment-reducer.ts        ← pure state machine (unit tested)
  src/lib/notifications/channels/constants.ts                 ← TOKEN_TTL_MS, STATUS_POLL_INTERVAL_MS, TTL_TICK_INTERVAL_MS
  src/lib/channels/telegram-enrollment.ts                     ← shared transaction helpers
  src/lib/channels/unique-violation.ts                        ← detect 23505 → 409 mapping
  src/app/(authenticated)/settings/SettingsGeneralForm.tsx    ← extracted client form (was page.tsx body)
  src/app/(authenticated)/settings/channels/page.tsx          ← server component
  src/app/(authenticated)/settings/channels/ChannelsClient.tsx ← client wrapper
  src/components/dashboard/SettingsTabs.tsx                   ← tab strip nav
  src/components/dashboard/OwnerTelegramWidget.tsx            ← thin shell (~50 lines)
  src/components/dashboard/ComingSoonChannelRow.tsx           ← static row for SMS/WA
  src/app/api/dashboard/channels/route.ts                     ← GET status
  src/app/api/dashboard/channels/telegram/start/route.ts      ← POST
  src/app/api/dashboard/channels/telegram/cancel/route.ts     ← POST
  src/app/api/dashboard/channels/telegram/disable/route.ts    ← POST

MODIFIED:
  src/components/admin/TelegramEnrollmentWidget.tsx           ← refactor to use hook
  src/components/admin/WhatsAppEnrollmentWidget.tsx           ← refactor to use hook
  src/app/api/admin/businesses/[id]/channels/route.ts         ← additive: also SELECT verification_token_expires_at AS expires_at
  src/app/api/admin/channels/telegram/start/route.ts          ← extract logic to shared module + 23505 catch
  src/app/api/admin/channels/telegram/cancel/route.ts         ← extract logic to shared module
  src/app/api/admin/channels/telegram/disable/route.ts        ← extract logic to shared module
  src/app/api/admin/channels/sms/verify/route.ts              ← 23505 catch (migration 027 surface area)
  src/app/api/admin/channels/whatsapp/start/route.ts          ← 23505 catch (migration 027 surface area)
  src/app/(authenticated)/settings/page.tsx                   ← convert to server component shell + render tab strip + SettingsGeneralForm
```

---

## 2. The enrollment hook + reducer

Two-layer split so the state machine stays unit-testable in node without jsdom.

- `enrollment-reducer.ts` — pure state machine (no React, no fetch). Reducer-shaped: `(state, action) => state`. Holds 100% of the transition logic. Unit tested in node.
- `use-enrollment.ts` — thin React hook that wires the reducer to `fetch` calls, polling timers, and `AbortController` cleanup. Tested via Playwright E2E (the hook's React side runs in a real browser; vitest stays node-only).

### Locations

```
src/lib/notifications/channels/enrollment-reducer.ts   ← pure
src/lib/notifications/channels/use-enrollment.ts       ← React glue
```

### Reducer contract (pure — node-testable)

```ts
type EnrollmentState =
  | 'idle' | 'generating' | 'awaiting_scan' | 'verified'
  | 'disabled' | 'unsubscribed' | 'expired' | 'error';

interface EnrollmentSnapshot {
  state: EnrollmentState;
  handle: string | null;
  deepLink: string | null;
  qrDataUrl: string | null;
  expiresAt: number | null;            // epoch ms — easier to test than Date
  unsubscribedReason: string | null;
  errorMessage: string | null;
}

type EnrollmentAction =
  | { type: 'CONNECT_REQUESTED' }
  | { type: 'CONNECT_SUCCEEDED'; deepLink: string; qrDataUrl: string; expiresAt: number }
  | { type: 'CONNECT_FAILED'; status: number; message: string }
  | { type: 'STATUS_FETCHED'; row: ChannelEnrollmentRow | null; nowMs: number }
  | { type: 'CANCEL_SUCCEEDED' }
  | { type: 'DISABLE_SUCCEEDED' }
  | { type: 'TICK'; nowMs: number }
  | { type: 'DISMISS_ERROR' };

export function enrollmentReducer(
  state: EnrollmentSnapshot,
  action: EnrollmentAction,
): EnrollmentSnapshot;

export const initialEnrollment: EnrollmentSnapshot;
```

### Hook contract (React shell — Playwright-tested)

```ts
interface EnrollmentEndpoints {
  start: string;       // POST → { deepLink, qrDataUrl, expiresAt }
  cancel: string;      // POST → cancels pending verification
  disable: string;     // POST → disables verified enrollment
  status: string;      // GET  → { enrollments: ChannelEnrollmentRow[] }   ← canonical shape
}

interface UseEnrollmentOptions {
  channel: 'telegram' | 'whatsapp';
  endpoints: EnrollmentEndpoints;
  postBody?: Record<string, unknown>;     // admin sends { businessId }; owner sends {}
  pollIntervalMs?: number;                // default 3000
}

interface UseEnrollmentReturn {
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
```

### What the reducer owns

1. State machine transitions for every action shape.
2. Computing whether `expiresAt` has elapsed: when a TICK action arrives with `nowMs >= state.expiresAt`, transition `awaiting_scan → expired`. The hook owns the 1-second `setInterval` that dispatches TICK; the reducer never reads `Date.now()`.
3. Mapping pre-classified error actions (`CONNECT_FAILED` with status code) to the right snapshot fields (`errorMessage`, `state: 'error'`).

The reducer is pure: `(state, action) => state`. No I/O, no `Date.now()`, no array filtering — every input is in the action.

### `STATUS_FETCHED` transition table

The reducer's STATUS_FETCHED handler is the most subtle transition because it interleaves with the ongoing Connect flow. Explicit rules (every other STATUS_FETCHED case is "take the row's authoritative state"):

| Current state | row.status from `STATUS_FETCHED` | Next state |
| --- | --- | --- |
| `awaiting_scan` | `null` (no row found for this channel) | `awaiting_scan` (no-op — owner is mid-flow, do not reset) |
| `awaiting_scan` | `pending_verification` | `awaiting_scan` (no-op — preserve cached `expiresAt` and `qrDataUrl`) |
| `awaiting_scan` | `verified` | `verified` (webhook arrived; transition immediately) |
| `awaiting_scan` | `disabled` / `unsubscribed` | take the row's state (rare — admin or webhook killed it mid-flow) |
| `idle` / `verified` / `disabled` / `unsubscribed` / `expired` / `error` | (any) | take the row's authoritative state |
| `generating` | (any) | `generating` (no-op — wait for `CONNECT_SUCCEEDED` or `CONNECT_FAILED`) |

**`expiresAt` preservation invariant:** the canonical status payload includes `expires_at` (after the §4.1 admin-endpoint extension), but for the `awaiting_scan` no-op cases above, the reducer keeps the snapshot's existing `expiresAt` rather than overwriting from the row. This guarantees the QR countdown is driven by the value generated at start time and is not jittered by serialization round-trips through Postgres.

### What the hook owns

1. `fetch` calls to start / cancel / disable / status.
2. **Filtering the canonical `{ enrollments: [...] }` status payload by `channel` name** to find this widget's row, then dispatching `STATUS_FETCHED` with the resolved `row | null`.
3. **Error classification** — translating HTTP response codes (`401/403/404/503/network 0`) into either dispatched actions (`CONNECT_FAILED` with status + message) or silent ignore (network failures during polling are not dispatched; they surface only on manual user action).
4. 3-second polling loop while `awaiting_scan`, with `AbortController` cleanup.
5. 1-second TTL tick for the QR countdown — dispatches `TICK` actions.
6. Cleanup on unmount.

### What neither owns

- Rendering (no JSX).
- Knowledge of admin vs owner endpoints (config-driven).
- Channel-specific copy.
- Masking of `handle` for display (caller decides).

### Canonical status response shape

Both admin (`GET /api/admin/businesses/[id]/channels`) and owner (`GET /api/dashboard/channels`) return an `enrollments` array with the same per-row shape:

```ts
{
  enrollments: Array<{
    channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
    handle: string | null;       // already masked by the route per channel rules
    status: 'verified' | 'pending_verification' | 'disabled' | 'unsubscribed';
    verified_at: string | null;
    disabled_at: string | null;
    unsubscribed_at: string | null;
    unsubscribed_reason: string | null;
    expires_at: string | null;   // pending_verification only — null otherwise
  }>;
}
```

**Endpoint differences** (small and intentional):

- Admin response also includes `last_activity_at` per row (joined from `notification_deliveries`) — needed for the admin business dashboard, ignored by the hook.
- Owner response also includes top-level `available: { telegram, sms, whatsapp }` and `reasons: { sms, whatsapp }` — needed for the coming-soon UI, ignored by admin.

The hook is shape-agnostic about top-level fields — it only reads `enrollments[]` and filters by `channel` name. Same code path for admin and owner.

**Phase 4 admin endpoint extension:** the existing admin endpoint at `src/app/api/admin/businesses/[id]/channels/route.ts` does not return `expires_at` today. We add `e.verification_token_expires_at AS expires_at` to its SELECT as part of Phase 4. Additive change — no existing admin client reads `expires_at` from this payload, so no breakage.

### Migration safety for existing admin widgets

The hook's API surface maps cleanly onto what `TelegramEnrollmentWidget` and `WhatsAppEnrollmentWidget` already do internally. The refactor:

1. Replace local `useState`/`useEffect` with `useEnrollment(...)`.
2. Rebind JSX to `snapshot.*` / `actions.*`.
3. The widgets already fetch from a `{ enrollments: [...] }` shape — no payload-shape change for the admin path.

There are no existing widget unit tests in `src/components/admin/__tests__/` (verified). Regression coverage for the admin refactor comes from Playwright E2E (see §7) plus reducer unit tests covering every state transition.

---

## 3. Page UI structure

### Tab strip on `/settings`

Two tabs at the top: "General" (existing form) and "Notification channels" (new page). Active tab gets the cyan underline. Both routes render the same page shell + tab strip; only the body changes.

### Page body — `/settings/channels`

```
┌─────────────────────────────────────────────────────────────┐
│  Notification channels                                       │
│  Choose where you get review approval requests.              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ✉️  Email                                       Always on   │
│      norbert@example.com                                     │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  Pick one extra channel                                      │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 💬  Telegram                              [Disconnect] │  │
│  │     ✓ Connected · ••• 1234                             │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 📱  SMS                                  Coming soon   │  │
│  │     Available once 10DLC verification clears           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 🟢  WhatsApp                             Coming soon   │  │
│  │     Available once Meta business verification clears   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Telegram row state machine

| State | Row appearance |
| --- | --- |
| `idle` | Logo + "Telegram" + "Get approval requests in Telegram" subtext + `Connect` button |
| `generating` | Spinner + "Generating link…" |
| `awaiting_scan` | QR expands inline, deep link as desktop fallback, 1h countdown, `Cancel` button (calls `/cancel`, NOT `/disable` — `/disable` only accepts `verified` rows and would 404) |
| `verified` | ✓ Connected · ••• 1234 + `Disconnect` button (cyan accent border). The `Disconnect` button renders ONLY in this state — never in `awaiting_scan`, `pending_verification`, or any other state. This invariant prevents the owner from generating a 404 by clicking Disconnect on a non-verified row. |
| `disabled` | "Disabled — reconnect to receive approvals" + `Reconnect` button |
| `unsubscribed` | "You blocked the bot — start the bot in Telegram, then reconnect" + `Reconnect` button |
| `expired` | "QR expired" + `Generate new link` button |
| `error` | Red border + error message + `Try again` button |

### Coming-soon rows (SMS, WhatsApp)

- Muted styling (~50% opacity, no hover).
- Status badge "Coming soon" on the right.
- One-line subtext explaining the gating.
- **No button at all** — the row is purely informational. There is no `Connect` button to disable, no tooltip, no hover state.

### Switching channel UX (future, when SMS / WhatsApp ship)

When SMS / WhatsApp become available, those rows will render their own widget shells (mirroring `OwnerTelegramWidget`) with a real `Connect` button. At that point:

- **Client-side gating** — if a different mobile channel is currently `verified` or `pending_verification`, the new row's `Connect` button shows the disabled visual state with a hover tooltip "Disconnect your current channel first."
- **Server-side enforcement** — migration 027's partial unique index causes the second `INSERT` to fail with `23505`. All four mobile-enrollment write paths (admin Telegram, admin SMS verify, admin WhatsApp start, owner Telegram start) catch `23505` and return `409 Conflict` with a clear error message.

Phase 4 implements only the Telegram owner flow + the static coming-soon rows. The disabled-button logic ships with the SMS / WhatsApp owner widgets in a later phase.

### Brand styling

Following the `repworth-brand-design` skill — cyan accent for verified state, dark slate background, rounded card edges, thin dividers between rows. The skill is invoked during implementation.

---

## 4. API routes

Four new owner-scoped routes under `/api/dashboard/channels/`. All follow the existing dashboard pattern: `requireRole(req, 'owner')` extracts `businessId` from session; `businessId` is **never** read from request body.

### 4.1 `GET /api/dashboard/channels` — status endpoint

Returns the same enrollment row shape as the admin endpoint (`/api/admin/businesses/[id]/channels`) — we extend the admin endpoint as part of Phase 4 so it ALSO emits `expires_at` (additive change; no existing admin client reads `expires_at`, so no breakage). The owner endpoint drops `last_activity_at` (admin needs it for the dashboard; owner doesn't, and computing it requires a join to `notification_deliveries` that is not worth doing on every poll). The owner endpoint adds top-level `available` + `reasons` so the page can render coming-soon rows.

```ts
// Owner response
{
  enrollments: Array<{
    channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
    handle: string | null;        // masked per channel rules (matches admin route)
    status: 'verified' | 'pending_verification' | 'disabled' | 'unsubscribed';
    verified_at: string | null;
    disabled_at: string | null;
    unsubscribed_at: string | null;
    unsubscribed_reason: string | null;
    expires_at: string | null;    // pending_verification only; null otherwise
  }>;
  available: {
    telegram: boolean;             // CHANNELS_TELEGRAM_ENABLED AND telegram env-ready
    sms: boolean;                  // CHANNELS_SMS_ENABLED AND sms env-ready
    whatsapp: boolean;             // CHANNELS_WHATSAPP_ENABLED AND whatsapp env-ready
  };
  reasons: {
    sms: 'pending_10dlc';
    whatsapp: 'pending_meta_verification';
  };
}
```

**Admin endpoint additive change** (`src/app/api/admin/businesses/[id]/channels/route.ts`): add `e.verification_token_expires_at AS expires_at` to the SELECT and to the response row type. The `last_activity_at` subquery stays for admin only. Existing admin widgets continue to work — they don't read `expires_at` from this payload today (they get it from the `start` route response). The new field becomes available for the refactored hook.

When a channel has no enrollment row, the `enrollments` array simply does not contain an entry for it. The page composes the display rows from this canonical shape:

- For each channel in `['email','telegram','sms','whatsapp']` order, find the matching `enrollments` entry (if any).
- If `available[channel] === false`, render the coming-soon row regardless of enrollment.
- If `available[channel] === true` and there's no entry, render the channel's `idle` state.

Headers: `Cache-Control: no-store, private`. Dynamic rendering: `export const dynamic = 'force-dynamic'`.

### 4.2 `POST /api/dashboard/channels/telegram/start`

Empty body. Mirrors `/api/admin/channels/telegram/start` but with owner auth + `businessId` from session.

Reuses the existing transaction logic — same advisory lock, same state machine (none / pending / unsubscribed / disabled → `pending_verification`; verified → `409`). Same response shape: `{ deepLink, qrDataUrl, expiresAt }`. Same `Cache-Control: no-store, private` header.

**Refactor:** Extract the transaction body from `/api/admin/channels/telegram/start/route.ts` into `src/lib/channels/telegram-enrollment.ts`. Explicit signature:

```ts
import type { TransactionSql } from 'postgres';

export type StartTelegramResult =
  | { kind: 'ok' }
  | { kind: 'already_verified' };

export async function startTelegramEnrollment(
  tx: TransactionSql,
  businessId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<StartTelegramResult>;
```

**Caller responsibilities:**

1. The caller generates `rawToken` (returned to the client) + `tokenHash = sha256(rawToken)` + `expiresAt = now + 1h` BEFORE calling `sql.begin`, so the secret is never derived inside a tx that might roll back.
2. The caller opens `sql.begin(async (tx) => {...})` and calls `startTelegramEnrollment(tx, ...)` from inside the callback. The helper does NOT open its own transaction.
3. The caller acquires the advisory lock (`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`) inside the same tx before invoking the helper. Lock acquisition stays in the route to keep the helper composable with non-locked callers (e.g., test fixtures).
4. After the tx commits, the caller generates the QR data URL (`QRCode.toDataURL`) outside the tx — heavy I/O shouldn't hold a connection.

Both admin and owner routes call this same helper. The helper itself takes `businessId` as a parameter; neither route trusts it from a body.

**23505 handling (migration 027 surface area):** The helper wraps its INSERT/UPDATE in a try/catch. On `code === '23505'` AND `constraint_name === 'channel_enrollments_one_mobile_per_biz'`, the helper throws `MultipleMobileChannelsError` from `src/lib/channels/unique-violation.ts`. Any OTHER 23505 (e.g., a hypothetical future constraint) is rewrapped as `EnrollmentDatabaseError` so the raw Postgres error never reaches the route handler — preventing `constraint_name` leakage in 500 responses.

Both admin and owner routes catch `MultipleMobileChannelsError` and return `409 Conflict` with body `{ error: 'multiple_mobile_channels' }`. The same catch is added to `/api/admin/channels/sms/verify/route.ts` (the catch goes INSIDE the existing `withSmsEnrollmentLock` callback so the lock-release order is preserved) and `/api/admin/channels/whatsapp/start/route.ts`.

Errors: `404` (channel flag off), `503` (env not ready), `403` (subscription not active), `409` (already verified OR another mobile channel already pending/verified).

### 4.3 `POST /api/dashboard/channels/telegram/cancel`

Empty body. Cancels an in-flight `pending_verification` row. Returns `{ ok: true }` or `404` if no pending row. Reuses logic from `/api/admin/channels/telegram/cancel`. Extract into:

```ts
export async function cancelTelegramEnrollment(
  sql: Sql,            // not a `tx` — cancel is idempotent and does not need atomicity beyond the single UPDATE statement
  businessId: string,
): Promise<{ kind: 'ok' | 'not_found' }>;
```

The helper does NOT take an advisory lock and does NOT open `sql.begin` — a single UPDATE is atomic, and concurrent cancel + cancel produces the same end state. This deliberately matches the existing admin cancel route's no-lock semantics; we are not adding a lock during refactor.

### 4.4 `POST /api/dashboard/channels/telegram/disable`

Empty body. Owner-initiated disconnect. Flips `verified` → `disabled`, sets `disabled_at = NOW()`, clears `handle` (so re-enrollment doesn't reuse the old chat_id). Reuses logic from `/api/admin/channels/telegram/disable`. Extract into:

```ts
export async function disableTelegramEnrollment(
  sql: Sql,
  businessId: string,
): Promise<{ kind: 'ok' | 'not_found' }>;
```

Same single-UPDATE pattern as cancel — no `sql.begin`, no advisory lock. The UPDATE filters `WHERE status = 'verified' AND archived_at IS NULL`, which means a `pending_verification` row will not be disabled via this route (use `/cancel` instead). See §3 state machine for the UI contract that prevents this case.

### 4.5 Subscription guard

All four routes:

```ts
SELECT subscription_status FROM businesses WHERE id = ${businessId}
```

If `subscription_status !== 'active'` → `403`. The page server component does its own `subscription_status === 'active'` check during SSR (see §5) and redirects non-active owners to `/onboarding/pay` before the page renders. The route-level check is defense-in-depth.

### 4.6 Concurrency

All POST routes take a Postgres advisory lock keyed on `hash('telegram_enroll:' + businessId)` inside the transaction. The shared transaction helpers preserve this. Two browser tabs racing the Connect button get serialized; the loser sees the winner's state on next polling tick.

### 4.7 Same-origin protection

Owner POST routes are wrapped with `withSameOrigin()` from `src/lib/auth/route-helpers.ts` — the existing same-origin enforcement used on owner mutations. Returns `403` when the `Origin` header is absent, mismatched, or `NEXT_PUBLIC_APP_URL` is misconfigured.

**Asymmetry note:** Admin Telegram routes (`/api/admin/channels/telegram/{start,cancel,disable}/route.ts`) do NOT currently use `withSameOrigin()` — verified at the time of writing this spec. The shared transaction helpers introduced in §4.2/4.3/4.4 are wrapper-agnostic. We add `withSameOrigin()` to the new owner routes only because owner credentials are CSRF-targetable from cross-site forms (owners are a much larger population than admins). Bringing the existing admin routes in-scope for the wrapper is a separate hardening task and is intentionally NOT in Phase 4.

---

## 5. Data flow & auth scoping

### `/settings` page restructuring (fix for the existing client-only page)

The current `/settings/page.tsx` is a single client component (`'use client'` at line 1). It does its own client-side auth/redirect for `pending_payment` owners by reading `/api/dashboard` and calling `window.location.href`. We can't add a shared server-rendered tab strip without restructuring.

**Restructure:**

1. Extract the existing form body into `src/app/(authenticated)/settings/SettingsGeneralForm.tsx` — still `'use client'`, fetches the same `/api/dashboard` data, identical behavior. No logic changes.
2. Convert `src/app/(authenticated)/settings/page.tsx` into a server component:
   - Server-component auth pattern matches `src/app/(authenticated)/layout.tsx:12`: `const cookieStore = await cookies();` (use `await` for forward-compat with Next 15 where `cookies()` returns a Promise — under Next 14 awaiting a sync value is harmless). Then `createServerClient` from `@supabase/ssr` → `await supabase.auth.getUser()`. Server components don't receive a `NextRequest`, so `requireRole(req, ...)` from `src/lib/db/auth.ts` cannot be used here — that helper is for route handlers only.
   - Direct SQL lookup: `SELECT u.role, b.id AS business_id, b.subscription_status FROM users u JOIN businesses b ON b.id = u.business_id WHERE u.auth_id = ${authUser.id}`.
   - Guard: no auth user → `redirect('/admin/login')`. No row → `redirect('/admin/login')`. Role mismatch → `redirect('/admin/overview')`. Non-active subscription → `redirect('/onboarding/pay')`. Helpers from `next/navigation`.
   - Renders `<SettingsTabs activeTab="general" /><SettingsGeneralForm />`.
3. Create `src/app/(authenticated)/settings/channels/page.tsx` as a server component using the same `cookies() + Supabase + direct SQL guard` pattern, then renders `<SettingsTabs activeTab="channels" /><ChannelsClient initialEnrollments={...} initialAvailability={...} />`.
4. `SettingsTabs` is a server component (just two `<Link>` elements with active-state styling — no interactivity needed).

This means the existing settings page gets a small refactor (~30 lines moved between two files) before the channels page lands. It's mechanical and reversible.

### Server / client component split for `/settings/channels`

```
/settings/channels (route)
├── page.tsx                 ← Server Component
│   ├── const cookieStore = await cookies()
│   ├── createServerClient → supabase.auth.getUser()
│   ├── If no authUser → redirect('/admin/login')
│   ├── SELECT u.role, b.id AS business_id, b.subscription_status, u.email AS owner_email
│   │     FROM users u JOIN businesses b ON b.id = u.business_id
│   │     WHERE u.auth_id = ${authUser.id}
│   ├── If no row → redirect('/admin/login')
│   ├── If role !== 'owner' → redirect('/admin/overview')
│   ├── If subscription_status !== 'active' → redirect('/onboarding/pay')
│   ├── Compute env-readiness for each channel (flag + required envs present)
│   ├── Single SQL query against channel_enrollments (canonical shape)
│   └── Render <SettingsTabs activeTab="channels" /> + <ChannelsClient
│         initialEnrollments={...}     ← canonical { enrollments: [...] } shape
│         initialAvailability={...}    ← { telegram, sms, whatsapp } booleans (flag AND env-ready)
│         ownerEmailFallback={ownerEmail}  ← used if no email row exists yet
│       />
│
└── ChannelsClient.tsx       ← Client Component
    ├── Hydrates with initial props (no flash of empty state on load)
    ├── Composes display rows: email + 3 channel rows
    └── <OwnerTelegramWidget /> uses useEnrollment({
          channel: 'telegram',
          endpoints: {
            start:  '/api/dashboard/channels/telegram/start',
            cancel: '/api/dashboard/channels/telegram/cancel',
            disable:'/api/dashboard/channels/telegram/disable',
            status: '/api/dashboard/channels'
          },
          postBody: {}
        })
```

Route handlers (`/api/dashboard/channels/...`) continue to use `requireRole(req, 'owner')` because they receive a `NextRequest`. Only the server components use the `cookies() + Supabase` pattern shown above.

### Why a direct subscription check, NOT `resolveWizardDestination`

`resolveWizardDestination` (`src/app/onboarding/business/guard.ts`) is wizard-specific. It redirects already-onboarded active owners (those with `place_id_verified` or `google_maps_url`) to `/dashboard` (line 33). Since every owner using the channels page is by definition already onboarded, that helper would bounce all of them away. We do our own targeted check inline in the server component:

```ts
// Inside the server component, after cookies() + supabase.auth.getUser()
const [row] = await sql<{ role: string; business_id: string; subscription_status: string }[]>`
  SELECT u.role, b.id AS business_id, b.subscription_status
  FROM users u
  JOIN businesses b ON b.id = u.business_id
  WHERE u.auth_id = ${authUser.id}
`;
if (!row || row.role !== 'owner') redirect('/admin/overview');
if (row.subscription_status !== 'active') redirect('/onboarding/pay');
const businessId = row.business_id;
```

### Server-side initial query

```sql
SELECT
  ce.channel,
  ce.status,
  ce.handle,
  ce.verified_at,
  ce.disabled_at,
  ce.unsubscribed_at,
  ce.unsubscribed_reason,
  ce.verification_token_expires_at AS expires_at
  -- INTENTIONALLY EXCLUDED: ce.verification_token_hash. Only the expiry
  -- timestamp is exposed (so the UI can render a countdown). The hash
  -- never leaves the server.
FROM channel_enrollments ce
WHERE ce.business_id = ${businessId}
  AND ce.archived_at IS NULL
```

Composes the response shape from this rowset + reads three feature flags from `process.env`:

- `CHANNELS_TELEGRAM_ENABLED` AND env-ready (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` present, or `MOCK_EXTERNAL_APIS=true`) → `available.telegram = true`
- `CHANNELS_SMS_ENABLED` AND SMS env-ready → `available.sms = true`
- `CHANNELS_WHATSAPP_ENABLED` AND WA env-ready → `available.whatsapp = true`

Server-side env readiness check uses the same logic as the route-level `assertTelegramEnvReady()` / `assertChannelsSmsEnv()` / `assertChannelsWhatsAppEnv()` so the page UI never advertises a Connect button that would 503 on click.

State matrix:

- `available[ch] === false` → render "Coming soon" row regardless of enrollment.
- `available[ch] === true` AND missing enrollment row → render `idle` (`Connect` CTA).
- `available[ch] === true` AND verified row → render "Connected ··· Disconnect."

### Email row fallback (Google-OAuth signup gap)

Per CLAUDE.md lab note (2026-04-24), Google-OAuth-signed-up businesses can land here BEFORE `EmailChannelReconcilePoller` (10-min interval) inserts their email enrollment row. The page must not render a blank email handle in that window.

The server query also reads `users.email AS owner_email` (added to the auth lookup query above). The `ChannelsClient` composer uses this as a fallback:

- If `enrollments` contains an `email` row → render with `enrollments[email].handle`.
- Else → render with `ownerEmailFallback` and badge it "Reconciling…".

The reconciliation poller will catch up within 10 minutes; the badge disappears on the next page load.

### Auth invariants

- `requireRole(req, 'owner')` validates the JWT against Supabase on every call (not cached).
- Routes use `user.businessId` — never the request body.
- No client-side `business_id`. The owner page never sees or sends one.

### No Supabase Realtime

Polling (3s while `awaiting_scan`) is sufficient. Realtime adds connection management complexity for a 1-minute window of polling.

### Pending-payment redirect

The server component's direct `subscription_status === 'active'` check redirects non-active owners to `/onboarding/pay` before any UI renders. Defense-in-depth: the API routes also return `403` if `subscription_status !== 'active'`. (We deliberately do NOT use `resolveWizardDestination` here — see "Why a direct subscription check" above.)

---

## 6. Edge cases, security, error handling

### 6.1 Edge case matrix

| # | Edge case | Mitigation |
| --- | --- | --- |
| 1 | Owner submits forged `businessId` to bypass scoping | Routes never read `businessId` from request body. `businessId` from `requireRole(req, 'owner').businessId`. Body schemas use Zod `.strict()` to reject extra fields. |
| 2 | Two browser tabs racing Connect | Postgres advisory lock serializes the start. The loser's UPDATE overwrites the winner's hash + expiry, so both tabs display visually-valid QRs but only the most recent token is accepted by the worker. The polling endpoint cannot detect the difference (both rows look `pending_verification` to both tabs); this is a documented edge case — owners should use a single tab for enrollment. |
| 3 | Owner clicks Connect on `verified` enrollment (state mismatch from stale tab) | Server returns `409 Conflict`. Hook surfaces "Already connected — refresh to see status" and calls `refresh()` automatically. |
| 4 | Raw verification token leakage | Token is in `deepLink` and `qrDataUrl` only, returned once with `Cache-Control: no-store, private`, never persisted (only SHA-256 hash stored). The hook holds the deepLink in React state — never logs it, never sends to error trackers. Console spy in tests asserts no leakage on every error path. |
| 5 | Owner's session expires mid-flow | Hook treats `401/403` from any endpoint as "Session expired" — pushes state to `error` with a "Sign in again" message + link to `/login`. Polling stops. |
| 6 | Telegram webhook arrives before page polls | Polling fetches `GET /api/dashboard/channels`, which reads the post-verification row. State transitions `awaiting_scan → verified` on next tick per the §2 transition table. SSR race: if the webhook fires DURING the SSR query window, hydration shows `verified` immediately (no polling needed). If between SSR and hydration, the next poll catches it within ≤3s. |
| 7 | Owner blocks the bot in Telegram | Existing flow: `NotificationWorker` catches `TelegramRecipientBlockedError`, flips enrollment to `unsubscribed` with reason `telegram_blocked`. Owner returns to the page → row shows guidance + `Reconnect` button. |
| 8 | Subscription becomes `cancelled` mid-flow | Next POST returns `403`. Hook surfaces it. Existing `subscription-guard.ts` covers worker-side fallthrough. |
| 9 | `archived_at IS NOT NULL` row exists | Status query filters `archived_at IS NULL`. State-machine UPDATEs in start/cancel/disable also filter on `archived_at IS NULL`. Migration 022's partial unique index `channel_enrollments_business_channel_active_key` already guarantees AT MOST ONE non-archived row per `(business_id, channel)` — the SSR query cannot return duplicates. |
| 10 | `CHANNELS_TELEGRAM_ENABLED` flips off mid-session | Routes return `404`. Hook surfaces "Telegram is currently unavailable." Page falls back to coming-soon row on next refresh. |
| 11 | Worker env (e.g., `TELEGRAM_BOT_TOKEN`) missing | The page server component computes env-readiness alongside the feature flag (see §5). When env is missing, `available.telegram = false` and the row renders as Coming Soon — the owner never sees a `Connect` button that would 503. If env vanishes mid-session (between page load and click), the route returns `503` and the hook surfaces "Service temporarily unavailable, please try again." This becomes a permanent error in practice but only for the rare race where env was stripped while a session was open. |
| 12 | CSRF on POST routes | `withSameOrigin()` wrapper from `src/lib/auth/route-helpers.ts`. Returns `403` on missing/mismatched `Origin` header. |
| 13 | Switching channels (when SMS/WA ship) | Client-side: future SMS/WA owner widgets disable their Connect buttons while a different mobile channel is `verified`/`pending_verification`. Server-side: migration 027 partial unique index. **All four mobile-enrollment writers** catch Postgres `23505` AND `constraint_name === 'channel_enrollments_one_mobile_per_biz'` and return `409` with `{ error: 'multiple_mobile_channels' }`: admin Telegram start, admin SMS verify (catch goes inside the existing `withSmsEnrollmentLock` callback), admin WhatsApp start, owner Telegram start. Any OTHER 23505 is rewrapped as `EnrollmentDatabaseError` and surfaces as a generic 500 — the raw Postgres error never reaches the client, so `constraint_name` cannot leak via 500 bodies. The shared `MultipleMobileChannelsError` type and 23505 detector live in `src/lib/channels/unique-violation.ts`. |
| 14 | Polling loop leaks on unmount | `AbortController` in the hook's polling effect; cleanup runs on unmount. Existing pattern from admin widgets. |
| 15 | Owner shares Telegram QR with a malicious third party | Whoever scans the QR first becomes the recipient — token has no further binding to the owner's Telegram account. Mitigation: 1h TTL; owner can `Disconnect` and re-enroll at any time. Same threat model as admin enrollment, accepted as out of Phase 4 scope. |
| 16 | Owner clicks `Cancel` from `awaiting_scan` | The `Cancel` button calls `/cancel` (NOT `/disable`). `/cancel` returns 200 on success and the hook transitions back to `idle`. The `Disconnect` button is never rendered in `awaiting_scan` (see §3 row state machine), so a `disable`-on-pending 404 is structurally impossible. |

### 6.2 Migration 027 — partial unique index

Enforces "one mobile channel per business" at the DB level so a buggy client or future API path can't slip past the UI gate.

```sql
-- supabase/migrations/027_one_mobile_channel_per_business.sql
CREATE UNIQUE INDEX channel_enrollments_one_mobile_per_biz
  ON channel_enrollments (business_id)
  WHERE channel IN ('sms','telegram','whatsapp')
    AND status IN ('pending_verification','verified')
    AND archived_at IS NULL;
```

**Predicate exclusions are intentional** — `disabled` and `unsubscribed` rows are deliberately NOT covered so that an owner's enrollment history (e.g., previously-verified Telegram now disabled) coexists with a freshly-pending different mobile channel. Tightening the predicate to include `disabled`/`unsubscribed` would force destructive deletes on channel switches and break the audit trail. Future readers: do not narrow this predicate without revisiting the switch-channel UX flow in §3.

Routes catch `23505` (specifically `constraint_name === 'channel_enrollments_one_mobile_per_biz'`) and return `409 Conflict` with body `{ error: 'multiple_mobile_channels' }`. See §6.1 row 13 for the full error-handling contract.

### 6.3 Logging

- Use `logger` from `src/lib/shared/logger.ts` with structured fields (`businessId`, `channel`, `action`, `correlation_id`).
- Never log the `deepLink`, raw token, or `qrDataUrl`.
- Hook tests assert with a console spy across all error paths.

### 6.4 Sentry

- Errors bubble through existing route-level handlers; nothing custom needed.
- Filter out routine `401/403/409` noise to keep the inbox clean.

---

## 7. Testing strategy

Three layers + regression coverage for the admin refactor.

### 7.1 Unit (Vitest, node — no jsdom required)

The repo's vitest config (`vitest.config.ts:7`) is `environment: 'node'`. We do not add jsdom or React Testing Library. Unit tests target only pure functions; the React hook is exercised end-to-end via Playwright (§7.3).

**Pure enrollment reducer** — `src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts`

- Every transition for every action shape on every state (8 states × ~8 action types — exhaustive table-driven test).
- STATUS_FETCHED transition table from §2 (every cell): `awaiting_scan` × `null` → no-op; `awaiting_scan` × `pending_verification` → no-op (preserves cached `expiresAt`); `awaiting_scan` × `verified` → `verified`; `awaiting_scan` × `disabled`/`unsubscribed` → take row's state. Idle/verified/etc. × any → take row's authoritative state. `generating` × any → no-op.
- `expiresAt` preservation: STATUS_FETCHED in `awaiting_scan` does NOT overwrite snapshot's `expiresAt` from the row, even when the row carries one.
- TICK action: `nowMs >= expiresAt` while in `awaiting_scan` → `expired`; same TICK with `nowMs < expiresAt` → unchanged.
- Error classification: action carrying `status: 401|403` → `error` with "Session expired"; `404` → `error` with "Channel disabled"; `503` → `error` with "Service unavailable"; status `0` (network) is documented but not surfaced from the reducer (the hook decides whether to dispatch silently or as error).
- Pure-function invariant: same `(state, action)` always produces the same next state. No `Date.now()`, no `Math.random()`, no I/O inside the reducer.

**Shared transaction helpers** — `src/lib/channels/__tests__/telegram-enrollment.test.ts`

- `startTelegramEnrollment(tx, businessId, tokenHash, expiresAt)` with a mocked `tx` queue: every state-machine case (none / pending / unsubscribed / disabled / verified). Test fixtures supply pre-generated `tokenHash` + `expiresAt` since the helper no longer derives them.
- Helper does NOT take an advisory lock (caller's responsibility — verified the helper emits no `pg_advisory_xact_lock` SQL).
- 23505 → `MultipleMobileChannelsError`: when the mocked `tx` throws a `PostgresError` with `code='23505'` and `constraint_name='channel_enrollments_one_mobile_per_biz'`, the helper throws `MultipleMobileChannelsError`.
- 23505 → `EnrollmentDatabaseError`: when the mocked `tx` throws `code='23505'` with ANY other `constraint_name` (e.g., a hypothetical `channel_enrollments_handle_unique`), the helper rewraps as `EnrollmentDatabaseError` with the original message scrubbed. The raw `PostgresError` is NEVER re-thrown.
- Non-23505 errors (`code='40001'` serialization failure, etc.) re-throw unchanged.
- `cancelTelegramEnrollment(sql, businessId)` and `disableTelegramEnrollment(sql, businessId)`: returns `{ kind: 'ok' | 'not_found' }` based on UPDATE row count. Idempotent on duplicate calls.

**Shared 23505 detector** — `src/lib/channels/__tests__/unique-violation.test.ts`

- `isMultipleMobileChannelsError(err)` returns true only for `code === '23505'` AND `constraint_name === 'channel_enrollments_one_mobile_per_biz'`. False for any other 23505 or non-Postgres error.

### 7.2 Integration (Vitest + real Supabase, when `TEST_DATABASE_POOL_URL` set)

**Owner API routes** — `src/app/api/dashboard/channels/__tests__/`

For each of the 4 routes:

- Auth: unauthenticated → `401`; admin role with no business → `403`; owner with `pending_payment` → `403`.
- BusinessId scoping: forged body fields ignored. Cross-tenant attempt never mutates another owner's row.
- State machine end-to-end against real Postgres.
- Idempotency: duplicate POST → no-op or same-state response.
- Concurrency: parallel requests serialize via advisory lock — at most one row in `pending_verification`.

**Migration 027 partial unique index**

- INSERT verified Telegram row → INSERT pending SMS row for same business → expect Postgres `23505` with `constraint_name = 'channel_enrollments_one_mobile_per_biz'`.
- Same business, same channel, both archived: allowed.
- Existing admin SMS / admin WhatsApp / owner Telegram start routes return `409` (not 500) when the index trips. Each route gets a dedicated 23505 integration test.

**Status endpoint shape**

- `GET /api/dashboard/channels` for each combination (no enrollments / pending / verified / disabled / unsubscribed) returns the canonical `{ enrollments: [...], available: {...}, reasons: {...} }` shape exactly.

### 7.3 E2E (Playwright)

Playwright covers everything that touches React (the hook + page components). The repo's existing E2E setup runs against the dev server with a real Supabase test DB.

**`tests/e2e/owner-channels.spec.ts`** — owner flow. Skips gracefully without `TEST_DATABASE_POOL_URL`.

- Sign in → navigate to `/settings/channels` → page renders with email row + Telegram row + 2 coming-soon rows.
- Click Connect on Telegram → QR + deep link appear → simulate verification webhook (POST to a `tests/e2e/helpers/telegram-test-ingress.ts` helper that synthesizes a valid Telegram update with the correct `X-Telegram-Bot-Api-Secret-Token` header) → polling tick → row flips to ✓ Connected. **Implementation note:** verify the helper file exists or write it in step 16 of Appendix A — the existing E2E suite does not currently include a Telegram ingress simulator.
- Click Disconnect on verified row → row flips back to idle.
- Non-active subscription owner navigating to `/settings/channels` lands on `/onboarding/pay`.
- Coming-soon rows: assert no button is present (text "Coming soon" badge only).
- Tab strip: clicking "General" navigates back to `/settings` and shows the existing form; URL changes correctly.
- Cross-channel: with Telegram verified, the SMS / WhatsApp coming-soon rows still render their static "Coming soon" — UI is unchanged regardless of Telegram state in Phase 4.

**`tests/e2e/admin-channels-refactor.spec.ts`** — regression coverage for the hook refactor of the admin Telegram + WhatsApp widgets.

- Admin opens a business detail page → Telegram widget renders with the same states the pre-refactor widget rendered (idle / awaiting_scan / verified / disabled paths).
- Same path for the WhatsApp widget under `CHANNELS_WHATSAPP_ENABLED=true`.
- Each test asserts the visible text + button labels — not pixel-perfect snapshots.

### 7.4 Regression — admin widget refactor

There are no existing unit tests for `TelegramEnrollmentWidget` or `WhatsAppEnrollmentWidget` (verified — the directory `src/components/admin/__tests__/` does not contain widget test files, and vitest's node environment couldn't render them anyway). Regression coverage comes from:

1. The reducer unit tests (§7.1) — every state transition the widgets care about is covered.
2. The Playwright admin regression spec (§7.3 `tests/e2e/admin-channels-refactor.spec.ts`).
3. Manual smoke test on staging before production deploy: admin connects Telegram on a test business, confirms the widget behaves identically to pre-refactor.

If a regression slips through, it surfaces in the manual ship gate before the flag flip — same model as Phase 2 / Phase 3 ship gates.

### 7.5 Manual

- One real end-to-end on an owner test account against `@RepWorthBot` via the staging worker. Owner sign in → connect Telegram → trigger a real review-approval notification → tap Approve in Telegram → watch the response flip in the dashboard.
- Pre-merge ship gate: zero blocking issues from `superpowers:code-reviewer` review pass.

---

## 8. Phasing

This is a single-phase ship. No flag gating beyond the existing `CHANNELS_TELEGRAM_ENABLED` flag:

- If `CHANNELS_TELEGRAM_ENABLED=false`, the Telegram row falls back to the same "Coming soon" UI as SMS/WhatsApp.
- The page itself is always live for `active`-subscription owners.

When SMS / WhatsApp clear their external review processes, flipping their flags renders the Connect CTA on those rows. No new Phase 4.x ship — it's a flag flip + thin owner-widget shells (~30 lines each, mirroring `OwnerTelegramWidget.tsx`).

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Refactor breaks shipped admin Telegram / WhatsApp widgets | Reducer unit tests cover every state transition. Playwright admin regression spec (`tests/e2e/admin-channels-refactor.spec.ts`) exercises the live admin widgets after the refactor. Manual smoke test on staging before flag flip. |
| Migration 027 fails in prod due to existing data violating the new index | Pre-run audit: `SELECT business_id, COUNT(*) FROM channel_enrollments WHERE channel IN ('sms','telegram','whatsapp') AND status IN ('pending_verification','verified') AND archived_at IS NULL GROUP BY business_id HAVING COUNT(*) > 1`. Read-only `SELECT` with no row locks — safe to run on prod primary. Must run in the SAME `psql` session immediately before applying the migration so a competing INSERT cannot land between audit and apply. Document in runbook with this ordering constraint. |
| Owner shares Telegram QR with malicious party | Whoever scans the QR first becomes the recipient — token has no further binding to the owner's Telegram account. Mitigation: 1h TTL + owner can `Disconnect` and re-enroll at any time. Same threat model as admin enrollment, accepted. |
| Multi-tab polling load | Owner has the page open in N tabs; each polls the status endpoint every 3s while in `awaiting_scan` (≤1h window per Connect). Worst case 1200 polls/tab/hour. With 100 owners doing this concurrently in 5 tabs each: ~167 reads/sec — trivial for the indexed SELECT (`idx_channel_enrollments_business`). Mitigation: stop polling on `document.visibilityState === 'hidden'` if observed in metrics later. Not in Phase 4 scope. |
| Owner shares a Telegram QR before scanning, leaks token | Existing token TTL (1h) + single-use semantic. The token is no more sensitive than the email approval link, which has the same surface. |
| Polling overload from many concurrent owners | Polling only runs in `awaiting_scan` (1-hour window per Connect attempt). At any time, the count of active polling sessions ≈ count of in-flight Connect flows — small. |

---

## 10. YAGNI — explicitly out of scope

- Push notifications (iOS/Android native apps).
- Discord / Slack / generic webhook channels. The hook supports any **QR + deep-link** flow (Discord bot install, Slack OAuth deep link). It does NOT support OTP-code-entry channels (SMS, email-2FA-style). For OTP channels in the future, write a separate `useOtpEnrollment` hook + reducer rather than overloading `useEnrollment` with conditional flows.
- Owner SMS / WhatsApp widgets. Will land when those channels go live (~30 lines each via the hook + the SMS-specific OTP variant).
- "Notify me when SMS/WhatsApp is ready" CTAs on the coming-soon rows.
- Multi-recipient per channel. `UNIQUE (business_id, channel)` enforces one handle per channel per business.
- Real-time enrollment state via Supabase Realtime. Polling is sufficient.

### Future refactors flagged but deferred

- **Hook fork on admin/owner divergence.** The shared `useEnrollment` hook works today because admin and owner share the QR/deep-link state machine. If a future phase introduces owner-specific UX (e.g., a "this connected your phone X" callout), fork the hook into `useAdminEnrollment` / `useOwnerEnrollment` while keeping the reducer shared. Do NOT pile divergent options onto `UseEnrollmentOptions`.
- **`requireOwnerSession()` server-component auth helper.** The inline `cookies() → supabase.auth.getUser() → SELECT u.role, b.subscription_status JOIN businesses` pattern is now duplicated across 3+ server components (`/settings/page.tsx`, `/settings/channels/page.tsx`, `/dashboard/connect/select-location/page.tsx`). Extract `requireOwnerSession(): Promise<{ authUser, role, businessId, subscriptionStatus, ownerEmail }>` into `src/lib/auth/server-component-auth.ts`. Deferred to a follow-up PR to keep Phase 4 scope tight.
- **Same-origin wrapper on admin channel routes.** Phase 4 adds `withSameOrigin()` only to owner routes. Admin routes are a separate hardening pass.

---

## Appendix A — Implementation order

The implementation plan (produced by `writing-plans` after this spec is approved) should sequence the work as:

1. **Pre-flight audit** — run the audit query (§9) on prod data in the SAME `psql` session as the migration apply; must return zero rows.
2. Migration 027 (partial unique index).
3. Build `src/lib/notifications/channels/constants.ts` — `TOKEN_TTL_MS`, `STATUS_POLL_INTERVAL_MS`, `TTL_TICK_INTERVAL_MS`. Used by both the hook and the route handlers.
4. Build `src/lib/channels/unique-violation.ts` — `MultipleMobileChannelsError`, `EnrollmentDatabaseError`, `isMultipleMobileChannelsError` detector. Unit tested.
5. Extend admin endpoint `src/app/api/admin/businesses/[id]/channels/route.ts` to also SELECT `verification_token_expires_at AS expires_at`. Additive change; no widget code reads it yet.
6. Extract pure `enrollment-reducer.ts` with exhaustive unit-test coverage (every state × action combination + the STATUS_FETCHED transition table from §2 + the `expiresAt` preservation invariant).
7. Build `use-enrollment.ts` hook (React shell wiring reducer to fetch + polling + AbortController). Filters `enrollments[]` by channel name; classifies HTTP errors into actions.
8. Extract shared transaction helpers (`startTelegramEnrollment(tx, businessId, tokenHash, expiresAt)`, `cancelTelegramEnrollment(sql, businessId)`, `disableTelegramEnrollment(sql, businessId)`) with 23505 → `MultipleMobileChannelsError` / `EnrollmentDatabaseError` mapping. Unit tested with mocked `tx` queue.
9. Refactor admin Telegram routes (`start`/`cancel`/`disable`) to use the helpers + return `409` on `MultipleMobileChannelsError`. Routes still own rawToken generation, advisory lock acquisition, and post-tx QR generation.
10. Add 23505 catch + 409 mapping to admin SMS verify (catch goes inside the existing `withSmsEnrollmentLock` callback) and admin WhatsApp start routes.
11. Refactor admin `TelegramEnrollmentWidget` to use the hook.
12. Refactor admin `WhatsAppEnrollmentWidget` to use the hook.
13. Build owner API routes:
    - `GET /api/dashboard/channels` (returns `{ enrollments, available, reasons }`).
    - `POST /api/dashboard/channels/telegram/{start,cancel,disable}` wrapped with `withSameOrigin()`.
14. Build `OwnerTelegramWidget` thin shell (~50 lines).
15. Build `ComingSoonChannelRow`.
16. Restructure `/settings/page.tsx`:
    a. Extract existing form body into `SettingsGeneralForm.tsx` (still client).
    b. Convert `page.tsx` to a server component with auth (`await cookies()` + Supabase + direct SQL guard incl. `users.email AS owner_email`) + subscription check.
    c. Build `SettingsTabs` server component (prop-driven `activeTab`, no `usePathname`).
    d. Render `<SettingsTabs activeTab="general" /><SettingsGeneralForm />`.
17. Build `/settings/channels/page.tsx` (server) + `ChannelsClient.tsx` (client). Auth + subscription guard mirrors step 16b. Server component also computes per-channel env-readiness and passes `availability` + `ownerEmailFallback` props.
18. Write `tests/e2e/helpers/telegram-test-ingress.ts` (POSTs a synthetic Telegram update with valid `X-Telegram-Bot-Api-Secret-Token`) — required by the E2E spec.
19. E2E test pass — `owner-channels.spec.ts` and `admin-channels-refactor.spec.ts`.
20. Manual test pass on staging.

Critical dependencies:

- Step 3 (constants) blocks steps 6, 7, 9.
- Step 4 (unique-violation detector) blocks steps 8, 9, 10, 13.
- Step 5 (admin endpoint extension) blocks step 7 (hook reads `expires_at` from status payload).
- Step 6 (reducer) blocks steps 7, 11, 12, 14.
- Step 8 (transaction helpers) blocks step 9.
- Step 16a (form extraction) blocks 16b (server component conversion).
- Step 18 (test ingress helper) blocks step 19's owner E2E spec.
- Steps 11, 12 (admin widget refactors) block step 19's admin regression spec.
