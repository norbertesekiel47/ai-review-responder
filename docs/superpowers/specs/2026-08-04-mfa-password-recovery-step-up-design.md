# MFA step-up in password recovery — design

**Date:** 2026-08-04
**Status:** Approved, not yet implemented
**Severity:** High — self-service password recovery is fully broken for every MFA-enrolled account
**Branch:** own branch off `main` (deliberately not `feat-645-manual-suppression-paths`)

## Problem

`src/app/api/auth/reset-password/route.ts` calls `supabase.auth.updateUser({ password })`
on a session minted by the recovery OTP. That session is AAL1. When the account has a
verified MFA factor, GoTrue requires AAL2 for a password change and returns
`401 insufficient_aal` — unconditionally, on every attempt, for every enrolled user.
The route performs no AAL check anywhere: it validates same-origin, session, role, flag
gate, rate limit, and body, then writes.

Every RepWorth admin is affected. AAL2 is required to use the console at all
(`src/proxy.ts:118-136`), so every admin has an enrolled factor by construction. An admin
who forgets their password has no self-service path back in.

Owners are affected identically. They can enroll TOTP at `/settings/security` and share
the same route.

### Evidence

Staging auth log, `norbertesekiel@gmail.com` (`728769a7-4c92-4413-9641-40361d1c38ca`):

| Time (UTC) | Event | Result |
|---|---|---|
| 08:44:48 | `POST /token` (password) | 400 `invalid_credentials` |
| 08:44:55 | `POST /token` (password) | 400 `invalid_credentials` |
| 08:45:03 | `POST /recover` | 200 — email sent |
| 08:45:09 | `POST /verify` | 200 — session created, `login_method: otp` |
| 08:45:17 | `PUT /user` | 401 `insufficient_aal` |
| 08:45:25 | `PUT /user` | 401 `insufficient_aal` |

Everything up to the final write succeeds. Only the password write is refused.

### Why it read as a validation error

`route.ts:186-188` maps every `updateError` to `status: 400`. GoTrue's 401 arrived at the
browser wearing a 400. The message itself ("AAL2 session is required…") was accurate and
did reach the client; the flattened status is what made it read as a bad-password problem.

### Why nothing caught it

`src/app/api/auth/__tests__/reset-password.test.ts` (282 lines) has no case where the
session carries an enrolled-but-unchallenged factor. Every fixture exercises the
no-factor path, which works.

## Scope

In scope:

- Server-side AAL2 gate in the reset-password route, for both roles.
- Inline TOTP collection on both reset cards (owner and admin).
- Pass-through of the real provider status instead of a flat 400.
- The missing regression test plus the cases around it.
- A break-glass runbook for the lost-authenticator case.

Out of scope:

- An admin-side tool for one admin to reset another's factor. That is a new
  account-takeover-shaped surface needing its own threat model, it does not solve the
  single-admin case, and it is a feature rather than a fix.
- Any change to MFA enrollment, to `/mfa/challenge`, or to the proxy AAL gate.

`updateUser` has exactly one call site in the repo, so the blast radius is bounded.

## Approach

Challenge the enrolled factor before the password write. The machinery exists and needs
wiring, not building: `/api/auth/mfa/challenge` already owns challenge, verify, unenroll,
per-action rate limits, and audit logging, and it is reachable on an AAL1 session because
`/api/auth/*` is not proxy-protected.

The TOTP code is collected **inline on the reset page**, beside the new-password fields.
One page, one submit by the user, one POST to the reset route. The alternative — bouncing through `/mfa/challenge` and
returning — costs a round trip, returns the user to an empty form, and burns one of the
reset route's 5 attempts/hour on the discovery submit.

### Load-bearing assumption

The design rests on `mfa.verify` upgrading a recovery-minted session (`login_method: otp`)
to `aal2`. GoTrue authenticates factor verification against any valid session and does not
inspect the originating `amr`, so this should hold — but it is unproven, and it is proven
first, on staging, before any UI work (see "Verification").

If it does not hold, the design collapses and the fallback is break-glass-only: the reset
page states up front that MFA-enrolled accounts recover through support, and the runbook
becomes the entire fix.

## Server design

### Gate placement

The new AAL gate goes **after the rate limit, before the body parse** — not immediately
before `updateUser` where the bug lives. Two reasons:

1. The rate limit stays the outermost cheap gate, so a scripted prober burns its own
   5/hour budget rather than ours.
2. The request is refused before the plaintext password is destructured out of the body.

It runs against the existing read-only client from step 2 (`readOnlySupabase`), which is
sufficient because the check only reads. Steps renumber: AAL becomes step 6, body parse 7,
response construction 8, update 9, signOut 10.

### The check

