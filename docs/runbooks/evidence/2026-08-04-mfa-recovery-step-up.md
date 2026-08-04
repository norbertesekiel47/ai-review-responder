# Evidence — MFA step-up on a recovery session (staging)

**Date:** 2026-08-04
**Env:** staging
**Account:** norbertesekiel@gmail.com (`728769a7-4c92-4413-9641-40361d1c38ca`)

**Question:** Does `mfa.verify` upgrade a recovery-minted session — one whose
`login_method` is `otp`, not `password` — to `aal2`, such that the password write
that currently 401s succeeds?

## Result: PASS

The operator ran the full recovery loop against staging and confirmed:

1. Requested a password reset and opened the link from the recovery email.
2. Entered the TOTP code from their authenticator **on that recovery session**.
3. The password change succeeded.
4. Signed in to the admin console with the new password.

Step 2 is the load-bearing one. The session that accepted the password write
originated from the recovery OTP, not from a password login — confirmed
explicitly, because an AAL2 session reached by ordinary sign-in would prove
nothing about this path.

## Why this is a stronger proof than running the fix would have been

Staging is running the **pre-fix** route. The branch `fix-mfa-recovery-step-up`
was not deployed, so `/api/auth/reset-password` had no AAL gate at the time of
this run — it called `updateUser` directly, exactly as it does in production
today.

That isolates the behavior under test. The write succeeded because the session
had already been stepped up to `aal2` through `/mfa/challenge`, with none of our
new code in the path. So this measures GoTrue's behavior, not our gate's: GoTrue
does not inspect the originating `amr` when verifying a factor, and an
`otp`-origin session upgrades to `aal2` like any other.

Had we tested against the fixed route, a pass would have been ambiguous between
"GoTrue accepts this" and "our gate happened to let it through."

## What this licenses

The design in
`docs/superpowers/specs/2026-08-04-mfa-password-recovery-step-up-design.md` is
viable. The client-side step-up (a TOTP field collected inline on the reset
cards, verified through `/api/auth/mfa/challenge` before the password POST) rests
on this behavior and is now cleared to build — plan tasks T2, T5, T6, T7.

The break-glass fallback described under "Approach" in the spec — where
MFA-enrolled accounts recover only through support — is **not** needed. The
runbook at `docs/runbooks/mfa-factor-reset.md` remains necessary for the separate
lost-authenticator case, which no amount of step-up can solve.

## Provenance and limits of this record

This is an **operator attestation**, not an extracted log. The per-request rows
(`/recover`, `/verify`, `/factors/{id}/challenge`, `/factors/{id}/verify`,
`PUT /user`) with their timestamps and status codes were not captured from the
Supabase staging auth log at the time of the run.

The attested outcome is unambiguous and sufficient to unblock the work — the
password write on a recovery-origin session either succeeded or it did not, and
it did. But if this record is ever needed to settle a finer question — the exact
ordering, or whether any request was retried — pull the rows from Supabase
staging → Authentication → Logs, filtered to the account above and to
2026-08-04, and append them here. Do not reconstruct them from memory.
