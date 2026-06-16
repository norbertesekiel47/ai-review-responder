# Security-Audit Remediation — Phase 3 Implementation Plan (Admin AAL2 Step-Up, F-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Route every admin state-mutating route through `requireAdminWithAal2`, and add a CI audit that keeps it that way.

**Architecture:** Mechanical gate swaps across ~8 route files + 2 channel `_shared` helpers, each TDD'd via its route test; plus a new file-level CI audit (`admin-aal2`) as the recurrence guard.

**Tech Stack:** Next.js 16 App Router route handlers, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-3-design.md`
**Branch:** `security/audit-remediation-phase-3` (already created off main `8ff3e667`).

---

## Canonical patterns (referenced by every task)

### GATE IDIOM (replaces `requireRoleOr401(request,'admin')` / bare `requireRole`)
```ts
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
// ...inside the handler, FIRST (before body parse / rate limit):
const gate = await requireAdminWithAal2(request);
if (!gate.ok) return gate.response;
const admin = gate.admin; // only if the user object is used; else omit this line
```
Then replace any `auth.user`/`authUser` usage with `admin`. Remove the now-unused
`requireRoleOr401`/`requireRole`/`AuthError` import if nothing else uses it.

### AAL2 TEST-MOCK RECIPE (apply to each swapped route's test)
`requireAdminWithAal2` internally calls `requireRole` (already mocked in these
tests) + `requireCurrentAal2FromSupabase` + `cookieBackedServerClient`. So DON'T
mock the gate directly — mock its deps. In each test file:
1. Hoist a mock: add `mockRequireCurrentAal2FromSupabase: vi.fn()` to the
   `vi.hoisted(...)` block (hoist `mockRequireRole` too if it's currently inline).
2. Extend the `vi.mock('@/lib/db/auth', ...)` factory to also export
   `cookieBackedServerClient: () => ({ auth: { mfa: {} } })` (keep `requireRole`
   + `AuthError`).
3. Add:
   ```ts
   vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({ auth: { mfa: {} } })) }));
   vi.mock('@/lib/auth/mfa', () => ({ requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase }));
   ```
4. In `beforeEach`: `mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });`
   (and ensure `mockRequireRole` resolves an admin by default).
5. Ensure env in the test: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL` set (copy from `flagged`/`offboardings` tests).
6. Add a NEW test asserting step-up enforcement:
   ```ts
   it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
     mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
     const res = await <VERB>(<request for this route>);
     expect(res.status).toBe(403);
   });
   ```
**Reference implementation to copy from:** `src/app/api/admin/flagged/__tests__/route.test.ts`.

### TDD order per route
Add the recipe (mock + the new mfa-required test) FIRST → run → the new test
FAILS (route still uses `requireRoleOr401`, ignores AAL2, returns non-403) → swap
the route to the gate idiom → run → PASS (and existing happy-path tests stay
green because of the default-ok `beforeEach`).

---

## Task 1: `businesses` POST + `businesses/[id]` PATCH

**Files:** `src/app/api/admin/businesses/route.ts` (POST handler), `src/app/api/admin/businesses/[id]/route.ts` (PATCH handler only — leave GET on `requireRoleOr401`), tests `…/businesses/__tests__/route.test.ts` and `…/businesses/[id]/__tests__/route.test.ts`.

- [ ] **Step 1:** In each test, apply the AAL2 TEST-MOCK RECIPE and add the mfa-required→403 test (POST for `businesses`, PATCH for `[id]`). Run `pnpm test -- src/app/api/admin/businesses` → the two new tests FAIL.
- [ ] **Step 2:** In `businesses/route.ts` POST handler, replace the `requireRoleOr401(request,'admin')` call with the GATE IDIOM; rename `auth.user`→`admin`. In `businesses/[id]/route.ts` PATCH handler only, same swap. Leave the GET handlers unchanged.
- [ ] **Step 3:** `pnpm test -- src/app/api/admin/businesses` → PASS (new + existing). `pnpm typecheck` → PASS.
- [ ] **Step 4:** Commit:
```bash
git add src/app/api/admin/businesses
git commit -m "fix(admin): require AAL2 step-up on businesses POST + [id] PATCH (F-1)"
```

## Task 2: `keywords` PUT + `ranking` POST

**Files:** `src/app/api/admin/businesses/[id]/keywords/route.ts` (PUT), `…/ranking/route.ts` (POST), + their tests.

