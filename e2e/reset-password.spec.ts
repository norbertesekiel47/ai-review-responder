import { test, expect } from '@playwright/test';
import { isE2eConfigured } from './seed';
import {
  isAuthHarnessConfigured,
  createOwnerUser,
  deleteOwnerUser,
  getResetUrl,
  isDeepAuthConfigured,
  type OwnerHandle,
} from './harness';

// ---------------------------------------------------------------------------
// Full owner reset-password flow:
//   recovery link → /reset-password → set new password → redirected to /login
//   → sign in with new password → authenticated app.
//
// Harness: staging Supabase (E2E_SUPABASE_URL/E2E_SUPABASE_SERVICE_KEY); the
// app under test must point at the same project — see
// docs/runbooks/e2e-local-setup.md §auth-harness.
// ---------------------------------------------------------------------------

test.describe('owner reset-password completion', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');
  test.skip(
    !isAuthHarnessConfigured,
    'E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_KEY not set — auth-harness specs run locally against staging (e2e/README.md)',
  );

  test('recovery URL → reset-password → new password → login works', async ({ page }) => {
    test.skip(
      !isDeepAuthConfigured,
      'Deep auth tier: requires E2E_AUTH_DEEP=true with TEST_DATABASE_POOL_URL pointed at the staging Postgres (dual-client constraint) — see docs/runbooks/e2e-local-setup.md',
    );
    let owner: OwnerHandle | undefined;
    try {
      owner = await createOwnerUser();

      // STEP 1-2: admin-API recovery link (no real email) → callback →
      // owner reset page.
      const resetUrl = await getResetUrl(owner.email);
      await page.goto(resetUrl);
      await page.waitForURL(/\/reset-password/, { timeout: 15_000 });
      await expect(page.getByText(/set a new password/i)).toBeVisible();

      // STEP 3: set the new password (owner variant — labeled fields).
      const newPassword = `pw-new-${Date.now()}`;
      await page.getByLabel('New password').fill(newPassword);
      await page.getByLabel('Confirm password').fill(newPassword);
      await page.getByRole('button', { name: /update password/i }).click();

      // STEP 4: successful reset redirects to the owner login.
      await page.waitForURL(/\/login/, { timeout: 15_000 });

      // STEP 5: the new password actually works.
      await page.getByLabel('Email').fill(owner.email);
      await page.getByLabel('Password').fill(newPassword);
      await page.getByRole('button', { name: /sign in/i }).click();
      // Authenticated landing — exact destination depends on onboarding
      // state; the contract here is "left the login page without an error".
      await page.waitForURL((url) => !/\/login/.test(url.pathname), { timeout: 20_000 });
    } finally {
      if (owner) await deleteOwnerUser(owner);
    }
  });

  test('mismatched-portal recovery link → never lands on the admin reset page', async ({
    page,
  }) => {
    // Cross-portal invariant: a recovery link generated for the owner flow,
    // with its `next` rewritten toward the admin portal, must not be accepted
    // at /admin/reset-password.
    let owner: OwnerHandle | undefined;
    try {
      owner = await createOwnerUser();

      const resetUrl = await getResetUrl(owner.email);
      const wrongPortalUrl = resetUrl.replace(
        'next%3D%2Freset-password',
        'next%3D%2Fadmin%2Freset-password',
      ).replace('next=/reset-password', 'next=/admin/reset-password');

      await page.goto(wrongPortalUrl);
      // The callback detects the role/flow mismatch and routes to the owner
      // portal (or an error) — never the admin reset form.
      await page.waitForURL(/\/(reset-password|login|forgot-password)/, { timeout: 15_000 });
      await expect(page).not.toHaveURL(/\/admin\/reset-password/);
    } finally {
      if (owner) await deleteOwnerUser(owner);
    }
  });

  test('consumed recovery link cannot be replayed', async ({ page }) => {
    test.skip(
      !isDeepAuthConfigured,
      'Deep auth tier: requires E2E_AUTH_DEEP=true with TEST_DATABASE_POOL_URL pointed at the staging Postgres (dual-client constraint) — see docs/runbooks/e2e-local-setup.md',
    );
    // Supabase recovery codes are single-use; a replayed link must not yield
    // a usable reset form session a second time. (True time-expiry is not
    // generatable in-harness; single-use consumption covers the replay half.)
    let owner: OwnerHandle | undefined;
    try {
      owner = await createOwnerUser();

      const resetUrl = await getResetUrl(owner.email);
      await page.goto(resetUrl);
      await page.waitForURL(/\/reset-password/, { timeout: 15_000 });

      // Complete the reset so the link is consumed.
      const newPassword = `pw-new-${Date.now()}`;
      await page.getByLabel('New password').fill(newPassword);
      await page.getByLabel('Confirm password').fill(newPassword);
      await page.getByRole('button', { name: /update password/i }).click();
      await page.waitForURL(/\/login/, { timeout: 15_000 });

      // Replay the SAME link in a fresh context-free navigation: it must not
      // land back on a working reset form (error param or bounce elsewhere).
      await page.context().clearCookies();
      await page.goto(resetUrl);
      await expect(page).not.toHaveURL(/\/reset-password$/, { timeout: 15_000 });
    } finally {
      if (owner) await deleteOwnerUser(owner);
    }
  });
});
