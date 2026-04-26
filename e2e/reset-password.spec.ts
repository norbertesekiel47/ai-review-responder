import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Full owner reset-password flow:
//   recovery link → /reset-password → set new password → redirected to /login
//   → sign in with new password → /dashboard
// ---------------------------------------------------------------------------

test.describe('owner reset-password completion', () => {
  // REQUIRES:
  //   SELF_SERVE_SIGNUP_ENABLED=true
  //   NEXT_PUBLIC_APP_URL=http://localhost:3000
  //   Supabase project with password auth enabled
  //   harness.createOwnerUser() — creates a Supabase Auth + users row
  //   harness.getResetUrl(email) — calls
  //     supabase.auth.admin.generateLink({ type: 'recovery', email })
  //     and returns the action_link URL
  //
  // Cleanup:
  //   supabase.auth.admin.deleteUser(userId)
  //   DELETE FROM users WHERE auth_id = userId

  test('recovery URL → reset-password → new password → login', async ({ page }) => {
    // STEP 1: Obtain a recovery link via admin API (no real email sent).
    //   const ownerEmail = await harness.createOwnerUser();
    //   const resetUrl = await harness.getResetUrl(ownerEmail);

    // STEP 2: Navigate to the recovery link.  The /api/auth/callback handler
    //         exchanges the code and redirects to /reset-password.
    //   await page.goto(resetUrl);
    //   await page.waitForURL(/\/reset-password/);
    //   await expect(page.getByText(/set a new password/i)).toBeVisible();

    // STEP 3: Fill the reset form with a new password.
    //   const newPassword = `pw-${Date.now()}`;
    //   await page.getByPlaceholder(/new password/i).fill(newPassword);
    //   await page.getByPlaceholder(/confirm password/i).fill(newPassword);
    //   await page.getByRole('button', { name: /update password/i }).click();

    // STEP 4: After a successful reset the page must redirect to /login.
    //   await page.waitForURL(/\/login/);

    // STEP 5: Sign in with the new password to confirm the change persisted.
    //   await page.getByPlaceholder('Email').fill(ownerEmail);
    //   await page.getByPlaceholder(/password/i).fill(newPassword);
    //   await page.getByRole('button', { name: /sign in/i }).click();
    //   await expect(page).toHaveURL(/\/dashboard/);

    test.skip(true, 'Harness (auth.admin.generateLink recovery) not yet wired up — see e2e/README.md');
  });

  test('mismatched-portal recovery link → redirected to correct portal reset page', async ({
    page,
  }) => {
    // Cross-portal invariant: a recovery link generated for the owner portal
    // (flow=owner) must not be accepted on /admin/reset-password and vice versa.
    // The callback route should redirect to the correct portal's reset page.
    //
    // REQUIRES:
    //   const ownerEmail = await harness.createOwnerUser();
    //   const resetUrl = await harness.getResetUrl(ownerEmail);
    //   // Manually rewrite the callback `next` param to point at the admin portal:
    //   const wrongPortalUrl = resetUrl.replace('next=/reset-password', 'next=/admin/reset-password');

    //   await page.goto(wrongPortalUrl);
    //   // The callback handler detects the role mismatch and redirects to the
    //   // correct portal rather than rendering the wrong one.
    //   await page.waitForURL(/\/reset-password/);          // owner portal
    //   await expect(page).not.toHaveURL(/\/admin\/reset-password/);

    test.skip(true, 'Harness (auth.admin.generateLink recovery + cross-portal redirect) not yet wired up — see e2e/README.md');
  });

  test('expired recovery link → error page', async ({ page }) => {
    // Supabase recovery codes expire after 1 hour by default.
    // A replayed / stale link must land on an error state rather than the form.
    //
    // REQUIRES:
    //   A genuinely expired link (hard to generate in-harness) OR the callback
    //   handler short-circuits and redirects to /reset-password?error=expired.
    //   One approach: call supabase.auth.admin.generateLink for a deleted user.

    //   await page.goto('/reset-password?error=expired');
    //   await expect(page.getByText(/link has expired/i)).toBeVisible();
    //   await expect(page.getByRole('link', { name: /request a new link/i })).toBeVisible();

    test.skip(true, 'Harness (expired link simulation) not yet wired up — see e2e/README.md');
  });
});
