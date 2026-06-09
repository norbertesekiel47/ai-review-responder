// scripts/component-placement/apply.mjs
// Usage: node scripts/component-placement/apply.mjs <approved-map.json>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { aliasFromPath } from './lca.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}
// Files importing this exact specifier (either quote style). Uses git grep — git
// is spawnable from Node here; ripgrep is a shell function not on the PATH.
function importerFiles(alias) {
  try {
    return execFileSync('git', ['grep', '-l', '-F', '-e', `'${alias}'`, '-e', `"${alias}"`, '--', 'src', 'worker'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // no matches
    throw e;
  }
}
function replaceInFile(file, from, to) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(from)) return;
  writeFileSync(file, src.split(from).join(to));
}

const mapPath = process.argv[2];
if (!mapPath) {
  console.error('usage: node apply.mjs <approved-map.json>');
  process.exit(2);
}
const map = JSON.parse(readFileSync(mapPath, 'utf8'));

for (const entry of map) {
  if (entry.dest.tier === 'shared') continue; // stays in components/<domain>
  const oldPath = entry.file;
  const base = path.posix.basename(oldPath);
  const newPath = path.posix.join(entry.dest.dir, base);
  const oldAlias = aliasFromPath(oldPath);
  const newAlias = aliasFromPath(newPath);

  mkdirSync(entry.dest.dir, { recursive: true });
  git(['mv', oldPath, newPath]);

  // Rewrite the alias everywhere it appears (quoted = exact, prefix-safe).
  for (const f of importerFiles(oldAlias)) {
    replaceInFile(f, `'${oldAlias}'`, `'${newAlias}'`);
    replaceInFile(f, `"${oldAlias}"`, `"${newAlias}"`);
  }

  // Move a co-located test if present (.test.tsx or .test.ts).
  const stem = base.replace(/\.tsx?$/, '');
  for (const ext of ['.test.tsx', '.test.ts']) {
    const testOld = path.posix.join(path.posix.dirname(oldPath), '__tests__', stem + ext);
    if (existsSync(testOld)) {
      const testDir = path.posix.join(entry.dest.dir, '__tests__');
      mkdirSync(testDir, { recursive: true });
      git(['mv', testOld, path.posix.join(testDir, stem + ext)]);
    }
  }
}
process.stdout.write('apply: done\n');
