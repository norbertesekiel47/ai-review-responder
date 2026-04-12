import { expect, test } from '@playwright/test';

const adminPages = [
  '/admin/businesses',
  '/admin/businesses/new',
  '/admin/businesses/00000000-0000-0000-0000-000000000000',
];

const adminApiRoutes = [
  { method: 'GET', path: '/api/admin/businesses?limit=20&offset=0' },
  { method: 'POST', path: '/api/admin/businesses' },
  { method: 'GET', path: '/api/admin/businesses/00000000-0000-0000-0000-000000000000' },
  { method: 'PATCH', path: '/api/admin/businesses/00000000-0000-0000-0000-000000000000' },
];

test.describe('Prompt 14c admin runtime guards', () => {
  for (const path of adminPages) {
    test(`unauthenticated page ${path} redirects to admin login`, async ({ page }) => {
      await page.goto(path);

      await expect(page).toHaveURL(/\/admin\/login\?from=/);
      const url = new URL(page.url());
      expect(url.pathname).toBe('/admin/login');
      expect(url.searchParams.get('from')).toBe(path);
      await expect(page.getByRole('heading', { name: 'RepWorth Admin' })).toBeVisible();
    });
  }

  for (const route of adminApiRoutes) {
    test(`unauthenticated ${route.method} ${route.path} returns 401`, async ({ request }) => {
      const response =
        route.method === 'GET'
          ? await request.get(route.path)
          : route.method === 'PATCH'
            ? await request.patch(route.path, {
                data: { name: 'No Auth' },
                headers: { 'Content-Type': 'application/json' },
              })
            : await request.post(route.path, {
                data: { name: 'No Auth' },
                headers: { 'Content-Type': 'application/json' },
              });

      expect(response.status()).toBe(401);
      expect(response.headers()['content-type']).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: 'Unauthorized' });
    });
  }
});
