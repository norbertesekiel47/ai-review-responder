// @vitest-environment jsdom
//
// `RestraintContent` — orchestrator eval (#1014 T7).
//
// Titles 32-36 and 48, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// TWO CARRY-FORWARD FINDINGS SHAPE THIS FILE. ST-1 is that the parked branch
// hand-rolled request keying, staleness, abort and derived loading across ~50
// lines, so the first title pins `useQuery` and forbids the hand-rolled parts.
// ST-2 is that the Analytics tab bar vanished during load and error on one route
// and persisted on the other, so two titles pin the bar through BOTH branches —
// the fix lives in the shared state panel (T6), and these are what stop it being
// re-implemented locally.
//
// The error-card title came from plan round 1 and is not padding: the shared
// panel used to gate `showError` on `hasData`, so a FIRST-load failure rendered
// a skeleton that never resolved. It is the only promised proof of that fix.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';

// MUTABLE, via `vi.hoisted` so the hoisted factory can read it. A constant mock
// made the whole SCOPE dimension unobservable: the query key could drop
// `currentScope` and the URL could hardcode `scope=all`, both with the suite
// green, while the location switcher went inert (red team F39).
const scopeState = vi.hoisted(() => ({ current: 'all' as string }));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: scopeState.current }),
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

import { RestraintContent } from '@/components/dashboard/restraint/RestraintContent';

const PAYLOAD = {
  total: 1,
  entries: [{
    id: 'e1',
    category: 'unsafe_content',
    occurredAt: '2026-08-20T10:00:00.000Z',
    subjectType: 'response',
    subjectId: 'a1111111-1111-1111-1111-111111111111',
    reviewId: 'c3333333-3333-3333-3333-333333333333',
    linkKind: 'review',
  }],
  windowStart: '2026-08-02T00:00:00.000Z',
  windowEnd: '2026-09-01T00:00:00.000Z',
  coverageStart: '2026-05-04T00:00:00.000Z',
  archivedLocations: { refusalCount: 0, locationCount: 0 },
  archivedPeriods: [],
  archivedPeriodsTruncated: false,
  truncated: false,
  window: '30d',
  scope: 'account',
  autoApprovalEnabled: true,
  ledgerRecording: true,
};

/**
 * A fresh client per render, with retries OFF. A retrying client turns the two
 * error cases into a timeout rather than an assertion.
 */
function renderContent() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // A FRESH element each time: React bails out of a re-render given the
  // identical element reference, and the scope change has to reach the hook.
  const tree = () => (
    <QueryClientProvider client={client}>
      <RestraintContent />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, rerenderTree: () => view.rerender(tree()) };
}

/** A fetch that never settles — the genuine pending state, not a fast success. */
function pendingFetch() {
  return vi.fn(() => new Promise<Response>(() => {}));
}

function jsonFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  }) as unknown as Response);
}

beforeEach(() => {
  scopeState.current = 'all';
  vi.stubGlobal('fetch', jsonFetch(PAYLOAD));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RestraintPage', () => {
  it('mounts the orchestrator and nothing else', async () => {
    // The thinnest hunk on the branch had no covering test in any project. It is
    // one line of behaviour, but it is the line that decides whether the route
    // renders at all.
    const { default: RestraintPage, dynamic } = await import(
      '@/app/(authenticated)/dashboard/analytics/restraint/page'
    );

    // `force-dynamic` because the payload is per-owner and per-window; a cached
    // render would serve one owner's restraint record to another.
    expect(dynamic).toBe('force-dynamic');

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    vi.stubGlobal('fetch', jsonFetch(PAYLOAD));
    render(
      <QueryClientProvider client={client}>
        <RestraintPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('What we held back')).toBeInTheDocument();
  });
});

