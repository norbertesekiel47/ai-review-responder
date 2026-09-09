import { createRequire } from 'node:module';
import './typecheck.mjs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = dirname(fileURLToPath(import.meta.url));
const collection = resolve(source, '..');
const repo = resolve(source, '../../../../..');
const runtime = resolve(repo, 'output/repworth-marketing-2026-09-08/runtime');
const require = createRequire(resolve(runtime, 'package.json'));
const { bundle } = require('@remotion/bundler');
const { getCompositions, renderMedia } = require('@remotion/renderer');
const browserExecutable = process.env.REPWORTH_RENDER_BROWSER || createRequire(resolve(repo, 'package.json'))('@playwright/test').chromium.executablePath();
const serveUrl = await bundle({ enableCaching: false, entryPoint: resolve(source, 'abstract-index.tsx'), outDir: resolve(runtime, 'abstract-bundle'), webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, modules: [resolve(runtime, 'node_modules'), 'node_modules'] } }) });
const [composition] = await getCompositions(serveUrl, { browserExecutable });
for (const dark of [false, true]) for (const kind of ['orbit', 'paper-flow', 'signal']) {
  const dir = resolve(collection, 'motion', dark ? 'dark' : 'light');
  await mkdir(dir, { recursive: true });
  const props = { dark, kind };
  await renderMedia({ serveUrl, composition: { ...composition, props }, inputProps: props, browserExecutable, outputLocation: resolve(dir, `abstract-${kind}-loop.mp4`), codec: 'h264', crf: 18, pixelFormat: 'yuv420p', concurrency: 2, muted: true });
  console.log(`Rendered ${dark ? 'dark' : 'light'} ${kind} loop.`);
}
