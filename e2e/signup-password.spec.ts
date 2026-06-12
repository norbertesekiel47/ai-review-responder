import { test, expect } from '@playwright/test';

test.describe('owner password signup flow', () => {
  test('signup → check-email → (harness) confirm + pay → dashboard active', async ({ page }) => {
    // Gate mirrors the other auth-flow specs: the body below stops at the
    // harness step regardless, and the signup POST needs a real Supabase.
    test.skip(true, 'Harness (Supabase signup + email capture + Stripe payment link) not yet wired up — see e2e/README.md');

    // REQUIRES:
    //   SELF_SERVE_SIGNUP_ENABLED=true
    //   STRIPE_PAYMENT_LINK_STANDARD=<test-mode Payment Link with success_url set>
    //   NEXT_PUBLIC_APP_URL=http://localhost:3000
    //   Supabase project configured with email auth

    const testEmail = `test+${Date.now()}@example.com`;
    const testPassword = 'password1234';

    // 1. Fill the signup form
    await page.goto('/signup');
    await expect(page.getByText(/sign up for repworth/i)).toBeVisible();

    await page.getByPlaceholder('Email').fill(testEmail);
    await page.getByPlaceholder('Your name').fill('E2E User');
    await page.getByPlaceholder(/password/i).fill(testPassword);
    await page.getByPlaceholder('Business name').fill('E2E Test Biz');
    await page.getByPlaceholder('Google Maps URL for your business').fill(
      'https://www.google.com/maps/place/Test/@0,0,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d0!4d0',
    );
    await page.getByRole('button', { name: /continue/i }).click();

    // 2. Landed on check-email page
    await expect(page).toHaveURL(/\/signup\/check-email/);
    await expect(page.getByText(/check your email/i)).toBeVisible();

    // ────────────────────────────────────────────────────────────────
    // 3. HARNESS STEP: retrieve the Supabase confirmation link.
    // Options (document which your CI uses in e2e/README.md):
    //   A) Read the link from Supabase's API: supabase.auth.admin.generateLink({
    //        type: 'signup', email: testEmail, password: testPassword })
    //   B) If using a Supabase local dev container with inbox, poll the dev inbox.
    //   C) For a fully offline CI, stub the /api/auth/callback endpoint.
    //
    // This test currently STOPS HERE. Uncomment + implement the block below
    // once the harness is wired up per the README.
    // ────────────────────────────────────────────────────────────────

    // const confirmUrl = await harness.getConfirmationUrl(testEmail);
    // await page.goto(confirmUrl);
    // await expect(page).toHaveURL(/\/onboarding\/pay/);

    // 4. HARNESS STEP: click Stripe payment button + simulate test payment.
    //    Stripe test card: 4242 4242 4242 4242, exp 12/34, CVC 123.
    //    Stripe redirects to success_url (/onboarding/payment-success?session_id=...).

    // await page.getByRole('link', { name: /complete payment/i }).click();
    // await page.waitForURL(/stripe\.com/);
    // // fill Stripe iframe ... (harness-specific)
    // await page.waitForURL(/\/onboarding\/payment-success/);

    // 5. HARNESS STEP: wait for webhook to fire + polling to detect active.
    //    Max 5min timeout in the client.
    // await expect(page.getByRole('button', { name: /go to dashboard/i })).toBeVisible({ timeout: 30_000 });
    // await page.getByRole('button', { name: /go to dashboard/i }).click();
    // await expect(page).toHaveURL(/\/dashboard/);
  });
});
