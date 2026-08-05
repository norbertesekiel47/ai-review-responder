# Runbook — MFA factor reset (break-glass)

**Run every command below from the repo root.** `.env.local`,
`.env.staging.local`, and `./src/lib/db/server` are all resolved relative to
the current working directory — running from anywhere else fails or, worse,
silently resolves a different file.

**When to use:** A user can receive email at their registered address but has
lost the authenticator device holding their TOTP factor. They cannot sign in and
cannot complete password recovery, because the recovery flow requires a code
from that device.

**When NOT to use — but check current status first.** If the user still has
their authenticator and only forgot their password, the *intent* is that they
self-serve via `/forgot-password` (owners) or `/admin/forgot-password`
(admins), entering their code inline. **As of this writing that path is not
yet functional for MFA-enrolled users.** `POST /api/auth/reset-password`
(`src/app/api/auth/reset-password/route.ts`) requires AAL2
(`requireAal2FromSupabase`) and returns `403 mfa_required` with no inline
code field — the step-up UI meant to collect that code
(`useRecoveryStepUp.ts`, `RecoveryStepUpField.tsx`) had not shipped when this
runbook was written; it's tracked in the same plan,
`docs/superpowers/plans/2026-08-04-mfa-password-recovery-step-up.md`.
**Verify the UI is actually live** (try the flow yourself, or ask
engineering) before telling a requester to "just reset your password." If it
is not live yet, a factor-holding user who forgot their password is *also* a
support-assisted case today — but that is a UI gap, not a lost-factor
problem, and it does **not** justify running this runbook's destructive step.
Do not remove someone's factor because the password-reset UI hasn't shipped.

## Why there is no self-service path for a lost factor

Removing a factor requires a currently stepped-up AAL2 session
(`src/app/api/auth/mfa/challenge/route.ts`, the `unenroll` branch). A user who
has lost the factor cannot reach AAL2, so they cannot remove it. That is
deliberate: a self-service AAL1 removal would make the factor worthless as a
second factor, since anyone holding the password alone could strip it.

## Identity verification — complete BEFORE touching anything

Removing someone's second factor is an account-takeover-shaped action, and
the threat model is **inbox compromise** — the same thing MFA exists to
survive. A check that only proves current control of the inbox (replying, or
reading a code sent to it) proves nothing beyond what the attacker already
has. Do not start until all of these hold:

- [ ] **Out-of-band challenge-response, on a channel other than email.**
      Check whether the account has a phone on file (`businesses.owner_phone`,
      `supabase/migrations/001_initial_schema.sql`) or a verified
      Telegram/WhatsApp enrollment:
      ```sql
      select channel, handle, status, location_id
      from channel_enrollments
      where account_id = '<account_id from step 1>'
        and channel in ('telegram', 'whatsapp', 'sms')
        and status = 'verified';
      ```
      If one exists, call the phone or message the enrolled channel and get
      spoken/typed confirmation of the request. **If no non-email channel is
      on file, stop and escalate** (see the third box below) — do not
      substitute an email-only check for this one; email is the compromised
      channel by hypothesis.
- [ ] **Supporting evidence only — not sufficient on its own,** since a
      Stripe receipt sits in the same inbox an attacker may control: the
      requester states the last invoice amount/date, the card's last 4
      digits, or the billing email on file. Useful for corroboration, not a
      substitute for the box above.
- [ ] For an admin account: a second RepWorth admin has confirmed the
      request out of band (not by replying to the same email thread). **If
      the requester is the only admin on the account, or no non-email
      channel is on file for the box above:** there is currently no
      documented on-call roster or rotation in this repo — checked
      `docs/runbooks/oncall-3am.md` (severity triage only: "Wake up (P0)",
      "Wait until morning (P1/P2)", "First five minutes", "Guardrails" — no
      contact info) and searched `docs/runbooks/`/`docs/` broadly; none
      exists. Escalate through whatever channel the team actually uses
      today — as of this writing, the closest thing to a named point of
      contact in this repo is `**Owner:** @norbertesekiel` on
      `docs/runbooks/pool-wedge-burst-drill.md`. Do not proceed on the
      strength of a solo admin's own say-so.
