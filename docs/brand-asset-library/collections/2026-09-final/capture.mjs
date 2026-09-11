import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const sharp = require(require.resolve('sharp', { paths: [require.resolve('next')] }));
const directory = path.dirname(fileURLToPath(import.meta.url));
const origin = process.env.FINAL_ORIGIN || 'http://localhost:3100';
const finalSelection = process.env.FINAL_SELECTION === 'true';
const browser = await chromium.launch({ headless: true });
const ids = finalSelection ? ['selected'] : process.argv.slice(2).length ? process.argv.slice(2) : ['F1', 'F2', 'F3', 'F4'];
await fs.mkdir(path.join(directory, 'screenshots'), { recursive: true });
const records = [];
try {
  for (const id of ids) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(finalSelection ? origin : `${origin}/design-final/${id}`, { waitUntil: 'networkidle', timeout: 90000 });
      await page.addStyleTag({ content: '.rw-lp-final-preview-nav,nextjs-portal{visibility:hidden!important}' });
      const sections = [['problem', '.rw-lp-syn-m-problem'], ['fleet', '.rw-lp-syn-l-fleet'], ['agents', '.rw-lp-syn-l-agents'], ['jobs', '.rw-lp-syn-l-jobs'], ['watch', '.rw-lp-syn-m-watch'], ['owner', '.rw-lp-final-owner'], ['roadmap', '.rw-lp-final-roadmap']];
      for (const [name, selector] of sections) {
        const element = page.locator(selector);
        await element.evaluate(e => scrollTo({ top: scrollY + e.getBoundingClientRect().top, behavior: 'instant' }));
        await page.waitForTimeout(250);
        const output = path.join(directory, 'screenshots', `${id}-${width}-${name}.webp`);
        if (name === 'agents' || name === 'jobs') await sharp(await page.screenshot()).webp({ quality: 86 }).toFile(output);
        else await sharp(await element.screenshot()).webp({ quality: 86 }).toFile(output);
      }
      records.push({ id, width, errors, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), missing: await page.locator('img').evaluateAll(images => images.filter(i => i.complete && !i.naturalWidth).map(i => i.src)), roadmapHeight: await page.locator('.rw-lp-final-roadmap').evaluate(e => e.getBoundingClientRect().height) });
      console.log(JSON.stringify(records.at(-1)));
      await page.close();
    }
  }
} finally { await browser.close(); await fs.writeFile(path.join(directory, finalSelection ? 'selected-capture-results.json' : 'capture-results.json'), JSON.stringify({ origin, records }, null, 2)); }
