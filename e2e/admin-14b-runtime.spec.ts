import { expect, test } from '@playwright/test';

const adminPages = [
  '/admin/overview',
  '/admin/costs',
  '/admin/notifications',
  '/admin/jobs',
];

const adminApiRoutes = [
  '/api/admin/overview',
  '/api/admin/costs?days=7',
  '/api/admin/notifications?limit=20&offset=0',
  '/api/admin/jobs?limit=20&offset=0',
];

test.describe('Prompt 14b admin runtime guards', () => {
  test('admin login page renders the Supabase email/password form', async ({ page }) => {
    await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'RepWorth Admin' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  for (const path of adminPages) {
    test(`unauthenticated page ${path} redirects to admin login`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });

      await expect(page).toHaveURL(/\/admin\/login\?from=/);
      const url = new URL(page.url());
      expect(url.pathname).toBe('/admin/login');
      expect(url.searchParams.get('from')).toBe(path);
      await expect(page.getByRole('heading', { name: 'RepWorth Admin' })).toBeVisible();
    });
  }

  for (const path of adminApiRoutes) {
    test(`unauthenticated API ${path} returns 401`, async ({ request }) => {
      const response = await request.get(path);

      expect(response.status()).toBe(401);
      expect(response.headers()['content-type']).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: 'Unauthorized' });
    });
  }
});
