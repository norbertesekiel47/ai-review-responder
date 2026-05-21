# Approval System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete approval flow: service layer (token validation, approve/edit/regenerate), cookie utilities (device binding + CSRF), 5 API routes, approval page (server shell + client interactive), and unit tests.

**Architecture:** The approval service receives a Postgres transaction client (`tx`) from callers, enabling composition of multiple operations in one transaction. Cookie utilities handle HMAC-signed device binding and CSRF double-submit pattern. API routes are thin HTTP handlers that validate cookies/CSRF, open a `sql.begin()` transaction, and delegate to the service. The approval page uses a server component for the shell (minimal HTML, no review text) and a client component for the interactive content (fetched via TanStack Query).

**Tech Stack:** Postgres.js transactions, node:crypto (SHA-256, HMAC, randomUUID), fastest-levenshtein, Next.js App Router (route handlers + server/client components), TanStack Query, `@/lib/shared/rate-limit`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/approval/errors.ts` | Create | Typed error classes for all approval failure modes |
| `src/lib/approval/service.ts` | Create | Core business logic: lockValidLink, establishSession, approve, edit, regenerate |
| `src/lib/approval/cookies.ts` | Create | Device cookie (HMAC-signed) + CSRF (double-submit pattern) |
| `src/lib/approval/index.ts` | Replace | Barrel exports |
| `src/app/api/approve/[token]/route.ts` | Create | GET: validate token, return review+response+business data |
| `src/app/api/approve/[token]/session/route.ts` | Create | POST: bind device cookie |
| `src/app/api/approve/[token]/approve/route.ts` | Create | POST: approve response |
| `src/app/api/approve/[token]/edit/route.ts` | Create | POST: approve with edits |
| `src/app/api/approve/[token]/regenerate/route.ts` | Create | POST: request new draft |
| `src/app/(public)/approve/[token]/page.tsx` | Replace | Server shell + client interactive component |
| `src/lib/approval/__tests__/service.test.ts` | Create | Unit tests for approval service |
| `src/lib/approval/__tests__/cookies.test.ts` | Create | Unit tests for cookie utilities |

---

### Task 1: Create error types

**Files:**
- Create: `src/lib/approval/errors.ts`

- [ ] **Step 1: Create the error types file**

```typescript
export class InvalidTokenError extends Error {
  constructor() {
    super('Invalid or unknown approval token');
    this.name = 'InvalidTokenError';
  }
}

export class ExpiredTokenError extends Error {
  constructor() {
    super('This approval link has expired');
    this.name = 'ExpiredTokenError';
  }
}

export class RevokedTokenError extends Error {
  constructor() {
    super('This approval link has been revoked');
    this.name = 'RevokedTokenError';
  }
}

export class ConsumedTokenError extends Error {
  constructor() {
    super('This approval link has already been used');
    this.name = 'ConsumedTokenError';
  }
}

