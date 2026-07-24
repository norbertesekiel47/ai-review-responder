---
name: approval-security
description: Approval-token security rules and the read-only approve-page flow (SHA-256 hashed tokens, POST-only session binding, TTL/rate limits, audit logging). Use before touching approval links, token generation/validation, or the /approve route.
---

# Approval Token Security

## Token storage
- Raw tokens are NEVER stored in Postgres. Only SHA-256(token) in approval_links.
- Use `import { createHash } from 'node:crypto'` for hashing — never crypto-js.
- Token generation happens in NotificationWorker, right before sending email.
- Raw tokens exist only in memory and in the sent email. Never in outbox payloads, logs, or any persisted store.

## Approval page flow
1. `GET /approve/:token` is READ-ONLY. Validates token for display, renders minimal shell (business name + "Review a draft response"), sets CSRF cookie. NEVER writes to DB. No review text in initial HTML (prevents email preview bot caching).
2. Client-side JS fetches actual content via TanStack Query after page mount.
3. Owner taps "Continue" -> `POST /api/approval/session` binds `device_cookie_hash` (if not yet bound).
4. `POST /approve/:token/approve|edit|regenerate` requires: raw token + device cookie + CSRF token. All three must match.

## Why POST-only binding
Email security scanners (Gmail, Outlook, corporate proxies) prefetch GET URLs. If GET bound the session, a scanner could hijack it. POST binding prevents this.

## Lifecycle rules
- Approval links have 48-hour TTL.
- Regenerate revokes ALL outstanding links for that response.
- Rate limit: 3 actions per token per minute.
- Regenerate budget: max 3 per review per day via Redis counter.

## Audit logging
- Log every approval action to `approval_audit_log`: timestamp, token hash, device cookie hash, response ID, business ID, action type, IP address.
- Critical for investigating disputes and detecting abuse patterns.

## Auto-approval runtime
- Auto-approval is disabled by default via server-only `AUTO_APPROVAL_ENABLED=false`; never add a `NEXT_PUBLIC_*` companion.
- `approval_method` is authoritative: owner actions set `owner`; policy approvals set `auto_policy`; pending drafts must have it `NULL`.
- High-severity moderation flags are an absolute veto. Held drafts are not notified, not auto-approved, and re-enter owner review only through admin disposition.
- Runtime policy approval is allowed only for fresh `live_ingest_new` v1 jobs with matching review content hash, active location/connection, allowed publisher subscription, enabled policy threshold, and clean provider moderation.
- If the runtime flag is off before publish, `ResponsePublisherWorker` downgrades unposted `auto_policy` rows to `pending_approval`, records `auto_policy_revoked_by_kill_switch`, enqueues normal owner notification, and completes the publish outbox in the same transaction.
- Manual approval after a downgrade must set `approval_method='owner'` and clear stale `posting_error`.

