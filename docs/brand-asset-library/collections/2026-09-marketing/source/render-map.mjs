import { createRequire } from 'node:module';
import './typecheck.mjs';
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = dirname(fileURLToPath(import.meta.url));
const collection = resolve(source, '..');
const repo = resolve(source, '../../../../..');
const runtime = resolve(repo, 'output/repworth-marketing-2026-09-08/runtime');
const require = createRequire(resolve(runtime, 'package.json'));
const { bundle } = require('@remotion/bundler');
const { getCompositions, renderStill, renderMedia } = require('@remotion/renderer');
const browserExecutable = process.env.REPWORTH_RENDER_BROWSER || createRequire(resolve(repo, 'package.json'))('@playwright/test').chromium.executablePath();
for (const file of ['map-day-blank.png', 'map-night-blank.png', ...['cottage','watchtower','mailbox','newsstand','lighthouse','airship','cloud'].map((p) => `props/${p}.png`)]) {
  const destination = resolve(runtime, 'public/maps', file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(collection, 'maps', file), destination);
}
const serveUrl = await bundle({ enableCaching: false, entryPoint: resolve(source, 'map-index.tsx'), publicDir: resolve(runtime, 'public'), outDir: resolve(runtime, 'map-bundle'), webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, modules: [resolve(runtime, 'node_modules'), 'node_modules'] } }) });
const [composition] = await getCompositions(serveUrl, { browserExecutable });
for (const night of [false, true]) {
  const options = { serveUrl, composition: { ...composition, props: { night } }, inputProps: { night }, browserExecutable };
  const base = resolve(collection, `maps/assembled-${night ? 'night' : 'day'}`);
  await renderStill({ ...options, frame: 240, imageFormat: 'png', output: `${base}.png` });
  await renderMedia({ ...options, codec: 'h264', crf: 18, pixelFormat: 'yuv420p', concurrency: 2, muted: true, outputLocation: `${base}-12s.mp4` });
  console.log(`Rendered assembled ${night ? 'night' : 'day'} map still and 12-second motion.`);
}
