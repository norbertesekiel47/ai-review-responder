# Lab notes — Supabase auth

## Summary

- **Supabase auth** — implicit-flow OTP, identities:[] for existing emails, auth_id vs users.id, SMTP rate limit, a client-wide fetch timeout also bounds identity MUTATIONS → split bounded/unbounded clients (#508)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-04.md § "Supabase server-side signUp implicit flow"
- history/2026-04.md § "Admin-onboarded owners with `auth_id=NULL`"
- history/2026-04.md § "Supabase built-in SMTP rate limit"
- history/2026-04.md § "`CleanupAbandonedSignupsPoller` TOCTOU vulnerability"
- history/2026-04.md § "Supabase obfuscated signUp response for existing emails"
- history/2026-05.md § "Postgres FK to `users(id)` — never store Supabase `auth_id` directly"
- history/2026-05.md § "Impersonation: reap expired sessions, re-check AAL2 on the view, no session swap"
- history/2026-07.md § "[2026-07-20] Bounding the shared supabase-js client's global fetch also bounded Auth identity MUTATIONS → an ambiguous timeout can orphan a committed signUp/invite → split the client"
