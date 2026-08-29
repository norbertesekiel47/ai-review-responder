// @vitest-environment jsdom
//
// The owner surface for #632 (Task 7): the "Reviews from your requests" section
// and the fetch that mounts it.
//
// Attribution is sentiment-blind, so a one-star match renders exactly like a
// five-star one — the section is evidence, not a scoreboard. The count is a
// shadow metric and the copy says so; the section is absent entirely when
// `SOLICITATION_SEND_ENABLED` is off. `RequestsClient` mounts it from its own
// scoped endpoint, independently of batch-build state.
//
// The runnable form follows `batch-report.test.tsx` and `requests-client.test.tsx`
// for render conventions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import type { AttributedReviewView } from '@/lib/solicitation/attribution';
import { AttributedReviews, type AttributedReviewsView } from '../AttributedReviews';

const scope = vi.hoisted(() => ({ current: 'loc-1' }));

// One case here mounts RequestsClient, whose TopBar carries the account menu
// (the only route to sign out on mobile). That needs a router; jsdom has none.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({
    currentScope: scope.current,
    locations: [],
    isMultiLocation: false,
    selectedLabel: 'Location 1',
    setLocationScope: () => {},
    setLocationScopeLabel: () => {},
    setLocations: () => {},
  }),
}));

import { RequestsClient } from '../RequestsClient';

// ── Fixtures ────────────────────────────────────────────────────────────────

function match(overrides: Partial<AttributedReviewView> = {}): AttributedReviewView {
  return {
    outreachId: 'a1b2c3d4-0000-7000-8000-000000000001',
    reviewId: 'b1b2c3d4-0000-7000-8000-000000000001',
    reviewerName: 'Dana Rodriguez',
    starRating: 5,
    reviewDate: '2026-07-21',
    askSentAt: '2026-07-14 09:30:00+00',
    attributedAt: '2026-07-21 10:00:00+00',
    rule: 'full_name',
    ...overrides,
  };
}

function ready(reviews: AttributedReviewView[]): AttributedReviewsView {
  return { kind: 'ready', enabled: true, reviews };
}

const section = () =>
  screen.getByRole('region', { name: /reviews from your requests/i });

// ── The section ─────────────────────────────────────────────────────────────

