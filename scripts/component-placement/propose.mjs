// scripts/component-placement/propose.mjs
// Usage: node scripts/component-placement/propose.mjs <domain>  > map.<domain>.json
import { execFileSync } from 'node:child_process';
import { aliasFromPath, transitiveDestination } from './lca.mjs';

// Uses git (always present in a repo; spawnable from Node) rather than ripgrep,
// which is a shell function here and not on Node's execFileSync PATH.
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // git grep: no matches (exit 1)
    throw e;
  }
}

function pageDirs() {
  const tracked = git(['ls-files', '--', 'src/app']);
  const pages = tracked.filter((p) => p.endsWith('/page.tsx'));
  return new Set(pages.map((p) => p.replace(/\/page\.tsx$/, '')));
}

function componentFiles(domain) {
  const tracked = git(['ls-files', '--', `src/components/${domain}`]);
  return tracked.filter((p) => p.endsWith('.tsx') && !p.includes('/__tests__/'));
}

function importersOf(alias) {
  // Files importing this exact module specifier (either quote style). Fixed-string
  // match bounded by quotes is prefix-safe (won't match a longer alias).
  return git(['grep', '-l', '-F', '-e', `'${alias}'`, '-e', `"${alias}"`, '--', 'src', 'worker']);
}

const domain = process.argv[2];
if (!domain) {
  console.error('usage: node propose.mjs <domain>');
  process.exit(2);
}

// Memoized importer lookup keyed by file (the transitive walk revisits shared
// sub-files across different top-level components — don't re-run git grep).
const importerMemo = new Map();
function getImporters(file) {
  if (!importerMemo.has(file)) importerMemo.set(file, importersOf(aliasFromPath(file)));
  return importerMemo.get(file);
}

const pd = pageDirs();
const map = [];
for (const file of componentFiles(domain)) {
  const alias = aliasFromPath(file);
  const importers = getImporters(file).filter((p) => p !== file); // direct importers, for review visibility
  const dest = transitiveDestination(file, getImporters, pd);
  map.push({ file, alias, importers, dest });
}
process.stdout.write(JSON.stringify(map, null, 2) + '\n');
