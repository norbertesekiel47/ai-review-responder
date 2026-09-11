import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const origin = process.env.FINAL_ORIGIN || 'http://localhost:3101';
const browser = await chromium.launch({ headless: true });
const report = { origin, browser: 'Chromium', nativeComputerUse: false, layouts: [], links: [], checks: [] };
const agents = ['reply', 'guardian', 'insights', 'solicitor'];

async function open(page) {
  await page.goto(origin, { waitUntil: 'networkidle' });
}
async function picture(page, name) {
  await page.screenshot({ path: path.join(directory, 'screenshots', `polished-${name}.png`) });
}

try {
  const staticPage = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', javaScriptEnabled: false });
  await open(staticPage);
  expect(await staticPage.locator('.rw-lp-hero-copy > *').evaluateAll(elements => elements.every(element => getComputedStyle(element).opacity === '1' && getComputedStyle(element).transform === 'none'))).toBe(true);
  await picture(staticPage, '390-reduced-motion-first-paint');
  report.checks.push({ reducedMotionFirstPaint: 'headline, copy and CTA visible without waiting for hydration' });
  await staticPage.close();
  for (const [width, height] of [[320,568], [390,844], [760,540], [768,1024], [844,390], [1440,1000]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    await open(page);
    for (const agent of agents) {
      const link = page.locator('.rw-lp-syn-l-agent-tabs').getByRole('link', { name: new RegExp(agent, 'i') });
      await link.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(180);
      await expect(link).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('.rw-lp-syn-l-current strong')).toHaveText(new RegExp(agent, 'i'));
      const target = await link.boundingBox();
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      const screen = await page.locator('.rw-lp-syn-l-aperture').boundingBox();
      expect(screen.y).toBeGreaterThanOrEqual(-1);
      expect(screen.y + screen.height).toBeLessThanOrEqual(height + 1);
      if (width <= 760) {
        expect(target.y).toBeGreaterThanOrEqual(screen.y + screen.height);
        expect(target.y + target.height).toBeLessThan(height);
      }
    }
    await picture(page, `${width}x${height}-agents`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    report.layouts.push({ width, height, galleryIndex: 'four keyboard links, readable selected state, 44px targets', screenFits: true });
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await open(page);
  expect(await page.locator('.rw-lp-hero-copy > *').evaluateAll(elements => elements.every(element => getComputedStyle(element).opacity === '1' && getComputedStyle(element).transform === 'none'))).toBe(true);
  const routes = await page.locator('a[href^="/"]').evaluateAll(links => [...new Set(links.map(link => link.getAttribute('href')))].filter(href => href !== '/'));
  for (const route of routes) {
    const link = page.locator(`a[href="${route}"]:visible`).first();
    await link.click();
    await expect(page).toHaveURL(`${origin}${route}`);
    await expect(page.locator('h1').first()).toBeVisible();
    expect(await page.title()).not.toMatch(/404|not found/i);
    report.links.push({ route, clicked: true, title: await page.title() });
    await open(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.locator('.rw-lp-menu-link[href="/pricing"]').click();
  await expect(page).toHaveURL(`${origin}/pricing`);
  report.checks.push({ mobileNavigation: 'menu → pricing' });

  // Exercise conversion without creating a lead or sending a message.
  let submissions = 0;
  await page.route('**/api/lead-intake', route => {
    submissions++;
    return route.fulfill({ status: submissions === 1 ? 503 : 200, contentType: 'application/json', body: submissions === 1 ? JSON.stringify({ error: 'Please try again shortly.' }) : '{}' });
  });
  await open(page);
  await page.locator('.rw-lp-hero a[href="/book-a-demo"]').click();
  const form = page.locator('form').first();
  const submit = form.getByRole('button', { name: 'Get early access', exact: true });
  await submit.click();
  await expect(form.locator('[aria-invalid="true"]')).toHaveCount(3);
  expect(submissions).toBe(0);
  await form.locator('input[name="name"]').fill('Landing preview');
  await form.locator('input[name="email"]').fill('landing-preview@example.invalid');
  await form.locator('input[name="businessName"]').fill('Preview business');
  await submit.click();
  await expect(page.getByText('Please try again shortly.', { exact: true })).toBeVisible();
  await picture(page, '390-conversion-retry');
  await submit.click();
  await expect(page.getByRole('heading', { name: "You're on the waitlist." })).toBeVisible();
  expect(submissions).toBe(2);
  await page.getByRole('heading', { name: "You're on the waitlist." }).evaluate(element => scrollTo({ top: scrollY + element.getBoundingClientRect().top - 150, behavior: 'instant' }));
  await picture(page, '390-conversion-success');
  await page.getByRole('link', { name: 'See how it works', exact: false }).last().click();
  await expect(page).toHaveURL(`${origin}/how-it-works`);
  report.checks.push({ conversion: 'hero CTA → required validation → simulated server error → retry → simulated success → how it works', backend: 'intercepted; no lead submitted' });
  await page.close();

  const failure = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await failure.route(/\/(agents\/(reply|guardian|judge|governor)|problem\/problem-diagram)\.mp4$/, route => route.abort());
  await open(failure);
  for (const id of ['house', 'judge', 'governor']) {
    const scene = failure.locator(`[data-brand-clip="${id}"]`);
    await scene.scrollIntoViewIfNeeded();
    await expect(scene.locator('video')).toHaveCount(0);
    await expect.poll(() => scene.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  }
  for (const agent of ['reply', 'guardian']) {
    await failure.locator(`.rw-lp-syn-l-agent-tabs a[href$="-${agent}"]`).click();
    const scene = failure.locator('.rw-lp-syn-l-aperture .rw-lp-syn-l-media');
    await expect(scene.locator('video')).toHaveCount(0);
    await expect.poll(() => scene.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  }
  await picture(failure, '390-original-media-fallback');
  report.checks.push({ originalMediaFailure: 'house, Judge, Governor, Reply and Guardian keep their still images' });
  await failure.close();
} finally {
  await browser.close();
  await fs.writeFile(path.join(directory, 'polish-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
