import { test, expect } from '@playwright/test';
import { isE2eConfigured } from './seed';
import {
  isAuthHarnessConfigured,
  createBareAuthUser,
  deleteProvisionedOwner,
  signInViaMagicLink,
  isDeepAuthConfigured,
} from './harness';

// ---------------------------------------------------------------------------
// Post-OAuth signup completion: /signup/finish → name form → /onboarding/pay.
//
// Playwright cannot drive Google's real consent screen, so the harness
// simulates the post-callback state: a confirmed bare auth user (no app rows
// yet — exactly what a first-time OAuth identity looks like) signed in via an
// admin magic link routed through the app's own callback.
//
// NOTE: the spec's original scaffold predated the current finish form — the
// page collects name/phone only ("we'll set up your business after payment");
// the business form moved into the post-pay wizard.
// ---------------------------------------------------------------------------

test.describe('owner Google signup flow', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');
  test.skip(
    !isAuthHarnessConfigured,
    'E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_KEY not set — auth-harness specs run locally against staging (e2e/README.md)',
  );

  test('OAuth-state session → /signup/finish → name form → /onboarding/pay', async ({
    page,
  }) => {
    test.skip(
      !isDeepAuthConfigured,
      'Deep auth tier: requires E2E_AUTH_DEEP=true with TEST_DATABASE_POOL_URL pointed at the staging Postgres (dual-client constraint) — see docs/runbooks/e2e-local-setup.md',
    );
    let authUserId: string | undefined;
    try {
      const bare = await createBareAuthUser();
      authUserId = bare.authUserId;

      // STEP 1: materialize an authenticated session through the app's own
      // callback (no hand-crafted cookies).
      await signInViaMagicLink(page, bare.email, '/signup/finish');

      // STEP 2: the finish page renders for the fresh identity.
      await page.goto('/signup/finish');
      await expect(page.getByText(/almost there/i)).toBeVisible({ timeout: 15_000 });

      // STEP 3: the email field is pre-filled from the OAuth identity and
      // not editable.
      const emailField = page.getByLabel(/email \(from your google account\)/i);
      await expect(emailField).toBeDisabled();
      await expect(emailField).toHaveValue(bare.email);

      // STEP 4: complete the name form.
      await page.getByLabel('Your name').fill('E2E Google User');
      await page.getByRole('button', { name: /continue/i }).click();

      // STEP 5: provisioning done → first onboarding step (/onboarding/start
      // when ONBOARDING_DEMO_ENABLED, /onboarding/pay in the legacy flow).
      await page.waitForURL(/\/onboarding\/(start|pay)/, { timeout: 20_000 });
    } finally {
      if (authUserId) await deleteProvisionedOwner(authUserId);
    }
  });
});