Use `requireAal2FromSupabase` (`src/lib/auth/mfa.ts:16`), which blocks when
`nextLevel === 'aal2' && currentLevel !== 'aal2'`. That predicate *is* the condition GoTrue
uses to emit `insufficient_aal`, so the pre-check and the provider cannot disagree.
Accounts with no factor report `nextLevel: 'aal1'` and fall through unchanged — "no factor
keeps today's path" comes free, with no branch to write.

Not `requireCurrentAal2FromSupabase` + `listFactors()`: two API calls, and it re-derives a
rule GoTrue already owns, so it can drift in either direction. That helper is correct for
the `unenroll` route — removing a factor genuinely needs a *currently* stepped-up session,
stricter than GoTrue's default — but the stricter reading buys nothing here.

### Refusal shape

`403 { error: 'mfa_required' }`.

Deliberately not 401. `ResetPasswordFormClient.tsx:211` already reads 401 as "recovery
session lapsed" and flips to the expired-link dead-end, so a 401 step-up would send the
user to `/forgot-password` for a fresh link that fails identically. 403 `mfa_required` is
also the vocabulary the proxy AAL refusals (`proxy.ts:149`) and the `unenroll` branch
(`mfa/challenge/route.ts:222`) already speak.

`mfa_check_failed` fails closed, also 403. This route already chose strict/fail-closed for
its rate limit (`{ strict: true }` → 503), which is the local precedent. The fail-open rule
in CLAUDE.md governs cost and abuse limiting, not a password write.

### Error status pass-through

Replace the flat `status: 400` at `route.ts:186-188` with:

- `insufficient_aal` → `403 { error: 'mfa_required' }`, so a pre-check that ever drifts from
  GoTrue lands in the client branch that already knows what to do. This is a backstop, not
  an alternative to the pre-check.
- Everything else → `updateError.status ?? 400`.

The pass-through is a second, quieter fix: a genuinely expired session now returns its real
401 and reaches the expired-link state instead of being flattened into a validation error —
the same masking that hid this bug.

The response body keeps surfacing `updateError.message`; the client already refuses to
render provider messages verbatim (`mapResetPasswordError` falls back to curated copy for
unrecognized codes). That behavior is unchanged.

## Client design

### New module: `useRecoveryStepUp`

`src/components/auth/useRecoveryStepUp.ts`. A five-state machine:

```
probing → no-session | no-factor | code-required → verified
```

It owns the mount probe (`getUser()` plus `mfa.listFactors()`), the code field's state, and
a `verify(code)` that runs challenge→verify against `/api/auth/mfa/challenge`. Error
handling mirrors `MfaChallengeForm`: a 429 yields the "too many attempts" copy, and any
verify failure clears the stored `challengeId` so the retry requests a fresh one.

A failed `listFactors()` resolves to `code-required`, not `no-factor`. Guessing
`no-factor` would walk the user into a submit the server refuses anyway; asking for a code
the account may not need is the cheaper wrong answer, and the server remains authoritative
either way.

Both cards consume it. It is unit-testable without rendering either.

### New component: `RecoveryStepUpField`

Presentational only — label plus the 6-digit input, carrying `MfaChallengeForm`'s input
attributes (`inputMode="numeric"`, `autoComplete="one-time-code"`, numeric pattern).

It takes `inputClassName` / `labelClassName` rather than a `variant` enum, so each card's
styling stays where it already lives instead of migrating two design languages into a
shared component that then has to know about both.

### One extraction, no new file

`MfaChallengeForm.tsx:24-51` already holds `normalizeFactor` / `normalizeFactors`, and the
hook needs exactly that logic. Rather than a second copy it moves into the existing
`src/lib/auth/mfa.ts` (44 lines today) and `MfaChallengeForm` imports it. Two callers, no
new top-level surface.

### Submit sequencing

1. Validate password client-side (existing behavior, unchanged).
2. If state is `code-required`, `await verify(code)`. On failure, stop and show the error.
3. `POST /api/auth/reset-password`.

A mistyped code stops at step 2 and never reaches the reset route. This is what keeps the
budgets separated: bad codes burn the challenge route's 8 verifies/hour, never the reset
route's 5 attempts/hour.

Once the state reaches `verified` it stays there. If the password write then fails on
something like "must differ from your old password," the retry does not demand a fresh
code. This is the client half of a decision the route already made deliberately — it does
not `signOut` on `updateError`, precisely so the user can retry.

### Card convergence

`ResetPasswordFormClient.tsx` currently gates its browser Supabase client on
`portal === 'owner'`, so the admin card has no mount probe: an admin with a stale link types
a password and eats a raw error, where an owner gets a clean dead-end. Inline MFA needs a
browser client on the admin card regardless, so the client stops being role-gated and both
cards gain `sessionReady` and the expired-link dead-end. The admin dead-end renders in the
admin card's own gray styling.