- [ ] No account-status change (offboarding, cancellation, ownership
      transfer) is in flight for this account.

If any box is unchecked, stop and escalate. A delayed reset is recoverable; a
reset granted to an attacker is not.

## Procedure

1. Look up the account before touching anything, and require the row to
   match what the ticket claims:

   ```sql
   select auth_id, email, role, account_id
   from users
   where lower(email) = lower('<requester email>');
   ```

   Record the account id, `auth_id`, and the requester's identity-verification
   evidence in the support ticket, citing this runbook
   (`docs/runbooks/mfa-factor-reset.md`) as the authorization procedure.

2. Remove the factor via the Supabase Admin Auth API, using the service-role
   client already wired in this repo — `supabaseServer` in
   `src/lib/db/server.ts` (built from `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`,
   never exposed to browser code per invariant #8 — though the key is present
   in the server-side Vercel/Railway env like any other server secret).
   There is no admin-console button for this today. `@supabase/auth-js`'s
   `GoTrueAdminApi` exposes `auth.admin.mfa.listFactors({ userId })` and
   `auth.admin.mfa.deleteFactor({ userId, id })` — confirmed against the
   installed source, which this repo resolves only through pnpm's nested
   store (there is no top-level `node_modules/@supabase/auth-js`):
   `node_modules/.pnpm/@supabase+auth-js@2.106.2/node_modules/@supabase/auth-js/src/GoTrueAdminApi.ts`
   (`_listFactors`/`_deleteFactor`). Per that package's doc comment at
   `.../auth-js/src/lib/types.ts:1778`, `deleteFactor` terminates the user's
   existing sessions when the deleted factor was verified — expect them to
   need to sign in again. **The entire `GoTrueAdminMFAApi` surface is marked
   `@expermental` [sic] upstream.** If a dependency bump has moved past
   `2.106.2`, re-verify `listFactors`/`deleteFactor` still exist with this
   shape before trusting this runbook — don't assume.

   **Environment matters — get this wrong and you mutate the wrong
   project.** `pnpm exec tsx -e` does **not** load any `.env*` file itself —
   only Next.js does that at build/dev time — so `supabaseServer` needs
   `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` populated by hand. Both 2a and 2b
   print `TARGET: <host>` as their first action so the command's own output
   shows which project it actually reached. That echo is a log line, not a
   gate — 2b additionally *enforces* a host match before it will call
   `deleteFactor` (see 2b below).

   Three ways to populate the two vars — **use the matching one for the
   environment you're actually operating on**, for BOTH 2a and 2b:

   - **Local** — `.env.local` defines bare `SUPABASE_URL` /
     `SUPABASE_SERVICE_KEY`, so load it with `dotenv` (already a repo
     dependency) inside the script, the same way `package.json`'s
     `test:integration` script loads `.env.local` with `node -e`. **This
     form was executed while authoring this runbook**, via `pnpm exec
     tsx -e` (not `node -e` — `test:integration` is the pattern precedent,
     not the exact command run):
     ```bash
     pnpm exec tsx -e "
       require('dotenv').config({ path: '.env.local' });
       ...
     "
     ```
     A stray `dotenv` line does no harm even if `SUPABASE_URL` is already
     set in the shell: `dotenv.config()` does not throw on a missing
     file/key, and by default it does not override a variable already
     present in `process.env` — confirmed empirically by pre-setting
     `SUPABASE_URL` in the shell and observing `dotenv.config({ path:
     '.env.local' })` leave it untouched. The `TARGET`/host-match check is
     the real safety net, not this.
   - **Staging** — `.env.staging.local` does NOT define bare
     `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`; it defines `STAGING_SUPABASE_URL`
     / `STAGING_SUPABASE_SERVICE_KEY`. **Do not `source` this file** — it
     contains at least one unquoted value with `<`/`>`
     (`STAGING_RESEND_FROM_EMAIL=RepWorth <name@repworth.net>`, confirmed at
     `.env.staging.local:13`), which a shell parses as redirections;
     `source` throws a parse error and aborts, and because it exits
     nonzero, chaining it with `&&` before `set +a` means `set +a` never
     runs — `allexport` is left stuck on in your interactive shell.
     Extract only the two lines you need instead:
     ```bash
     STAGING_URL=$(grep -m1 '^STAGING_SUPABASE_URL=' .env.staging.local | cut -d= -f2-)
     # As observed 2026-08-04, this repo's local .env.staging.local has
     # STAGING_SUPABASE_URL empty (a placeholder never filled in — see the
     # comment above that line in the file). Fall back to the NEXT_PUBLIC
     # copy, which the file's own comment and .env.example both document as
     # carrying the same value; the fallback was confirmed end-to-end
     # against the real project (see the confirmed output below 2a).
     [ -z "$STAGING_URL" ] && STAGING_URL=$(grep -m1 '^STAGING_NEXT_PUBLIC_SUPABASE_URL=' .env.staging.local | cut -d= -f2-)
     STAGING_KEY=$(grep -m1 '^STAGING_SUPABASE_SERVICE_KEY=' .env.staging.local | cut -d= -f2-)
     SUPABASE_URL="$STAGING_URL" SUPABASE_SERVICE_KEY="$STAGING_KEY" pnpm exec tsx -e "..."
     ```
     **This form was executed while authoring this runbook**, in zsh,
     against this repo's real `.env.staging.local` and real staging
     project — see the confirmed output below 2a.
   - **Prod** — export `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` directly in
     your prod-scoped shell (however you reach production secrets — e.g. a
     `railway run` shell), then run the script with no `dotenv` line at all.
     **Reasoned, not executed** — no prod shell access while authoring this
     runbook.

   **Step 2a — read-only, safe to run on its own.**

   ```bash
   pnpm exec tsx -e "
     require('dotenv').config({ path: '.env.local' });
     import('./src/lib/db/server').then(async ({ supabaseServer }) => {
       console.log('TARGET:', new URL(process.env.SUPABASE_URL).host);
       const userId = '<auth_id from step 1>';
       const { data, error } = await supabaseServer.auth.admin.mfa.listFactors({ userId });
       console.log(JSON.stringify({ data, error }, null, 2));
       process.exit(0);
     }).catch((e) => { console.error(e); process.exit(1); });
   "
   ```
   (Swap the `dotenv`/local prefix line for whichever of the three env forms
   above matches your target.)

   Confirmed output, observed 2026-08-04 running the exact **local** command
   above against a real Supabase Auth Admin API project (a `userId` that
   does not exist there, so this is the error path):
   ```
   TARGET: udey***.supabase.co
   {
     "data": null,
     "error": {
       "name": "AuthApiError",
       "message": "User not found",
       "status": 404,
       "code": "user_not_found"
     }
   }
   ```

   Confirmed output, observed 2026-08-04 running the **staging** form (env
   vars via `grep`/`cut` with the `STAGING_NEXT_PUBLIC_SUPABASE_URL`
   fallback above, no `source`) against this repo's real staging project,
   for a real user with one enrolled `totp` factor (id, `friendly_name`,
   and timestamps redacted below — they're real staging data, not
   placeholders):
   ```
   TARGET: kubd***.supabase.co
   {
     "data": {
       "factors": [
         {
           "id": "<redacted>",
           "friendly_name": "<redacted>",
           "factor_type": "totp",
           "status": "verified",
           "phone": null,
           "last_challenged_at": "<redacted>",
           "created_at": "<redacted>",
           "updated_at": "<redacted>"
         }
       ]
     },
     "error": null
   }
   ```
   This is the real success shape — field set genuinely observed on live
   data, adapted here only by redacting the real values: `id`,
   `friendly_name`, `factor_type`, `status`, `phone`, `last_challenged_at`,
   `created_at`, `updated_at`.

   **Read `data.factors` and branch before doing anything else:**
   - **Two or more `status: "verified"` factors** → the user can very
     likely still authenticate with the other one. Break-glass is not
     warranted — stop, and help them sign in with the remaining factor
     instead of deleting anything.
   - **A mix of verified and unverified factors** → only a *verified*
     factor gates sign-in; an unverified one does nothing and deleting it
     will not fix the lockout. Identify which factor is verified and act
     only on that one.
   - **Exactly one verified factor** (the expected break-glass case) →
     confirm its `id` and `friendly_name` match what the requester
     described, and note the `TARGET` host you just saw — you need both for
     2b.

   ---

   **Step 2b — DESTRUCTIVE. Only after 2a's real output confirms the single
   verified factor to remove.** Do not run this in the same paste as 2a; do
   not fill in an `id` you have not actually read from 2a's output.
   `EXPECT_HOST` below is an enforced gate, not a log line — it compares
   against the host you actually read in 2a and exits before calling
   `deleteFactor` on a mismatch, so it can't fire only after the delete the
   way a plain echo would:

   ```bash
   pnpm exec tsx -e "
     require('dotenv').config({ path: '.env.local' });
     import('./src/lib/db/server').then(async ({ supabaseServer }) => {
       const EXPECT_HOST = '<host you read in step 2a>';
       const host = new URL(process.env.SUPABASE_URL).host;
       if (host !== EXPECT_HOST) { console.error('TARGET MISMATCH', host, EXPECT_HOST); process.exit(1); }
       const userId = '<same auth_id as step 2a>';
       const id = '<factor id copied from step 2a output — not a guess>';
       const { data, error } = await supabaseServer.auth.admin.mfa.deleteFactor({ userId, id });
       console.log(JSON.stringify({ data, error }, null, 2));
       process.exit(0);
     }).catch((e) => { console.error(e); process.exit(1); });
   "
   ```
   (Same three env forms as 2a — swap the `dotenv`/prefix line to match your
   target, and keep `EXPECT_HOST` matching whichever project you're on.)

   This destructive command was **not** executed while authoring this
   runbook — no disposable MFA-enrolled test user was available on either
   local or staging. Its form follows directly from the now-verified
   `listFactors` mechanism (same env loading, same client, same
   `auth.admin.mfa.*` namespace, params matching
   `AuthMFAAdminDeleteFactorParams`), but treat it as reasoned-not-executed
   and dry-run it on staging with a disposable account before the first real
   incident.

3. Confirm the removal immediately — do not defer this to the user's next
   sign-in. Re-run the **step 2a** script verbatim (same env form, same
   `userId`) and check the output: the deleted `id` must no longer appear in
   `data.factors` (an empty array, or a list no longer containing that id).

4. Tell the user to sign in and re-enroll a factor as soon as possible, at
   `/settings/security` (owners) or `/admin/security` (admins). **Nothing in
   the codebase forces this, and the account can sit at AAL1 with no second
   factor indefinitely if nobody follows up:**
   - `getAalGate()` (`src/proxy.ts`) returns `'ok'` immediately whenever
     `mfaEnforcementEnabled()` is false, and `MFA_ENFORCEMENT_ENABLED=false`
     is the documented default (`.env.example`).
   - Even with the flag on, the gate only checks
     `nextLevel === 'aal2' && currentLevel !== 'aal2'` — a step-up check,
     not an enrollment check. Once the only factor is gone, GoTrue reports
     `nextLevel: 'aal1'`, so the gate is satisfied at AAL1 forever. There is
     no "must have a factor enrolled" check anywhere in the repo.

5. Open a tracked follow-up (ticket or reminder) to confirm re-enrollment,
   with an explicit deadline — 7 days from the reset. If the user has not
   re-enrolled by then, follow up again; the reset does not self-close the
   exposure. Also notify the account's other owners/admins that a factor
   reset occurred, so a compromise is caught by someone who isn't the
   (possibly attacker-controlled) requester. Append the final outcome to the
   support ticket: who authorized the reset, on what evidence, the
   follow-up ticket id and deadline, and when the user actually re-enrolled
   (or that they had not, as of the deadline).

## Audit

The `unenroll` route writes an `mfa_factor_unenrolled` audit event when a user
removes their own factor. An operator-side removal performed outside the app
does NOT produce that event — which is exactly why steps 1 and 5's ticket
trail are mandatory. The support ticket is the only record.