describe('AttributedReviews', () => {
  it('AttributedReviews: renders reviewer name, stars, review date and ask date for each match', () => {
    render(
      <AttributedReviews
        view={ready([
          match(),
          match({
            outreachId: 'a1b2c3d4-0000-7000-8000-000000000002',
            reviewId: 'b1b2c3d4-0000-7000-8000-000000000002',
            reviewerName: 'Sam Okafor',
            starRating: 4,
            reviewDate: '2026-07-19',
            askSentAt: '2026-07-10 08:00:00+00',
            rule: 'first_last_initial',
          }),
        ])}
      />,
    );

    const rows = within(section()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    expect(within(rows[0]!).getByText('Dana Rodriguez')).toBeInTheDocument();
    // The rating is spoken, never carried by the gold alone.
    expect(within(rows[0]!).getByRole('img', { name: '5 out of 5 stars' })).toBeInTheDocument();
    expect(rows[0]!.textContent).toContain('Reviewed Jul 21, 2026');
    expect(rows[0]!.textContent).toContain('asked Jul 14, 2026');

    expect(within(rows[1]!).getByText('Sam Okafor')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('img', { name: '4 out of 5 stars' })).toBeInTheDocument();
    expect(rows[1]!.textContent).toContain('Reviewed Jul 19, 2026');
    expect(rows[1]!.textContent).toContain('asked Jul 10, 2026');

    // The window is stated on the heading line, and it comes from the read
    // model's own constant rather than a re-spelling.
    expect(within(section()).getByText(/last 30 days/i)).toBeInTheDocument();
    // D2: the evidence envelope carries no personal data, so nothing beyond
    // what the read model joined for may appear — internal ids included.
    expect(section().textContent).not.toContain('a1b2c3d4');
    expect(section().textContent).not.toContain('full_name');
  });

  it('AttributedReviews: renders the shadow-metric never-billed disclosure', () => {
    render(<AttributedReviews view={ready([match()])} />);
    const text = section().textContent ?? '';

    // The two claims the disclosure has to make: it is a guess, and it is never
    // billed.
    expect(text).toMatch(/best guess/i);
    expect(text).toMatch(/never billed/i);
    expect(text).toMatch(/never changes what you pay/i);
    // …and the claims it may never make. A shadow metric is not revenue, not a
    // guarantee, and not something the owner is charged for.
    expect(text).not.toMatch(/revenue|earned you|guarantee|proven|roi/i);

    // Present in the empty state too — the caveat about how the number is made
    // is not conditional on there being a number.
    const { container } = render(<AttributedReviews view={ready([])} />);
    expect(container.textContent).toMatch(/never billed/i);
  });

  it('AttributedReviews: renders an empty state when no review is attributed', () => {
    render(<AttributedReviews view={ready([])} />);

    expect(within(section()).getByText(/nothing matched yet/i)).toBeInTheDocument();
    expect(within(section()).queryAllByRole('listitem')).toHaveLength(0);
    // "Nothing yet", never a failure: no alert, no error voice.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(section().textContent).not.toMatch(/error|failed|could not/i);
  });

  it('AttributedReviews: renders nothing when enabled is false', () => {
    const { container } = render(
      <AttributedReviews view={{ kind: 'ready', enabled: false, reviews: [] }} />,
    );

    // Invariant #13: the absence of the section IS how the browser learns the
    // send flag is off. Not a heading, not an empty state, not a hint.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/reviews from your requests/i)).toBeNull();
    expect(screen.queryByText(/nothing matched yet/i)).toBeNull();
  });

  it('AttributedReviews: renders one-star and five-star matches identically', () => {
    // Sentiment-blind by construction: the star run is the ONLY difference
    // between the two rows — no filtering, no separate group, no tone class.
    const one = render(
      <AttributedReviews view={ready([match({ starRating: 1 })])} />,
    );
    const oneRow = within(section()).getByRole('listitem');
    const oneHtml = oneRow.outerHTML;
    const oneStars = within(oneRow).getByRole('img');
    expect(oneStars).toHaveAccessibleName('1 out of 5 stars');
    one.unmount();

    const five = render(
      <AttributedReviews view={ready([match({ starRating: 5 })])} />,
    );
    const fiveRow = within(section()).getByRole('listitem');
    const fiveStars = within(fiveRow).getByRole('img');
    expect(fiveStars).toHaveAccessibleName('5 out of 5 stars');

    // Strip the rating itself from both markups; everything that remains —
    // classes, element order, copy — must be byte-identical.
    const strip = (html: string) =>
      html.replace(/\d out of 5 stars/, 'N out of 5 stars').replace(/★/g, '');
    expect(strip(fiveRow.outerHTML)).toBe(strip(oneHtml));
    five.unmount();
  });
});

// ── The mount ───────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

const NO_CONTENT = { status: 204, ok: true, json: async () => null } as Response;

/** A batch that is still building — so this suite proves the section mounts
 *  while the batch screen has no report to show at all. */
const BUILDING_BATCH = {
  state: 'building',
  batchId: 'batch-building',
  createdAt: '2026-07-25 11:59:00+00',
  contactsOnFile: 1240,
};

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  scope.current = 'loc-1';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RequestsClient', () => {
  it('RequestsClient: fetches the scoped attributed endpoint and mounts the section independently of batch-build state', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/solicitation/attributed')) {
        return Promise.resolve(
          jsonResponse(200, { enabled: true, attributed: [match()] }),
        );
      }
      if (String(url).includes('/batch/reviewed')) return Promise.resolve(NO_CONTENT);
      return Promise.resolve(jsonResponse(200, BUILDING_BATCH));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestsClient />);
    await flush();

    const attributedCalls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/solicitation/attributed'),
      );

    // Without ?scope= the server falls back to the owner's default location and
    // this section would silently describe a different one.
    expect(attributedCalls()).toHaveLength(1);
    expect(String(attributedCalls()[0]?.[0])).toBe(
      '/api/dashboard/solicitation/attributed?scope=loc-1',
    );

    // The batch is BUILDING — there is no report on screen — and the section is
    // rendered anyway: attribution spans batches, so it is a function of the
    // location, not of whichever batch happens to be latest.
    expect(screen.getByText(/building your batch/i)).toBeInTheDocument();
    expect(
      within(section()).getByText('Dana Rodriguez'),
    ).toBeInTheDocument();

    // …and it is NOT on the 2-second build poll: the batch keeps being read,
    // this endpoint is read once.
    const batchCallsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(batchCallsBefore);
    expect(attributedCalls()).toHaveLength(1);
  });
});
