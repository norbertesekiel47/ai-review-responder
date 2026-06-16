# Security-Audit Remediation — Phase 2 Implementation Plan (DB + Boot Invariant Backstops)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land F-17, F-13, F-16 (code + boot asserts) and F-4 (a DB constraint migration) as one PR; the migration apply to staging/prod is an operator-gated step after green CI.

**Architecture:** Three code findings are independent and unit-testable. F-4 is a checked-in migration `.sql` + migrations-log entry; its verification is a preflight query + staging apply (no CI test — the repo has no constraint-integration harness and CI lacks `TEST_DATABASE_POOL_URL`).

**Tech Stack:** Postgres (CHECK constraint), Node `node:crypto` HMAC, ioredis Lua (`eval`), Vitest, pnpm, Fastify worker.

**Spec:** `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-2-design.md`
**Branch:** `security/audit-remediation-phase-2` (already created off `main`).

---

## File Structure

**Created:**
- `src/lib/shared/worker-public-url.ts` — `getWorkerPublicUrl()`: reads + trailing-slash-normalizes `WORKER_PUBLIC_URL` (single authoritative accessor). (F-13)
- `src/lib/shared/__tests__/worker-public-url.test.ts` — accessor tests. (F-13)
- `supabase/migrations/068_approval_method_required.sql` — the CHECK constraint. (F-4)

**Modified:**
- `src/lib/costs/tracker.ts` — `ADJUST_COST_LUA` gains `EXPIRE`; both eval call sites pass the TTL. (F-17)
- `src/lib/costs/__tests__/tracker.test.ts` — assert the TTL arg on finalize/release. (F-17)
- `worker/ingress/twilio/whatsapp-shared.ts` — `fullUrl` uses the accessor. (F-13)
- `src/lib/notifications/channels/whatsapp-channel.ts` — two `statusCallback` sites use the accessor. (F-13)
- `worker/config/startup-assert.ts` — `WORKER_PUBLIC_URL` format check (F-13) + `SESSION_COOKIE_SECRET` length check (F-16).
- `worker/config/__tests__/startup-assertion.test.ts` — tests for both new checks.
- `src/lib/approval/cookies.ts` — `getSessionSecret()` min-length guard. (F-16)
- `src/lib/approval/__tests__/cookies.test.ts` — short-secret rejection test. (F-16)
- `.claude/reference/migrations-log.md` — record migration 068. (F-4)

---

## Task 1: F-17 — `ADJUST_COST_LUA` `EXPIRE`

TDD: add TTL assertions to the existing finalize/release tests (red), then add `EXPIRE` to the Lua + pass the TTL from both callers (green).

**Files:**
- Test: `src/lib/costs/__tests__/tracker.test.ts`
- Modify: `src/lib/costs/tracker.ts`

- [ ] **Step 1: Add the failing TTL assertions**

In `src/lib/costs/__tests__/tracker.test.ts`, in the existing `finalizeCost` test (the one asserting `evalArgs[4]` is `'-10'`) add after that assertion:
```ts
    expect(evalArgs[5]).toBe('86400'); // ARGV[2] TTL — mirrors RESERVE
```
And in the existing `releaseCost` test (asserting `evalArgs[4]` is `'-15'`) add:
```ts
    expect(evalArgs[5]).toBe('86400'); // ARGV[2] TTL — mirrors RESERVE
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/lib/costs/__tests__/tracker.test.ts`
Expected: FAIL — `evalArgs[5]` is `undefined` (the adjust path passes no TTL yet).

- [ ] **Step 3: Add `EXPIRE` to `ADJUST_COST_LUA`**

In `src/lib/costs/tracker.ts`, replace the `ADJUST_COST_LUA` script body:
```lua
local adjustment = tonumber(ARGV[1])
redis.call('INCRBY', KEYS[1], adjustment)
redis.call('INCRBY', KEYS[2], adjustment)
return 'ok'
```
with:
```lua
local adjustment = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
redis.call('INCRBY', KEYS[1], adjustment)
redis.call('INCRBY', KEYS[2], adjustment)
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return 'ok'
```
(Keep the surrounding `const ADJUST_COST_LUA = \`...\`` template exactly; only the Lua text changes.)

