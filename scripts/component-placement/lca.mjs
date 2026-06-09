// scripts/component-placement/lca.mjs
import path from 'node:path';

const SRC = 'src/';

export function aliasFromPath(repoRelPath) {
  const noSrc = repoRelPath.startsWith(SRC) ? repoRelPath.slice(SRC.length) : repoRelPath;
  const noExt = noSrc.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
  return '@/' + noExt;
}

export function routeLeafOf(importerPath, pageDirs) {
  if (!importerPath.startsWith('src/app/')) return null;
  let dir = path.posix.dirname(importerPath);
  while (dir.startsWith('src/app')) {
    if (pageDirs.has(dir)) return dir;
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function commonDirPrefix(dirs) {
  const split = dirs.map((d) => d.split('/'));
  const first = split[0];
  let i = 0;
  for (; i < first.length; i++) {
    if (!split.every((s) => s[i] === first[i])) break;
  }
  return first.slice(0, i).join('/');
}

export function computeDestination(importers, pageDirs) {
  const nonApp = importers.filter((p) => !p.startsWith('src/app/'));
  if (nonApp.length > 0) return { tier: 'shared', reason: 'non-route importer(s)' };
  if (importers.length === 0) return { tier: 'shared', reason: 'no importers found' };
  const leaves = importers.map((p) => routeLeafOf(p, pageDirs));
  if (leaves.some((l) => l === null)) return { tier: 'shared', reason: 'importer not under a route leaf' };
  const lca = commonDirPrefix([...new Set(leaves)]);
  if (!/^src\/app\/[^/]+/.test(lca)) return { tier: 'shared', reason: 'consumers span multiple areas' };
  return { tier: 'co-locate', dir: lca + '/_components' };
}

// Test files never determine placement — they move WITH their component.
export function isPlacementIgnorable(p) {
  return p.includes('/__tests__/') || /\.test\.(tsx?|jsx?)$/.test(p);
}

// Transitive placement: a component's real consumers are the ROUTES that reach
// it, possibly through other components. Follow component→component import edges
// until a route leaf (co-locatable) or a non-route/non-component importer
// (forces "shared") is reached, then take the LCA of the route leaves.
//
// `getImporters(file)` returns the repo-relative files that import `file`.
// "shared" is sticky: if ANY importer cannot move (non-route/non-component) or
// resolves to shared, the component cannot co-locate either — otherwise that
// stuck importer would end up importing `@/app/**` and break the boundary rule.
export function transitiveDestination(file, getImporters, pageDirs) {
  const memo = new Map();
  const stack = new Set();

  function resolve(f) {
    if (memo.has(f)) return memo.get(f);
    if (stack.has(f)) return { leaves: [], shared: false, reason: null }; // cycle: contributes nothing
    stack.add(f);

    const importers = getImporters(f).filter((p) => p !== f && !isPlacementIgnorable(p));
    const leaves = [];
    let shared = false;
    let reason = null;

    if (importers.length === 0) {
      shared = true;
      reason = 'no non-test importers (dead-code or dynamic-import candidate)';
    }
    for (const imp of importers) {
      if (imp.startsWith('src/app/')) {
        const leaf = routeLeafOf(imp, pageDirs);
        if (leaf) leaves.push(leaf);
        else { shared = true; reason = reason || 'app importer not under a route leaf'; }
      } else if (imp.startsWith('src/components/')) {
        const sub = resolve(imp);
        leaves.push(...sub.leaves);
        if (sub.shared) { shared = true; reason = reason || sub.reason; }
      } else {
        shared = true; // hook/lib/context importer → cannot co-locate under a route
        reason = reason || 'imported by non-route, non-component code';
      }
    }

    stack.delete(f);
    const res = { leaves: [...new Set(leaves)], shared, reason };
    memo.set(f, res);
    return res;
  }

  const { leaves, shared, reason } = resolve(file);
  if (shared || leaves.length === 0) return { tier: 'shared', reason: reason || 'no route consumers' };
  const lca = commonDirPrefix(leaves);
  if (!/^src\/app\/[^/]+/.test(lca)) return { tier: 'shared', reason: 'consumers span multiple areas' };
  return { tier: 'co-locate', dir: lca + '/_components' };
}
