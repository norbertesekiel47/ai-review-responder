# Spec 04 — Authentication, Authorization & Identity

> **Goal:** Email/Google/Magic-Link auth is **already live** — harden it. Add TOTP MFA (mandatory for billing owners), land the `account_memberships` schema + backfill **behind a flag (UI deferred)**, and generalize the **existing** `account_audit_log` into an append-only audit trail. Rate-limit hardening on the current single-owner model.

---

## 1. Why this matters

Auth bugs are silent for a long time then catastrophic. Designing the role model now (even hiding most of it) saves a migration nightmare at $50k MRR when the first enterprise prospect asks for SSO + RBAC.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- **Auth methods already wired:** email/password (`src/app/api/auth/signup/route.ts`), **Google OAuth** (`src/components/auth/hooks/useGoogleOAuth.ts`), **Magic Link** (`src/app/api/auth/callback/route.ts`, `'magiclink'` OTP type). The spec's "day 1" set is **done** — this spec hardens it.
- Signup uses a manual **6-digit OTP** entry path (`/api/auth/verify-otp`); the `{{ .Token }}` gotcha lives in the **Supabase dashboard** templates, not this repo.
- Self-serve signup behind `SELF_SERVE_SIGNUP_ENABLED` (checked in signup/verify-otp routes + `CleanupAbandonedSignupsPoller`).
- **Roles:** `users.role` already exists with `'owner' | 'sales_partner' | 'admin'` (migration 001). No `roles` table, no `account_memberships`. Model is **single owner per account** (`accounts.owner_user_id` 1:1 `users.id`); no teams/invites.
- **Two audit tables already exist:** `approval_audit_log` (migration 001 — approval actions) and `account_audit_log` (migration 034 — `account_id, location_id, event_type, actor_user_id, payload JSONB, created_at`). **Generalize `account_audit_log`** — do not invent a third `audit_events` table. (CSV-import audit writes are not yet wired to it.)
- **No MFA/TOTP** anywhere (greenfield).
- **Rate limiting exists** but is **Redis-Lua based** (`src/lib/shared/rate-limit.ts`), not `@upstash/ratelimit` — signup (5/hr) and verify-otp (per-email + per-IP) limits already enforced. Reuse it; don't add a new lib.
- `src/middleware.ts` enforces role + `account_id` per route (post-migration-034). No Settings → Team and no Settings → Security tab (Settings has Account/Voice/Channels/Locations).
- `CleanupAbandonedSignupsPoller` exists (`deleteUser()` irreversible — advisory-lock + FOR-UPDATE revalidation already in place).

## 3. Target state

### Auth methods
| When | Methods |
|---|---|
| Day 1 (now) | Email/password, Google SSO, Magic Link |
| Day 90 | Microsoft SSO (365 customers) |
| Day 365 | Passkeys |
| Skip until enterprise | Apple SSO, SAML/SCIM via WorkOS or Stytch B2B |

### MFA
- TOTP available for every user, via Supabase Auth MFA.
- **Mandatory** for `billing_owner` role.
- **Mandatory** for every user on Scale tier.
- Recovery codes generated at enrollment, downloadable once, never re-shown.

### Role model
```
roles:
  owner            -- billing + everything (always exactly 1 per account)
  admin            -- everything except delete-account and billing changes
  editor           -- approve + edit responses
  viewer           -- read-only
  billing          -- billing portal only

per-location roles (Scale tier):
  location_admin   -- admin scoped to a business_id
  location_editor  -- editor scoped to a business_id
```

Schema: new table `account_memberships(account_id, user_id, role, business_id NULL, created_at, deactivated_at)`. **Phase A (this spec):** land the schema + backfill `(owner_user_id, 'owner')` per account behind a flag — **no team UI**. **Phase B (later spec):** invite flow + Settings → Team. ⚠️ Reconcile with the existing `users.role`: `owner`/`sales_partner`/`admin` are **platform** roles; `account_memberships.role` is **per-account** membership. Document the mapping so the two don't collide (e.g. middleware checks platform `admin` first, then membership role).

### Sessions
- 30-day rolling session.
- 12-hour idle timeout for sensitive routes: billing, audit log export, admin impersonation.
- Settings → Security: device list (UA + IP + last seen), revoke session, "sign out everywhere".

### Invites
- Email invite with 7-day signed token (HMAC, not stored raw — same pattern as approval tokens).
- Accept page sets password / SSO, assigns role per invite.
- Deactivation revokes sessions immediately, preserves history.
- Re-activation is one-click for Owner.

### Audit log
- Generalize the **existing `account_audit_log`** (migration 034: `account_id, location_id, event_type, actor_user_id, payload JSONB, created_at`) rather than creating a new table. Add the columns it lacks for security events — `entity_type, entity_id, ip, user_agent, request_id` — via migration; keep `payload JSONB` for action-specific detail.
- Wire the CSV-import path (and other actor actions) to write through the generalized helper (currently not wired).
- Surface in-app at Settings → Audit log on Scale tier; CSV/JSON export.
- Retain 13 months minimum (compliance + dispute defense).

### Brute-force / rate limits
- 5 reset requests / email / hour.
- 10 signups / IP / hour.
- Exponential backoff after 5 failed logins (Upstash Ratelimit).
- All auth failures logged with IP + UA for anomaly detection.

## 4. Implementation tasks

