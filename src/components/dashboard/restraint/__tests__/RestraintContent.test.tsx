// @vitest-environment jsdom
//
// The Refusal Log eval — Restraint tab and page (T0 red-first, T7 green).
//
// Titles are VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches them as fixed strings.
//
// THE SHAPE (plan §4, §6 T7). `RestraintReport` is pure presentation fed by ONE
// `RefusalLog` object, the way `BatchReport` is fed one `BatchView` — so the
// stated total and the category breakdown cannot disagree. Fetching, the window
// control and the scope live in `RestraintContent`. The ten tab cases therefore
// render the report directly with a hand-built log; the two page cases render
// the orchestrator with `useDashboardData` and `fetch` mocked.
//
// FOUR OF THESE ARE CONTRACT CASES, not cosmetics:
//   - the total/sum case is the reason the screen takes one object rather than
//     a count plus a list;
//   - the held-draft case asserts the ABSENCE of raw reason text — S1 is
//     deny-all RLS and redaction is the whole security story (plan §7 risk 1).
//     It feeds the entry a `reason` the read can never produce, so the case
//     fails the day someone widens the projection AND renders it;
//   - the link cases pin the closed link table: held draft → its review,
//     autonomy_paused → /settings/auto-approval, no_permission → the contacts
//     list, and NO link for wrong_moment, below_our_bar, missing_information.
//     The review link is keyed off the ENTRY's review_id, never its category
//     (D8) — `unsafe_content` is fed by S1 (has a review) and by S6
//     `moderation_high` (does not);
//   - the empty case is a plain sentence, never an error or an empty grid.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  REFUSAL_CATEGORIES,
  REFUSAL_CATEGORY_META,
  type RefusalCategory,
} from '@/lib/refusals/vocabulary';
import type {
  RefusalCategoryGroup,
  RefusalEntry,
  RefusalLog,
} from '@/lib/refusals/read';

const { scope, useDashboardDataMock } = vi.hoisted(() => ({
  scope: { current: 'all' as string },
  useDashboardDataMock: vi.fn(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => useDashboardDataMock(...args),
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: scope.current }),
}));
// The real TopBar reaches AccountMenu and the location picker, neither of which
// this surface is testing. It keeps its action slot so the period control — a
// child of the TopBar on every branch — still renders.
vi.mock('@/components/dashboard/shell/TopBar', () => ({
  TopBar: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import { RestraintContent } from '@/components/dashboard/restraint/RestraintContent';
import { RestraintReport } from '@/components/dashboard/restraint/RestraintReport';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** One entry. `source` and `reviewId` default to the shape a solicitation lane
 *  produces (no review); the cases that need a review name one explicitly. */
function entry(
  fields: { id: string; category: RefusalCategory; occurredAt: string } & Partial<RefusalEntry>,
): RefusalEntry {
  return { source: 'ask_withheld', reviewId: null, ...fields };
}

/** A group whose `count` IS its entry count, exactly as `groupEntries` builds it. */
function group(
  category: RefusalCategory,
  entries: RefusalEntry[],
): RefusalCategoryGroup {
  return { category, count: entries.length, entries };
}

/** A log whose `total` IS the sum of its group counts — the read's guarantee,
 *  restated here so a fixture can never assert something the read cannot produce. */
function logOf(groups: RefusalCategoryGroup[]): RefusalLog {
  return {
    total: groups.reduce((sum, g) => sum + g.count, 0),
    categories: groups,
  };
}

function textOf(container: HTMLElement, selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}

const ACTIVE_AGGREGATE = { scope: 'aggregate' };

function dashboardReady(data: unknown = ACTIVE_AGGREGATE) {
  useDashboardDataMock.mockReturnValue({
    data,
    error: null,
    loading: false,
    refresh: vi.fn(),
  });
}

/** Stubs `fetch` and records the URLs it was asked for, so the scope case can
 *  assert the request rather than an index into an untyped `mock.calls`. */
function stubRefusalFetch(body: unknown): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      urls.push(input);
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    }),
  );
  return { urls };
}

beforeEach(() => {
  scope.current = 'all';
  useDashboardDataMock.mockReset();
});

// ── The tab ─────────────────────────────────────────────────────────────────