- [ ] **Step 1:** Apply the RECIPE + mfa-required→403 test to each test file (if a test file is missing for a route, create a minimal one mirroring `flagged`'s mock + a happy-path + the 403 case). Run the targeted tests → new ones FAIL.
- [ ] **Step 2:** Swap each handler to the GATE IDIOM (replace `requireRoleOr401`).
- [ ] **Step 3:** `pnpm test -- src/app/api/admin/businesses/[id]/keywords src/app/api/admin/businesses/[id]/ranking` → PASS. `pnpm typecheck` → PASS.
- [ ] **Step 4:** Commit:
```bash
git add "src/app/api/admin/businesses/[id]/keywords" "src/app/api/admin/businesses/[id]/ranking"
git commit -m "fix(admin): require AAL2 step-up on keywords PUT + ranking POST (F-1)"
```

## Task 3: `demos/generate` POST (gate BEFORE rate-limit)

**Files:** `src/app/api/admin/demos/generate/route.ts`, `…/demos/generate/__tests__/route.test.ts`.

- [ ] **Step 1:** Apply the RECIPE + mfa-required→403 test. CRITICAL: the 403 test must NOT pre-satisfy the rate-limiter — assert the gate rejects BEFORE any LLM-spend/outbox path. Run → new test FAILS.
- [ ] **Step 2:** In the POST handler, put the GATE IDIOM as the **first** operation, BEFORE the per-IP/global rate-limit check. Replace `requireRoleOr401`. (Behavior note: non-auth errors now surface as the gate's clean 500.)
- [ ] **Step 3:** `pnpm test -- src/app/api/admin/demos/generate` → PASS. `pnpm typecheck` → PASS.
- [ ] **Step 4:** Commit:
```bash
git add src/app/api/admin/demos/generate
git commit -m "fix(admin): require AAL2 step-up before demo LLM-spend trigger (F-1)"
```

## Task 4: `locations/csv-import` POST (throwing → discriminant)

**Files:** `src/app/api/admin/locations/csv-import/route.ts`, `…/csv-import/__tests__/route.test.ts`.

- [ ] **Step 1:** Apply the RECIPE + mfa-required→403 test. Run → new test FAILS.
- [ ] **Step 2:** Replace the `try { authUser = await requireRole(req,'admin') } catch (AuthError) {...}` block (lines ~53-67) with the GATE IDIOM (`const gate = await requireAdminWithAal2(req); if (!gate.ok) return gate.response; const authUser = gate.admin;`). The `req.formData()` parse (line ~70) stays after — unaffected. Drop the now-unused `requireRole`/`AuthError`/`NO_STORE`-on-auth imports if unused elsewhere.
- [ ] **Step 3:** `pnpm test -- src/app/api/admin/locations/csv-import` → PASS. `pnpm typecheck` → PASS.
- [ ] **Step 4:** Commit:
```bash
git add src/app/api/admin/locations/csv-import
git commit -m "fix(admin): require AAL2 step-up on bulk csv-import (F-1)"
```

## Task 5: Channel `_shared` helpers (gates all 6 channel routes)

**Files:** `src/app/api/admin/channels/_shared/account.ts` (`resolveAdminChannelAccount`), `src/app/api/admin/channels/_shared/start.ts` (`runAdminChannelStart`). Tests: the telegram/whatsapp `start`/`cancel`/`disable` test files.

- [ ] **Step 1:** In each affected channel test (start/cancel/disable for both providers), apply the AAL2 TEST-MOCK RECIPE — note several use INLINE `requireRole` mocks; hoist them (`mockRequireRole` + `mockRequireCurrentAal2FromSupabase`) and add the `mfa`/`ssr`/`cookieBackedServerClient` mocks. Add one mfa-required→403 test per provider×action (or at minimum: one start, one disable, one cancel). Run → new tests FAIL.
- [ ] **Step 2:** In `account.ts` `resolveAdminChannelAccount`: replace the `try { await requireRole(req,'admin') } catch (AuthError) {...}` with `const gate = await requireAdminWithAal2(req); if (!gate.ok) return { ok: false, response: gate.response };` and set `actorUserId = gate.admin.id`. In `start.ts` `runAdminChannelStart`: replace its `try { await requireRole(req,'admin') } catch {...}` with `const gate = await requireAdminWithAal2(req); if (!gate.ok) return gate.response;`. (`action.ts` reaches `account.ts` via `gateAndResolveAccount`, so cancel + disable are covered transitively.) The `req.json()` reads stay after auth — ordering preserved.
- [ ] **Step 3:** `pnpm test -- src/app/api/admin/channels` → PASS. `pnpm typecheck` → PASS.
- [ ] **Step 4:** Commit:
```bash
git add src/app/api/admin/channels
git commit -m "fix(admin): require AAL2 step-up on channel enroll/cancel/disable via _shared helpers (F-1)"
```

## Task 6: Recurrence guard — `admin-aal2` CI audit

**Files:** create `scripts/ci/admin-aal2-audit.ts` + `scripts/ci/__tests__/admin-aal2-audit.test.ts`; modify `package.json`; modify `.github/workflows/ci.yml`.

- [ ] **Step 1: Write the audit + failing unit test.** Create `scripts/ci/admin-aal2-audit.ts` exporting a pure `scanRouteFile(path, text): string[]` (returns finding messages) and a `main()` that walks `src/app/api/admin/**/route.ts`, and for any file whose text matches an export of a mutation verb (`export const (POST|PUT|PATCH|DELETE)` OR `export async function (POST|PUT|PATCH|DELETE)`) asserts the text includes `requireAdminWithAal2`; prints `file [admin-aal2] mutation route missing requireAdminWithAal2` and `process.exit(1)` on any finding. Create the unit test asserting: (a) a GET-only route → no finding; (b) a POST route without the gate → finding; (c) a POST route WITH `requireAdminWithAal2` → no finding.
- [ ] **Step 2:** Run `pnpm test -- scripts/ci/__tests__/admin-aal2-audit.test.ts` → PASS (the scan fn is self-contained).
- [ ] **Step 3:** Add to `package.json` scripts: `"ci:admin-aal2": "tsx scripts/ci/admin-aal2-audit.ts"`. Run `pnpm ci:admin-aal2` → **PASS** (all mutation routes were gated in Tasks 1-5). If it reports any route, that route was missed — go back and gate it.
- [ ] **Step 4:** Wire into CI: in `.github/workflows/ci.yml`, add `pnpm ci:admin-aal2` to the same job that runs the other audits (the `lint` job runs tenant-scope/analytics-events/static-policy — add this alongside). Read the workflow to match the exact step format.
- [ ] **Step 5:** Commit:
```bash
git add scripts/ci/admin-aal2-audit.ts scripts/ci/__tests__/admin-aal2-audit.test.ts package.json .github/workflows/ci.yml
git commit -m "ci(admin): audit that every admin mutation route requires AAL2 (F-1 guard)"
```

## Task 7: Full verification + PR

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test` → all PASS.
- [ ] **Step 2:** `pnpm ci:admin-aal2 && pnpm ci:static-policy && pnpm ci:tenant-scope && pnpm ci:rls-audit` → all PASS.
- [ ] **Step 3:** `pnpm build` → PASS.
- [ ] **Step 4:** Confirm clean tree + branch log:
```bash
git status --short && git --no-pager log --oneline origin/main..HEAD
```
- [ ] **Step 5:** Push + open PR:
```bash
git push -u origin security/audit-remediation-phase-3
gh pr create --base main --title "Security audit Phase 3: uniform admin AAL2 step-up (F-1)" --body "Implements F-1 (docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-3-design.md): every admin state-mutating route requires requireAdminWithAal2, enforced by a new ci:admin-aal2 audit. Preview lane, no operator-gated steps."
```
Expect CI green (incl. the new audit).

---

## Self-Review

**Spec coverage:** all in-scope mutations gated — businesses POST/PATCH (T1), keywords/ranking (T2), demos/generate (T3), csv-import (T4), 6 channel routes via helpers (T5); recurrence guard (T6); verification (T7). Corrected exclusions (payment-success GET, offboardings no-POST) honored (not touched). 

**Placeholder scan:** the gate idiom + test recipe are given in full once and referenced; per-route specifics carry exact files/lines/verbs. The "read the file for exact insertion" notes (test files, ci.yml) are deliberate — those exact contents must be read live, but the change to make is fully specified.

**Type/name consistency:** `requireAdminWithAal2` → `{ ok, admin|response }` used uniformly; `gate.admin` replaces `auth.user`/`authUser`; `mockRequireCurrentAal2FromSupabase` name matches the flagged reference; `ci:admin-aal2` script name consistent across package.json + CI + verification.
