# Env-var documentation & boot-hardening (launch-ready point 5)

**Date:** 2026-05-28
**Branch:** `worktree-feat+env-boot-hardening`
**Source:** `docs/launch-ready-part1.md` line 170 — *"Document + assert `CONTACT_NOTIFY_TO`
and `LIST_UNSUBSCRIBE_EMAIL`; harden the `ADMIN_NOTIFICATION_EMAIL` silent-drop; add
the `SENTRY_DSN`-unset boot warning."*

Classified in the launch doc as **🔀 "Write now, set value at deploy"**: this change
ships the documentation, the boot assertions/warnings, and the fallback hardening
**now**; the actual production values are set later at deploy time (out of scope here).

---

## Problem

Four notification/observability env vars degrade silently when unset, hiding
misconfiguration until something breaks in production:

| Var | Runtime | Current behavior when unset |
|---|---|---|
| `CONTACT_NOTIFY_TO` | Next.js / Vercel (3 routes) | Falls back to a hardcoded **personal Gmail** (`norbertesekiel@gmail.com`), duplicated in `contact`, `demo-request`, `lead-intake` routes. Public leads silently route to a personal inbox. |
| `LIST_UNSUBSCRIBE_EMAIL` | Worker / Railway (marketing email) | Falls back to a non-functional `example.com` mailbox; only a per-send `console.warn` surfaces it. No boot-time signal. |
| `ADMIN_NOTIFICATION_EMAIL` | Worker / Railway (3 sites) | Silently drops admin alerts — `AdminExceptionWorker` marks the outbox **completed**; `NotificationFailoverPoller` logs a `console.warn` and continues. No boot-time signal. |
| `SENTRY_DSN` | Worker + Next.js boot | `Sentry.init` silently no-ops; production errors go untracked with no boot signal. |

The house style (`worker/config/startup-assert.ts`) already establishes the
correct pattern: **hard-assert required vars at boot, but only bite in production /
non-mock** so local dev, CI, and tests never break.

---

## Decisions (settled with the user)

1. **Boot strictness — tiered.**
   - `ADMIN_NOTIFICATION_EMAIL` → **hard assert** (throws at boot in production; core
     ops alerts must never silently drop).
   - `LIST_UNSUBSCRIBE_EMAIL` → **warn only** (marketing-compliance only, and it
     already has a safe runtime fallback + per-send warning).
2. **`CONTACT_NOTIFY_TO` fallback — company mailbox + warn.** When unset but
   `RESEND_API_KEY` is set, fall back to the `RESEND_FROM_EMAIL` mailbox (company
   sending domain, monitorable) and log a loud warning. The personal Gmail is
   removed. Never 500 a visitor, never lose a lead. A single shared helper replaces
   the triplicated fallback.

---

## Design

### 1. `CONTACT_NOTIFY_TO` (Next.js)

**New module `src/lib/notifications/contact-notify.ts`** — single owner of the
recipient-resolution rule:

```ts
export type ContactNotifySource = 'env' | 'from-email' | 'default';

export function resolveContactNotifyTo(): { to: string; source: ContactNotifySource };
```

Resolution order:
1. `CONTACT_NOTIFY_TO` (trimmed, non-empty) → `source: 'env'`
2. `extractMailbox(RESEND_FROM_EMAIL)` → `source: 'from-email'`
3. `'noreply@repworth.com'` (matches the existing `from` default in the routes) →
   `source: 'default'`

The helper itself emits a single `console.warn` when `source !== 'env'` (mirrors the
existing per-send warn pattern in `email/headers.ts`; routes are rate-limited, so
volume is low). Routes stay thin: `const { to } = resolveContactNotifyTo();`.

**`extractMailbox`** is currently a private function in
`src/lib/notifications/email/headers.ts`. Export it (single source of truth for
mailbox parsing) and import it into `contact-notify.ts` — no duplication.

**Route edits** (remove the `?? 'norbertesekiel@gmail.com'` constant, call the helper):
- `src/app/api/contact/route.ts`
- `src/app/api/demo-request/route.ts`
- `src/app/api/lead-intake/route.ts`

### 2. `LIST_UNSUBSCRIBE_EMAIL` (worker) — warn-only

