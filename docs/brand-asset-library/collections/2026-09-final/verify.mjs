import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium, expect } = require('@playwright/test');
const sharp = require(require.resolve('sharp', { paths: [require.resolve('next')] }));
const directory = path.dirname(fileURLToPath(import.meta.url));
const origin = process.env.FINAL_ORIGIN || 'http://localhost:3100';
const finalSelection = process.env.FINAL_SELECTION === 'true';
const browser = await chromium.launch({ headless: true });
const report = { origin, browser: 'Playwright Chromium', computerUse: false, journeys: [] };
const names = ['The run spine', 'Review responses', 'Review requests', 'The Review QR', 'The Restraint tab', 'Something is plugging in', 'A second chance', 'What is slipping', 'Facts and rules', 'Your hand on the dial', 'More than one map', 'Numbers you can defend', 'Doors for other tools', 'Beyond reviews', 'The one that was never a customer'];
async function center(page, element) {
  await element.evaluate(e => scrollTo({ top: scrollY + e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2 - innerHeight / 2, behavior: 'instant' }));
  await page.waitForTimeout(180);
}
async function shot(page, name) {
  await sharp(await page.screenshot({ style: '.rw-lp-final-preview-nav,nextjs-portal{visibility:hidden!important}' })).webp({ quality: 86 }).toFile(path.join(directory, 'screenshots', name + '.webp'));
}
try {
  for (const id of finalSelection ? ['selected'] : ['F1', 'F2', 'F3', 'F4']) {
    for (const width of [1440, 390]) {
      const mobile = width === 390;
      const page = await browser.newPage({ viewport: { width, height: mobile ? 844 : 1000 }, hasTouch: mobile, reducedMotion: 'no-preference' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/analytics/enqueue', route => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
      await page.goto(finalSelection ? origin : `${origin}/design-final/${id}`, { waitUntil: 'networkidle', timeout: 90000 });
      const activate = async locator => { if (mobile) await locator.tap(); else { await locator.focus(); await page.keyboard.press('Enter'); } };
      const film = page.getByRole('button', { name: /Watch the RepWorth film/ });
      await activate(film);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect.poll(() => dialog.locator('video').evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2);
      await dialog.locator('video').evaluate(v => v.play());
      if (mobile) await dialog.getByRole('button', { name: 'Close video' }).tap(); else await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible(); await expect(film).toBeFocused();
      for (const agent of ['reply', 'guardian', 'insights', 'solicitor', 'insights', 'guardian', 'reply']) {
        await center(page, page.locator(`#rw-lp-syn-l-agent-${agent}`));
        const clip = page.locator(`.rw-lp-syn-l-gallery-sticky video[src="/agents/${agent}.mp4"]`);
        await expect(clip).toHaveCount(1);
        const bounds = await clip.boundingBox();
        expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(mobile ? 845 : 1001);
      }
      for (const link of await page.locator('.rw-lp-syn-l-station').all()) {
        await activate(link); await expect(page).toHaveURL(new RegExp(`${await link.getAttribute('href')}$`));
      }
      const jobMotion = [];
      for (const job of ['respond', 'protect', 'request', 'brief', 'measure']) {
        const scene = page.locator(`[data-job-film="${job}"]`);
        await center(page, scene);
        const video = scene.locator('video');
        await expect.poll(() => video.evaluate(v => v.readyState), { timeout: 20000 }).toBeGreaterThanOrEqual(2);
        await expect.poll(() => video.evaluate(v => !v.paused)).toBe(true);
        const before = await video.evaluate(v => v.currentTime);
        await page.waitForTimeout(250);
        const after = await video.evaluate(v => v.currentTime);
        expect(after).not.toBe(before); jobMotion.push({ job, playing: true });
      }
      const owner = page.locator('.rw-lp-final-owner');
      const auto = owner.getByRole('button', { name: /Autopilot/ });
      const copilot = owner.getByRole('button', { name: /Copilot/ });
      expect((await copilot.boundingBox()).x).toBeLessThan((await auto.boundingBox()).x);
      await activate(auto);
      await expect(auto).toHaveAttribute('aria-pressed', 'true');
      await expect(owner.locator('[data-lever-position]')).toHaveAttribute('data-lever-position', 'right');
      const autoVideo = owner.locator('[data-lever-transition]');
      await expect(autoVideo).toHaveAttribute('src', '/landing-final/motion/to-copilot.mp4');
      await expect.poll(() => autoVideo.evaluate(v => v.currentTime), { timeout: 15000 }).toBeGreaterThan(0);
      expect(await autoVideo.evaluate(v => v.currentTime / v.duration)).toBeGreaterThanOrEqual(0.44);
      expect(await autoVideo.evaluate(v => v.duration / v.playbackRate)).toBeCloseTo(0.7, 2);
      await shot(page, `${id}-${width}-lever-moving`);
      await expect(owner.locator('[data-lever-transition]')).toHaveCount(0, { timeout: 12000 });
      await center(page, owner.locator('.rw-lp-final-owner-picture'));
      await expect(owner.locator('[data-mode-activity="autopilot"]')).toHaveCount(1);
      await expect.poll(() => owner.locator('[data-mode-activity="autopilot"]').evaluate(v => !v.paused && v.readyState >= 2), { timeout: 15000 }).toBe(true);
      await expect(owner.locator('.rw-lp-final-owner-detail')).toContainText('Bounded autonomy.');
      await shot(page, `${id}-${width}-autopilot`);
      const returnStarted = Date.now();
      await activate(copilot);
      await expect(owner.locator('[data-lever-transition]')).toHaveCount(0, { timeout: 1500 });
      expect(Date.now() - returnStarted).toBeLessThan(1500);
      await center(page, owner.locator('.rw-lp-final-owner-picture'));
      await expect.poll(() => owner.locator('[data-mode-activity="copilot"]').evaluate(v => !v.paused && v.readyState >= 2), { timeout: 15000 }).toBe(true);
      await shot(page, `${id}-${width}-copilot`);
      await activate(auto);
      await activate(copilot); await page.waitForTimeout(200); await activate(auto); await page.waitForTimeout(160); await activate(copilot);
      await expect(owner.locator('[data-lever-transition]')).toHaveCount(0, { timeout: 12000 });
      await expect(owner.locator('[data-lever-position]')).toHaveAttribute('data-lever-position', 'left');
      await expect(copilot).toHaveAttribute('aria-pressed', 'true');
      await expect(owner.locator('.rw-lp-final-owner-detail')).toContainText('You approve everything.');
      await activate(page.getByRole('button', { name: 'Pause background motion' }));
      await center(page, page.locator('[data-job-film="respond"]'));
      await expect.poll(() => page.locator('#final-middle video').evaluateAll(videos => videos.every(v => v.paused))).toBe(true);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await activate(auto); await expect(owner.locator('video')).toHaveCount(0);
      await expect(owner.locator('[data-lever-position]')).toHaveAttribute('data-lever-position', 'right');
      await activate(copilot); await expect(owner.locator('video')).toHaveCount(0);
      const roadmap = page.locator('.rw-lp-final-roadmap');
      const visited = [];
      for (const [chapterIndex, chapter] of ['shipped', 'planned', 'horizon'].entries()) {
        const button = roadmap.locator(id === 'F3' ? `.rw-lp-final-survey-row[data-state="${chapter}"] .rw-lp-final-survey-chapter` : `.rw-lp-final-chapters button[data-state="${chapter}"]`);
        await activate(button);
        const buttons = roadmap.locator(id === 'F3' ? `.rw-lp-final-survey-row[data-state="${chapter}"] ol button` : '.rw-lp-final-stop-index button');
        await expect(buttons).toHaveCount(5);
        for (let i = 0; i < 5; i++) {
          const stop = buttons.nth(i); await activate(stop); await expect(stop).toHaveAttribute('aria-pressed', 'true');
          const detail = roadmap.locator('.rw-lp-final-stop-detail');
          await expect(detail).toContainText(names[chapterIndex * 5 + i]);
          await expect(detail).toContainText(chapter === 'shipped' ? 'Available today' : 'Not available yet');
          visited.push(names[chapterIndex * 5 + i]);
        }
        await shot(page, `${id}-${width}-roadmap-${chapter}`);
      }
      if (id === 'F4') {
        await activate(roadmap.getByRole('button', { name: /^Next stop:/ }));
        await expect(roadmap.locator('.rw-lp-final-stop-detail')).toContainText(names[0]);
        await activate(roadmap.getByRole('button', { name: /^Previous stop:/ }));
        await expect(roadmap.locator('.rw-lp-final-stop-detail')).toContainText(names[14]);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(await page.locator('img').evaluateAll(images => images.filter(i => i.complete && !i.naturalWidth).map(i => i.src))).toEqual([]);
      expect(errors).toEqual([]);
      const cta = owner.locator('a[href="/signup"],a[href="/book-a-demo"]').first();
      const destination = await cta.getAttribute('href'); await activate(cta); await expect(page).toHaveURL(new RegExp(`${destination}$`));
      const result = { id, width, film: 'passed', gallery: 'passed both directions', jobMotion, modeChanges: 'passed including rapid reversal and reduced motion', roadmapStops: visited, cta: destination, errors };
      report.journeys.push(result); console.log(JSON.stringify(result)); await page.close();
    }
  }
} finally { await browser.close(); await fs.writeFile(path.join(directory, finalSelection ? 'selected-interaction-results.json' : 'interaction-results.json'), JSON.stringify(report, null, 2)); }
