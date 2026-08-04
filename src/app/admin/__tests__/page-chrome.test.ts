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
 *
 * The client-side assertion matches `<AdminPage`, not the bare word: four
 * sibling admin clients already carry a `// server page ... requireAdminPage`
 * comment, so a bare-substring guard would fail the moment someone adds that
 * same correct comment to one of these five.
 */
const CONVERGED_PAGES = [
  {
    page: 'src/app/admin/overview/page.tsx',
    client: 'src/app/admin/overview/OverviewClient.tsx',
    component: 'OverviewClient',
    group: 'Operate',
    title: 'Overview',
    description: 'System health and every business at a glance',
  },
  {
    page: 'src/app/admin/jobs/page.tsx',
    client: 'src/app/admin/jobs/JobsClient.tsx',
    component: 'JobsClient',
    group: 'Operate',
    title: 'Jobs',
    description: 'Outbox, queue depth, and failed jobs',
  },
  {
    page: 'src/app/admin/costs/page.tsx',
    client: 'src/app/admin/costs/CostsClient.tsx',
    component: 'CostsClient',
    group: 'Operate',
    title: 'Costs',
    description: 'LLM + API spend and margin by account',
  },
  {
    page: 'src/app/admin/notifications/page.tsx',
    client: 'src/app/admin/notifications/NotificationsClient.tsx',
    component: 'NotificationsClient',
    group: 'Operate',
    title: 'Notifications',
    description: 'Delivery log across channels',
  },
  {
    page: 'src/app/admin/flagged/page.tsx',
    client: 'src/app/admin/flagged/FlaggedClient.tsx',
    component: 'FlaggedClient',
    group: 'Safety',
    title: 'Flagged responses',
    description: 'Held drafts awaiting your disposition',
  },
];

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe('admin page chrome lives on the server page, not the client', () => {
  it.each(CONVERGED_PAGES)(
    '$page owns exactly one <AdminPage group="$group" title="$title">',
    ({ page, group, title, description }) => {
      const source = readFileSync(page, 'utf8');

      expect(source).not.toContain("'use client'");
      // Exactly one: two render doubled chrome, which reads as a bug but throws
      // nothing, so no other check would catch it.
      expect(occurrences(source, '<AdminPage')).toBe(1);
      expect(occurrences(source, '</AdminPage>')).toBe(1);
      expect(source).toContain(`group="${group}"`);
      expect(source).toContain(`title="${title}"`);
      // `description` is the prop most easily dropped in this exact refactor —
      // nothing breaks and nothing looks obviously wrong without it.
      expect(source).toContain(`description="${description}"`);
    },
  );

  it.each(CONVERGED_PAGES)('$page renders $component inside its chrome', ({ page, component }) => {
    const source = readFileSync(page, 'utf8');
    const chrome = source.slice(source.indexOf('<AdminPage'), source.indexOf('</AdminPage>'));

    // Guards the sibling-instead-of-child mistake: a client rendered next to
    // AdminPage rather than within it silently loses the max-width and padding.
    expect(chrome).toContain(`<${component}`);
  });

  it.each(CONVERGED_PAGES)('$client no longer renders page chrome', ({ client }) => {
    const source = readFileSync(client, 'utf8');

    expect(source).toContain("'use client'");
    expect(source).not.toContain('<AdminPage');
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
