import { test, expect } from '@playwright/test';
import { isE2eConfigured } from './seed';

/**
 * Zernio Google Business connect — happy-path E2E (Task 34).
 *
 * Mock-mode constraints:
 *   - The OAuth callback is fake. There is no real Zernio doing the redirect,
 *     so a fully end-to-end "click Connect → callback fires → land on
 *     select-location" cannot run without manually crafting Redis state
 *     (connect_state + connect_pending) and a session cookie. That harness is
 *     out of scope for v1.
 *   - This test therefore verifies the unauthenticated surface (redirect to
 *     login) and documents the full happy-path under a fixme block, matching
 *     the pattern used by signup-password.spec.ts.
 *
 * Full happy path (deferred to harness — see fixme below):
 *   1. Owner is logged in (Supabase admin API generateLink for a magiclink).
 *   2. Visit /dashboard → ConnectGoogleBanner with "Connect" CTA visible.
 *   3. Click Connect → POST /api/zernio/connect/start.
 *      Mock returns authUrl: 'http://localhost:3000/__mock_oauth_complete'.
 *   4. Hit /api/zernio/connect/callback?state=...&connect_token=...
 *      → 302 redirect to /dashboard/connect/select-location with session cookie.
 *   5. Visit /dashboard/connect/select-location → 1 mock location rendered.
 *   6. Pick first location, submit → POST /api/zernio/connect/select-location.
 *   7. Land on /dashboard. Banner is gone. zernio_connections row status='active'.
 */
test.describe('Zernio connect happy-path E2E', () => {
  // Gate: skip the entire describe block when no test DB is configured. We
  // don't seed yet, but locking in the gate now matches the seed.ts contract
  // and makes future expansion (login + DB assertions) drop-in.
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set — skipping E2E zernio connect tests');

  test('unauthenticated /dashboard/connect redirects to login', async ({ page }) => {
    // Static-surface check: visiting the connect entry point without a
    // Supabase session must bounce to the owner login (/login?from=…,
    // enforced by the
    // (authenticated) layout). This confirms the route exists and the auth
    // gate is wired before we layer authenticated assertions on top.
    await page.goto('/dashboard/connect');

    await expect(page).toHaveURL(/\/login\?from=/, { timeout: 10_000 });
  });

  // ── Authenticated happy path ────────────────────────────────────────
  // Marked fixme until the auth harness (Supabase admin generateLink +
  // session-cookie injection, per e2e/README.md "signup-google.spec.ts"
  // section) is wired up. Running this without the harness will fail at
  // step 1 because there's no logged-in owner.
  test.fixme(
    'authenticated owner: dashboard banner → connect → select-location → active',
    async ({ page }) => {
      // 1. HARNESS: seed business + owner, inject Supabase session cookie.
      //    See e2e/README.md "signup-google.spec.ts" for the recipe.

      // 2. Visit /dashboard. ConnectGoogleBanner ("none" status) renders.
      await page.goto('/dashboard');
      const connectCta = page.getByRole('link', { name: /^Connect$/ });
      await expect(connectCta).toBeVisible({ timeout: 10_000 });

      // 3. Navigate to /dashboard/connect (banner CTA target).
      await connectCta.click();
      await expect(page).toHaveURL(/\/dashboard\/connect$/);

      // 4. Click "Connect Google Business". In MOCK_EXTERNAL_APIS=true the
      //    /api/zernio/connect/start handler returns a mock authUrl.
      const startBtn = page.getByRole('button', { name: /Connect Google Business/ });
      await expect(startBtn).toBeVisible();

      // The remaining steps (callback simulation + select-location submit +
      // dashboard re-check + DB assertion that zernio_connections.status =
      // 'active') require the Redis state-crafting harness described above.
    },
  );
});
