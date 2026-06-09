// scripts/component-placement/normalize.mjs
// Convert src-internal relative imports (./x, ../x) to @/ aliases so every
// module reference is move-stable. Imports that resolve OUTSIDE src/ (cross-tree
// to worker/ or scripts/, which have no alias) are left untouched.
//
// Usage:
//   node scripts/component-placement/normalize.mjs            # dry-run (default)
//   node scripts/component-placement/normalize.mjs --write    # apply
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Pure: importing file (repo-relative) + a relative specifier → @/ alias, or
// null when the specifier is not relative or resolves outside src/.
export function relativeToAlias(file, spec) {
  if (!spec.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  if (!resolved.startsWith('src/')) return null; // cross-tree (worker/scripts) — no alias exists
  return '@/' + resolved.slice('src/'.length).replace(/\/index$/, '');
}

function srcFiles() {
  return execFileSync('git', ['ls-files', '--', 'src'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter((p) => /\.(tsx?|jsx?)$/.test(p));
}

// from './x'  |  import('./x')  |  import './x'  (side-effect)
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;

const write = process.argv.includes('--write');
let rewritten = 0;
let skippedCrossTree = 0;
const changedFiles = [];
const samples = [];

for (const file of srcFiles()) {
  const before = readFileSync(file, 'utf8');
  let fileChanged = false;
  const after = before.replace(IMPORT_RE, (m, kw, q, spec) => {
    const alias = relativeToAlias(file, spec);
    if (!alias) { if (spec.startsWith('.')) skippedCrossTree++; return m; }
    rewritten++; fileChanged = true;
    if (samples.length < 10) samples.push(`${file.replace('src/', '')}:  ${spec}  ->  ${alias}`);
    return `${kw}${q}${alias}${q}`;
  });
  if (fileChanged) {
    changedFiles.push(file);
    if (write) writeFileSync(file, after);
  }
}

console.log(JSON.stringify({ mode: write ? 'WRITE' : 'dry-run', rewritten, skippedCrossTree, filesChanged: changedFiles.length }, null, 2));
console.log('\nsamples:');
for (const s of samples) console.log('  ' + s);
