import { test, expect } from '@playwright/test';

test.describe('owner Google signup flow', () => {
  test('Google OAuth redirect → /signup/finish → business form → /onboarding/pay', async ({
    page,
    context,
  }) => {
    // REQUIRES:
    //   SELF_SERVE_SIGNUP_ENABLED=true
    //   NEXT_PUBLIC_APP_URL=http://localhost:3000
    //   Supabase project configured with Google OAuth provider
    //
    // Because Playwright cannot interact with Google's real OAuth consent screen,
    // simulate the post-callback state by injecting a Supabase session cookie
    // directly via the admin API:
    //
    //   1. Create a Supabase Auth user with email_confirmed=true to match the
    //      OAuth identity state:
    //        const { data } = await supabase.auth.admin.createUser({
    //          email: 'e2e-google@example.com',
    //          email_confirm: true,
    //          user_metadata: { full_name: 'E2E Google User' },
    //        });
    //
    //   2. Generate a magic-link session and extract the access/refresh tokens:
    //        const { data: link } = await supabase.auth.admin.generateLink({
    //          type: 'magiclink',
    //          email: 'e2e-google@example.com',
    //        });
    //        // Navigate to link.properties.action_link to obtain session cookies.
    //
    //   3. Inject the session cookie so /signup/finish sees an authenticated user:
    //        await context.addCookies([
    //          { name: 'sb-<ref>-auth-token', value: '<base64-session>', ... },
    //        ]);
    //
    // Cleanup: supabase.auth.admin.deleteUser(data.user.id)
    //          + DELETE FROM businesses WHERE owner_email = 'e2e-google@example.com'

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 1: Inject harness session cookie (see above).
    // Uncomment once harness is wired up per e2e/README.md.
    // ──────────────────────────────────────────────────────────────────────────

    // await context.addCookies([/* harness-provided Supabase session cookies */]);

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 2: Navigate to the post-OAuth finish page.
    // ──────────────────────────────────────────────────────────────────────────

    // await page.goto('/signup/finish');
    // await expect(page.getByText(/almost there/i)).toBeVisible();

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 3: The email field should be pre-filled and read-only (from the
    //         OAuth identity — owner cannot change it).
    // ──────────────────────────────────────────────────────────────────────────

    // const disabledEmail = page.locator('input[disabled]').first();
    // await expect(disabledEmail).toHaveValue(/example\.com/);

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 4: Fill the business-info portion of the finish form.
    // ──────────────────────────────────────────────────────────────────────────

    // await page.getByPlaceholder('Business name').fill('E2E Google Biz');
    // await page.getByPlaceholder('Google Maps URL').fill(
    //   'https://www.google.com/maps/place/X/@0,0,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d0!4d0',
    // );
    // await page.getByRole('button', { name: /continue to payment/i }).click();

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 5: Assert redirect to payment page.
    // ──────────────────────────────────────────────────────────────────────────

    // await expect(page).toHaveURL(/\/onboarding\/pay/);

    // Placeholder assertion so the test file is a valid Playwright spec
    // and is visible in the report while the harness is being wired up.
    test.skip(true, 'Harness (session cookie injection) not yet wired up — see e2e/README.md');
  });
});
