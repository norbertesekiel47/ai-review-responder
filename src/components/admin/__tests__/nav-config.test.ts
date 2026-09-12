import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_NAV_GROUPS } from '../nav-config';

// Widened to string: ADMIN_NAV_GROUPS is `as const`, so `item.href` narrows to
// a union of literals and every comparison against a filesystem-derived path
// would be a type error rather than a test.
const NAV_HREFS: string[] = ADMIN_NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => item.href as string),
);

/**
 * Auth pages deliberately absent from breadcrumb navigation. Each needs a reason — this list
 * is the escape hatch, so an unexplained entry is the smell.
 */
const NON_NAV_PAGES: Record<string, string> = {
  '/admin/login': 'auth route, renders outside the shell (ADMIN_AUTH_ROUTES)',
  '/admin/forgot-password': 'auth route, renders outside the shell',
  '/admin/reset-password': 'auth route, renders outside the shell',
};

function adminPageRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${route}/${entry.name}`);
      } else if (entry.name === 'page.tsx') {
        routes.push(route);
      }
    }
  };
  walk(resolve(process.cwd(), 'src/app/admin'), '/admin');
  // Dynamic segments are detail views of a nav page, never nav entries.
  return routes.filter((route) => !route.includes('[')).sort();
}

describe('admin IA: nav ⇄ filesystem', () => {
  it('lists every non-auth admin page exactly once', () => {
    const unlisted = adminPageRoutes().filter(
      (route) => !NAV_HREFS.includes(route) && !(route in NON_NAV_PAGES),
    );
    expect(unlisted, 'admin pages missing from ADMIN_NAV_GROUPS').toEqual([]);
  });

  it('has no duplicate nav hrefs', () => {
    expect(NAV_HREFS).toHaveLength(new Set(NAV_HREFS).size);
  });

  it('points every nav href at a real page', () => {
    const routes = adminPageRoutes();
    const broken = NAV_HREFS.filter((href) => !routes.includes(href));
    expect(broken, 'nav hrefs with no page.tsx behind them').toEqual([]);
  });

  it('keeps the excluded-page list honest — every exclusion still exists', () => {
    const routes = adminPageRoutes();
    const stale = Object.keys(NON_NAV_PAGES).filter((route) => !routes.includes(route));
    expect(stale, 'NON_NAV_PAGES entries whose page was deleted').toEqual([]);
  });
});