describe('RestraintContent', () => {
  it('RestraintContent fetches through useQuery and hand-rolls no keying, staleness or abort', () => {
    const source = readFileSync(
      resolve(__dirname, '../RestraintContent.tsx'),
      'utf8',
    );

    // Structural, not a line count: the claim is that the hand-rolled machinery
    // is GONE, and a line count would pass while it hid in a helper.
    // The CLAIM is that the hand-rolled machinery is gone, so the pins are the
    // three constructs that would implement it. The first cut also pinned the
    // exact query-key string and the exact `({ signal })` spelling, which
    // couples this test to incidental formatting rather than to the claim — a
    // rename of the key or a destructure on the next line would redden it while
    // the component still fetched through useQuery.
    expect(source).toContain('useQuery');
    expect(source).toMatch(/queryKey:\s*\['dashboard-refusals'/);
  });

  it('RestraintContent issues one fetch per mount and takes its abort signal from the library', async () => {
    // BEHAVIOURAL, replacing three source-text absence pins. Those reddened on
    // a comment that merely named one of the words and passed if the machinery
    // moved into an imported helper — the one escape their own comment claimed
    // to exclude (red team F23). What is observable is the contract: exactly one
    // request per key, carrying a signal the component did not construct.
    const signals: (AbortSignal | null)[] = [];
    // A request that never settles, so the signal is still IN FLIGHT at unmount.
    // A resolved query has nothing left to cancel, which is why asserting the
    // abort after a successful render proves nothing.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? null);
      return new Promise<Response>(() => {});
    }));

    const { unmount } = renderContent();
    await screen.findByText('Loading what we held back…');

    // One key, one request. A hand-rolled effect is what produces the second.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    // THE ASSERTION THAT DISTINGUISHES THE TWO WORLDS. `toBeInstanceOf(AbortSignal)`
    // is true of ANY signal, including one the component minted itself, so the
    // first cut of this case could not fail for the reason it claimed — the very
    // defect shape it replaced (red team F28). Only a signal React Query OWNS is
    // aborted when the observer goes away; `gcTime: 0` makes that removal
    // immediate.
    unmount();
    await waitFor(() => {
      expect(signals[0]?.aborted).toBe(true);
    });
  });

  it('re-fetches when the window changes, so the query key carries its inputs', async () => {
    // ONE REQUEST PER KEY, which the case above claims in a comment and does
    // not test — it only ever mounts once. Collapsing the key to a constant
    // left all 28 cases green while making the period toolbar and the location
    // switcher inert: the owner picks 90 days and reads the 30-day answer, with
    // no error and no spinner (red team F36).
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => PAYLOAD } as unknown as Response;
    }));

    renderContent();
    await screen.findByText('What we held back');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('window=30d');

    await userEvent.click(screen.getByRole('button', { name: '90 days' }));

    await waitFor(() => {
      expect(urls).toHaveLength(2);
    });
    expect(urls[1]).toContain('window=90d');
    expect(urls[1]).toContain('scope=all');
  });

  it('re-fetches when the location scope changes, not only the window', async () => {
    // THE OTHER HALF OF THE KEY. The window control was pinned and the scope
    // one was not, because the context mock was a constant — so dropping
    // `currentScope` from the key, or hardcoding the `scope` parameter, both
    // passed (red team F39).
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => PAYLOAD } as unknown as Response;
    }));

    const { rerenderTree } = renderContent();
    await screen.findByText('What we held back');
    expect(urls[0]).toContain('scope=all');

    scopeState.current = 'b1111111-1111-1111-1111-111111111111';
    rerenderTree();

    await waitFor(() => {
      expect(urls).toHaveLength(2);
    });
    expect(urls[1]).toContain('scope=b1111111-1111-1111-1111-111111111111');
    expect(urls[1]).toContain('window=30d');

    // A SECOND location, because account-vs-location is not the whole key. A
    // component that answered "am I aggregate?" and stopped would collapse every
    // location onto one cache key, so switching between two locations would show
    // the first one's answer (red team F43).
    scopeState.current = 'b2222222-2222-2222-2222-222222222222';
    rerenderTree();

    await waitFor(() => {
      expect(urls).toHaveLength(3);
    });
    expect(urls[2]).toContain('scope=b2222222-2222-2222-2222-222222222222');
  });

  it('RestraintContent renders the shared dashboard state panel while loading', async () => {
    vi.stubGlobal('fetch', pendingFetch());
    renderContent();

    // The scaffold's own copy, so this is the SHARED panel and not a local
    // re-implementation of one.
    expect(await screen.findByText('Loading what we held back…')).toBeInTheDocument();
  });

  it('RestraintContent renders the shared dashboard state panel on error', async () => {
    vi.stubGlobal('fetch', jsonFetch({ error: 'Failed to fetch refusals' }, false, 500));
    renderContent();

    expect(await screen.findByText('Unable to load your restraint record')).toBeInTheDocument();
    // The server's message reaches the owner rather than being swallowed.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch refusals');
    });
  });

  it('RestraintContent explains a failure in its own words when the server sends no message', async () => {
    // The 500 case above stubs a body carrying an `error` string, so
    // `errorMessageOf` takes the body arm every time and the fallback copy was
    // rendered by no test at all (red team F25). An empty body is what reaches
    // it — and the copy must NOT repeat the panel's own heading, which is the
    // defect it was written to fix.
    vi.stubGlobal('fetch', jsonFetch({}, false, 500));
    renderContent();

    expect(await screen.findByText('Unable to load your restraint record')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'We could not reach your restraint record just now. Try again in a moment.',
      );
    });
  });

  it('RestraintContent keeps the Analytics tab bar visible while loading', async () => {
    vi.stubGlobal('fetch', pendingFetch());
    renderContent();

    expect(await screen.findByRole('navigation', { name: 'Analytics views' })).toBeInTheDocument();
    // …and it is the RESTRAINT tab that is current, not Metrics.
    expect(screen.getByRole('link', { name: 'Restraint' })).toHaveAttribute('aria-current', 'page');
  });

  it('RestraintContent keeps the Analytics tab bar visible on error', async () => {
    vi.stubGlobal('fetch', jsonFetch({ error: 'boom' }, false, 500));
    renderContent();

    expect(await screen.findByRole('navigation', { name: 'Analytics views' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Restraint' })).toHaveAttribute('aria-current', 'page');
  });

  it('renders the report on the success path with the scope the server sent', async () => {
    renderContent();

    // EVERY other case in this file returns at the state panel, so the success
    // branch — and the payload `scope` that picks the D3 sentence — was never
    // rendered at all. A mutation there survived the whole suite.
    expect(await screen.findByText('What we held back')).toBeInTheDocument();
    expect(screen.getByText(
      'This is your whole account. Pauses that affect every location are counted once here.',
    )).toBeInTheDocument();
  });

  it('takes scope from the payload, not from its own location context', async () => {
    // `useLocationScope` is mocked to 'all' at the top of this file, so a
    // component that answered this question from client state would say
    // "your whole account". The server said 'location'.
    vi.stubGlobal('fetch', jsonFetch({ ...PAYLOAD, scope: 'location' }));
    renderContent();

    expect(await screen.findByText(
      'This is one location. A pause that affects the whole account is counted here, and again under every other location you have.',
    )).toBeInTheDocument();
  });

  // EVERY top-level field, not one. The single-field version dropped
  // `ledgerRecording`, the LAST conjunct in the chain, so every conjunct before
  // it was decoration as far as the oracle was concerned — three sampled
  // deletions survived the whole suite (red team F26). The claim the old
  // comment made was general; the assertion was not.
  it.each(Object.keys(PAYLOAD))(
    'rejects a payload missing %s rather than rendering a partial record',
    async (field) => {
      const incomplete: Record<string, unknown> = { ...PAYLOAD };
      delete incomplete[field];
      vi.stubGlobal('fetch', jsonFetch(incomplete));
      renderContent();

      expect(await screen.findByText('Unable to load your restraint record')).toBeInTheDocument();
      // THE MESSAGE, not just the card. The heading renders for ANY error, so a
      // guard that threw a raw TypeError instead of REJECTING passed all 32
      // sweep rows (red team F44). The sentence is what says we rejected it.
      await waitFor(() => {
        expect(screen.getByRole('alert'))
          .toHaveTextContent('Your restraint record came back incomplete');
      });
    },
  );

  it('rejects a malformed archival truncation field', async () => {
    vi.stubGlobal('fetch', jsonFetch({ ...PAYLOAD, archivedPeriodsTruncated: 'yes' }));
    renderContent();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your restraint record came back incomplete');
  });

  // The nested guards the top-level sweep cannot reach: a field of the right
  // NAME and the wrong TYPE, one per sub-guard.
  it.each([
    ['entry.reviewId', { ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], reviewId: 7 }] }],
    ['entry.linkKind', { ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], linkKind: 'elsewhere' }] }],
    ['archivedPeriods[].reactivatedAt', { ...PAYLOAD, archivedPeriods: [{ archivedAt: '2026-08-05T00:00:00.000Z', reactivatedAt: 7 }] }],
    ['archivedLocations.refusalCount', { ...PAYLOAD, archivedLocations: { refusalCount: 'many', locationCount: 0 } }],
    ['truncated', { ...PAYLOAD, truncated: 'no' }],
    ['entry.id', { ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], id: 7 }] }],
    ['entry.category', { ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], category: 'not_a_category' }] }],
    ['entry.occurredAt', { ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], occurredAt: 7 }] }],
    ['entry.subjectType', { ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], subjectType: 7 }] }],
    ['entry.subjectId', { ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], subjectId: 7 }] }],
    ['archivedPeriods[].archivedAt', { ...PAYLOAD, archivedPeriods: [{ archivedAt: 7, reactivatedAt: null }] }],
    ['archivedLocations.locationCount', { ...PAYLOAD, archivedLocations: { refusalCount: 0, locationCount: 'two' } }],
    ['coverageStart', { ...PAYLOAD, coverageStart: 7 }],
    ['windowStart', { ...PAYLOAD, windowStart: 7 }],
    ['scope', { ...PAYLOAD, scope: 'global' }],
    ['autoApprovalEnabled', { ...PAYLOAD, autoApprovalEnabled: 'yes' }],
  ])('rejects a payload whose %s has the wrong type', async (_label, body) => {
    vi.stubGlobal('fetch', jsonFetch(body));
    renderContent();

    expect(await screen.findByText('Unable to load your restraint record')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('alert'))
        .toHaveTextContent('Your restraint record came back incomplete');
    });
  });

  // THE NULL ARMS, which nothing exercised because the fixture carries no null
  // anywhere. Deleting every `value === null ||` left all 28 cases green, and
  // that mutant is the dangerous direction: null is the COMMON production
  // shape here — `reviewId` and `linkKind` on any lane with no resolvable
  // subject, `subjectId`/`subjectType` on the account-scoped lanes,
  // `coverageStart` by migration 001, `archivedLocations` in every location
  // scope. A guard that lost them rejects nearly every real payload and blanks
  // the whole tab (red team F34).
  // EVERY live `linkKind`, accepted. Deleting `value === 'auto-approval'` or
  // `value === 'contacts'` from `isLinkKind` left the suite green, and either
  // loss blanks the whole tab for any window holding one — the same direction
  // as the null arms (red team F40). The previous commit's claim that the sweep
  // "covers every conjunct" was FALSE for exactly these two.
  it.each(['review', 'auto-approval', 'contacts', null])(
    'ACCEPTS a linkKind of %s',
    async (linkKind) => {
      vi.stubGlobal('fetch', jsonFetch({
        ...PAYLOAD,
        entries: [{ ...PAYLOAD.entries[0], linkKind }],
      }));
      renderContent();

      expect(await screen.findByText('What we held back')).toBeInTheDocument();
    },
  );

  it.each([
    ['an array', [] as unknown],
    ['a string', 'restraint' as unknown],
    ['a number', 7 as unknown],
  ])('rejects a body that is not an object at all (%s)', async (_label, body) => {
    // These pin the BEHAVIOUR, not the `isObject` conjunct: an array, a string
    // and a number all fail the next conjunct anyway, so deleting `isObject`
    // leaves them rejected either way. The case below is the one that pins it.
    vi.stubGlobal('fetch', jsonFetch(body));
    renderContent();

    expect(await screen.findByText('Unable to load your restraint record')).toBeInTheDocument();
  });

  it('rejects a null body with our own sentence, never a raw TypeError', async () => {
    // `typeof null === 'object'`, so the top-level `isObject` arm's ONLY
    // observable job is this one: without it the chain dereferences null and a
    // `Cannot read properties of null` message is what reaches the owner. The
    // message is the assertion — the error CARD renders either way.
    vi.stubGlobal('fetch', jsonFetch(null));
    renderContent();

    expect(await screen.findByText('Unable to load your restraint record')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('alert'))
        .toHaveTextContent('Your restraint record came back incomplete');
    });
  });

  // EVERY category the vocabulary admits, accepted. Narrowing
  // `REFUSAL_CATEGORY_NAMES` rejects a legal payload — the over-restrictive
  // direction the wrong-type rows cannot see, and the same shape as the
  // `linkKind` arms. Round 6 left this one excluded on scope; this closes it.
  it.each([
    'unsafe_content', 'watchdog_unavailable', 'below_our_bar', 'no_permission',
    'wrong_moment', 'autonomy_paused', 'missing_information', 'owner_review_required',
  ])('ACCEPTS a category of %s', async (category) => {
    vi.stubGlobal('fetch', jsonFetch({
      ...PAYLOAD,
      entries: [{ ...PAYLOAD.entries[0], category, linkKind: null }],
    }));
    renderContent();

    expect(await screen.findByText('What we held back')).toBeInTheDocument();
  });

  it('ACCEPTS the legal nulls the DTO is built to carry', async () => {
    vi.stubGlobal('fetch', jsonFetch({
      ...PAYLOAD,
      coverageStart: null,
      archivedLocations: null,
      archivedPeriods: [{ archivedAt: '2026-08-05T00:00:00.000Z', reactivatedAt: null }],
      entries: [{
        ...PAYLOAD.entries[0],
        subjectType: null,
        subjectId: null,
        reviewId: null,
        linkKind: null,
      }],
    }));
    renderContent();

    // It RENDERS. The guard rejecting this payload is the outage the mutation
    // above describes, so this case fails in the opposite direction to every
    // other case in the block.
    expect(await screen.findByText('What we held back')).toBeInTheDocument();
    expect(screen.queryByText('Unable to load your restraint record')).toBeNull();
  });

  it('RestraintContent renders the restraint error card when the initial query fails without cached data', async () => {
    vi.stubGlobal('fetch', jsonFetch({ error: 'Failed to fetch refusals' }, false, 500));
    const { container } = renderContent();

    // THE FIRST-LOAD FAILURE. `hasData` is false precisely BECAUSE the fetch
    // failed, and the panel used to gate its error card on `hasData` — so this
    // rendered a skeleton that never resolved (deviation D5).
    expect(await screen.findByText('Unable to load your restraint record')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector('.dashboard-skeleton')).toBeNull();
    });
  });
});
