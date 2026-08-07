// @vitest-environment jsdom
//
// src/components/dashboard/__tests__/DashboardContent.importOffer.test.tsx
//
// T0 EVAL suite for #677 — titles 55 and 56 of the intake's 69, authored VERBATIM
// before implementation and filled in by T5.
//
// These two are MOUNT and SCOPE, and they are the reason the feature cannot ship
// green-but-invisible:
//
//  - Title 55 is the eval's bar item 5, "a feature that is never mounted". Every
//    other banner title renders ImportOfferBanner directly, so all seven would
//    pass on a component no page ever mounts.
//  - Title 56 is round-1 High (F110): the react-query key must include the scoped
//    location id. A key that omits it serves location A's offer on location B —
//    which for THIS feature means one location's consent decision answering for
//    another's, the exact D8/D9 failure the ticket exists to prevent.
//
// WHY 55 IS A SOURCE ASSERTION, stated plainly rather than hidden: rendering
// DashboardOperationalContent for real needs useDashboardData, LocationContext,
// PendingCountContext, the offboarding query and a dozen child components mocked.
// That harness would be larger than the thing under test and would break on any
// unrelated dashboard change — and it would not catch the failure mode any better,
// because the failure mode is "someone deleted the mount". This reads the source
// and asserts the mount exists WITH the scoped prop. Title 56 below is a real
// render, because its failure mode is cache behaviour that source text cannot show.
//
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportOfferBanner } from '../account-state/ImportOfferBanner';
// The wire contract's ONE owner (round-1 A10).
import type { ImportOfferView } from '@/lib/reviews/import-offer-view';

const LOCATION_A = '11111111-1111-4111-8111-111111111111';
const LOCATION_B = '22222222-2222-4222-8222-222222222222';

describe('DashboardContent — Import offer mounting and scope', () => {
  it('DashboardOperationalContent renders the Import offer banner for the location in scope', () => {
    // Resolved from cwd, NOT from `new URL(…, import.meta.url)`: this suite runs
    // under jsdom, where `import.meta.url` carries an http scheme and readFileSync
    // rejects it ("The URL must be of scheme file"). The node-env source tripwire
    // in src/lib/reviews can use the URL form; a jsdom one cannot.
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/dashboard/DashboardContent.tsx'),
      'utf8',
    );

    // Imported…
    expect(source).toMatch(
      /import\s*\{\s*ImportOfferBanner\s*\}\s*from\s*'@\/components\/dashboard\/account-state\/ImportOfferBanner'/,
    );
    // …and actually rendered, with the SCOPED location threaded in. `locationId`
    // being present is the load-bearing half: without it the banner cannot key its
    // query per location (title 56).
    expect(source).toMatch(/<ImportOfferBanner\s+locationId=\{currentScope\}/);
    // …and `readOnly` from the same source as ConnectGoogleBanner's (round-1 A6):
    // a past-due read-only owner must not be handed CTAs whose POST answers 402.
    expect(source).toMatch(
      /<ImportOfferBanner[\s\S]{0,120}readOnly=\{pastDueData\?\.isReadOnly\s*\?\?\s*false\}/,
    );
    // Guarded on the per-location scope, since an aggregate view has no single
    // offer to answer for. 'all' is the aggregate sentinel of
    // `LocationScope = 'all' | LocationId`.
    expect(source).toMatch(/currentScope\s*!==\s*'all'/);
    // The banner OWNS its section wrapper (round-1 A6b): it self-nulls on
    // `{ state: 'none' }`, so an always-mounted animated wrapper here would leave
    // an empty flex item. This asserts the wrapper did not come back.
    expect(source).not.toMatch(/section-enter[^\n]*\n\s*<ImportOfferBanner/);
  });

  it("switching location scope refetches the import offer and never reuses another location's state", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // The route resolves the location from the OWNER SCOPE COOKIE, not from a
      // query param — so both locations hit the identical URL. That is precisely
      // why the react-query KEY has to carry the location: the URL cannot.
      expect(url).toBe('/api/dashboard/import-offer');
      const state: ImportOfferView = calls === 0
        ? { state: 'offer', expiresAt: '2026-08-14T00:00:00.000Z' }
        : { state: 'none' };
      calls += 1;
      return { ok: true, json: async () => state } as Response;
    });
    let calls = 0;
    vi.stubGlobal('fetch', fetchMock);

    // ONE QueryClient across both renders — a shared cache is the only condition
    // under which a location-blind key can leak.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const { rerender, container } = render(
      <QueryClientProvider client={queryClient}>
        <ImportOfferBanner locationId={LOCATION_A} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Import your recent reviews?')).toBeInTheDocument();

    // Switch scope. Location B has no offer.
    rerender(
      <QueryClientProvider client={queryClient}>
        <ImportOfferBanner locationId={LOCATION_B} />
      </QueryClientProvider>,
    );

    // B must refetch rather than serve A's cached offer.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('.banner')).toBeNull());

    // And the two entries are distinct in the cache, keyed by location.
    expect(queryClient.getQueryData(['import-offer', LOCATION_A])).toEqual({
      state: 'offer',
      expiresAt: '2026-08-14T00:00:00.000Z',
    });
    expect(queryClient.getQueryData(['import-offer', LOCATION_B])).toEqual({ state: 'none' });
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});
