// @vitest-environment jsdom
//
// `RestraintReport` — presentation eval (#1014 T8).
//
// Titles 37-47 and 49-54, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// THIS COMPONENT OWNS EVERY OWNER-FACING SENTENCE, which is why seventeen titles
// land on one file. Three groups carry a trap each:
//
//   * LINKS. The tab links exactly three things and drops the link — never the
//     row — when a subject no longer resolves. The `policy_gate_held` case came
//     from plan round 1: `held_draft` and `policy_gate_held`'s
//     `moderation_flagged` BOTH map to `unsafe_content` and BOTH carry a
//     response subject, so link authority keyed on the Refusal category hands a
//     policy-gate row a held draft's review link. Authority is the
//     server-resolved `linkKind` (I14), which is why the fixtures below set it
//     explicitly and never let it be inferred.
//
//   * CLAIMS. The empty window is window-scoped and makes no claim about all
//     time — #1000 retired the parked branch's absolute sentence permanently. A
//     populated window makes no such claim either, and that is a SEPARATE test
//     because the two sentences have different authors in the component.
//
//   * RECONCILIATION. An account-wide suspension appears under every location
//     once each and once in the account total, so a per-location sum may
//     legitimately exceed the account total. CONTEXT.md requires the tab to
//     state WHICH number it shows (deviation D3).
//
// TWO CARRY-FORWARD CORRECTIONS ARE LOAD-BEARING HERE. SC-2: the grouping case
// uses categories with SEVERAL rows each, because the parked fixture used groups
// of exactly one and could not distinguish per-category from per-entry. SC-5:
// the ordering case starts from UNSORTED input, because its real proof used to
// live in an integration suite that changed owner.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { RefusalCategory } from '@/lib/refusals/vocabulary';
import type { RefusalLogEntry } from '@/lib/refusals/read';

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: 'loc-1' }),
}));
vi.mock('@/components/dashboard/shell/TopBar', () => ({
  TopBar: ({ title, children }: { title: string; children?: ReactNode }) => (
    <>
      <h1>{title}</h1>
      {children}
    </>
  ),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { RestraintReport, type RestraintPayload } from '@/components/dashboard/restraint/RestraintReport';

const RESPONSE_ID = 'a1111111-1111-1111-1111-111111111111';
const WINDOW_START = '2026-08-02T00:00:00.000Z';
const WINDOW_END = '2026-09-01T00:00:00.000Z';

type EntrySeed = Partial<RefusalLogEntry> & { category: RefusalCategory };

let nextId = 0;

function entry(seed: EntrySeed): RefusalLogEntry {
  nextId += 1;
  return {
    id: `e${nextId}`,
    category: seed.category,
    occurredAt: seed.occurredAt ?? '2026-08-20T10:00:00.000Z',
    subjectType: seed.subjectType ?? null,
    subjectId: seed.subjectId ?? null,
    // NEVER defaulted from the category. Authority is per-LANE and the category
    // does not carry the lane — a fixture that inferred it here would make the
    // policy-gate case unwritable.
    linkKind: seed.linkKind ?? null,
  };
}

function logWith(
  seeds: EntrySeed[],
  overrides: Partial<RestraintPayload> = {},
): RestraintPayload {
  const entries = seeds.map(entry);
  return {
    total: entries.length,
    entries,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    coverageStart: '2026-05-04T00:00:00.000Z',
    archivedLocations: null,
    archivedPeriods: [],
    window: '30d',
    autoApprovalEnabled: true,
    ...overrides,
  };
}

function renderReport(
  log: RestraintPayload,
  scope: 'account' | 'location' = 'account',
) {
  return render(
    <RestraintReport log={log} scope={scope} tabs={null} periodToolbar={null} />,
  );
}

describe('RestraintReport', () => {
  // ── Grouping and ordering ──────────────────────────────────────────────

  it('RestraintReport groups rows under one owner sentence per category across categories with several rows each', () => {
    renderReport(logWith([
      { category: 'unsafe_content', occurredAt: '2026-08-30T10:00:00.000Z' },
      { category: 'unsafe_content', occurredAt: '2026-08-29T10:00:00.000Z' },
      { category: 'unsafe_content', occurredAt: '2026-08-28T10:00:00.000Z' },
      { category: 'wrong_moment', occurredAt: '2026-08-27T10:00:00.000Z' },
      { category: 'wrong_moment', occurredAt: '2026-08-26T10:00:00.000Z' },
    ]));

    // THREE rows in one category, ONE sentence. The parked fixture used groups
    // of one and could not tell per-category from per-entry apart.
    expect(screen.getAllByText('We held a reply back because it was not safe to send.')).toHaveLength(1);
    expect(screen.getAllByText('We waited because it was not the right moment.')).toHaveLength(1);
    // And the counts are per-group, so five rows are not five sentences.
    expect(screen.getByText('3 times')).toBeInTheDocument();
    expect(screen.getByText('2 times')).toBeInTheDocument();
    expect(screen.getAllByTestId('refusal-date')).toHaveLength(5);
  });

  it('RestraintReport orders rows newest first within a category given an unsorted input', () => {
    renderReport(logWith([
      { category: 'unsafe_content', occurredAt: '2026-08-26T10:00:00.000Z' },
      { category: 'unsafe_content', occurredAt: '2026-08-30T10:00:00.000Z' },
      { category: 'unsafe_content', occurredAt: '2026-08-28T10:00:00.000Z' },
    ]));

    const dates = screen.getAllByTestId('refusal-date').map((node) => node.textContent);
    expect(dates).toEqual(['30 Aug 2026', '28 Aug 2026', '26 Aug 2026']);
  });

  // ── The three links, and the two ways a row carries none ───────────────

  it('RestraintReport links a held draft to its review', () => {
    renderReport(logWith([{
      category: 'unsafe_content',
      subjectType: 'response',
      subjectId: RESPONSE_ID,
      linkKind: 'review',
    }]));

    expect(screen.getByRole('link', { name: 'See the review' }))
      .toHaveAttribute('href', `/dashboard/reviews/${RESPONSE_ID}`);
  });

  it('RestraintReport links an autonomy_paused row to the auto-approval settings', () => {
    renderReport(logWith([{ category: 'autonomy_paused', linkKind: 'auto-approval' }]));

    expect(screen.getByRole('link', { name: 'Automatic posting settings' }))
      .toHaveAttribute('href', '/settings/auto-approval');
  });

  it('RestraintReport links a no_permission row to the contacts list', () => {
    renderReport(logWith([{ category: 'no_permission', linkKind: 'contacts' }]));

    expect(screen.getByRole('link', { name: 'See your contacts' }))
      .toHaveAttribute('href', '/dashboard/contacts');
  });

  it('RestraintReport renders no link for a category that carries none', () => {
    renderReport(logWith([
      { category: 'below_our_bar', linkKind: null },
      // `owner_review_required` is the second latent case round 1 caught: the
      // ticket names exactly three links and this is not one of them.
      { category: 'owner_review_required', subjectType: 'response', subjectId: RESPONSE_ID, linkKind: null },
    ]));

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    // Non-vacuous: the rows themselves are on the page.
    expect(screen.getAllByTestId('refusal-date')).toHaveLength(2);
  });

  it('RestraintReport keeps the row and drops only the link when the subject no longer resolves', () => {
    renderReport(logWith([{
      category: 'unsafe_content',
      subjectType: 'response',
      // A non-null id whose subject aged away. The server resolved `linkKind` to
      // null; the category and `occurredAt` stay true.
      subjectId: RESPONSE_ID,
      linkKind: null,
      occurredAt: '2026-08-30T10:00:00.000Z',
    }]));

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByTestId('refusal-date')).toHaveTextContent('30 Aug 2026');
    expect(screen.getByText('We held a reply back because it was not safe to send.')).toBeInTheDocument();
  });

  it("RestraintReport does not link a policy_gate_held response that shares held_draft's unsafe_content category", () => {
    renderReport(logWith([
      // A held draft: same category, same subject type, and it DOES link.
      {
        category: 'unsafe_content',
        subjectType: 'response',
        subjectId: RESPONSE_ID,
        linkKind: 'review',
        occurredAt: '2026-08-30T10:00:00.000Z',
      },
      // A policy-gate hold: SAME category, SAME subject type, a real response id
      // — and no link, because the server resolved the LANE. A component that
      // keyed links off the category would link this to a draft the owner was
      // never asked to review, and every other test here would still pass.
      {
        category: 'unsafe_content',
        subjectType: 'response',
        subjectId: 'b2222222-2222-2222-2222-222222222222',
        linkKind: null,
        occurredAt: '2026-08-29T10:00:00.000Z',
      },
    ]));

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `/dashboard/reviews/${RESPONSE_ID}`);
    // Both rows are shown; only one of them links.
    expect(screen.getAllByTestId('refusal-date')).toHaveLength(2);
  });

  // ── Redaction (ADR 0023) ───────────────────────────────────────────────

  it('RestraintReport shows no draft text, review text or moderation reason for a held draft', () => {
    const { container } = renderReport(logWith([{
      category: 'unsafe_content',
      subjectType: 'response',
      subjectId: RESPONSE_ID,
      // REQUIRED. The component reads authority from `linkKind`, never from the
      // category — a fixture that omits it renders no link and the assertion
      // below fails for the wrong reason.
      linkKind: 'review',
    }]));

    // The DTO carries no prose to leak, and the component invents none.
    expect(container.textContent).not.toMatch(/reason|draft|moderat/i);
    expect(screen.getByRole('link')).toHaveAttribute('href', `/dashboard/reviews/${RESPONSE_ID}`);
  });

  // ── What the window does and does not claim ────────────────────────────

  it('RestraintReport renders the window-scoped empty sentence and makes no claim about all time', () => {
    const { container } = renderReport(logWith([]));

    expect(screen.getByText(
      'We did not hold anything back between 2 Aug 2026 and 1 Sept 2026.',
    )).toBeInTheDocument();
    // The parked sentence is retired PERMANENTLY (#1000): #1002's pre-ledger
    // tail and #996's 180-day floor leave holes the ledger never closes.
    expect(container.textContent).not.toContain('Everything we were asked to do, we did');
    // The phrases that would turn a window count into an ALL-TIME claim. Not a
    // bare /ever/ — "every location" is a legitimate word on this page, and a
    // regex that forbids it tests the assertion's spelling, not the copy.
    expect(container.textContent).not.toMatch(
      /all time|at any point|since you joined|we have never|nothing was ever|always/i,
    );
  });

  it('RestraintReport makes no claim about all time in a populated window', () => {
    const { container } = renderReport(logWith([
      { category: 'unsafe_content' },
      { category: 'wrong_moment' },
    ]));

    // The count is bounded by the same two dates the empty sentence names, so a
    // populated window is no more absolute than an empty one.
    expect(container.textContent).toContain('between 2 Aug 2026 and 1 Sept 2026');
    expect(container.textContent).not.toMatch(/all time|in total|ever held|since you joined/i);
  });

  // ── The policy-gate disclosure, which is flag-driven (Coverage start) ───

  it('RestraintReport renders the policy-gate disclosure line while auto-approval is disabled', () => {
    renderReport(logWith([{ category: 'unsafe_content' }], { autoApprovalEnabled: false }));

    // The lane writes ZERO rows while the flag is off — not few, zero — so one
    // account-wide Coverage start without this line would claim coverage the
    // ledger never had.
    expect(screen.getByText(/only recorded once automatic posting is switched on/))
      .toBeInTheDocument();
    // And the Coverage start it qualifies is on the page beside it.
    expect(screen.getByText('We have been watching since 4 May 2026.')).toBeInTheDocument();
  });

  it('RestraintReport omits the policy-gate disclosure line while auto-approval is enabled', () => {
    const { container } = renderReport(
      logWith([{ category: 'unsafe_content' }], { autoApprovalEnabled: true }),
    );

    expect(container.textContent).not.toContain('only recorded once automatic posting is switched on');
    // Non-vacuous: the other disclosure lines still render, so the assertion is
    // about this line and not about the block being absent.
    expect(screen.getByText('We have been watching since 4 May 2026.')).toBeInTheDocument();
  });

  // ── Archived locations and archived periods ────────────────────────────

  it('RestraintReport renders the archived-location footnote with no link and no instruction', () => {
    renderReport(logWith(
      [{ category: 'unsafe_content' }],
      { archivedLocations: { refusalCount: 4, locationCount: 2 } },
    ));

    const footnote = screen.getByText('4 more from 2 archived locations are not shown.');
    expect(footnote).toBeInTheDocument();
    // NO LINK AND NO INSTRUCTION (#1005): reactivation can be DENIED and
    // enqueues a Stripe increment, so a trust surface does not sell a billed,
    // refusable action to show a number.
    expect(footnote.querySelector('a')).toBeNull();
    expect(footnote.textContent).not.toMatch(/reactivat|restore|unarchive|click|to see/i);
  });

  it('RestraintReport omits the archived-location footnote when the count is zero', () => {
    const { container } = renderReport(logWith(
      [{ category: 'unsafe_content' }],
      // An archived location that held nobody. Zero is a number, and the line
      // that reports it would be noise.
      { archivedLocations: { refusalCount: 0, locationCount: 1 } },
    ));

    expect(container.textContent).not.toContain('are not shown');
  });

  it('RestraintReport renders one archived-period line per intersecting period in a location view', () => {
    renderReport(
      logWith([{ category: 'unsafe_content' }], {
        archivedLocations: null,
        archivedPeriods: [
          { archivedAt: '2026-08-05T00:00:00.000Z', reactivatedAt: '2026-08-12T00:00:00.000Z' },
          // Still archived at the end of the window.
          { archivedAt: '2026-08-25T00:00:00.000Z', reactivatedAt: null },
        ],
      }),
      'location',
    );

    // Without these a reactivated location reads flat-then-spike under a
    // Coverage start claiming we watched throughout.
    expect(screen.getByText(/archived from 5 Aug 2026 to 12 Aug 2026/)).toBeInTheDocument();
    expect(screen.getByText(/archived from 25 Aug 2026 to now/)).toBeInTheDocument();
  });

  // ── Which number this view shows (D3) ──────────────────────────────────

  it('RestraintReport states which number it shows when an account-wide suspension is in the window', () => {
    const suspension: EntrySeed = { category: 'autonomy_paused', linkKind: 'auto-approval' };

    const account = renderReport(logWith([suspension]), 'account');
    expect(screen.getByText(
      'This is your whole account. Pauses that affect every location are counted once here.',
    )).toBeInTheDocument();
    account.unmount();

    renderReport(logWith([suspension]), 'location');
    // The two numbers may legitimately DISAGREE — one suspension appears under
    // every location once each and once in the account total — so the tab says
    // which one this is rather than pretending they reconcile (D3).
    expect(screen.getByText(
      'This is one location. Pauses that affect every location are counted here and at each of your other locations.',
    )).toBeInTheDocument();
  });
});
