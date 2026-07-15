import { expect, test } from '@playwright/test';

test('pricing presents only the two monthly launch plans with no interval selector', async ({ page }) => {
  await page.goto('/pricing');

  const plans = page.locator('.pr-plan');
  await expect(plans).toHaveCount(2);
  await expect(plans.getByRole('heading', { name: 'Copilot' })).toBeVisible();
  await expect(plans.getByRole('heading', { name: 'Autopilot' })).toBeVisible();
  await expect(page.locator('.pr-toggle')).toHaveCount(0);
  await expect(page.getByText(/save 20%/i)).toHaveCount(0);
  await expect(page.getByText(/14-day|no credit card|95% automation/i)).toHaveCount(0);

  const comparison = page.getByRole('region', {
    name: 'Plan comparison, scroll horizontally to compare both plans',
  });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText('Copilot', { exact: true })).toBeVisible();
  await expect(comparison.getByText('Autopilot', { exact: true })).toBeVisible();
});
