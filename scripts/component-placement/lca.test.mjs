// scripts/component-placement/lca.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasFromPath, routeLeafOf, computeDestination } from './lca.mjs';

test('aliasFromPath strips src/ and extension', () => {
  assert.equal(aliasFromPath('src/components/dashboard/kpi/Kpi.tsx'), '@/components/dashboard/kpi/Kpi');
  assert.equal(aliasFromPath('src/components/dashboard/kpi/index.tsx'), '@/components/dashboard/kpi');
});

const PAGES = new Set([
  'src/app/(authenticated)/dashboard',
  'src/app/(authenticated)/dashboard/settings',
  'src/app/(authenticated)/connect',
  'src/app/admin/overview',
]);

test('routeLeafOf finds nearest ancestor page dir', () => {
  assert.equal(
    routeLeafOf('src/app/(authenticated)/dashboard/settings/SettingsForm.tsx', PAGES),
    'src/app/(authenticated)/dashboard/settings',
  );
  assert.equal(routeLeafOf('src/components/dashboard/kpi/Kpi.tsx', PAGES), null);
});

test('computeDestination: single route leaf → that leaf _components', () => {
  const d = computeDestination(['src/app/(authenticated)/dashboard/settings/page.tsx'], PAGES);
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/dashboard/settings/_components' });
});

test('computeDestination: two leaves sharing a subtree → that subtree LCA (not area root)', () => {
  const d = computeDestination(
    ['src/app/(authenticated)/dashboard/page.tsx', 'src/app/(authenticated)/dashboard/settings/page.tsx'],
    PAGES,
  );
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/dashboard/_components' });
});

test('computeDestination: leaves in different subtrees of one area → area-level LCA', () => {
  const d = computeDestination(
    ['src/app/(authenticated)/dashboard/page.tsx', 'src/app/(authenticated)/connect/page.tsx'],
    PAGES,
  );
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/_components' });
});

test('computeDestination: spans areas → shared', () => {
  const d = computeDestination(
    ['src/app/(authenticated)/dashboard/page.tsx', 'src/app/admin/overview/page.tsx'],
    PAGES,
  );
  assert.equal(d.tier, 'shared');
});

test('computeDestination: a non-route importer → shared', () => {
  const d = computeDestination(['src/components/dashboard/shell/Shell.tsx'], PAGES);
  assert.equal(d.tier, 'shared');
});