- [ ] **Step 4: Pass the TTL from both callers**

In `finalizeCost` (the `redis.eval(ADJUST_COST_LUA, 2, …, String(adjustment))` call), add `String(CACHE_TTL_SECONDS)` as the final argument:
```ts
  await redis.eval(
    ADJUST_COST_LUA,
    2,
    dailyBusinessKey(businessId, reservationDate),
    dailyGlobalKey(reservationDate),
    String(adjustment),
    String(CACHE_TTL_SECONDS),
  );
```
In `releaseCost` (the `String(-PESSIMISTIC_ESTIMATE_CENTS)` eval call), add the same final argument:
```ts
  await redis.eval(
    ADJUST_COST_LUA,
    2,
    dailyBusinessKey(businessId, reservationDate),
    dailyGlobalKey(reservationDate),
    String(-PESSIMISTIC_ESTIMATE_CENTS),
    String(CACHE_TTL_SECONDS),
  );
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- src/lib/costs/__tests__/tracker.test.ts`
Expected: PASS (finalize + release assert `evalArgs[5] === '86400'`).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add src/lib/costs/tracker.ts src/lib/costs/__tests__/tracker.test.ts
git commit -m "fix(costs): EXPIRE in ADJUST_COST_LUA to avoid TTL-less ghost keys (F-17)"
```

---

## Task 2: F-13 — `WORKER_PUBLIC_URL` accessor + boot format check

TDD: write the accessor test (red), create the accessor (green), wire the 3 sites, then add the boot format check + its tests.

**Files:**
- Create: `src/lib/shared/worker-public-url.ts`, `src/lib/shared/__tests__/worker-public-url.test.ts`
- Modify: `worker/ingress/twilio/whatsapp-shared.ts`, `src/lib/notifications/channels/whatsapp-channel.ts`, `worker/config/startup-assert.ts`, `worker/config/__tests__/startup-assertion.test.ts`

- [ ] **Step 1: Write the failing accessor test**

Create `src/lib/shared/__tests__/worker-public-url.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getWorkerPublicUrl } from '../worker-public-url';

