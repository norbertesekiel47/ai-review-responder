import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Chrome convergence guard (spec §4, Phase 3 Task 9). `<AdminPage>` is owned by
 * the SERVER page on every migrated admin page, so the group/title/description
 * render in the RSC payload instead of behind the client's loading state — and
 * each page's chrome strings have exactly one owner.
 *
 * Written table-driven rather than as five near-identical
 * `<page>/__tests__/page-source.test.ts` files (the plan's letter): the
 * assertions are identical per page, so one list is the single place a sixth
 * page gets added.
 */
const CONVERGED_PAGES = [
  {
    page: 'src/app/admin/overview/page.tsx',
    client: 'src/app/admin/overview/OverviewClient.tsx',
    group: 'Operate',
    title: 'Overview',
  },
  {
    page: 'src/app/admin/jobs/page.tsx',
    client: 'src/app/admin/jobs/JobsClient.tsx',
    group: 'Operate',
    title: 'Jobs',
  },
  {
    page: 'src/app/admin/costs/page.tsx',
    client: 'src/app/admin/costs/CostsClient.tsx',
    group: 'Operate',
    title: 'Costs',
  },
  {
    page: 'src/app/admin/notifications/page.tsx',
    client: 'src/app/admin/notifications/NotificationsClient.tsx',
    group: 'Operate',
    title: 'Notifications',
  },
  {
    page: 'src/app/admin/flagged/page.tsx',
    client: 'src/app/admin/flagged/FlaggedClient.tsx',
    group: 'Safety',
    title: 'Flagged responses',
  },
];

describe('admin page chrome lives on the server page, not the client', () => {
  it.each(CONVERGED_PAGES)('$page owns <AdminPage group="$group" title="$title">', ({ page, group, title }) => {
    const source = readFileSync(page, 'utf8');

    expect(source).not.toContain("'use client'");
    expect(source).toContain('<AdminPage');
    expect(source).toContain(`group="${group}"`);
    expect(source).toContain(`title="${title}"`);
  });

  it.each(CONVERGED_PAGES)('$client no longer renders page chrome', ({ client }) => {
    const source = readFileSync(client, 'utf8');

    expect(source).toContain("'use client'");
    expect(source).not.toContain('AdminPage');
  });
});

describe('admin overview actions are static links, safe to render on the server', () => {
  it('keeps the three action links on the server page and none in the client', () => {
    const page = readFileSync('src/app/admin/overview/page.tsx', 'utf8');
    const client = readFileSync('src/app/admin/overview/OverviewClient.tsx', 'utf8');

    expect(page).toContain('href="/admin/demos"');
    expect(page).toContain('href="/admin/businesses"');
    expect(page).toContain('href="/admin/businesses/new"');
    expect(client).not.toContain('href="/admin/businesses/new"');
  });
});
