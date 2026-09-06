---
paths:
  - "src/lib/auth/**"
  - "src/app/api/auth/**"
  - "src/app/api/signup/**"
  - "src/app/(public)/**"
---

# Supabase auth rules

## Read first

- Lab notes: `.claude/reference/lab-notes/supabase-auth.md` (implicit-flow OTP, `identities: []` for existing emails, `auth_id` vs `users.id`, SMTP rate limit, split bounded/unbounded clients).
- File map: `docs/directory/lib-platform.md` § `auth/`; `docs/directory/app-public.md` (`src/app/(public)/`), `docs/directory/app-api-a.md` / `app-api-b.md` (`src/app/api/auth/`, `src/app/api/signup/`).
- Invariant #8 (`users.auth_id` maps to Supabase Auth identity; browser code never receives `SUPABASE_SERVICE_KEY`) and #15 (`src/lib/db/auth.ts` is the owner-classified auth gate) stay in `.claude/CLAUDE.md`.
- Skill `supabase:supabase` for any Supabase Auth work (sessions, JWT, cookies, `getUser`/`getClaims`, RLS).

## Traps

- **`SELF_SERVE_SIGNUP_ENABLED`**: confirmation template must use `{{ .Token }}` (6-digit OTP), NOT `{{ .ConfirmationURL }}`. Reset/invite links need `&amp;` not `&` in `href` attributes.
- **Supabase `signUp()`** returns `identities: []` for already-confirmed emails (anti-enumeration). Detect before `createBusinessTx`.

## Rules

- Nothing beyond the two gotchas was moved from `.claude/CLAUDE.md`; the `CleanupAbandonedSignupsPoller` gotcha lives in `.claude/rules/worker-layout.md`.
