// e2e/admin-channels-refactor.spec.ts
//
// Regression coverage for the Phase 4 useEnrollment hook extraction.
// Asserts the admin Telegram + WhatsApp widgets behave identically
// after the refactor.
//
// Authenticated flows are test.fixme until the admin signin harness is
// wired (matching e2e/zernio-connect.spec.ts).

import { test, expect } from '@playwright/test';
import { isE2eConfigured } from './seed';

test.describe('Admin business detail — unauthenticated', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  test('unauthenticated /admin/businesses/:id redirects to login', async ({ page }) => {
    await page.goto('/admin/businesses/00000000-0000-0000-0000-000000000000');
    await expect(page).toHaveURL(/\/admin\/login/, { timeout: 10_000 });
  });
});

test.describe('Admin TelegramEnrollmentWidget (post-refactor, deferred)', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  test.fixme(
    'idle state shows Connect button',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_TELEGRAM_ENABLED !== 'true', 'Telegram disabled');
      await page.goto(`/admin/businesses/${process.env.E2E_ADMIN_TEST_BUSINESS_ID}`);
      const widget = page.locator('.telegram-enrollment-widget');
      await expect(widget).toBeVisible();
      await expect(widget.getByRole('heading', { name: 'Telegram' })).toBeVisible();
      await expect(widget.getByRole('button', { name: 'Connect' })).toBeVisible();
    },
  );

  test.fixme(
    'clicking Connect shows QR + deep link',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_TELEGRAM_ENABLED !== 'true', 'Telegram disabled');
      await page.goto(`/admin/businesses/${process.env.E2E_ADMIN_TEST_BUSINESS_ID}`);
      const widget = page.locator('.telegram-enrollment-widget');
      await widget.getByRole('button', { name: 'Connect' }).click();
      await expect(widget.locator('img[alt="Telegram deep link QR"]')).toBeVisible();
      await expect(widget.locator('a[href^="https://t.me/"]')).toBeVisible();
      await expect(widget.getByRole('button', { name: 'Cancel' })).toBeVisible();
    },
  );
});

test.describe('Admin WhatsAppEnrollmentWidget (post-refactor, deferred)', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  test.fixme(
    'idle state shows Connect button',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_WHATSAPP_ENABLED !== 'true', 'WhatsApp disabled');
      await page.goto(`/admin/businesses/${process.env.E2E_ADMIN_TEST_BUSINESS_ID}`);
      const widget = page.locator('.whatsapp-enrollment-widget');
      await expect(widget).toBeVisible();
      await expect(widget.getByRole('heading', { name: 'WhatsApp' })).toBeVisible();
      await expect(widget.getByRole('button', { name: 'Connect' })).toBeVisible();
    },
  );

  test.fixme(
    'clicking Connect shows QR + deep link',
    async ({ page }) => {
      test.skip(process.env.CHANNELS_WHATSAPP_ENABLED !== 'true', 'WhatsApp disabled');
      await page.goto(`/admin/businesses/${process.env.E2E_ADMIN_TEST_BUSINESS_ID}`);
      const widget = page.locator('.whatsapp-enrollment-widget');
      await widget.getByRole('button', { name: 'Connect' }).click();
      await expect(widget.locator('img[alt="WhatsApp deep link QR"]')).toBeVisible();
      await expect(widget.locator('a[href^="https://wa.me/"]')).toBeVisible();
      await expect(widget.getByRole('button', { name: 'Cancel' })).toBeVisible();
    },
  );
});