describe('getWorkerPublicUrl', () => {
  const SNAP = process.env.WORKER_PUBLIC_URL;
  afterEach(() => {
    if (SNAP === undefined) delete process.env.WORKER_PUBLIC_URL;
    else process.env.WORKER_PUBLIC_URL = SNAP;
  });

  it('returns the URL unchanged when there is no trailing slash', () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('strips a single trailing slash', () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com/';
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('strips multiple trailing slashes', () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com///';
    expect(getWorkerPublicUrl()).toBe('https://worker.example.com');
  });

  it('throws when unset', () => {
    delete process.env.WORKER_PUBLIC_URL;
    expect(() => getWorkerPublicUrl()).toThrow(/WORKER_PUBLIC_URL/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/lib/shared/__tests__/worker-public-url.test.ts`
Expected: FAIL — `../worker-public-url` does not exist.

- [ ] **Step 3: Create the accessor**

Create `src/lib/shared/worker-public-url.ts`:
```ts
/**
 * Single authoritative reader for WORKER_PUBLIC_URL. Strips trailing slashes so
 * callers can safely append a path (a trailing slash would otherwise produce a
 * double-slash URL and break Twilio signature verification / status callbacks).
 */
export function getWorkerPublicUrl(): string {
  const raw = process.env.WORKER_PUBLIC_URL;
  if (!raw) throw new Error('WORKER_PUBLIC_URL is not set');
  return raw.replace(/\/+$/, '');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/lib/shared/__tests__/worker-public-url.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Wire the three call sites**

In `worker/ingress/twilio/whatsapp-shared.ts`, replace the `fullUrl` body and add the import:
```ts
import { getWorkerPublicUrl } from '@/lib/shared/worker-public-url';
// ...
export function fullUrl(request: FastifyRequest): string {
  return `${getWorkerPublicUrl()}${request.url}`;
}
```
In `src/lib/notifications/channels/whatsapp-channel.ts`, add the import and replace BOTH `statusCallback` lines (currently `` `${process.env.WORKER_PUBLIC_URL}/ingress/twilio/whatsapp-status` ``):
```ts
import { getWorkerPublicUrl } from '@/lib/shared/worker-public-url';
// ...both sites:
        statusCallback: `${getWorkerPublicUrl()}/ingress/twilio/whatsapp-status`,
```
(Use the project's existing import alias style — match the file's other imports for `@/lib/...` vs relative.)

- [ ] **Step 6: Add the boot format check**

In `worker/config/startup-assert.ts`, add a helper and call it from the two blocks that already require `WORKER_PUBLIC_URL`:
```ts
function assertWorkerPublicUrlFormat(): void {
  const url = process.env.WORKER_PUBLIC_URL;
  if (!url) return; // presence is enforced by the caller's required-list check
  const isProd = process.env.NODE_ENV === 'production';
  const pattern = isProd ? /^https:\/\/[^/]+$/ : /^https?:\/\/[^/]+$/;
  if (!pattern.test(url)) {
    throw new Error(
      `WORKER_PUBLIC_URL must be ${isProd ? 'https://<host>' : 'http(s)://<host>'} ` +
        `with no trailing slash or path (got: ${url})`,
    );
  }
}
```
Call `assertWorkerPublicUrlFormat();` at the END of both `assertChannelsWhatsAppEnv()` and `assertZernioPublishingEnv()` (after their existing required-list checks). Read the file to place the calls correctly inside each function.

- [ ] **Step 7: Add boot-format tests**

In `worker/config/__tests__/startup-assertion.test.ts`, follow the existing env snapshot/restore pattern for `assertChannelsWhatsAppEnv` (which already sets all required vars in a happy-path helper). Add tests:
```ts
  it('rejects a WORKER_PUBLIC_URL with a trailing slash', () => {
    // (set all required WhatsApp vars to valid values first, per the existing happy-path setup)
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com/';
    expect(() => assertChannelsWhatsAppEnv()).toThrow(/WORKER_PUBLIC_URL/);
  });

  it('accepts a clean https WORKER_PUBLIC_URL', () => {
    process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
    expect(() => assertChannelsWhatsAppEnv()).not.toThrow();
  });
```
Match the exact happy-path var setup the existing `assertChannelsWhatsAppEnv` tests use (read them first), so only `WORKER_PUBLIC_URL` is the variable under test.

- [ ] **Step 8: Verify + commit**

Run: `pnpm test -- src/lib/shared worker/config && pnpm typecheck`
Expected: PASS.
```bash
git add src/lib/shared/worker-public-url.ts src/lib/shared/__tests__/worker-public-url.test.ts worker/ingress/twilio/whatsapp-shared.ts src/lib/notifications/channels/whatsapp-channel.ts worker/config/startup-assert.ts worker/config/__tests__/startup-assertion.test.ts
git commit -m "fix(worker): normalize + format-assert WORKER_PUBLIC_URL via single accessor (F-13)"
```

---

## Task 3: F-16 — `SESSION_COOKIE_SECRET` minimum length

TDD: add the short-secret rejection tests (red), then the length guard in `getSessionSecret()` + the boot assert (green).

**Files:**
- Test: `src/lib/approval/__tests__/cookies.test.ts`, `worker/config/__tests__/startup-assertion.test.ts`
- Modify: `src/lib/approval/cookies.ts`, `worker/config/startup-assert.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/approval/__tests__/cookies.test.ts`, add a test that a short secret is rejected (set it, call a public function that uses `getSessionSecret`, restore after):
```ts
  it('throws when SESSION_COOKIE_SECRET is shorter than 32 bytes', () => {
    const prev = process.env.SESSION_COOKIE_SECRET;
    process.env.SESSION_COOKIE_SECRET = 'short';
    try {
      // setDeviceCookie reads the secret via getSessionSecret()
      expect(() => setDeviceCookie(/* use the same args the other setDeviceCookie tests use */)).toThrow(/SESSION_COOKIE_SECRET/);
    } finally {
      process.env.SESSION_COOKIE_SECRET = prev;
    }
  });
```
(Read the existing `setDeviceCookie` tests to copy the exact call args/response object they pass. If `setDeviceCookie`'s signature makes this awkward, use `verifyDeviceCookie` instead — whichever the existing tests already exercise.)

In `worker/config/__tests__/startup-assertion.test.ts`, add to the `assertAccountOffboardingEnv` describe block (following its existing snapshot/restore pattern):
```ts
  it('throws when SESSION_COOKIE_SECRET is shorter than 32 bytes', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECRET = 'short';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(() => assertAccountOffboardingEnv()).toThrow(/SESSION_COOKIE_SECRET/);
  });

  it('accepts a SESSION_COOKIE_SECRET of at least 32 bytes', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECRET = 'a'.repeat(32);
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(() => assertAccountOffboardingEnv()).not.toThrow();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test -- src/lib/approval/__tests__/cookies.test.ts worker/config/__tests__/startup-assertion.test.ts`
Expected: FAIL — no length guard exists yet (the short secret is currently accepted).

- [ ] **Step 3: Add the length guard in `getSessionSecret`**

In `src/lib/approval/cookies.ts`, update `getSessionSecret`:
```ts
function getSessionSecret(): string {
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (!secret) throw new Error('SESSION_COOKIE_SECRET is not set');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_COOKIE_SECRET must be at least 32 bytes (256-bit HMAC key)');
  }
  return secret;
}
```

- [ ] **Step 4: Add the length check to the boot assert**

In `worker/config/startup-assert.ts`, in `assertAccountOffboardingEnv()` after the existing presence check passes, add:
```ts
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (secret && Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_COOKIE_SECRET must be at least 32 bytes (256-bit HMAC key)');
  }
```
(Place it so it runs only when the flag is on and presence already passed — read the function to position it correctly.)

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm test -- src/lib/approval/__tests__/cookies.test.ts worker/config/__tests__/startup-assertion.test.ts`
Expected: PASS. Also confirm the pre-existing cookies tests (which use a 34-char secret) stay green.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add src/lib/approval/cookies.ts src/lib/approval/__tests__/cookies.test.ts worker/config/startup-assert.ts worker/config/__tests__/startup-assertion.test.ts
git commit -m "fix(auth): require SESSION_COOKIE_SECRET >=32 bytes at read + boot (F-16)"
```

---

## Task 4: F-4 — `approval_method` CHECK constraint (migration 068)

No CI test (no constraint-integration harness; CI lacks `TEST_DATABASE_POOL_URL`). Deliverable = the migration file + migrations-log entry. Verification = the in-file preflight + the operator's staging apply.

**Files:**
- Create: `supabase/migrations/068_approval_method_required.sql`
- Modify: `.claude/reference/migrations-log.md`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/068_approval_method_required.sql` (mirror the header style of `067_*.sql` — read it first):
```sql
-- =====================================================================
-- 068_approval_method_required.sql
--
-- F-4 (security audit 2026-06-15): schema backstop for invariant #3
-- ("no unapproved posting"). Today approval_method is nullable and only a
-- value-check exists (responses_approval_method_check: NULL or in
-- ('owner','auto_policy')). Nothing ties an *approved* status to a non-null
-- method, so the invariant is code-enforced only. This adds that backstop.
--
-- Constraint: any row in an approved/edited/awaiting-owner-connect state MUST
-- carry an approval_method. 'posted' is intentionally OMITTED: migration 055
-- left some legacy 'posted' rows with NULL approval_method (only audit-logged
-- ones were backfilled), and a row can only reach 'posted' THROUGH
-- approved/edited (now guarded), so the invariant holds without choking on
-- grandfathered rows.
--
-- Safety: migration 055 exhaustively backfilled approved/edited/
-- awaiting_owner_connect rows to 'owner', so this applies cleanly.
-- Apply staging-first, then production, both Supabase projects in lockstep.
--
-- Preflight BEFORE applying (run on each project; expect 0 rows):
--   SELECT status, count(*) FROM responses
--    WHERE status IN ('approved','edited','awaiting_owner_connect')
--      AND approval_method IS NULL
--    GROUP BY status;
--
-- Verification after apply (should reject):
--   -- UPDATE responses SET status='approved', approval_method=NULL WHERE id=<test row>;  -- expect CHECK violation
-- =====================================================================

ALTER TABLE responses
  ADD CONSTRAINT responses_approval_method_required
  CHECK (
    status NOT IN ('approved', 'edited', 'awaiting_owner_connect')
    OR approval_method IS NOT NULL
  );
```

- [ ] **Step 2: Record the migration in the log**

In `.claude/reference/migrations-log.md`, update the head/next-number line (068 is now head; next is 069) and add a 068 entry describing the constraint + the staging-first/both-projects apply note, matching the format of the existing entries (read the file to match the format exactly).

- [ ] **Step 3: Sanity-check the SQL is well-formed**

This migration is not applied by CI. Confirm the file parses as valid SQL by eye and matches the 067 header style. (Optional, if `psql` + a throwaway DB is handy: `psql <scratch> -f supabase/migrations/068_approval_method_required.sql` after applying 001..067 — not required for the PR.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/068_approval_method_required.sql .claude/reference/migrations-log.md
git commit -m "feat(db): CHECK approval_method on approved states — migration 068 (F-4)"
```

> **Operator-gated (NOT part of this PR's CI):** before/at merge, run the preflight on **staging** Supabase (expect 0), apply 068 to staging, then production — both projects in lockstep, staging first.

---

## Task 5: Full verification gate

**Files:** none.

- [ ] **Step 1: Lint + typecheck + full test suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS.

- [ ] **Step 2: Schema/tenant audits (migration touched schema)**

Run: `pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:static-policy`
Expected: all PASS.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 4: Confirm clean tree + branch log**

Run: `git status --short && git --no-pager log --oneline origin/main..HEAD`
Expected: clean; 4 finding commits (F-17, F-13, F-16, F-4) + the spec/plan doc commits.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin security/audit-remediation-phase-2
gh pr create --base main --title "Security audit Phase 2: DB + boot invariant backstops (F-4/13/16/17)" --body "Implements Phase 2 (docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-2-design.md). Staging lane: migration 068 apply is operator-gated (preflight + staging-first, both Supabase projects in lockstep) after green CI."
```
Expected: CI green. The migration apply + staging deploy remain operator-gated.

---

## Self-Review

**Spec coverage:** F-17 (Task 1) ✓, F-13 (Task 2) ✓, F-16 (Task 3) ✓, F-4 (Task 4) ✓, verification (Task 5) ✓. F-4's "no CI test" is explicit and matches the spec §4 (preflight + staging apply is the verification).

**Placeholder scan:** Code/Lua/SQL shown in full. The two spots that say "read the existing test setup" (Task 2 Step 7 happy-path vars; Task 3 Step 1 `setDeviceCookie` args) are deliberate — the exact var/arg lists live in the existing test files and must be copied verbatim rather than guessed; the assertion being added is fully specified.

**Type/name consistency:** `getWorkerPublicUrl` name matches across accessor, test, and the 3 call sites. `CACHE_TTL_SECONDS` (module-private in tracker.ts) is referenced only within tracker.ts. Constraint name `responses_approval_method_required` is distinct from the existing `responses_approval_method_check`. TTL value `86400` matches `CACHE_TTL_SECONDS` and the `'86400'` string asserted in tests.
