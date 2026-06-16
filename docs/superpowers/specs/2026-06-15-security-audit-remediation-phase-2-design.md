# Security-Audit Remediation — Phase 2 Design (DB + Boot Invariant Backstops)

**Date:** 2026-06-15
**Source audit:** `docs/security-audit/2026-06-15-refresh-delta.md`
**Phase 1 (merged):** PR #325 — `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-1-design.md`
**Status:** Design approved; ready for implementation plan.

## 1. Context

Phase 2 of the 7-phase remediation (roadmap in the Phase 1 spec §1). Four
findings that backstop invariants at the database and worker-boot layers:
F-4, F-13, F-16, F-17.

**Lane: `staging` first.** This phase adds one migration and worker boot
assertions, so per the RepWorth promotion rules it rides `staging` before
`main`, and the migration applies to **both** Supabase projects in lockstep,
**staging first**. The code/test implementation and PR CI do **not** require a
live migration apply (the migration is a checked-in `.sql` file; tests use the
test DB / mocks). The actual staging migration apply + staging deploy are
operator-gated steps after the PR is green (same class as the Phase 1 staging
push).

## 2. Scope

| # | Sev | Finding | Location |
|---|---|---|---|
| F-4 | Low | Invariant #3 code-enforced, not schema-enforced | `responses` table (migration 068) |
| F-13 | Med | `WORKER_PUBLIC_URL` not normalized/asserted | `worker/ingress/twilio/whatsapp-shared.ts`, `src/lib/notifications/channels/whatsapp-channel.ts`, `worker/config/startup-assert.ts` |
| F-16 | Med | `SESSION_COOKIE_SECRET` length never validated | `src/lib/approval/cookies.ts`, `worker/config/startup-assert.ts` |
| F-17 | Med | `ADJUST_COST_LUA` missing `EXPIRE` → TTL-less ghost key | `src/lib/costs/tracker.ts` |

## 3. Per-finding design

### F-4 — `approval_method` CHECK constraint (migration 068)
**Current:** `approval_method TEXT NULL` (migration 055) with only a value-check
(`responses_approval_method_check`: NULL or in `('owner','auto_policy')`). No
constraint ties an approved status to a non-null method. Invariant #3 ("no
unapproved posting") is code-enforced only.

**Fix:** new migration `supabase/migrations/068_approval_method_required.sql`:
```sql
ALTER TABLE responses
  ADD CONSTRAINT responses_approval_method_required
  CHECK (
    status NOT IN ('approved', 'edited', 'awaiting_owner_connect')
    OR approval_method IS NOT NULL
  );
```

**Decision — omit `'posted'` (approved with the design):** migration 055 left
some legacy `posted` rows with `NULL approval_method` (only audit-logged ones
were backfilled), so including `'posted'` would fail the migration on
grandfathered data. It is also unnecessary — a row can only reach `posted`
*through* `approved`/`edited`, which this constraint guards, so the upstream
invariant is enforced without choking on legacy rows.

**Migration safety:** migration 055 exhaustively backfilled `approved`/`edited`/
`awaiting_owner_connect` rows to `'owner'`, so the constraint is expected to
apply cleanly. The migration is preceded by a **preflight** (run before applying,
staging first):
```sql
SELECT status, count(*) FROM responses
 WHERE status IN ('approved','edited','awaiting_owner_connect')
   AND approval_method IS NULL
 GROUP BY status;   -- expect: 0 rows
```
If non-zero, stop and investigate (do not force the constraint). The migration
header documents the preflight + the staging-first/both-projects-lockstep apply.

### F-13 — `WORKER_PUBLIC_URL` normalization + format assertion
**Current:** `worker/ingress/twilio/whatsapp-shared.ts` builds the Twilio
signature base URL as `` `${process.env.WORKER_PUBLIC_URL}${request.url}` ``; a
trailing slash yields `https://host//ingress/…` → signature mismatch → 403. Two
more raw uses in `whatsapp-channel.ts:35,64` (`statusCallback`). The var is
asserted (presence-only) only inside the WhatsApp/Zernio flag-gated blocks; no
format/trailing-slash check anywhere.

**Fix — one authoritative accessor + boot format check:**
- New `src/lib/shared/worker-public-url.ts` exporting `getWorkerPublicUrl(): string`
  — reads `process.env.WORKER_PUBLIC_URL`, throws if unset, returns it with any
  trailing slash(es) stripped (`.replace(/\/+$/, '')`). (Placed in `src/lib/shared`
  because both `worker/ingress/*` and `src/lib/notifications/*` consume it.)
