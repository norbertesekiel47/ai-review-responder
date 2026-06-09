// scripts/component-placement/propose.mjs
// Usage: node scripts/component-placement/propose.mjs <domain>  > map.<domain>.json
import { execFileSync } from 'node:child_process';
import { aliasFromPath, computeDestination } from './lca.mjs';

function rg(args) {
  try {
    return execFileSync('rg', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // ripgrep: no matches
    throw e;
  }
}

function pageDirs() {
  const pages = rg(['--files', '-g', 'page.tsx', 'src/app']);
  return new Set(pages.map((p) => p.replace(/\/page\.tsx$/, '')));
}

function componentFiles(domain) {
  return rg(['--files', '-g', '*.tsx', '-g', '!**/__tests__/**', `src/components/${domain}`]);
}

function importersOf(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `(from|import)\\s*\\(?['"]${escaped}['"]`;
  return rg(['-l', '-e', pattern, 'src', 'worker']);
}

const domain = process.argv[2];
if (!domain) {
  console.error('usage: node propose.mjs <domain>');
  process.exit(2);
}

const pd = pageDirs();
const map = [];
for (const file of componentFiles(domain)) {
  const alias = aliasFromPath(file);
  const importers = importersOf(alias).filter((p) => p !== file);
  const dest = computeDestination(importers, pd);
  map.push({ file, alias, importers, dest });
}
process.stdout.write(JSON.stringify(map, null, 2) + '\n');
