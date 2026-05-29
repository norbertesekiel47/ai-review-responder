# Launch-review follow-ups (#2–#7) — Design

> **Date:** 2026-05-28
> **Branch:** `worktree-fix+launch-review-followups` (worktree off `origin/main` @ `0671dee7`)
> **Origin:** Findings #2–#7 from the code review of PRs #152–#158 (launch-ready P1/P2 batch).
> **Scope:** Six independent fixes, one PR. No schema/DB changes.

## Context

A high-effort review of the merged launch batch (PRs #152–#158) surfaced six
actionable items. Finding **#1 (founders `base_price_cents`) is NOT in scope** —
it was implemented and merged as PR #157 (migration `054`); the original
"missing" call was a stale-local-`main` artifact.

The remaining six are routes/tests/docs/config only. Validation gate is **CI
after push** — this worktree is nested under `.claude/worktrees/`, and project
CLAUDE.md warns that local lint/test from a nested worktree poisons module
resolution. CI on `main` is green (baseline).

## Fixes

### #2 — Surface unset `CONTACT_NOTIFY_TO` loudly (keep delivering)

**Problem:** `src/lib/notifications/contact-notify.ts` falls back from
`CONTACT_NOTIFY_TO` → `RESEND_FROM_EMAIL` mailbox → `noreply@repworth.com` and
emits only a `console.warn`. When the var is unset in prod, leads route to the
unmonitored no-reply mailbox and the misconfig is easy to miss.

**Decision (chosen):** Keep sending; make the fallback *loud*, not fatal.

**Change:**
- In the fallback branch (`source !== 'env'`), replace the bare `console.warn`
  with `Sentry.captureMessage('contact_notify_to_unset', { level: 'error',
  extra: { resolvedTo: to, source } })`. Precedent:
  `src/app/api/zernio/connect/cancel/route.ts:163`. `scrubSentryEvent`
  (instrumentation `beforeSend`) already strips PII; `to`/`source` are
  non-PII config values. Keep one `console.warn` line for local visibility.
- The function still returns `{ to, source }` — delivery unchanged, form never
  breaks.
- Sharpen `.env.example` + `.claude/reference/env-vars.md` to mark
  `CONTACT_NOTIFY_TO` **required-for-leads** (key already documented).

**Test:** `src/lib/notifications/__tests__/contact-notify.test.ts` — mock
`@sentry/nextjs` (precedent: the select-location route test); assert
`captureMessage` fires on the fallback path and **not** on the `env` path.

### #3 — Document the `ADMIN_NOTIFICATION_EMAIL` boot prerequisite (docs only)

**Problem:** `worker/config/startup-assert.ts` hard-throws (→ `process.exit(1)`
at import via `startup-side-effect-guard`) when `ADMIN_NOTIFICATION_EMAIL` is
unset in prod. Combined with `railway.toml` `restartPolicyMaxRetries = 10`, a
missing var crash-loops the worker to a permanent down state. The fail-fast is
correct; the runbook doesn't flag it as a deploy prerequisite.

**Change (no code):**
- `docs/runbooks/rollback.md` — add `ADMIN_NOTIFICATION_EMAIL` (and the other
  fail-fast worker env vars) to a "boot prerequisites" note in the redeploy
  section: set in Railway **before** deploying; Railway will not self-heal a
  deterministic boot failure.
- `railway.toml` — one-line comment near the restart policy cross-referencing
  the runbook note.

### #4 — `bounced-skip` test can't pass for the wrong reason

**Problem:** `worker/jobs/notification/__tests__/bounced-skip.test.ts` uses a
content-addressed SQL mock that returns `[]` on fragment drift. For the three
summary-worker cases, a `[]` business-load result takes the *business-not-found*
early return — which also sends no email + completes the outbox — so the
assertions pass green even though the `owner_email_bounced` branch was never
reached.

**Change:** For each affected case, add a **positive** assertion that flow
reached the bounce branch (e.g. channel-resolution / dispatch was invoked, or
the business-load query fragment actually matched and returned the fixture), so
a fragment-drift `[]` skip **fails** the test instead of silently passing.

### #5 — `OutboxPoller` test asserts shape, not the safety guard

**Problem:** `worker/background/pollers/__tests__/OutboxPoller.test.ts` asserts
via SQL substring (`status = 'dispatched'`), so a regression that dropped the
optimistic-lock `WHERE` guard (`status = 'dispatching' AND attempts = …`) would
still match and pass. The attempt-guard cases assert presence of the expected
branch but not absence of the opposite.

**Change:**
- Assert the **full** optimistic-lock predicate on the dispatched-status update.
- Make the attempt-guard cases **mutually exclusive**: in the reset-to-pending
  case assert the dead-letter SQL was *not* issued, and vice versa.

### #6 — Route the 3 contact routes through `sendInternalEmail()`

**Problem:** `contact`, `demo-request`, `lead-intake` routes each hand-roll
`new Resend(...)` + `from ?? 'noreply@repworth.com'` + `emails.send`. They
bypass `isMockMode()` (so hit the **live Resend API even under
`MOCK_EXTERNAL_APIS=true`**), duplicate the `from` literal a 4th time, and skip
category headers/tags. The codebase already has `sendInternalEmail()`
(`src/lib/notifications/email/templates/internal.ts`) and lazy `getResend()`.

**Decision (chosen):** Full refactor through `sendInternalEmail()`.

**Change:**
- Add a thin owner in `contact-notify.ts`:
  `notifyContactSubmission({ subject, lines: string[] }): Promise<{ sent: boolean }>`.
  It resolves the recipient (`resolveContactNotifyTo`), owns the
  **skip-when-unconfigured** policy, renders `lines` → simple HTML body, and
  delegates to `sendInternalEmail({ to, subject, bodyHtml, category: 'internal' })`.
  `category: 'internal'` = no `List-Unsubscribe` (correct for admin/founder
  notices).
- The 3 routes build `subject` + field `lines` and call it; delete `new
  Resend`, the duplicated `from` literal, and the raw `emails.send`.
- **Behavior preserved:** unconfigured (non-mock with no `RESEND_API_KEY`, or no
  `RESEND_FROM_EMAIL`) → skip + `{ success: true }` (best-effort, as today);
  a real send error → 500. **Gained:** mock-mode honored, single `from` owner,
  category headers/tags. `lead-intake`'s existing try/catch→500 semantics are
  preserved by the wrapper's throw-on-real-error contract.

**Tests:** update the 3 route tests to assert (a) no live send under
`MOCK_EXTERNAL_APIS=true`, (b) skip→success when unconfigured, (c) 500 on send
error. Recipient resolution stays covered by `contact-notify.test.ts`.

### #7 — Trim `vercel.json`

**Problem:** `vercel.json` sets `framework: "nextjs"` + `buildCommand: "pnpm
build"`, which silently override the Vercel dashboard build config for all
future deploys.

**Change:** Both keys are Vercel auto-detected defaults for a Next.js project,
so removing them leaves only `$schema` — i.e. nothing meaningful. **Delete
`vercel.json`.** Update references that mention it:
- `docs/runbooks/rollback.md` (if referenced)
- `docs/launch-ready-part1.md` P2 item ("add `vercel.json`")
- `.claude/reference/env-vars.md` (if referenced)
- Re-add a `vercel.json` only later if a route genuinely needs a non-default
  function timeout (none does today; Vercel default is 300s).

## Out of scope (explicitly deferred)

- **#1 / task 4** — done (PR #157).
- **Minor bundle** from the review (SENTRY_DSN warning duplicated between
  `instrumentation.ts` and `startup-assert.ts`; edge-runtime has no SENTRY
  warning; `resolveContactNotifyTo` returns `source` two callers discard;
  `missingEnvVars()` helper bypassed by single-var asserts). Low-severity;
  track separately if desired. The `source`-discard item is naturally resolved
  by #6 (the new `notifyContactSubmission` is the single consumer).

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` — run via **CI after push**
  (nested-worktree local runs are unreliable per CLAUDE.md).
- No DB/schema change → `ci:rls-audit` / `ci:tenant-scope` not required.
- Land via PR to `main` (protected).
