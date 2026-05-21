# Spec 04 — Authentication, Authorization & Identity

> **Goal:** Email/password + Google SSO + Magic Link day 1; TOTP MFA available everywhere and mandatory for billing owners; full role model in the schema even if UI only exposes Owner+Editor; append-only audit log.

---

## 1. Why this matters

Auth bugs are silent for a long time then catastrophic. Designing the role model now (even hiding most of it) saves a migration nightmare at $50k MRR when the first enterprise prospect asks for SSO + RBAC.

## 2. Current state (RepWorth)

- Supabase Auth with email/password + 6-digit OTP confirmation template (per CLAUDE.md gotcha: `{{ .Token }}` not `{{ .ConfirmationURL }}`).
- Self-serve signup behind `SELF_SERVE_SIGNUP_ENABLED` flag.
- Only an "owner" role; no `roles` table.
- Audit log pattern exists for billing (recent CSV-import fix writes audit before enqueue).
- Cleanup poller for abandoned signups exists (`CleanupAbandonedSignupsPoller`) — handle with care per CLAUDE.md gotcha (`deleteUser()` irreversible).

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

Schema: new table `account_memberships(account_id, user_id, role, business_id NULL, created_at, deactivated_at)`. UI initially exposes Owner + Editor; rest gated behind feature flag.

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
- Append-only `audit_events(account_id, actor_user_id, action, entity_type, entity_id, metadata JSONB, ip, user_agent, request_id, created_at)`.
- Generalize the existing pattern (already used for CSV import billing).
- Surface in-app at Settings → Audit log on Scale tier; CSV/JSON export.
- Retain 13 months minimum (compliance + dispute defense).

### Brute-force / rate limits
- 5 reset requests / email / hour.
- 10 signups / IP / hour.
- Exponential backoff after 5 failed logins (Upstash Ratelimit).
- All auth failures logged with IP + UA for anomaly detection.

## 4. Implementation tasks

1. New migration **043** — `account_memberships` table + `audit_events` generalized table. Foreign keys, RLS, indexes on `(account_id, created_at)`.
2. Refactor authorization middleware (`src/middleware.ts` + per-route helpers) to read role from `account_memberships`, not from an implicit `users.role`.
3. Enable Supabase MFA. Add Settings → Security UI with TOTP enrollment + recovery codes.
4. Enforce MFA on billing-owner login (block flow if not enrolled). Banner prompt on Scale-tier user logins without MFA.
5. Build Settings → Team UI: invite, role assignment, deactivate, re-activate. Audit every action.
6. Implement Settings → Security: device list, revoke session, "sign out everywhere" — backed by Supabase Auth session API.
7. Generalize audit-log helper into `src/lib/audit/log.ts` with typed `action` enum. Replace ad-hoc audit writes in billing/CSV paths.
8. Add Upstash Ratelimit middleware (`src/lib/ratelimit/*`) — per-IP signup, per-email password reset, exponential backoff on login.
9. Add admin impersonation path (see [Spec 13](./13-customer-support.md)) — separate from regular login, behind admin flag + MFA + audit.
10. Cloudflare / Vercel WAF rules for IP-level abuse — gate at edge before Supabase.

## 5. Acceptance criteria

- [ ] Login with email/pw, Google SSO, Magic Link all work in production.
- [ ] TOTP enrollment works for any user; recovery codes downloadable once.
- [ ] Billing-owner role cannot disable MFA without re-auth + audit entry.
- [ ] `account_memberships` schema present; `audit_events` writing on invite/accept/role-change/deactivate/MFA-enroll/MFA-disable/login-fail/session-revoke.
- [ ] Settings → Team and Settings → Security pages live with the listed actions.
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
- Gotchas: `{{ .Token }}` vs `{{ .ConfirmationURL }}` confirmation template (CLAUDE.md)
