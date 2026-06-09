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