Add `warnMissingProductionEnv()` to `worker/config/startup-assert.ts`. It logs one
warning line per missing var **only when `NODE_ENV === 'production'`** (and not mock),
so tests/dev stay quiet. Called once from `worker/index.ts` `main()` startup block,
next to the existing feature-flag `console.log` (entry point orchestrates; module
owns the check — invariant #12). Covers `LIST_UNSUBSCRIBE_EMAIL` **and** `SENTRY_DSN`
(item 4). The existing per-send warn in `email/headers.ts` stays as defense-in-depth.

### 3. `ADMIN_NOTIFICATION_EMAIL` (worker) — hard assert

Add `assertAdminNotificationEmail()` to `worker/config/startup-assert.ts` and call it
inside the existing `assertWorkerStartupEnv()` (the unconditional always-required
group, alongside Stripe, run at import via `startup-side-effect-guard.ts`). It throws
**only when `NODE_ENV === 'production'` and not mock** — identical gating to
`assertProductionMockModeEnv`, so dev/CI/test never break even when the var is unset.

The 3 existing per-site runtime guards (`AdminExceptionWorker`,
`NotificationFailoverPoller` ×2, `EngagementAlertWorker`) are **left untouched** as
defense-in-depth; this keeps all current worker tests green and only adds a fail-fast
boot gate on top.

### 4. `SENTRY_DSN` — boot warning

- **Worker:** covered by `warnMissingProductionEnv()` (item 2).
- **Next.js:** add a prod-gated `console.warn` in `src/instrumentation.ts`
  `register()` (nodejs runtime branch) when `SENTRY_DSN` is unset.

---

## Files touched

**New:**
- `src/lib/notifications/contact-notify.ts`
- `src/lib/notifications/__tests__/contact-notify.test.ts`

**Modified — source:**
- `src/lib/notifications/email/headers.ts` (export `extractMailbox`)
- `src/app/api/contact/route.ts`
- `src/app/api/demo-request/route.ts`
- `src/app/api/lead-intake/route.ts`
- `src/instrumentation.ts`
- `worker/config/startup-assert.ts`
- `worker/index.ts`

**Modified — tests:**
- `worker/config/__tests__/startup-assertion.test.ts` (assert + warn cases)
- `src/app/api/contact/__tests__/route.test.ts` (fallback assertion → `noreply@repworth.com`; add env-set path)
- `src/app/api/demo-request/__tests__/route.test.ts` (same fallback assertion update)

**Modified — docs/config:**
- `.env.example` (add `CONTACT_NOTIFY_TO`, `LIST_UNSUBSCRIBE_EMAIL`)
- `.claude/reference/env-vars.md` (correct `CONTACT_NOTIFY_TO`; add `LIST_UNSUBSCRIBE_EMAIL`,
  `ADMIN_NOTIFICATION_EMAIL` prod-required, `SENTRY_DSN` boot-warning notes)
- `docs/launch-ready-part1.md` (mark point 5 done)
- `.gitignore` (add `.claude/worktrees/` — prevents accidentally committing native-tool worktrees; already applied)

---

## Test plan (test-first)

**`startup-assert`:**
- `assertAdminNotificationEmail` — throws in production when unset; no-op in dev;
  no-op in production + mock; passes when set.
- `warnMissingProductionEnv` — warns for each unset var in production; silent in dev;
  silent when the vars are set. (Spy on `console.warn`.)

**`contact-notify`:**
- Returns `CONTACT_NOTIFY_TO` with `source: 'env'` when set (no warn).
- Falls back to the `RESEND_FROM_EMAIL` mailbox with `source: 'from-email'` + warns.
- Falls back to `noreply@repworth.com` with `source: 'default'` + warns when both unset.
- Handles `RESEND_FROM_EMAIL` in both `Display <addr>` and bare-`addr` forms.

**Route tests:** update the two fallback assertions; confirm the `CONTACT_NOTIFY_TO`-set
path still routes to the configured address.

---

## Validation strategy

CLAUDE.md: *"Never validate CI from a git worktree nested inside the repo — module
resolution leaks into parent `node_modules`/eslintrc and poisons lint+test. Push and
read the runner, or clone clean."* This worktree is nested under `.claude/worktrees/`,
so **CI is the authoritative gate**: push the branch and read the runner
(`lint` / `typecheck` / `test` / `build`). Targeted local `vitest` runs may be used
only as quick smoke checks, never as the final word.

---

## Out of scope

- Setting the actual production values (the "at deploy" half).
- Changing the 3 per-site `ADMIN_NOTIFICATION_EMAIL` runtime behaviors (boot assert
  is added on top; runtime guards unchanged).
- `NEXT_PUBLIC_SENTRY_DSN` browser-side init (separate var; already `.env.example`-listed).
- Any other launch-ready point.

---

## Rollout

Pure code/docs change. At deploy, set the four values: `CONTACT_NOTIFY_TO` +
`SENTRY_DSN` (+ `NEXT_PUBLIC_SENTRY_DSN`) on **Vercel**; `ADMIN_NOTIFICATION_EMAIL`
(required — worker won't boot without it in prod) + `LIST_UNSUBSCRIBE_EMAIL` +
`SENTRY_DSN` on **Railway**.
