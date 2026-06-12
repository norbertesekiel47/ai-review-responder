import { test, expect } from '@playwright/test';
import { isE2eConfigured } from './seed';
import {
  isAuthHarnessConfigured,
  createOwnerUser,
  createAdminUser,
  deleteOwnerUser,
  deleteAdminUser,
  getResetUrl,
  isDeepAuthConfigured,
  type OwnerHandle,
  type AdminHandle,
} from './harness';

// ---------------------------------------------------------------------------
// Cross-portal protection: an owner email submitted to /admin/forgot-password
// (or an admin email to /forgot-password) must return the same generic success
// message. This prevents an attacker from enumerating which portal an email
// belongs to.
//
// SCOPE NOTE: the "…and NO reset email was dispatched" half of the invariant
// is owned by the route's unit tests (the route silently no-ops on role
// mismatch before any resetPasswordForEmail call) — e2e cannot observe email
// dispatch against the staging-backed harness without an inbox capture.
// These specs assert the user-visible anti-enumeration contract.
//
// Harness: staging Supabase via E2E_SUPABASE_URL/E2E_SUPABASE_SERVICE_KEY;
// the app under test must point at the same project. Local recipe:
// docs/runbooks/e2e-local-setup.md §auth-harness.
// ---------------------------------------------------------------------------

const GENERIC_SUCCESS = /if an account exists/i;

test.describe('forgot-password cross-portal protection', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');
  test.skip(
    !isAuthHarnessConfigured,
    'E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_KEY not set — auth-harness specs run locally against staging (e2e/README.md)',
  );

  test('owner email on /forgot-password → generic success message', async ({ page }) => {
    let owner: OwnerHandle | undefined;
    try {
      owner = await createOwnerUser();

      await page.goto('/forgot-password');
      await expect(page.getByText(/reset your password/i)).toBeVisible();

      await page.getByLabel('Email').fill(owner.email);
      await page.getByRole('button', { name: /send reset link/i }).click();

      await expect(page.locator('p', { hasText: GENERIC_SUCCESS })).toBeVisible();
    } finally {
      if (owner) await deleteOwnerUser(owner);
    }
  });

  test('owner email on /admin/forgot-password → same generic message', async ({ page }) => {
    // Cross-portal case: owner email → admin portal. Identical generic
    // success; the no-send half is unit-tested in the route.
    let owner: OwnerHandle | undefined;
    try {
      owner = await createOwnerUser();

      await page.goto('/admin/forgot-password');
      await page.getByLabel('Email').fill(owner.email);
      await page.getByRole('button', { name: /send reset link/i }).click();

      await expect(page.locator('p', { hasText: GENERIC_SUCCESS })).toBeVisible();
    } finally {
      if (owner) await deleteOwnerUser(owner);
    }
  });

  test('admin email on /forgot-password → same generic message', async ({ page }) => {
    // Reciprocal cross-portal case: admin email → owner portal.
    let admin: AdminHandle | undefined;
    try {
      admin = await createAdminUser();

      await page.goto('/forgot-password');
      await page.getByLabel('Email').fill(admin.email);
      await page.getByRole('button', { name: /send reset link/i }).click();

      await expect(page.locator('p', { hasText: GENERIC_SUCCESS })).toBeVisible();
    } finally {
      if (admin) await deleteAdminUser(admin);
    }
  });

  test('matched role → generic success + recovery callback lands on /reset-password', async ({
    page,
  }) => {
    test.skip(
      !isDeepAuthConfigured,
      'Deep auth tier: requires E2E_AUTH_DEEP=true with TEST_DATABASE_POOL_URL pointed at the staging Postgres (dual-client constraint) — see docs/runbooks/e2e-local-setup.md',
    );
    // Happy path: owner email on the owner portal, then bypass real email
    // delivery via the admin generateLink recovery URL — the callback route
    // must land on the OWNER portal's reset page.
    let owner: OwnerHandle | undefined;
    try {
      owner = await createOwnerUser();

      await page.goto('/forgot-password');
      await page.getByLabel('Email').fill(owner.email);
      await page.getByRole('button', { name: /send reset link/i }).click();
      await expect(page.locator('p', { hasText: GENERIC_SUCCESS })).toBeVisible();

      const resetUrl = await getResetUrl(owner.email);
      await page.goto(resetUrl);
      await page.waitForURL(/\/reset-password/, { timeout: 15_000 });
      await expect(page).not.toHaveURL(/\/admin\/reset-password/);
    } finally {
      if (owner) await deleteOwnerUser(owner);
    }
  });
});
