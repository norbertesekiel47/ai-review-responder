import { expect, type Page, test } from '@playwright/test';

type ToggleMetrics = {
  toggleWidth: number;
  thumbLeft: number;
  thumbWidth: number;
  monthlyWidth: number;
  annualWidth: number;
  monthlyPressed: string | null;
  annualPressed: string | null;
};

async function getToggleMetrics(page: Page): Promise<ToggleMetrics> {
  return page.locator('.pr-toggle').evaluate((toggle) => {
    const thumb = toggle.querySelector('.pr-toggle-thumb');
    const buttons = Array.from(toggle.querySelectorAll('button'));

    if (!(thumb instanceof HTMLElement) || buttons.length !== 2) {
      throw new Error('Pricing billing toggle is missing expected elements');
    }

    const toggleRect = toggle.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const monthlyBtn = buttons[0]!;
    const annualBtn = buttons[1]!;
    const monthlyRect = monthlyBtn.getBoundingClientRect();
    const annualRect = annualBtn.getBoundingClientRect();

    return {
      toggleWidth: toggleRect.width,
      thumbLeft: thumbRect.left - toggleRect.left,
      thumbWidth: thumbRect.width,
      monthlyWidth: monthlyRect.width,
      annualWidth: annualRect.width,
      monthlyPressed: monthlyBtn.getAttribute('aria-pressed'),
      annualPressed: annualBtn.getAttribute('aria-pressed'),
    };
  });
}

function expectAlignedSegment(metrics: ToggleMetrics, segment: 'monthly' | 'annual') {
  const segmentWidth = segment === 'monthly' ? metrics.monthlyWidth : metrics.annualWidth;
  const expectedLeft = segment === 'monthly'
    ? 6
    : 6 + metrics.monthlyWidth;

  expect(Math.abs(metrics.monthlyWidth - metrics.annualWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.thumbWidth - segmentWidth)).toBeLessThanOrEqual(2);
  expect(Math.abs(metrics.thumbLeft - expectedLeft)).toBeLessThanOrEqual(2);
}

async function waitForAlignedSegment(page: Page, segment: 'monthly' | 'annual') {
  await expect.poll(async () => {
    const metrics = await getToggleMetrics(page);
    const expectedLeft = segment === 'monthly'
      ? 6
      : 6 + metrics.monthlyWidth;

    return Math.abs(metrics.thumbLeft - expectedLeft);
  }).toBeLessThanOrEqual(2);
}

test('pricing billing toggle thumb aligns with equal monthly and annual segments', async ({ page }) => {
  await page.goto('/pricing');

  const toggle = page.locator('.pr-toggle');
  await expect(toggle).toBeVisible();
  await toggle.scrollIntoViewIfNeeded();

  const annualMetrics = await getToggleMetrics(page);
  expect(annualMetrics.annualPressed).toBe('true');
  expect(annualMetrics.monthlyPressed).toBe('false');
  expectAlignedSegment(annualMetrics, 'annual');

  await toggle.getByRole('button', { name: 'Monthly', exact: true }).click();
  await waitForAlignedSegment(page, 'monthly');

  const monthlyMetrics = await getToggleMetrics(page);
  expect(monthlyMetrics.monthlyPressed).toBe('true');
  expect(monthlyMetrics.annualPressed).toBe('false');
  expectAlignedSegment(monthlyMetrics, 'monthly');
});
