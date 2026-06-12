# E2E Test Harness

## Running signup E2E tests

Signup flow E2E tests (signup-password, signup-google, forgot-password,
reset-password) require two external systems:

### Supabase confirmation link

Supabase sends a confirmation email on signup. To automate the click:

1. Set `SUPABASE_SERVICE_KEY` in the E2E env.
2. Use `supabase.auth.admin.generateLink({ type: 'signup', email, password })`
   server-side to obtain the confirmation URL without actually sending an email.
3. Navigate to the URL in Playwright.

Alternative: run Supabase locally via `supabase start` and poll the local
inbox (http://localhost:54324 by default).

### Stripe test-mode payment

1. Use a Stripe Payment Link in test mode with `success_url` set to
   `<APP_URL>/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`.
2. Stripe test card: 4242 4242 4242 4242, exp 12/34, CVC 123, ZIP any.
3. Stripe redirects to success_url after payment.

To automate filling the Stripe checkout form, use Playwright's iframe helpers.
Beware that Stripe's internal DOM is opaque — prefer using their test-mode
redirect parameters where possible.

### Webhook delivery

In CI, the worker ingress must be reachable from Stripe (ngrok / smee.io).
Alternative: mock the webhook by posting a fixture to `/ingress/stripe`
directly from the E2E harness, bypassing Stripe.

### Cleanup between runs

After each test, delete:
- Supabase Auth user: `supabase.auth.admin.deleteUser(authId)`.
- DB rows: `DELETE FROM businesses WHERE id = ?` (cascades to users + channel_enrollments).

Consider using unique per-run emails (`test+${Date.now()}@example.com`) to
avoid conflicts when cleanup is incomplete.

## Current state (2026-06-11)

**`e2e/harness.ts` is implemented** — a staging-backed Supabase `auth.admin`
wrapper (createOwnerUser/createAdminUser/createBareAuthUser, getResetUrl,
signInViaMagicLink, deletion helpers). Links are NOT navigated through
Supabase's hosted `/verify` (its redirect honors only the project allow-list);
the harness builds the app's own `/api/auth/callback?token_hash=…` URL, which
verifies server-side via `verifyOtp`.

Two tiers (recipes: `docs/runbooks/e2e-local-setup.md#auth-harness`):

- **Base** (`E2E_SUPABASE_URL` + `E2E_SUPABASE_SERVICE_KEY`): the 4
  cross-portal/anti-enumeration specs — staging Auth + local test DB.
- **Deep** (`E2E_AUTH_DEEP=true`, TEST_DATABASE_POOL_URL = staging Postgres):
  recovery callback, reset happy-path, link replay, signup-google. Required
  because the app reads `users` through BOTH Postgres.js and
  supabase-js/PostgREST — the two must see the same database.

CI never gets the harness env, so all 8 self-skip there.

`signup-password.spec.ts` (full Stripe payment loop) remains hard-gated —
it additionally needs the Stripe test-mode payment automation described above.

---

## Additional specs (signup-google, forgot-password, reset-password)

### signup-google.spec.ts

Tests the post-OAuth `/signup/finish` → business form → `/onboarding/pay` flow.

**Why session-cookie injection instead of real OAuth:** Playwright cannot interact
with Google's OAuth consent screen. The workaround is to create a Supabase Auth
user via the admin API with `email_confirm: true`, then generate a magic-link to
obtain a valid session, and finally inject the resulting session cookie via
`context.addCookies(...)` before navigating to `/signup/finish`.

Required harness steps:
1. `supabase.auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name } })`
2. `supabase.auth.admin.generateLink({ type: 'magiclink', email })` — navigate
   to `action_link` in a headless page to materialise session cookies.
3. `context.addCookies([{ name: 'sb-<ref>-auth-token', value: '<base64>', ... }])`
4. Navigate to `/signup/finish` and assert the email field is disabled.
5. Cleanup: `supabase.auth.admin.deleteUser(uid)` + `DELETE FROM businesses WHERE owner_email = email`.

### forgot-password.spec.ts — cross-portal protection

Four test cases covering the cross-portal invariant:

| Submitted email | Portal URL | Expected outcome |
|---|---|---|
| owner | `/forgot-password` | Generic success, email sent |
| owner | `/admin/forgot-password` | Generic success, **no email** |
| admin | `/forgot-password` | Generic success, **no email** |
| owner | `/forgot-password` + recovery link callback | Lands on `/reset-password` |

**Email capture requirement:** To assert "no email sent" for cross-portal cases,
the harness must count emails dispatched to a given address. Options:
- Run Supabase locally (`supabase start`) and poll the Inbucket dev inbox at
  `http://localhost:54324`.
- Stub the Supabase SMTP settings to a local mailhog/mailpit instance.
- Use `supabase.auth.admin.generateLink({ type: 'recovery', email })` as a
  proxy: if the call returns a link, Supabase would have sent an email; if it
  rejects (wrong portal), treat that as zero emails.

**Recovery link for happy-path callback test:**
```ts
const { data } = await supabase.auth.admin.generateLink({
  type: 'recovery',
  email: ownerEmail,
});
// data.properties.action_link — navigate here instead of waiting for email
```

### reset-password.spec.ts

Three test cases:

1. **Happy path** — recovery link → `/reset-password` → set password → `/login`
   → sign in → `/dashboard`.
2. **Mismatched-portal redirect** — a recovery link for the owner portal must
   not be accepted at `/admin/reset-password`; the callback handler redirects
   to the correct portal.
3. **Expired link** — a stale or replayed link must show an error state with a
   "request a new link" CTA rather than silently failing.

Required harness utility:
```ts
async function getResetUrl(email: string): Promise<string> {
  const { data } = await supabase.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo: `${APP_URL}/api/auth/callback?flow=owner&next=/reset-password` },
  });
  return data.properties.action_link;
}
```
