#!/usr/bin/env node
// One reproducible prep pass for the RepWorth design-system sync.
//
// RepWorth is a Next.js app, not a published component package, so three
// inputs the converter normally reads from a `dist/` do not exist here and are
// generated instead. Run this from the repo root BEFORE package-build.mjs, and
// again whenever a brand component, the stylesheet, or a design doc changes:
//
//   node .design-sync/prepare.mjs
//
// Requires the staged converter deps in .ds-sync/ (see NOTES.md).
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CACHE = join(HERE, '.cache');
const TS_MORPH = join(ROOT, '.ds-sync/node_modules/ts-morph/dist/ts-morph.js');
const TAILWIND = join(ROOT, '.ds-sync/node_modules/@tailwindcss/cli/dist/index.mjs');

// The design-system surface: the two component trees that carry the brand.
const SCOPE_DIRS = ['src/components/ui', 'src/components/sections'];
// Scroll-motion wrappers with no visual identity. Both files export `Reveal`,
// so they would also collide on window.RepWorth.
// Both paths for the how-it-works Reveal: it moved to src/components/ui/ on
// 2026-08-22. Keep the old entry until that rename lands on main, so the sync
// is stable whichever revision it runs against.
const EXCLUDE = new Set([
  'src/components/ui/Reveal.tsx',
  'src/components/sections/how-it-works/Reveal.tsx',
  'src/components/sections/landing/reveal.tsx',
]);
// Design docs shipped as guidelines. The converter flattens to basename, so a
// distinct name per file is required — two DESIGN.md would silently drop one.
const GUIDELINES = {
  'brand-story.md': 'docs/design/brand-story.md',
  'design-systems-overview.md': 'docs/design/README.md',
  'island-system.md': 'docs/design/island/DESIGN.md',
  'landing-system.md': 'docs/design/landing/DESIGN.md',
  'landing-measurements.md': 'docs/design/landing/measurements.md',
};

// public/ assets reached through `next/image`. They cannot resolve from a
// preview card or a rendered design (an absolute /path points at the serving
// origin, not the project), so they are inlined as data URIs. Keep this list
// SMALL — every byte lands in _ds_bundle.js. Anything not listed falls back to
// the production origin at runtime; see .design-sync/shims/next-image.tsx.
const INLINE_ASSETS = [
  '/logo.svg',
  '/video/heroVideo-poster.jpg',
  '/video/ctaVideo-poster.jpg',
  // Agent avatar stills. Small, and they are what actually paints: the matching
  // .mp4 clips are far too large to inline, so the poster carries the card
  // wherever the clip cannot load. Also the reduced-motion render of
  // AgentFlipCard, which goes through next/image and so reads this map.
  '/agents/reply.jpg',
  '/agents/guardian.jpg',
  '/agents/insights.jpg',
  '/agents/solicitor.jpg',
  '/agents/judge.jpg',
  '/agents/governor.jpg',
];
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
               '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif' };

const step = (n, msg) => console.error(`[${n}/6] ${msg}`);

// ── 1. component scan → entry.tsx + componentSrcMap ──────────────────────
step(1, 'scanning the brand components');
const { Project, Node, ts } = await import(TS_MORPH);
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__') walk(p); }
    else if (/\.tsx$/.test(n) && !/\.(test|spec|stories)\./.test(n)) files.push(p);
  }
};
for (const d of SCOPE_DIRS) walk(join(ROOT, d));
files.sort();

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, skipLibCheck: true },
});
const byFile = new Map();
for (const p of files) {
  const rel = relative(ROOT, p);
  if (EXCLUDE.has(rel)) continue;
  const sf = project.addSourceFileAtPathIfExists(p);
  if (!sf) continue;
  const names = new Set();
  for (const [name, decls] of sf.getExportedDeclarations()) {
    const real = name === 'default'
      ? decls.map((d) => d.getName?.()).find((n) => n && n !== 'default')
      : name;
    if (!real || !/^[A-Z][A-Za-z0-9]*$/.test(real)) continue;
    if (decls.some((d) => Node.isVariableDeclaration(d) || Node.isFunctionDeclaration(d) || Node.isClassDeclaration(d))) {
      names.add(real);
    }
  }
  if (names.size) byFile.set(rel, [...names].sort());
}
const collisions = [...byFile.values()].flat().filter((n, i, a) => a.indexOf(n) !== i);
if (collisions.length) {
  console.error(`✗ duplicate export name(s) across modules: ${[...new Set(collisions)].join(', ')}`);
  console.error('  Add the losing file to EXCLUDE in this script, or rename the export.');
  process.exit(1);
}

