import { test, expect } from '@playwright/test';

const hasSupabaseBrowserEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

// The DB-backed lifecycle scenarios that used to live here (cancel_only /
// reactivation / delete_data / keep-my-data / purge) were ported to
// `worker/jobs/account-offboarding/__tests__/integration-lifecycle.test.ts`
// (issue #283): their dynamic src/worker imports broke under Playwright's
// transform, so they never ran — the Vitest integration lane imports app code
// natively and executes in the CI `test` job.

test.describe('Owner offboarding — unauthenticated', () => {
  test.skip(!hasSupabaseBrowserEnv, 'Supabase browser env not set');

  test('status page redirects unauthenticated owners to login', async ({ page }) => {
    await page.goto('/account/offboarding/status');
    await expect(page).toHaveURL(/\/login\?from=/, { timeout: 10_000 });
  });
});