- All three call sites use `getWorkerPublicUrl()` instead of reading the env
  directly.
- In `startup-assert.ts`, where `WORKER_PUBLIC_URL` is already required
  (WhatsApp + Zernio blocks), strengthen presence → **format**: must match
  `^https://[^/]+$` when `NODE_ENV === 'production'`; allow `^https?://[^/]+$`
  (i.e. `http://localhost…`) otherwise. Reject a trailing slash / path / non-
  https-in-prod at boot with a clear message.

This keeps the functional fix in one place (the accessor) and fails fast on
misconfiguration in the environments that use the var.

### F-16 — `SESSION_COOKIE_SECRET` minimum length
**Current:** `getSessionSecret()` (`cookies.ts`) checks presence only, then uses
the raw UTF-8 string as an HMAC-SHA256 key. Also consumed by worker-side
account-offboarding. Boot assertion is presence-only and only when
`ACCOUNT_OFFBOARDING_ENABLED=true`.

**Fix:** enforce a minimum key strength at the single authoritative read site
and at worker boot:
- In `getSessionSecret()`, after the presence check, require
  `Buffer.byteLength(secret, 'utf8') >= 32` (256-bit key); throw a clear error
  otherwise. This covers every consumer (Next.js approval cookies + worker
  offboarding tokens/destructive-auth).
- Strengthen the worker `assertAccountOffboardingEnv()` block from presence-only
  to presence + the same ≥32-byte length check, so the worker fails fast at boot
  rather than on first use.

### F-17 — `ADJUST_COST_LUA` `EXPIRE`
**Current (`tracker.ts`):** `RESERVE_COST_LUA` sets `EXPIRE KEYS[1]/KEYS[2]` to
`CACHE_TTL_SECONDS` (86400) on success; `ADJUST_COST_LUA` does `INCRBY` on both
keys with **no** `EXPIRE`. If `finalizeCost()`/`releaseCost()` is the first
writer of the day (reserve key expired/evicted), it creates an immortal key.

**Fix:** mirror RESERVE in `ADJUST_COST_LUA`:
```lua
local adjustment = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
redis.call('INCRBY', KEYS[1], adjustment)
redis.call('INCRBY', KEYS[2], adjustment)
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return 'ok'
```
Update both eval call sites (`finalizeCost`, `releaseCost`) to pass
`String(CACHE_TTL_SECONDS)` as `ARGV[2]`. TTL stays 86400, consistent with
RESERVE.

## 4. Verification plan

- `pnpm lint && pnpm typecheck && pnpm test`
- `pnpm ci:tenant-scope && pnpm ci:rls-audit` (migration touches schema)
- New/updated tests: F-13 accessor strips trailing slash + throws when unset;
  F-16 rejects a <32-byte secret and accepts ≥32; F-17 `ADJUST_COST_LUA` sets a
  TTL on both keys (assert the `EXPIRE`/`ttl` arg is passed by both callers).
- F-4: CI applies migrations to its test DB and runs the integration suite, so
  the constraint is exercised in CI — existing `responses` seed fixtures (in the
  publisher integration test, `audit-snapshot.integration`, and an e2e seed)
  that create `approved`/`edited`/`awaiting_owner_connect` rows must seed
  `approval_method='owner'` to satisfy it. The remaining operator-gated
  verification is the staging preflight (expect 0) + the staging/prod apply.

## 5. Lane & rollout (operator-gated steps)

- PR to `main` with green CI (CI does not need the live migration).
- **Operator-gated, after green CI / before or at merge:** apply migration 068
  to **staging** Supabase first (run the preflight; expect 0), then production,
  both projects in lockstep. Then the normal promote + `staging` fast-forward.
- Worker boot-assert changes (F-13/F-16) take effect on the next worker deploy;
  no data migration.

## 6. Out of scope (this phase)

F-1, F-3, F-5, F-7–F-12, F-14, F-15, F-18–F-26 — other phases (Phase 1 spec §1
roadmap). F-3 remains deferred to 2026-06-18; the newly-surfaced `form-data`
(high) + OpenTelemetry (moderate) transitive-dep advisories are recommended for
that same dependency follow-up.
