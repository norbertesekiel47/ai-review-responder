# Security-Audit Remediation — Phase 3 Design (Admin AAL2 Step-Up Consistency, F-1)

**Date:** 2026-06-15
**Source audit:** `docs/security-audit/2026-06-15-refresh-delta.md` (F-1)
**Phases 1–2 (merged):** PR #325, #326
**Status:** Design approved (uniform AAL2); ready for implementation plan.

## 1. Context & decision

F-1: AAL2 (MFA step-up) is enforced inconsistently across admin mutation
routes. Since `sales_partner` was removed, `admin` is a single global
super-role, so AAL2 is the primary compensating control for high-impact admin
actions — yet only 7 routes use the per-route gate `requireAdminWithAal2`, while
several state-mutating routes use plain `requireRole`/`requireRoleOr401`.

**Why it's exploitable (not just defense-in-depth):** the proxy's AAL2 gate
(`src/proxy.ts` `getAalGate`) is gated behind `MFA_ENFORCEMENT_ENABLED`. When
that flag is not `true` (staging, local, or if unset in prod), the per-route
`requireAdminWithAal2` call is the **only** layer enforcing step-up. Routes on
plain `requireRole` get zero AAL2 enforcement regardless of flag state.

**Decision: UNIFORM.** Every admin state-mutating route (`POST/PUT/PATCH/DELETE`
under `src/app/api/admin/**`) goes through `requireAdminWithAal2`. This kills the
root cause (no central tier; each route opts in by hand) and is lockable with a
CI check. The cost — step-up on low-impact admin config — is negligible for the
small admin user set. **Lane: preview** (no migration/worker/billing).

## 2. Scope

`requireAdminWithAal2` returns the discriminated union
`{ ok: true; admin: AppUser } | { ok: false; response: NextResponse }`; the
idiom is:
```ts
const gate = await requireAdminWithAal2(request);
if (!gate.ok) return gate.response;
const admin = gate.admin; // only where the user is needed
```

### Mutations to gate (currently NOT using AAL2)

| Route (file) | Verb | Current guard | Note |
|---|---|---|---|
| `admin/businesses/route.ts` | POST | `requireRoleOr401` | onboarding tx — highest blast radius |
| `admin/businesses/[id]/route.ts` | PATCH | `requireRoleOr401` | leave the GET as-is; swap PATCH only |
| `admin/businesses/[id]/keywords/route.ts` | PUT | `requireRoleOr401` | |
| `admin/businesses/[id]/ranking/route.ts` | POST | `requireRoleOr401` | |
| `admin/locations/csv-import/route.ts` | POST | bare `requireRole` (throwing) | swap try/catch → discriminant; AAL2 before `formData` parse |
| `admin/demos/generate/route.ts` | POST | `requireRoleOr401` | AAL2 before the rate-limit check (ordering) |
| `admin/channels/{telegram,whatsapp}/{start,cancel,disable}` (6) | POST | `requireRole` via `_shared/` helpers | gate inside the 2 shared helpers — one change covers all 6 |

### Already gated — DO NOT change
`impersonation/{start,end}`, `offboardings` (GET), `offboardings/[id]/provider-disposition`, `billing/grant-extension`, `flagged`, `businesses/[id]/zernio-queue`.

### Out of scope / corrected
- **`payment-success`** — GET-only, writes nothing (checkout-poll read). The audit wrongly listed it. **Not gated.**
- **`offboardings` CSRF companion** — corrected: `offboardings/route.ts` exports **only GET**; there is no POST missing `withSameOrigin`. The offboarding POST (`provider-disposition`) already has `withSameOrigin` + AAL2. **No companion fix needed.**
- **GET-only admin routes** (`costs`, `jobs`, `notifications`, `overview`, `businesses/prefill`, `demos` list, `businesses/[id]/channels`) — reads; not in scope. (`costs`/`prefill` use bare `requireRole`; left as-is.)

## 3. Per-area design

### 3a. `requireRoleOr401` → `requireAdminWithAal2` swaps
`businesses` POST, `businesses/[id]` PATCH, `keywords` PUT, `ranking` POST,
`demos/generate` POST. Mechanical: replace the `requireRoleOr401(request,
'admin')` call + `auth.user` usage with the gate idiom + `gate.admin`. For
`demos/generate`, the gate must run **before** the per-IP/global rate-limit
check (auth before spend-trigger). Behavior note: non-auth errors now surface as
the gate's clean `500`, not a raw 5xx.

### 3b. `csv-import` (bare throwing `requireRole`)
Replace the `try { requireRole } catch (AuthError) {...}` block (lines ~53-67)
with the gate discriminant. AAL2 runs before the `req.formData()` parse (line
~70). No rate limit here.

### 3c. Channel `_shared/` helpers (gates all 6 channel routes)
Replace the internal `requireRole(req, 'admin')` with `requireAdminWithAal2(req)`
in:
- `channels/_shared/account.ts` (`resolveAdminChannelAccount`) — used by
  cancel + disable (via `action.ts` `gateAndResolveAccount`). On `!gate.ok`
  return `{ ok: false, response: gate.response }`; set `actorUserId =
  gate.admin.id`.
- `channels/_shared/start.ts` (`runAdminChannelStart`) — return `gate.response`
  on failure.
Both already receive `req: NextRequest` and read `req.json()` *after* auth, so
ordering is preserved. Observable change: channel 401/403 responses now carry
`no-store` headers (the gate adds them) — correct, not a regression.

### 3d. Recurrence guard — `scripts/ci/admin-aal2-audit.ts` (new)
A file-level audit (not line-level, so it does NOT extend `static-policy-audit`):
enumerate `src/app/api/admin/**/route.ts`; for each that exports a mutation verb
(`export const POST|PUT|PATCH|DELETE` or `export async function POST|...`),
assert the file references `requireAdminWithAal2`. Print `file [admin-aal2]
detail` and exit 1 on any finding. Add `"ci:admin-aal2": "tsx
scripts/ci/admin-aal2-audit.ts"` to `package.json` and wire it into the CI lint
job alongside the other audits. Unit-test the scan function (mutation-verb
detection; GET-only exemption; gate-present pass).

## 4. Testing

Each swapped route's existing test must adopt the canonical AAL2 mock (from
`flagged/__tests__/route.test.ts`): add `vi.mock('@/lib/auth/mfa')` with
`requireCurrentAal2FromSupabase`, `vi.mock('@supabase/ssr')`,
`cookieBackedServerClient` in the `@/lib/db/auth` mock, and a default
`beforeEach` of admin-authed + AAL2-ok. Add per-route assertions: (a) a missing
step-up → `403 mfa_required`; (b) happy path still works. The `admin-aal2-audit`
unit test covers the structural guarantee.

## 5. Verification

`pnpm lint && pnpm typecheck && pnpm test` + `pnpm ci:admin-aal2` (new) +
`pnpm ci:static-policy` + `pnpm build`. Preview lane — single PR, no operator-
gated steps.

## 6. Out of scope (later phases)
F-3 (deferred 2026-06-18 + dep CVEs), F-5, F-7–F-12, F-14/15, F-18–F-26.
