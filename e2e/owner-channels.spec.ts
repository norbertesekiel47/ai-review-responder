// e2e/owner-channels.spec.ts
//
// Owner channels page E2E.
//
// Mirrors the established pattern from e2e/zernio-connect.spec.ts:
//   - Unauthenticated assertions run today.
//   - Authenticated flows are test.fixme until the Supabase admin
//     generateLink harness lands (see e2e/README.md). When that lands,
//     un-fixme each authenticated test and supply the magic-link login.
//
// The simulateTelegramStart helper is already plan-built (Task 17) so
// the verified-flip step is ready as soon as the auth harness exists.
//
// Coverage status:
//   - Pure reducer + hook actions: 27 unit tests in src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts
//   - Owner route-handler logic: 13 unit tests in src/lib/channels/__tests__/telegram-enrollment.test.ts
//   - Cancel-releases-mobile-slot regression: covered in telegram-enrollment.test.ts
//   - Authenticated UI flows below remain test.fixme until the Supabase admin
//     generateLink magic-link harness lands (tracked separately, see e2e/README.md).

import { test, expect } from '@playwright/test';
import { isE2eConfigured } from './seed';
import { simulateTelegramStart } from './helpers/telegram-test-ingress';

test.describe('Owner /settings/channels — unauthenticated', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set — skipping E2E channels tests');

  test('unauthenticated /settings/channels redirects to login', async ({ page }) => {
    await page.goto('/settings/channels');
    await expect(page).toHaveURL(/\/admin\/login/, { timeout: 10_000 });
  });
});

test.describe('Owner /settings/channels — authenticated (deferred)', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  // Each test below is fixme'd until the auth harness is wired. The
  // assertion bodies are concrete so the implementer can un-fixme them
  // one at a time as the harness comes online.

  test.fixme(
    'renders email + telegram + 2 coming-soon rows',
    async ({ page }) => {
      // After signin via auth harness:
      await page.goto('/settings/channels');
      await expect(page.getByRole('heading', { name: 'Notification channels' })).toBeVisible();
      await expect(page.getByText('Email')).toBeVisible();
      await expect(page.getByText('Always on')).toBeVisible();
      await expect(page.getByText('Telegram')).toBeVisible();
      await expect(page.getByText('SMS')).toBeVisible();
      await expect(page.getByText('WhatsApp')).toBeVisible();
    },
  );

  test.fixme(
    'connect Telegram → simulated webhook → verified',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_TELEGRAM_ENABLED !== 'true', 'Telegram disabled');
      await page.goto('/settings/channels');

      const telegramRow = page.getByText('Telegram').locator('xpath=ancestor::*[contains(@class,"rounded-lg")]').first();
      await telegramRow.getByRole('button', { name: 'Connect' }).click();

      await expect(page.locator('img[alt="Telegram QR"]')).toBeVisible();
      const linkLocator = page.locator('a[href^="https://t.me/"]');
      const deepLink = await linkLocator.getAttribute('href');
      expect(deepLink).toMatch(/^https:\/\/t\.me\/.+\?start=.+$/);
      const rawToken = new URL(deepLink!).searchParams.get('start');
      expect(rawToken).toBeTruthy();

      const ingressRes = await simulateTelegramStart({ rawToken: rawToken! });
      expect(ingressRes.status).toBeLessThan(400);

      await expect(page.getByText(/✓ Connected/)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    },
  );

  test.fixme(
    'disconnect verified Telegram → idle',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_TELEGRAM_ENABLED !== 'true', 'Telegram disabled');
      await page.goto('/settings/channels');
      page.on('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Disconnect' }).click();
      await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible({ timeout: 10_000 });
    },
  );

  test.fixme(
    'non-active subscription owner is redirected to /onboarding/pay',
    async ({ page }) => {
      // Requires a pending_payment owner fixture in seed.ts.
      await page.goto('/settings/channels');
      await expect(page).toHaveURL(/\/onboarding\/pay/);
    },
  );

  test.fixme(
    'tab strip navigates between General and Notification channels',
    async ({ page }) => {
      await page.goto('/settings/channels');
      await page.getByRole('link', { name: 'General' }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await page.getByRole('link', { name: 'Notification channels' }).click();
      await expect(page).toHaveURL(/\/settings\/channels$/);
    },
  );

  test.fixme(
    'coming-soon rows have no button',
    async ({ page }) => {
      await page.goto('/settings/channels');
      const smsRow = page.getByText('SMS').locator('xpath=ancestor::*[contains(@class,"rounded-lg")]');
      await expect(smsRow.getByRole('button')).toHaveCount(0);
    },
  );
});
