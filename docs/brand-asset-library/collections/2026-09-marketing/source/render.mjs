import { createRequire } from 'node:module';
import './typecheck.mjs';
import { mkdir, copyFile, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const collection = resolve(source, '..');
const repo = resolve(source, '../../../../..');
const runtime = resolve(repo, 'output/repworth-marketing-2026-09-08/runtime');
const require = createRequire(resolve(runtime, 'package.json'));
const { bundle } = require('@remotion/bundler');
const { getCompositions, renderStill, renderMedia } = require('@remotion/renderer');
const { chromium } = createRequire(resolve(repo, 'package.json'))('@playwright/test');
const browserExecutable = process.env.REPWORTH_RENDER_BROWSER || chromium.executablePath();
const content = JSON.parse(await readFile(resolve(source, 'content.json'), 'utf8'));
const exists = async (path) => access(path).then(() => true, () => false);

async function stage(from, to) {
  const target = resolve(runtime, 'public', to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(from, target);
}
await stage(resolve(repo, 'public/logo.svg'), 'logo.svg');
for (const agent of content.agents) await stage(resolve(repo, `public/agents/${agent.id}.jpg`), `agents/${agent.id}.jpg`);
for (const font of ['dm-sans', 'plus-jakarta-sans', 'jetbrains-mono']) await stage(resolve(repo, `src/app/fonts/${font}-latin.woff2`), `fonts/${font}-latin.woff2`);
for (const bg of ['light-01-architecture', 'dark-01-folded-paper']) await stage(resolve(collection, `backgrounds/${bg}.png`), `backgrounds/${bg}.png`);

const css = await readFile(resolve(repo, 'src/app/globals.css'), 'utf8');
const landing = await readFile(resolve(repo, 'src/components/sections/landing/landing-experience.css'), 'utf8');
function token(text, name) {
  const value = text.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1];
  if (!value) throw new Error(`Missing brand token ${name}`);
  return value.trim();
}
const rgb = (name, alpha = 1) => `rgb(${token(landing, name)} / ${alpha})`;
const palettes = {
  light: { ground: token(css, '--rw-bone'), paper: token(css, '--rw-paper'), ink: token(css, '--rw-ink2'), accent: token(css, '--rw-forest'), watch: token(css, '--rw-forest'), line: 'rgba(21,25,26,.16)', muted: token(css, '--rw-ink2-soft') },
  dark: { ground: rgb('--rw-lp-ink-rgb'), paper: rgb('--rw-lp-text-rgb', .055), ink: rgb('--rw-lp-text-rgb'), accent: rgb('--rw-lp-accent-rgb'), watch: '#a9c6c0', line: rgb('--rw-lp-text-rgb', .17), muted: rgb('--rw-lp-text-rgb', .76) },
};
await writeFile(resolve(source, 'palette-snapshot.json'), JSON.stringify({ source: ['src/app/globals.css', 'src/components/sections/landing/landing-experience.css'], palettes }, null, 2) + '\n');
const serveUrl = await bundle({ enableCaching: false, entryPoint: resolve(source, 'index.tsx'), publicDir: resolve(runtime, 'public'), outDir: resolve(runtime, 'bundle'), webpackOverride: (config) => ({ ...config, resolve: { ...config.resolve, modules: [resolve(runtime, 'node_modules'), ...(config.resolve?.modules ?? ['node_modules'])] } }) });
const compositions = await getCompositions(serveUrl, { browserExecutable });
const mode = process.argv[2] ?? '--all';
const jobs = [];
for (const theme of ['light', 'dark']) {
  for (const item of content.social) for (const [id, size] of [['SocialSquare', 'square'], ['SocialPortrait', 'portrait'], ['SocialStory', 'story']]) jobs.push({ id, theme, item: item.id, kind: 'social', path: `social/${theme}/${item.id}-${size}.png` });
  for (const agent of content.agents) jobs.push({ id: 'AgentStill', theme, item: agent.id, kind: 'agent', path: `agents/${theme}/${agent.id}.png` });
  for (const kind of ['logo-intro', 'logo-outro', 'typography', 'workflow', 'escalation', 'report', 'map-route']) jobs.push({ id: 'BrandMotion', theme, kind, path: `motion/${theme}/${kind}.mp4` });
  for (const agent of content.agents) jobs.push({ id: 'AgentMotion', theme, item: agent.id, kind: 'agent', path: `motion/${theme}/agent-${agent.id}.mp4` });
}
const selected = mode === '--smoke' ? [jobs[0], jobs.find((j) => j.id === 'AgentStill' && j.item === 'governor'), jobs.find((j) => j.id === 'BrandMotion')]
  : jobs.filter((j) => mode === '--all' || (mode === '--stills' ? j.path.endsWith('.png') : j.path.endsWith('.mp4')));
const match = process.argv.find((arg) => arg.startsWith('--match='))?.slice('--match='.length);
const filtered = match ? selected.filter((job) => new RegExp(match).test(job.path)) : selected;
for (const job of filtered) {
  const outputLocation = resolve(collection, job.path);
  if (await exists(outputLocation) && !process.argv.includes('--force')) { console.log(`Exists: ${job.path}`); continue; }
  await mkdir(dirname(outputLocation), { recursive: true });
  const composition = compositions.find((c) => c.id === job.id);
  if (!composition) throw new Error(`Unknown composition ${job.id}`);
  const inputProps = { theme: job.theme, colors: palettes[job.theme], kind: job.kind, item: job.item };
  const options = { serveUrl, composition: { ...composition, props: inputProps }, inputProps, output: outputLocation, browserExecutable };
  if (job.path.endsWith('.png')) await renderStill({ ...options, frame: 100, imageFormat: 'png' });
  else await renderMedia({ ...options, outputLocation, codec: 'h264', crf: 18, pixelFormat: 'yuv420p', concurrency: 2, muted: true });
  console.log(`Rendered: ${job.path}`);
}
console.log(`Finished ${filtered.length} requested exports.`);