`RESET_PASSWORD_ERROR_COPY` gains curated entries for `mfa_required` and `mfa_check_failed`.

### Lost-factor dead-end

Beneath the code field, a support link in the same register as `MfaChallengeForm`:
"Lost your authenticator? Contact support" → `support@repworth.net`.

No self-service unenroll. The `unenroll` action requires a currently stepped-up AAL2
session by design, which an AAL1 recovery session structurally cannot reach. That is the
correct answer rather than a gap.

## Runbook

`docs/runbooks/mfa-factor-reset.md` — the break-glass procedure for an operator resetting a
locked-out user's factor:

- Identity-verification checklist to complete before touching anything.
- The operator-side factor removal. Whether that is the Supabase dashboard or the admin
  API is confirmed against the live project while writing the runbook — not asserted here.
- A required audit note recording who authorized the reset and on what evidence.
- Re-enrollment required on the user's first login after the reset.

The comment at `mfa/challenge/route.ts:215` currently refers to "the documented support
path." No such document exists anywhere in `docs/runbooks/`. That comment is amended to
name this file. `docs/directory.md` picks up the runbook and the two new client modules.

## Verification

### Staging proof — runs before any code

Prove the load-bearing assumption on staging against the reported account, capturing the
inverted form of the evidence table:

```
/recover                 200  email sent
/verify                  200  session created, login_method: otp
/factors/{id}/challenge  200
/factors/{id}/verify     200  aal2
PUT /user                200  ← the line that has never once succeeded
```

Evidence: `docs/runbooks/evidence/2026-08-04-mfa-recovery-step-up.md`.

If `PUT /user` does not return 200, stop and fall back to the break-glass-only design
described under "Approach".

### Route tests

In `src/app/api/auth/__tests__/reset-password.test.ts`:

| Case | Expected |
|---|---|
| Enrolled but unchallenged (`nextLevel: 'aal2'`, `currentLevel: 'aal1'`) | `updateUser` **not called**; 403 `mfa_required` |
| No factor (`nextLevel: 'aal1'`) | `updateUser` called; 200; unchanged |
| Already AAL2 | `updateUser` called; 200 |
| AAL probe errors | `updateUser` **not called**; 403 `mfa_check_failed` |
| `updateUser` returns `insufficient_aal` | 403 `mfa_required`, not 400 |
| `updateUser` returns 422 | 422 passes through, not flattened to 400 |
| Rate-limited caller | 429 before the AAL probe runs, pinning gate order |

The first case must assert the **absence** of the `updateUser` call, not merely the status.
A status-only assertion would pass against a route that still reaches GoTrue and relabels
the failure — which is the exact shape of this bug.

### Hook tests

Probe outcomes (`no-session` / `no-factor` / `code-required`); a verify failure clears
`challengeId`; `verified` persists across a failed password write; 429 yields the
rate-limited copy.

### Existing suite

Every mock in the current 282-line route suite needs a `getAuthenticatorAssuranceLevel`
method or it will throw once the route calls it. Default the fixture to
`{ currentLevel: 'aal1', nextLevel: 'aal1' }` so existing no-factor assertions keep their
meaning. This is mechanical but it is the largest single chunk of the diff.

### Gates

`pnpm lint && pnpm typecheck && pnpm test`. No schema changes, so the DB-specific audits
(`ci:tenant-scope`, `ci:rls-audit`) have nothing new to inspect, though they run in the
`lint` job regardless.

## Rollout

No migration, no env var, no feature flag, no worker or webhook surface. The promotion
rules in CLAUDE.md do not require a staging ride for a change of this shape. It gets one
anyway — because the assumption above needs proving, not because the lane demands it.

Own branch off `main`, PR into `main`.

## Files

Changed:

- `src/app/api/auth/reset-password/route.ts` — AAL gate; status pass-through
- `src/components/auth/ResetPasswordFormClient.tsx` — both cards consume the hook; admin
  card gains the probe; new error copy
- `src/lib/auth/mfa.ts` — gains `normalizeFactor` / `normalizeFactors`
- `src/app/mfa/challenge/MfaChallengeForm.tsx` — imports the shared normalizers
- `src/app/api/auth/mfa/challenge/route.ts` — comment names the runbook
- `src/app/api/auth/__tests__/reset-password.test.ts` — fixture update plus new cases
- `docs/directory.md` — new files

Added:

- `src/components/auth/useRecoveryStepUp.ts`
- `src/components/auth/RecoveryStepUpField.tsx`
- `src/components/auth/__tests__/useRecoveryStepUp.test.ts`
- `docs/runbooks/mfa-factor-reset.md`
- `docs/runbooks/evidence/2026-08-04-mfa-recovery-step-up.md`
