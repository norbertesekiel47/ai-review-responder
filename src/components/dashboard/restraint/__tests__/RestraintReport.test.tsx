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
const REVIEW_ID = 'c3333333-3333-3333-3333-333333333333';
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
    reviewId: seed.reviewId ?? null,
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
    truncated: false,
    window: '30d',
    scope: 'account',
    autoApprovalEnabled: true,
    ledgerRecording: true,
    ...overrides,
  };
}

function renderReport(
  log: RestraintPayload,
  scope: 'account' | 'location' = 'account',
) {
  // `scope` rides the PAYLOAD — the server decides it (S2). The parameter is
  // kept for readability at the call sites.
  return render(
    <RestraintReport log={{ ...log, scope }} tabs={null} periodToolbar={null} />,
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
    expect(dates).toEqual(['Aug 30, 2026', 'Aug 28, 2026', 'Aug 26, 2026']);
  });

  // ── The three links, and the two ways a row carries none ───────────────

  it('RestraintReport links a held draft to its review', () => {
    renderReport(logWith([{
      category: 'unsafe_content',
      subjectType: 'response',
      subjectId: RESPONSE_ID,
      reviewId: REVIEW_ID,
      linkKind: 'review',
    }]));

    // The REVIEW id on the route that exists — not the response id on one that
    // does not. Both halves of this href were wrong in the first cut.
    expect(screen.getByRole('link', { name: /See the review/ }))
      .toHaveAttribute('href', `/dashboard/reviews/${REVIEW_ID}/timeline`);
  });

  it('RestraintReport links an autonomy_paused row to the auto-approval settings', () => {
    renderReport(logWith([{ category: 'autonomy_paused', linkKind: 'auto-approval' }]));

    expect(screen.getByRole('link', { name: /Automatic posting settings/ }))
      .toHaveAttribute('href', '/settings/auto-approval');
  });

  it('RestraintReport links a no_permission row to the contacts list', () => {
    renderReport(logWith([{ category: 'no_permission', linkKind: 'contacts' }]));

    expect(screen.getByRole('link', { name: /See your contacts/ }))
      .toHaveAttribute('href', '/dashboard/requests/contacts');
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
    expect(screen.getByTestId('refusal-date')).toHaveTextContent('Aug 30, 2026');
    expect(screen.getByText('We held a reply back because it was not safe to send.')).toBeInTheDocument();
  });

  it("RestraintReport does not link a policy_gate_held response that shares held_draft's unsafe_content category", () => {
    renderReport(logWith([
      // A held draft: same category, same subject type, and it DOES link.
      {
        category: 'unsafe_content',
        subjectType: 'response',
        subjectId: RESPONSE_ID,
        reviewId: REVIEW_ID,
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
    expect(links[0]).toHaveAttribute('href', `/dashboard/reviews/${REVIEW_ID}/timeline`);
    // Both rows are shown; only one of them links.
    expect(screen.getAllByTestId('refusal-date')).toHaveLength(2);
  });

  // ── Redaction (ADR 0023) ───────────────────────────────────────────────

  it('RestraintReport shows no draft text, review text or moderation reason for a held draft', () => {
    const { container } = renderReport(logWith([{
      category: 'unsafe_content',
      subjectType: 'response',
      subjectId: RESPONSE_ID,
      reviewId: REVIEW_ID,
      // REQUIRED. The component reads authority from `linkKind`, never from the
      // category — a fixture that omits it renders no link and the assertion
      // below fails for the wrong reason.
      linkKind: 'review',
    }]));

    // SENTINELS, not English words. The first cut banned /reason|draft|moderat/i,
    // which could never catch a leak — the DTO has no prose field to leak — but
    // could redden on an innocent copy change. These strings are the shapes an
    // actual leak would carry.
    const leaked = [
      'hate speech directed at a named staff member',
      'moderation_high_severity',
      'all_refusal_codes',
      'refusalCode',
      'refusalSource',
      'held_draft',
    ];
    for (const sentinel of leaked) {
      expect(container.textContent, `rendered ${sentinel}`).not.toContain(sentinel);
    }

    // POSITIVE CLOSURE. A sentinel list is allow-by-omission: a field added to
    // the DTO later leaks straight past it. The row renders exactly two things
    // — the formatted date and, when it links, the label — so asserting the
    // WHOLE text is the only assertion that closes the set (red team F22).
    // The row's CHILDREN, not their concatenation. Equality over the joined
    // text also pinned the absence of any separator between the two elements,
    // so a bullet or a wrapper reddened it with no behaviour change — the shape
    // F21 was raised about (red team F33). This closes the set the same way and
    // says nothing about whitespace.
    expect(container.innerHTML).not.toContain(RESPONSE_ID);

    const row = container.querySelector('.rst-row');
    // BOTH, and dropping either is what broke this. `children` is an
    // HTMLCollection of ELEMENT children, so a leaked field rendered as a bare
    // JSX expression is a text node and never appears in it — the exact leak the
    // sentinel list misses walked straight past the children-only form (red team
    // F35). Normalising whitespace keeps the text assertion from pinning the
    // absence of a separator, which is the fragility that replaced it.
    expect([...(row?.children ?? [])].map((el) => [el.tagName, el.textContent]))
      .toEqual([['TIME', 'Aug 20, 2026'], ['A', 'See the review']]);
    // TEXT NODES, asserted separately rather than folded into one string. An
    // equality over the joined text would pin the absence of a separator
    // between the two elements all over again, which is the fragility F33 was
    // raised about. What closes the set without saying anything about
    // whitespace is this: every DIRECT text child of the row must be blank.
    const strayText = [...(row?.childNodes ?? [])]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('');
    expect(strayText.trim()).toBe('');
    expect(screen.getByRole('link', { name: /See the review/ }))
      .toHaveAttribute('href', `/dashboard/reviews/${REVIEW_ID}/timeline`);
  });

  // ── What the window does and does not claim ────────────────────────────

  it('RestraintReport renders the window-scoped empty sentence and makes no claim about all time', () => {
    const { container } = renderReport(logWith([]));

    expect(screen.getByText(
      'We did not hold anything back between Aug 2, 2026 and Sep 1, 2026.',
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
    expect(container.textContent).toContain('between Aug 2, 2026 and Sep 1, 2026');
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
    expect(screen.getByText('We have been watching since May 4, 2026.')).toBeInTheDocument();
  });

  it('RestraintReport omits the policy-gate disclosure line while auto-approval is enabled', () => {
    const { container } = renderReport(
      logWith([{ category: 'unsafe_content' }], { autoApprovalEnabled: true }),
    );

    expect(container.textContent).not.toContain('only recorded once automatic posting is switched on');
    // Non-vacuous: the other disclosure lines still render, so the assertion is
    // about this line and not about the block being absent.
    expect(screen.getByText('We have been watching since May 4, 2026.')).toBeInTheDocument();
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
    expect(screen.getByText(/archived from Aug 5, 2026 to Aug 12, 2026/)).toBeInTheDocument();
    // An OPEN period must not claim a reactivation that has not happened.
    expect(screen.getByText(/has been archived since Aug 25, 2026/)).toBeInTheDocument();
    // The CLAIM is that an open period never uses the closed-period wording.
    // The proxy this replaces searched the concatenated text of two sibling
    // paragraphs, so it passed the moment anything was inserted between them
    // (red team F21). Query the sentence itself instead.
    expect(screen.queryByText(/archived from Aug 25, 2026/)).toBeNull();
  });

  it('omits the coverage line entirely when the ledger has no start date for this view', () => {
    const { container } = renderReport(
      logWith([{ category: 'unsafe_content' }], { coverageStart: null }),
    );

    // `businesses.created_at` is nullable (migration 001). Three separate docs
    // call this branch load-bearing and no fixture exercised it. The tab OMITS
    // the line rather than naming a date it does not have.
    expect(container.textContent).not.toContain('We have been watching since');
    // Non-vacuous: the other disclosures still render.
    expect(container.textContent).toContain('This is your whole account');
    // OMISSION IS AN ABSENT ELEMENT, not merely absent text. `note()` decides
    // which lines are dropped, and returning an empty string instead of null
    // passed every case in this file — up to five blank paragraphs inside
    // `.rst-notes`, each carrying the margin, and every `key` colliding on ''
    // (red team F27).
    // The COUNT, not a per-node emptiness check. `not.toBe('')` is one
    // character wide — a note returning ' ' renders the same blank paragraph
    // and passes — and the loop is vacuous-safe only by fixture (red team F37).
    // One line survives here: the scope sentence. The ledger is recording, the
    // window is not truncated, auto-approval is on and nothing is archived, so
    // every other builder returns null — which is what makes this the case that
    // catches an omitted line rendering as a blank paragraph.
    expect(container.querySelectorAll('.rst-note')).toHaveLength(1);
  });

  it('says how many rows it is showing when the window holds more than the read returned', () => {
    renderReport(logWith([{ category: 'unsafe_content' }], { total: 431, truncated: true }));

    // The COUNT stays true and the LIST is what shortened, so the sentence says
    // exactly that rather than implying the total was capped too.
    expect(screen.getByText('Showing the 1 most recent of 431. The count above is the full window.'))
      .toBeInTheDocument();
    expect(screen.getByText('431')).toBeInTheDocument();
  });

  it('omits the truncation line when the window fits', () => {
    const { container } = renderReport(logWith([{ category: 'unsafe_content' }]));
    expect(container.textContent).not.toContain('Showing the');
  });

  it('says recording is paused when the ledger kill switch is off', () => {
    renderReport(logWith([], { ledgerRecording: false }));

    // Without this the tab prints a confident empty window while nothing is
    // being written — a false zero produced by an operator action.
    expect(screen.getByText(/Recording is paused for your account right now/))
      .toBeInTheDocument();
    expect(screen.getByText(/It is not a record that nothing happened/))
      .toBeInTheDocument();
  });

  it('omits the recording-paused line while the ledger is recording', () => {
    const { container } = renderReport(logWith([], { ledgerRecording: true }));
    expect(container.textContent).not.toContain('Recording is paused');
  });

  it('uses singular phrasing for a single Refusal', () => {
    renderReport(logWith([{ category: 'unsafe_content' }]));
    expect(screen.getByText(/thing we chose not to do/)).toBeInTheDocument();
    expect(screen.getByText('1 time')).toBeInTheDocument();
  });

  it('marks the scope line and the footnote with their own note modifiers', () => {
    // The refactor that collapsed three hand-written <p> elements into one
    // `.map` dropped `rst-note-scope` and `rst-note-footnote` silently: both
    // rule sets survived with no emitter, so the scope line lost its full
    // contrast and nothing failed (red team F18). Computed style is not
    // observable here, but the CLASS is — which is the assertion that keeps a
    // future refactor from dropping them again.
    const { container } = renderReport(logWith(
      [{ category: 'unsafe_content' }],
      { archivedLocations: { refusalCount: 3, locationCount: 2 } },
    ));

    const scope = container.querySelectorAll('.rst-note-scope');
    expect(scope).toHaveLength(1);
    expect(scope[0]?.textContent).toContain('This is your whole account');

    const footnote = container.querySelectorAll('.rst-note-footnote');
    expect(footnote).toHaveLength(1);
    expect(footnote[0]?.textContent).toBe('3 more from 2 archived locations are not shown.');

    // EXACTLY `rst-note` on a plain line. The existential form above passed
    // while every note shipped a `rst-note-null` class matching no rule, and
    // would pass again if a second line were marked 'scope' (red team F32).
    const plain = [...container.querySelectorAll('.rst-note')]
      .filter((p) => p.textContent?.startsWith('We have been watching since'));
    expect(plain).toHaveLength(1);
    expect(plain[0]?.className).toBe('rst-note');
  });

  it('renders every row shape as exactly its own two facts, and nothing else', () => {
    // ALL FOUR LINK KINDS, and the WHOLE shape of each row — tags, text and
    // every attribute name AND value. Each narrower form missed something real:
    // text nodes alone missed a leak wrapped in an element; tags without text
    // missed a leak INSIDE the <time> (red team F46); an attribute-name
    // allowlist missed a value smuggled through an allowed name (F49); and a
    // two-row fixture never rendered the contacts or auto-approval shapes (F47).
    // A row shows the date and, when it links, the label. That is the contract.
    const { container } = renderReport(logWith([
      { category: 'unsafe_content', subjectType: 'response', subjectId: RESPONSE_ID, reviewId: REVIEW_ID, linkKind: 'review' },
      { category: 'autonomy_paused', subjectType: 'response', subjectId: RESPONSE_ID, linkKind: 'auto-approval' },
      { category: 'no_permission', subjectType: 'solicitation_ask', subjectId: RESPONSE_ID, linkKind: 'contacts' },
      { category: 'below_our_bar', subjectType: 'response', subjectId: RESPONSE_ID, linkKind: null },
    ]));

    const attrs = (el: Element) =>
      Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
    const shape = (li: Element) => ({
      attrs: attrs(li),
      strayText: [...li.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim(),
      children: [...li.children].map((el) => ({
        tag: el.tagName,
        text: el.textContent,
        attrs: attrs(el),
      })),
    });

    const when = {
      class: 'rst-row-when',
      datetime: '2026-08-20T10:00:00.000Z',
      'data-testid': 'refusal-date',
    };
    const timeChild = { tag: 'TIME', text: 'Aug 20, 2026', attrs: when };
    const link = (label: string, href: string) => ({
      tag: 'A',
      text: label,
      attrs: {
        class: 'rst-row-link',
        href,
        'aria-label': `${label} — Aug 20, 2026`,
      },
    });

    // Rows appear in CATEGORY order, not seed order — the groups are ordered by
    // the vocabulary, safety-bearing first.
    // AND the descendant scan, which the whole-shape map does not subsume: that
    // map reads the row and its DIRECT children, so an empty element nested
    // INSIDE the <time> carrying an attribute survives it (red team F50). The
    // previous commit deleted this loop when it introduced the map — replacing
    // coverage rather than adding to it — and it is the branch's only
    // descendant-wide DOM scan.
    const allowed = new Set(['class', 'datetime', 'data-testid', 'href', 'aria-label']);
    for (const anyRow of container.querySelectorAll('.rst-row')) {
      for (const descendant of anyRow.querySelectorAll('*')) {
        for (const attribute of descendant.attributes) {
          expect(allowed, `unexpected attribute ${attribute.name}`).toContain(attribute.name);
        }
      }
    }

    expect([...container.querySelectorAll('.rst-row')].map(shape)).toEqual([
      {
        attrs: { class: 'rst-row' },
        strayText: '',
        children: [timeChild, link('See the review', `/dashboard/reviews/${REVIEW_ID}/timeline`)],
      },
      // below_our_bar: no link, so a time alone. The shape a leak hid behind.
      { attrs: { class: 'rst-row' }, strayText: '', children: [timeChild] },
      {
        attrs: { class: 'rst-row' },
        strayText: '',
        children: [timeChild, link('See your contacts', '/dashboard/requests/contacts')],
      },
      {
        attrs: { class: 'rst-row' },
        strayText: '',
        children: [timeChild, link('Automatic posting settings', '/settings/auto-approval')],
      },
    ]);
  });

  it('gives every category its own owner-facing heading', () => {
    // ALL EIGHT. The outline case reads the two headings its fixture renders,
    // so swapping any of the other six survived (red team F48). These strings
    // are what the owner is told a Refusal WAS, so a swap misreports the
    // decision rather than merely looking untidy.
    const { container } = renderReport(logWith([
      { category: 'unsafe_content' },
      { category: 'watchdog_unavailable' },
      { category: 'below_our_bar' },
      { category: 'no_permission' },
      { category: 'wrong_moment' },
      { category: 'autonomy_paused' },
      { category: 'missing_information' },
      { category: 'owner_review_required' },
    ]));

    expect([...container.querySelectorAll('.rst-group-title')].map((h) => h.textContent))
      .toEqual([
        'Not safe to send',
        'Could not be checked',
        'Not good enough',
        'No permission to contact',
        'Not the right moment',
        'Acting on your behalf paused',
        'Missing information',
        'Sent to you for review',
      ]);
  });

  it('gives every category its own owner-facing sentence', () => {
    // The SENTENCES, the fuller half of what the owner is told a Refusal was.
    // Six of the eight were read by no test and swapping two survived the whole
    // suite (red team F51) — the same shape as the headings, one record above
    // them in the same file.
    const { container } = renderReport(logWith([
      { category: 'unsafe_content' },
      { category: 'watchdog_unavailable' },
      { category: 'below_our_bar' },
      { category: 'no_permission' },
      { category: 'wrong_moment' },
      { category: 'autonomy_paused' },
      { category: 'missing_information' },
      { category: 'owner_review_required' },
    ]));

    expect([...container.querySelectorAll('.rst-group-sentence')].map((p) => p.textContent))
      .toEqual([
        'We held a reply back because it was not safe to send.',
        'We did not post because our reviewer was unavailable.',
        'We did not send a message that was not good enough.',
        'We did not contact someone who had not agreed to hear from us.',
        'We waited because it was not the right moment.',
        'We stopped acting on your behalf.',
        'We stopped because we did not have what we needed.',
        'We sent a reply to you for review instead of posting it.',
      ]);
  });

  it('exposes the summary as a named region landmark', () => {
    renderReport(logWith([{ category: 'unsafe_content' }]));

    // A bare <section> is exposed as a `region` ONLY when it has an accessible
    // name, so deleting the `aria-labelledby` removes a landmark outright — and
    // both mutation forms survived the whole suite, because nothing queried by
    // role (red team F29).
    expect(screen.getByRole('region', { name: 'What we held back' })).toBeInTheDocument();
  });

  it('exposes every category section as a named region landmark too', () => {
    renderReport(logWith([
      { category: 'unsafe_content' },
      { category: 'no_permission', linkKind: 'contacts' },
    ]));

    // The same rule applies one level down, and `CategorySection`'s own
    // `aria-labelledby` could be deleted with all cases green (red team F38).
    // NAMES, not a count: collapsing `headingId` to a constant left every
    // landmark reading the same and duplicated the DOM ids, with the count
    // assertion green (red team F41).
    const names = screen.getAllByRole('region').map((el) => el.getAttribute('aria-label')
      ?? el.getAttribute('aria-labelledby'));
    expect(new Set(names).size).toBe(3);
    expect(screen.getByRole('region', { name: 'What we held back' })).toBeInTheDocument();
    // Each category section is named by its own heading, so the two groups are
    // distinguishable to a screen reader rather than three identical regions.
    // THE STRINGS, not merely their distinctness. Swapping two CATEGORY_HEADING
    // values keeps them distinct and no restraint test read one (red team F45),
    // so the owner could be told a held draft was "No permission to contact".
    // The summary's own heading leads the list, so this pins the whole level-2
    // outline in document order — one more thing a swap would disturb.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent))
      .toEqual(['What we held back', 'Not safe to send', 'No permission to contact']);
  });

  it('uses singular phrasing for a single archived location', () => {
    // The other two singular arms were covered; this one was not, and no
    // fixture could even REACH it — `archivedFootnote` returns null when
    // `refusalCount` is 0, and the only `locationCount: 1` fixture had a zero
    // count (red team F9). A non-zero count is what executes the branch.
    renderReport(logWith(
      [{ category: 'unsafe_content' }],
      { archivedLocations: { refusalCount: 3, locationCount: 1 } },
    ));

    expect(screen.getByText('3 more from 1 archived location are not shown.'))
      .toBeInTheDocument();
  });

  it('gives each repeated row link an accessible name that names its own row', () => {
    renderReport(logWith([
      { category: 'no_permission', linkKind: 'contacts', occurredAt: '2026-08-25T10:00:00.000Z' },
      { category: 'no_permission', linkKind: 'contacts', occurredAt: '2026-08-24T10:00:00.000Z' },
    ]));

    // The visible label repeats down the group; the ACCESSIBLE name must not, or
    // a screen-reader user hears the same phrase twice with nothing to tell the
    // rows apart.
    const names = screen.getAllByRole('link').map((el) => el.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('See your contacts — Aug 25, 2026');
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
      'This is one location. A pause that affects the whole account is counted here, and again under every other location you have.',
    )).toBeInTheDocument();
    // NOT "at each of your other locations" — a single-location account has
    // none, and the copy would describe a fleet the owner does not have.
    expect(screen.queryByText(/at each of your other locations/)).toBeNull();
  });
});
