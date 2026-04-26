import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Cross-portal protection: an owner email submitted to /admin/forgot-password
// (or an admin email to /forgot-password) must return the same generic success
// message BUT must NOT send a password-reset email.  This prevents an attacker
// from enumerating which portal an email belongs to or resetting credentials
// across portals.
// ---------------------------------------------------------------------------

test.describe('forgot-password cross-portal protection', () => {
  // REQUIRES (all tests in this describe):
  //   SELF_SERVE_SIGNUP_ENABLED=true
  //   NEXT_PUBLIC_APP_URL=http://localhost:3000
  //   Supabase project with password auth enabled
  //   harness.createOwnerUser()  — seed a users row with role='owner'
  //   harness.createAdminUser()  — seed a users row with role='admin'
  //   harness.countEmailsSentTo(email) — inspect Supabase dev inbox or a
  //     stubbed email sink to verify no reset email was dispatched.
  //
  // Cleanup after each test:
  //   supabase.auth.admin.deleteUser(userId)
  //   DELETE FROM users WHERE auth_id = userId

  test('owner email on /forgot-password → generic success message', async ({ page }) => {
    // REQUIRES: a real owner user pre-seeded in the test DB.
    //   const ownerEmail = await harness.createOwnerUser();

    await page.goto('/forgot-password');
    await expect(page.getByText(/reset your password/i)).toBeVisible();

    // await page.getByPlaceholder('Email').fill(ownerEmail);
    // await page.getByRole('button', { name: /send reset link/i }).click();

    // Generic message regardless of whether the email exists — prevents
    // account enumeration.
    // await expect(page.getByText(/if an account exists/i)).toBeVisible();

    test.skip(true, 'Harness (owner user seed) not yet wired up — see e2e/README.md');
  });

  test('owner email on /admin/forgot-password → same generic message, NO email sent', async ({
    page,
  }) => {
    // Cross-portal case: owner email → admin portal.
    // The page must still show the generic success message, but no reset email
    // should be dispatched because this email belongs to the owner portal.
    //
    // REQUIRES:
    //   const ownerEmail = await harness.createOwnerUser();
    //   harness.countEmailsSentTo(ownerEmail) via email capture

    await page.goto('/admin/forgot-password');

    // await page.getByPlaceholder('Email').fill(ownerEmail);
    // await page.getByRole('button', { name: /send reset link/i }).click();
    // await expect(page.getByText(/if an account exists/i)).toBeVisible();

    // Zero emails confirms cross-portal protection is active.
    // const emailsSent = await harness.countEmailsSentTo(ownerEmail);
    // expect(emailsSent).toBe(0);

    test.skip(true, 'Harness (email capture + owner user seed) not yet wired up — see e2e/README.md');
  });

  test('admin email on /forgot-password → same generic message, NO email sent', async ({
    page,
  }) => {
    // Reciprocal cross-portal case: admin email → owner portal.
    //
    // REQUIRES:
    //   const adminEmail = await harness.createAdminUser();
    //   harness.countEmailsSentTo(adminEmail) via email capture

    await page.goto('/forgot-password');

    // await page.getByPlaceholder('Email').fill(adminEmail);
    // await page.getByRole('button', { name: /send reset link/i }).click();
    // await expect(page.getByText(/if an account exists/i)).toBeVisible();

    // const emailsSent = await harness.countEmailsSentTo(adminEmail);
    // expect(emailsSent).toBe(0);

    test.skip(true, 'Harness (email capture + admin user seed) not yet wired up — see e2e/README.md');
  });

  test('matched role → email sent + callback link works', async ({ page }) => {
    // Happy path: owner email on the owner portal.
    // Supabase sends a recovery link; the callback route (/api/auth/callback)
    // must route it to /reset-password (owner portal), NOT /admin/reset-password.
    //
    // REQUIRES:
    //   const ownerEmail = await harness.createOwnerUser();
    //   supabase.auth.admin.generateLink({ type: 'recovery', email: ownerEmail })
    //     to obtain the reset URL without triggering real email delivery.

    await page.goto('/forgot-password');

    // await page.getByPlaceholder('Email').fill(ownerEmail);
    // await page.getByRole('button', { name: /send reset link/i }).click();
    // await expect(page.getByText(/if an account exists/i)).toBeVisible();

    // Bypass real email delivery by generating the recovery link via admin API:
    //   const resetUrl = await harness.getResetUrl(ownerEmail);
    //   // Expected shape: /api/auth/callback?code=...&flow=owner&next=/reset-password
    //   await page.goto(resetUrl);
    //   await page.waitForURL(/\/reset-password/);

    test.skip(true, 'Harness (auth.admin.generateLink recovery) not yet wired up — see e2e/README.md');
  });
});
