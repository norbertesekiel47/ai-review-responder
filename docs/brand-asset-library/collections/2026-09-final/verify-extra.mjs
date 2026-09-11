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
const report = { origin, widths: [], checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  for (const width of finalSelection ? [320,375,390,428,760,900,1100,1440,1920] : [320,900,1100,1920]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const id of finalSelection ? ['selected'] : ['F1','F2','F3','F4']) {
      await page.goto(finalSelection ? origin : `${origin}/design-final/${id}`, { waitUntil: 'networkidle', timeout: 90000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
      report.widths.push({ id, width, overflow });
      if (finalSelection) {
        await expect(page.locator('.rw-lp-final-owner')).toHaveAttribute('data-owner-variant','F3');
        await expect(page.locator('.rw-lp-final-roadmap')).toHaveAttribute('data-variant','F1');
        await expect(page.locator('.rw-lp-final-preview-nav')).toHaveCount(0);
        const scene=page.locator('.rw-lp-syn-m-watch-scene');
        await scene.scrollIntoViewIfNeeded();
        const bounds=await scene.boundingBox();
        for (const clip of await scene.locator('.rw-lp-syn-m-clip').all()) {
          const b=await clip.boundingBox();
          expect(b.x).toBeGreaterThanOrEqual(bounds.x); expect(b.x+b.width).toBeLessThanOrEqual(bounds.x+bounds.width);
          expect(b.y+b.height).toBeLessThanOrEqual(bounds.y+bounds.height);
        }
        if(width<=428 || width===1440) await sharp(await scene.screenshot()).webp({quality:88}).toFile(path.join(directory,'screenshots',`selected-${width}-watch.webp`));
      }
    }
  }
  if (!finalSelection) for (const width of [1440,390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${origin}/design-final`, { waitUntil: 'networkidle' });
    await expect(page.locator('.rw-lp-final-comparison-grid article')).toHaveCount(4);
    expect(await page.locator('img').evaluateAll(images => images.every(i => i.complete && i.naturalWidth > 0))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await sharp(await page.screenshot({ fullPage: true })).webp({ quality: 88 }).toFile(path.join(directory,'screenshots',`comparison-${width}.webp`));
    const link = page.getByRole('link', { name: 'Explore F2', exact: true });
    await link.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/design-final\/F2#final-middle$/);
    const mode = page.getByRole('button',{name:/Autopilot/}).first();
    await mode.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    expect(await mode.evaluate(e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth) >= 2)).toBe(true);
    const b=await mode.boundingBox(); expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44);
    report.checks.push({ comparison: width, links: true, focus: true, modeTouchTarget: b });
  }
  const bad = await page.goto(`${origin}/design-final/unknown`); expect(bad.status()).toBe(404); report.checks.push({invalidId:404});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`${origin}/design-final/F1`,{waitUntil:'networkidle'});
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
  await page.goto(`${origin}/design-synthesis/M1`,{waitUntil:'networkidle'});
  await expect(page.locator('.rw-lp-syn-m-house')).toHaveCSS('border-top-left-radius','50%');
  await page.goto(`${origin}/design-synthesis/L1`,{waitUntil:'networkidle'});
  await expect(page.locator('.rw-lp-syn-l-job-carriage')).toHaveCount(5);
  await page.goto(origin,{waitUntil:'networkidle'});
  await expect(page.locator('.rw-lp-final-roadmap')).toHaveAttribute('data-variant','F1');
  await expect(page.locator('.rw-lp-final-owner')).toHaveAttribute('data-owner-variant','F3');
  report.checks.push({oldPreviewsPreserved:true,selectedComposition:true,noindex:true});
  if(finalSelection) {
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Open menu',exact:true}).click();
    await expect(page.getByRole('button',{name:'Close menu',exact:true})).toHaveAttribute('aria-expanded','true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:'Open menu',exact:true})).toBeFocused();
    const mode=page.getByRole('button',{name:/Copilot/}).first();
    await mode.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    expect(await mode.evaluate(e=>e.matches(':focus-visible')&&parseFloat(getComputedStyle(e).outlineWidth)>=2)).toBe(true);
    const box=await mode.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    report.checks.push({mobileMenu:true,keyboardFocus:true,modeTouchTargets:true});
  }
  await page.close();
  const failure = await browser.newPage({viewport:{width:1440,height:1000}});
  await failure.route('**/landing-final/motion/respond.mp4',route=>route.abort());
  await failure.route('**/landing-final/motion/to-copilot.mp4',route=>route.abort());
  await failure.route('**/landing-final/motion/activity-autopilot.mp4',route=>route.abort());
  await failure.goto(finalSelection ? origin : `${origin}/design-final/F1`,{waitUntil:'networkidle'});
  const job=failure.locator('[data-job-film="respond"]'); await job.scrollIntoViewIfNeeded();
  await expect(job.locator('video')).toHaveCount(0);
  await expect.poll(() => job.locator('img').evaluate(i=>i.complete&&i.naturalWidth>0), {timeout:15000}).toBe(true);
  await failure.getByRole('button',{name:/Autopilot/}).click();
  await expect(failure.locator('[data-lever-transition]')).toHaveCount(0);
  await expect(failure.locator('[data-lever-position]')).toHaveAttribute('data-lever-position','right');
  const poster=failure.locator('.rw-lp-final-owner-picture > img');
  await expect.poll(() => poster.evaluate(i=>i.complete&&i.naturalWidth>0), {timeout:15000}).toBe(true);
  report.checks.push({jobMediaFailure:'still remains',leverMediaFailure:'correct selected endpoint remains'});
  await failure.close();
} finally { await browser.close(); await fs.writeFile(path.join(directory,finalSelection ? 'selected-extra-results.json' : 'extra-results.json'),JSON.stringify(report,null,2)); }
console.log(JSON.stringify(report));
