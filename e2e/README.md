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

## Current state

The signup-password.spec.ts test documents the happy path but harness-required
steps are commented out pending CI infrastructure. Implement the `harness` helper
module and uncomment those sections once the above is wired up.
