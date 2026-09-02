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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: 'all' }),
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
  return render(
    <QueryClientProvider client={client}>
      <RestraintContent />
    </QueryClientProvider>,
  );
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
    expect(source).not.toContain('useEffect');
    expect(source).not.toContain('AbortController');
    expect(source).not.toContain('useRef');
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

  it('rejects a payload that is missing a required field rather than rendering a partial record', async () => {
    const { ledgerRecording: _dropped, ...incomplete } = PAYLOAD;
    vi.stubGlobal('fetch', jsonFetch(incomplete));
    renderContent();

    // The guards must actually REJECT — this is what makes them guards rather
    // than decoration, and it is the assertion the boolean-returning versions
    // could not support.
    expect(await screen.findByText('Unable to load your restraint record')).toBeInTheDocument();
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