const stem = (rel) => rel.replace(/^src\//, '').replace(/\.tsx$/, '');
const banner = (what) => `// GENERATED by .design-sync/prepare.mjs — ${what}. Do not edit.\n`;
writeFileSync(join(HERE, 'entry.tsx'),
  banner('the design-system surface of RepWorth')
  + [...byFile].map(([rel, n]) => `export { ${n.join(', ')} } from '@/${stem(rel)}';`).join('\n')
  + `\nexport { PreviewProviders } from './shims/preview-providers';\n`);

// ── 2. declaration tree (the converter's props contract) ─────────────────
step(2, 'emitting declarations with tsc');
rmSync(join(CACHE, 'types'), { recursive: true, force: true });
execFileSync(join(ROOT, 'node_modules/typescript/bin/tsc'),
  ['-p', join(HERE, 'tsconfig.dts.json')], { stdio: 'inherit', cwd: ROOT });
writeFileSync(join(CACHE, 'types/entry.d.ts'),
  banner('declaration entry for the brand surface')
  + [...byFile].map(([rel, n]) => `export { ${n.join(', ')} } from './${stem(rel)}';`).join('\n') + '\n');

// ── 3. stylesheet (Tailwind v4 is CSS-first — globals.css is a SOURCE file) ──
step(3, 'compiling the stylesheet');
const cssOut = join(CACHE, 'compiled.css');
execFileSync(process.execPath,
  [TAILWIND, '-i', 'src/app/globals.css', '-o', relative(ROOT, cssOut), '--minify=false'],
  { stdio: 'inherit', cwd: ROOT });
// next/font/local assigns these in src/app/layout.tsx at build time. The bundle
// has no Next build, so they are declared here and bound to the @font-face
// families in .design-sync/fonts.css (cfg.extraFonts harvests @font-face rules
// only, never declarations — which is why this block cannot live there).
appendFileSync(cssOut, `
/* --- design-sync: font variables next/font/local assigns in src/app/layout.tsx --- */
:root {
  --font-inter: 'Inter';
  --font-plus-jakarta: 'Plus Jakarta Sans';
  --font-dm-sans: 'DM Sans';
  --font-fraunces: 'Fraunces';
  --font-jetbrains-mono: 'JetBrains Mono';
  --font-young-serif: 'Young Serif';
}
`);

// ── 4. guidelines, renamed so no two flatten onto one basename ───────────
step(4, 'staging design guidelines');
const gDir = join(HERE, 'design-docs');
rmSync(gDir, { recursive: true, force: true });
mkdirSync(gDir, { recursive: true });
for (const [dest, src] of Object.entries(GUIDELINES)) {
  const from = join(ROOT, src);
  if (!existsSync(from)) { console.error(`  ! guideline missing, skipped: ${src}`); continue; }
  cpSync(from, join(gDir, dest));
}

// ── 5. inlined public assets ─────────────────────────────────────────────
step(5, 'inlining public assets');
const assetLines = [];
for (const ref of INLINE_ASSETS) {
  const from = join(ROOT, 'public', ref.replace(/^\//, ''));
  if (!existsSync(from)) { console.error(`  ! asset missing, skipped: ${ref}`); continue; }
  const ext = ref.slice(ref.lastIndexOf('.')).toLowerCase();
  const mime = MIME[ext];
  if (!mime) { console.error(`  ! no mime for ${ref} — skipped`); continue; }
  const b64 = readFileSync(from).toString('base64');
  assetLines.push(`  ${JSON.stringify(ref)}: 'data:${mime};base64,${b64}',`);
}
writeFileSync(join(CACHE, 'assets.ts'),
  banner('public/ assets inlined as data URIs')
  + 'export const INLINED_ASSETS: Record<string, string> = {\n' + assetLines.join('\n') + '\n};\n');
console.error(`  inlined ${assetLines.length} asset(s), ${Math.round(assetLines.join('').length / 1024)} KB`);

// ── 6. config.componentSrcMap, rewritten from the scan ───────────────────
step(6, 'updating componentSrcMap');
const cfgPath = join(HERE, 'config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const srcMap = {};
for (const [rel, names] of byFile) for (const n of names) srcMap[n] = `../${rel}`;
srcMap.PreviewProviders = null; // provider wrapper, not a design-system component
cfg.componentSrcMap = srcMap;
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

console.error(`✓ prepared: ${Object.keys(srcMap).length - 1} components from ${byFile.size} modules`);