1. New migration (claims the next free number — coordinate with Specs 02/05; head is 042) — `account_memberships` table + **extend `account_audit_log`** with `entity_type, entity_id, ip, user_agent, request_id`. Foreign keys, RLS, index on `(account_id, created_at)`. Backfill `account_memberships` with one `(owner_user_id, 'owner')` row per account.
2. **Phase A:** keep `src/middleware.ts` reading `users.role`; add an `account_memberships` read **behind the team flag** so Owner behavior is unchanged when the flag is off. Do not rip out `users.role` — platform roles (`admin`/`sales_partner`) still live there.
3. Enable Supabase MFA. Add Settings → Security UI with TOTP enrollment + recovery codes.
4. Enforce MFA on billing-owner login (block flow if not enrolled). Banner prompt on Scale-tier user logins without MFA.
5. Build Settings → Team UI: invite, role assignment, deactivate, re-activate. Audit every action.
6. Implement Settings → Security: device list, revoke session, "sign out everywhere" — backed by Supabase Auth session API.
7. Generalize the audit helper into `src/lib/audit/log.ts` with a typed `action` enum, writing to the extended **`account_audit_log`**. Wire the CSV-import path and other actor actions through it (currently unwired).
8. **Extend the existing `src/lib/shared/rate-limit.ts`** (Redis-Lua) — add per-email password-reset and exponential backoff on login to the signup/verify-otp limits already there. ⚠️ Do **not** add `@upstash/ratelimit` or a `src/lib/ratelimit/*` dir; that would duplicate working infrastructure.
9. Add admin impersonation path (see [Spec 13](./13-customer-support.md)) — separate from regular login, behind admin flag + MFA + audit.
10. Cloudflare / Vercel WAF rules for IP-level abuse — gate at edge before Supabase.

## 5. Acceptance criteria

- [ ] Login with email/pw, Google SSO, Magic Link continue to work (already live — covered by a regression E2E so this spec's changes don't break them).
- [ ] TOTP enrollment works for any user; recovery codes downloadable once.
- [ ] Billing-owner role cannot disable MFA without re-auth + audit entry.
- [ ] `account_memberships` schema present + backfilled (flag-off); extended `account_audit_log` writing on role-change/deactivate/MFA-enroll/MFA-disable/login-fail/session-revoke. (Invite/accept events land in Phase B.)
- [ ] Settings → Security page live (MFA, device list, session revoke). _Settings → Team is **Phase B** — not gated by this spec._
- [ ] Rate limits return 429 with `Retry-After`; load test confirms.
- [ ] Audit log export downloads CSV+JSON, scoped by `account_id`, signed URL expiring in 24h.

## 6. Metrics

| Metric | Target |
|---|---|
| MFA adoption (owners) | 100% (enforced) |
| MFA adoption (all users on Scale) | 100% (enforced) |
| Login failure rate | < 2% of attempts |
| Password reset success | > 90% (failures usually = abandoned email) |
| Audit log write latency (p95) | < 50ms |
| Audit log retention | ≥ 13 months |

## 7. Risks & mitigations

- **Risk:** MFA enforcement locks out an owner mid-flow. **Mitigation:** recovery code download required at enrollment; support-side break-glass with full audit.
- **Risk:** Role model migration breaks existing customers. **Mitigation:** backfill `account_memberships` with `(owner_user_id, 'owner')` per existing `accounts` row; ship behind feature flag.
- **Risk:** Magic link replayability. **Mitigation:** single-use tokens, 15-min TTL, signed with server-side secret rotated quarterly.

## 8. Dependencies & cross-links

- [Spec 03 — Multi-tenancy & Data Isolation](./03-multitenancy-isolation.md)
- [Spec 09 — Security & Compliance](./09-security-compliance.md)
- [Spec 13 — Customer Support](./13-customer-support.md) (admin impersonation)
- Code anchors: `src/middleware.ts`, `src/app/api/auth/*`, `worker/jobs/notification/*` (invite emails)
- Gotchas: `{{ .Token }}` vs `{{ .ConfirmationURL }}` confirmation template (Supabase dashboard, per CLAUDE.md)
- Code anchors (current state): `src/components/auth/hooks/useGoogleOAuth.ts`, `src/app/api/auth/{signup,verify-otp,callback}/route.ts`, `src/lib/shared/rate-limit.ts`, migrations 001 (`approval_audit_log`) + 034 (`account_audit_log`)

## 9. Implementation in the current repo

- **MFA** rides Supabase Auth's MFA API (factors enroll/challenge/verify) — surface in a new Settings → Security tab (sibling to the existing Settings tabs). No custom TOTP crypto; let Supabase own the secret.
- **`account_memberships`** is schema + backfill only this round. The flag (e.g. `flags.teams_enabled` on `accounts`, which already carries a `flags JSONB`) keeps Phase A inert — Owner-only behavior is preserved with the flag off, mirroring the edit-replies dark-ship pattern (PR #56).
- **Audit helper** (`src/lib/audit/log.ts`) writes via the Postgres.js client. Where an audit row must accompany a state change, put both in the **same transaction / outbox** (transactional-outbox invariant) — never write state then separately log.
- **Rate-limit** extensions are additional callers of the existing `rate-limit.ts` Lua primitive; reuse `strict` mode for auth-failure paths (fail-closed).
- **Invite tokens (Phase B)** reuse the approval-token pattern: HMAC, store only the SHA-256 hash (approval-security skill), raw token only in the email.

---
_Verified 2026-05-23 against migration head 042. Marked email/Google/Magic-Link as already-shipped; redirected audit work to the existing `account_audit_log` (not a new `audit_events`); reused `rate-limit.ts` instead of Upstash SDK; phased teams to schema-now/UI-later per decision._