export class DeviceConflictError extends Error {
  constructor() {
    super('This approval link is bound to a different device');
    this.name = 'DeviceConflictError';
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

---

### Task 2: Create approval service

**Files:**
- Create: `src/lib/approval/service.ts`

The service methods all receive a Postgres transaction client (`tx`) — they never create their own transactions. This lets callers compose multiple operations atomically.

- [ ] **Step 1: Create the service file**

The service needs these imports and depends on:
- `node:crypto` for SHA-256 hashing
- `uuid` for UUIDv7
- `fastest-levenshtein` for edit distance
- `@/lib/shared/worker-types` for payload types
- The error types from `./errors.ts`

Key methods:
- `lockValidLink(tx, rawToken)` — FOR UPDATE lock, validates hash/consumed/revoked/expired
- `establishApprovalSession(tx, linkId, deviceCookieHash, auditContext)` — binds device or verifies match
- `approve(tx, link, deviceCookieHash, auditContext)` — consume link, revoke siblings, update response, insert publish outbox
- `edit(tx, link, editedText, deviceCookieHash, auditContext)` — same as approve + Levenshtein + edited_text
- `regenerate(tx, link, deviceCookieHash, auditContext)` — consume, revoke, supersede old response, insert generate outbox

Each audit method inserts into `approval_audit_log` with `token_hash`, `device_cookie_hash`, `ip_address`, `action`, `metadata`.

Full implementation is ~250 lines. The subagent will receive the complete code.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

---

### Task 3: Create cookie utilities

**Files:**
- Create: `src/lib/approval/cookies.ts`

- [ ] **Step 1: Create the cookies file**

Device cookie:
- `setDeviceCookie(response: NextResponse): string` — generates randomUUID, HMAC-signs with SESSION_COOKIE_SECRET, sets `__device` cookie (Secure, HttpOnly, SameSite=Lax, Path=/, Max-Age=172800)
- `getDeviceCookieHash(request: NextRequest): string | null` — reads `__device`, returns SHA-256(value) or null
- `verifyDeviceCookie(request: NextRequest): boolean` — reads cookie, verifies HMAC signature

CSRF (double-submit):
- `setCsrfCookie(response: NextResponse): string` — generates randomUUID, sets `__csrf` cookie (Secure, SameSite=Lax, Path=/, NOT HttpOnly)
- `validateCsrf(request: NextRequest): boolean` — compares `x-csrf-token` header with `__csrf` cookie value

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

---

### Task 4: Update barrel exports

**Files:**
- Replace: `src/lib/approval/index.ts`

- [ ] **Step 1: Replace with barrel exports**

```typescript
export {
  lockValidLink,
  establishApprovalSession,
  approve,
  edit,
  regenerate,
} from './service';

export {
  setDeviceCookie,
  getDeviceCookieHash,
  verifyDeviceCookie,
  setCsrfCookie,
  validateCsrf,
} from './cookies';

export {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
} from './errors';
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

---

### Task 5: Create API routes

**Files:**
- Create: `src/app/api/approve/[token]/route.ts` (GET)
- Create: `src/app/api/approve/[token]/session/route.ts` (POST)
- Create: `src/app/api/approve/[token]/approve/route.ts` (POST)
- Create: `src/app/api/approve/[token]/edit/route.ts` (POST)
- Create: `src/app/api/approve/[token]/regenerate/route.ts` (POST)

All routes:
- Set `Cache-Control: no-store, private` on every response
- Handle typed errors from the service with appropriate HTTP status codes and messages

GET route:
- Hash raw token, look up approval_links → response → review → business
- Rate limit: `checkRateLimit('approve:get:${ip}', 10, 60)`
- Set device cookie + CSRF cookie on the response
- Return `{ review, response, businessName, expiresAt }`

POST session route:
- Validate CSRF via `validateCsrf(request)`
- Get device cookie hash via `getDeviceCookieHash(request)`
- `sql.begin(tx => { lockValidLink(tx, rawToken); establishApprovalSession(tx, ...) })`

POST approve/edit/regenerate routes:
- Validate CSRF + verify device cookie
- `sql.begin(tx => { const link = lockValidLink(tx, rawToken); approve/edit/regenerate(tx, link, ...) })`
- Return success message

- [ ] **Step 1: Create all 5 route files**

Full implementations provided to the subagent.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

---

### Task 6: Create approval page

**Files:**
- Replace: `src/app/(public)/approve/[token]/page.tsx`

Server component:
- Hash token server-side, look up `approval_links` → `responses` → `businesses.name`
- If invalid/expired: render error message directly
- If valid: render minimal shell (business name + heading) — NO review text in server HTML

Client component (`ApprovalClient`):
- Fetches GET `/api/approve/{token}` via TanStack Query
- POSTs `/api/approve/{token}/session` on mount (device binding)
- Displays: review card (stars, reviewer, date, text), response in editable textarea
- Three buttons: Approve, Edit & Approve, Regenerate
- Each button POSTs with `x-csrf-token` header (read from `__csrf` cookie)
- Success/error state handling
- Mobile-first Tailwind layout

- [ ] **Step 1: Create the page with server shell + client component**

- [ ] **Step 2: Verify TypeScript compiles and build succeeds**

Run: `npx tsc --noEmit && pnpm build`

---

### Task 7: Write unit tests

**Files:**
- Create: `src/lib/approval/__tests__/service.test.ts`
- Create: `src/lib/approval/__tests__/cookies.test.ts`

Service tests (mocked `tx`):
1. `lockValidLink` — valid token returns link row
2. `lockValidLink` — expired token throws `ExpiredTokenError`
3. `lockValidLink` — consumed token throws `ConsumedTokenError`
4. `lockValidLink` — revoked token throws `RevokedTokenError`
5. `lockValidLink` — unknown token throws `InvalidTokenError`
6. `establishApprovalSession` — binds device on first call
7. `establishApprovalSession` — throws `DeviceConflictError` on different device
8. `approve` — consumes link, updates response status, revokes siblings, inserts publish outbox
9. `edit` — same as approve + stores edited_text + computes edit_distance
10. `regenerate` — consumes link, supersedes response, inserts generate outbox with version+1

Cookie tests:
1. `setDeviceCookie` returns signed value
2. `getDeviceCookieHash` returns SHA-256 of cookie value
3. `getDeviceCookieHash` returns null when no cookie
4. `verifyDeviceCookie` validates HMAC
5. `setCsrfCookie` returns token
6. `validateCsrf` matches header to cookie

- [ ] **Step 1: Create both test files**

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass

---

### Task 8: Final verification + tracking

- [ ] **Step 1: Full type check**

Run: `npx tsc --noEmit`

- [ ] **Step 2: Full test suite**

Run: `pnpm test`

- [ ] **Step 3: Build check**

Run: `pnpm build`

- [ ] **Step 4: Update tracking files**

Update `.claude/CLAUDE.md` and `docs/progresstracking.md` with Prompt 12 completion.