describe('Restraint tab', () => {
  it('the Restraint tab renders one owner sentence per category', () => {
    // Every one of the seven, so a category added without a sentence fails here
    // rather than rendering a heading with nothing under it.
    const log = logOf(
      REFUSAL_CATEGORIES.map((category, index) =>
        group(category, [
          entry({ id: `e-${category}`, category, occurredAt: `2026-08-0${index + 1}T09:00:00.000Z` }),
        ]),
      ),
    );

    render(<RestraintReport log={log} period="30d" />);

    for (const category of REFUSAL_CATEGORIES) {
      expect(screen.getByText(REFUSAL_CATEGORY_META[category].label)).toBeInTheDocument();
      expect(screen.getByText(REFUSAL_CATEGORY_META[category].sentence)).toBeInTheDocument();
    }
  });

  it('the Restraint tab total equals the sum of its category counts', () => {
    const log = logOf([
      group('unsafe_content', [
        entry({ id: 'a1', category: 'unsafe_content', occurredAt: '2026-08-20T10:00:00.000Z' }),
        entry({ id: 'a2', category: 'unsafe_content', occurredAt: '2026-08-19T10:00:00.000Z' }),
      ]),
      group('no_permission', [
        entry({ id: 'b1', category: 'no_permission', occurredAt: '2026-08-18T10:00:00.000Z' }),
        entry({ id: 'b2', category: 'no_permission', occurredAt: '2026-08-17T10:00:00.000Z' }),
        entry({ id: 'b3', category: 'no_permission', occurredAt: '2026-08-16T10:00:00.000Z' }),
      ]),
      group('wrong_moment', [
        entry({ id: 'c1', category: 'wrong_moment', occurredAt: '2026-08-15T10:00:00.000Z' }),
      ]),
    ]);

    const { container } = render(<RestraintReport log={log} period="30d" />);

    const total = Number.parseInt(
      container.querySelector('.rst-summary-count')?.textContent ?? '',
      10,
    );
    const counts = textOf(container, '.rst-group-count').map((text) =>
      Number.parseInt(text, 10),
    );

    expect(counts).toEqual([2, 3, 1]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(total);
    expect(total).toBe(6);
  });

  it('the Restraint tab lists entries newest first within each category', () => {
    // The read hands them over `ORDER BY occurred_at DESC`; the screen maps and
    // must not re-sort. Two categories, so a global sort that ignored the group
    // boundary would show up too.
    const log = logOf([
      group('unsafe_content', [
        entry({ id: 'u1', category: 'unsafe_content', occurredAt: '2026-08-20T10:00:00.000Z' }),
        entry({ id: 'u2', category: 'unsafe_content', occurredAt: '2026-08-11T10:00:00.000Z' }),
        entry({ id: 'u3', category: 'unsafe_content', occurredAt: '2026-08-02T10:00:00.000Z' }),
      ]),
      group('wrong_moment', [
        entry({ id: 'w1', category: 'wrong_moment', occurredAt: '2026-08-18T10:00:00.000Z' }),
        entry({ id: 'w2', category: 'wrong_moment', occurredAt: '2026-08-04T10:00:00.000Z' }),
      ]),
    ]);

    const { container } = render(<RestraintReport log={log} period="30d" />);

    const stamps = [...container.querySelectorAll('.rst-row-when')].map((el) =>
      el.getAttribute('datetime'),
    );
    expect(stamps).toEqual([
      '2026-08-20T10:00:00.000Z',
      '2026-08-11T10:00:00.000Z',
      '2026-08-02T10:00:00.000Z',
      '2026-08-18T10:00:00.000Z',
      '2026-08-04T10:00:00.000Z',
    ]);
  });

  it('the Restraint tab renders no raw reason text for a held draft', () => {
    const MODERATION_PROSE = 'Draft insults the reviewer and names a staff member';
    const held = {
      ...entry({
        id: 'held-1',
        category: 'unsafe_content',
        occurredAt: '2026-08-20T10:00:00.000Z',
        source: 'held_draft',
        reviewId: 'rev-1',
      }),
      // The read never selects this column, so it can never arrive. Feeding it
      // in anyway is the point: the screen must have no slot that would render
      // it if a widened projection ever started sending one.
      reason: MODERATION_PROSE,
    } as RefusalEntry;

    const { container } = render(
      <RestraintReport log={logOf([group('unsafe_content', [held])])} period="30d" />,
    );

    expect(container.textContent).not.toContain(MODERATION_PROSE);
    expect(container.textContent).not.toContain('insults');
    // The owner still gets the category's own words, and nothing beyond them.
    expect(screen.getByText('We would not say that.')).toBeInTheDocument();
  });

  it('the Restraint tab links a held-draft entry to its review', () => {
    const log = logOf([
      group('unsafe_content', [
        entry({
          id: 'held-1',
          category: 'unsafe_content',
          occurredAt: '2026-08-20T10:00:00.000Z',
          source: 'held_draft',
          reviewId: 'rev-1',
        }),
        // Same category, fed by S6 `moderation_high`, which names no review —
        // so the link is keyed off the entry, never off the category (D8).
        entry({
          id: 'out-1',
          category: 'unsafe_content',
          occurredAt: '2026-08-19T10:00:00.000Z',
          source: 'outreach_withheld',
        }),
      ]),
    ]);

    const { container } = render(<RestraintReport log={log} period="30d" />);

    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/dashboard/reviews/rev-1/timeline');
    expect(links[0]).toHaveTextContent('See the review');
  });

  it('the Restraint tab links an autonomy-paused entry to auto-approval settings', () => {
    const log = logOf([
      group('autonomy_paused', [
        entry({
          id: 'sus-1',
          category: 'autonomy_paused',
          occurredAt: '2026-08-20T10:00:00.000Z',
          source: 'autonomy_suspended',
        }),
      ]),
    ]);

    const { container } = render(<RestraintReport log={log} period="30d" />);

    // ONE link for the category, not one per row: an `href` link is the same
    // page for every entry under that heading, which is what the vocabulary
    // says distinguishes it from the per-entry `review` kind.
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/settings/auto-approval');
    expect(links[0]).toHaveClass('rst-group-link');
  });

  it('the Restraint tab links a no-permission entry to the contacts list', () => {
    // Three entries, one link — see the autonomy-paused case above for why.
    const log = logOf([
      group('no_permission', [
        entry({ id: 'ask-1', category: 'no_permission', occurredAt: '2026-08-20T10:00:00.000Z' }),
        entry({ id: 'ask-2', category: 'no_permission', occurredAt: '2026-08-14T10:00:00.000Z' }),
        entry({ id: 'ask-3', category: 'no_permission', occurredAt: '2026-08-09T10:00:00.000Z' }),
      ]),
    ]);

    const { container } = render(<RestraintReport log={log} period="30d" />);

    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/dashboard/requests/contacts');
    expect(container.querySelectorAll('.rst-row')).toHaveLength(3);
  });

  it('the Restraint tab renders no link for wrong_moment, below_our_bar and missing_information entries', () => {
    // Each one carries a reviewId it has no business linking to: these three
    // categories are `link: null` in the vocabulary, and the category decides.
    const log = logOf([
      group('below_our_bar', [
        entry({
          id: 'bar-1',
          category: 'below_our_bar',
          occurredAt: '2026-08-20T10:00:00.000Z',
          reviewId: 'rev-9',
        }),
      ]),
      group('wrong_moment', [
        entry({
          id: 'mom-1',
          category: 'wrong_moment',
          occurredAt: '2026-08-19T10:00:00.000Z',
          reviewId: 'rev-8',
        }),
      ]),
      group('missing_information', [
        entry({
          id: 'inf-1',
          category: 'missing_information',
          occurredAt: '2026-08-18T10:00:00.000Z',
          reviewId: 'rev-7',
        }),
      ]),
    ]);

    const { container } = render(<RestraintReport log={log} period="30d" />);

    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelectorAll('.rst-row')).toHaveLength(3);
  });

  it('the Restraint tab offers the 7d 30d 90d and 12w windows', () => {
    dashboardReady();
    stubRefusalFetch({ window: '30d', total: 0, categories: [] });

    render(<RestraintContent />);

    for (const label of ['7 days', '30 days', '90 days', '12 weeks']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('the Restraint tab states the empty case as a sentence', () => {
    const { container } = render(
      <RestraintReport log={{ total: 0, categories: [] }} period="7d" />,
    );

    expect(
      screen.getByText(/We did not hold anything back in the last 7 days\./),
    ).toBeInTheDocument();
    // Not an error, and not an empty grid: no alert, no rows, no headings for
    // categories that held nobody.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.rst-row')).toHaveLength(0);
    expect(container.querySelectorAll('.rst-group')).toHaveLength(0);
  });
});

// ── The page ────────────────────────────────────────────────────────────────

describe('Restraint page', () => {
  it('the Restraint page requests the active aggregate or location scope', async () => {
    dashboardReady();
    const aggregate = stubRefusalFetch({ window: '30d', total: 0, categories: [] });

    const { unmount } = render(<RestraintContent />);
    expect(aggregate.urls).toEqual(['/api/dashboard/refusals?scope=all&window=30d']);
    unmount();

    scope.current = 'loc-1';
    dashboardReady({ business: { name: 'Biz' } });
    const location = stubRefusalFetch({ window: '30d', total: 0, categories: [] });

    render(<RestraintContent />);
    expect(location.urls).toEqual(['/api/dashboard/refusals?scope=loc-1&window=30d']);
  });

  it('the Restraint page renders SubscriptionUnavailableCard for a subscription without full access', () => {
    scope.current = 'loc-1';
    dashboardReady({ business: { name: 'Biz' }, subscriptionStatus: 'cancelled' });
    stubRefusalFetch({ window: '30d', total: 0, categories: [] });

    render(<RestraintContent />);

    expect(
      screen.getByText(/Your restraint log isn't available right now/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Back to dashboard/i)).toBeInTheDocument();
    // The gate replaces the whole surface, tab bar and period control included.
    expect(screen.queryByRole('button', { name: '30 days' })).not.toBeInTheDocument();
  });
});
