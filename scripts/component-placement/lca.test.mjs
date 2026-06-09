// scripts/component-placement/lca.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasFromPath, routeLeafOf, computeDestination, transitiveDestination, isPlacementIgnorable } from './lca.mjs';

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

// --- transitive resolution -------------------------------------------------

const A = 'src/components/dashboard/account-state/Banner.tsx';
const B = 'src/components/dashboard/DashboardContent.tsx';
const C = 'src/components/dashboard/Connect.tsx';
const D = 'src/components/admin/AdminThing.tsx';
const PAGE_DASH = 'src/app/(authenticated)/dashboard/page.tsx';
const PAGE_CONNECT = 'src/app/(authenticated)/connect/page.tsx';
const PAGE_ADMIN = 'src/app/admin/overview/page.tsx';
const HOOK = 'src/hooks/useThing.ts';
const A_TEST = 'src/components/dashboard/account-state/__tests__/Banner.test.tsx';
const make = (graph) => (f) => graph[f] || [];

test('isPlacementIgnorable flags test files only', () => {
  assert.equal(isPlacementIgnorable(A_TEST), true);
  assert.equal(isPlacementIgnorable('src/components/x/Foo.test.tsx'), true);
  assert.equal(isPlacementIgnorable(A), false);
});

test('transitive: A ← B ← page → co-locate to the page leaf', () => {
  const d = transitiveDestination(A, make({ [A]: [B], [B]: [PAGE_DASH] }), PAGES);
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/dashboard/_components' });
});

test('transitive: reached by two leaves in one area → area-level LCA', () => {
  const d = transitiveDestination(
    A, make({ [A]: [B, C], [B]: [PAGE_DASH], [C]: [PAGE_CONNECT] }), PAGES,
  );
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/_components' });
});

test('transitive: reached across areas → shared', () => {
  const d = transitiveDestination(
    A, make({ [A]: [B, D], [B]: [PAGE_DASH], [D]: [PAGE_ADMIN] }), PAGES,
  );
  assert.equal(d.tier, 'shared');
});

test('transitive: imported by a non-component (hook) → shared', () => {
  const d = transitiveDestination(A, make({ [A]: [HOOK] }), PAGES);
  assert.equal(d.tier, 'shared');
});

test('transitive: sticky-shared — A ← B, B ← hook → A shared', () => {
  const d = transitiveDestination(A, make({ [A]: [B], [B]: [HOOK] }), PAGES);
  assert.equal(d.tier, 'shared');
});

test('transitive: cycle A↔B with B ← page terminates and co-locates', () => {
  const d = transitiveDestination(A, make({ [A]: [B], [B]: [A, PAGE_DASH] }), PAGES);
  assert.deepEqual(d, { tier: 'co-locate', dir: 'src/app/(authenticated)/dashboard/_components' });
});

test('transitive: no non-test importers → shared (dead-code candidate)', () => {
  const d = transitiveDestination(A, make({ [A]: [A_TEST] }), PAGES);
  assert.equal(d.tier, 'shared');
  assert.match(d.reason, /dead-code/);
});
