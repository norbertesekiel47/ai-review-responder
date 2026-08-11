// @vitest-environment jsdom
//
// #781 regression guard — the add-location wizard spun forever after an add
// that had already succeeded. Two compounding faults, one test file:
//
//   1. `router.refresh()` issued AFTER `router.push()` superseded the in-flight
//      navigation, so the owner went nowhere. Guarded by asserting the push is
//      the LAST router call the wizard makes.
//   2. The reducer had no success action, so the wizard could only leave its
//      loading state by navigating away — making any navigation failure an
//      unbounded spinner. Guarded by asserting a terminal phase is reached from
//      the 201 alone, with the router deliberately never completing.
//
// The LocationProvider is real, not mocked: its setLocationScope calls
// router.refresh() internally, and that refresh is legitimate — the bug is
// specifically a refresh issued after the push.

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { LocationProvider } from '@/contexts/LocationContext';
import type { BillingSnapshot } from '@/lib/accounts/quota';
import { useAddLocationWizard } from '../wizard/useAddLocationWizard';
import type { Props } from '../wizard/types';

const NEW_LOCATION_ID = '019fef1b-a9e5-77a9-8e55-2599b812460e';
const CONNECT_HREF = `/dashboard/connect?locationId=${NEW_LOCATION_ID}`;

// Ordered log of every router call the wizard (or the location context) makes.
// Ordering is the whole point: `refresh` before `push` is correct, after it is
// the bug.
const { routerCalls, router, pushBehavior } = vi.hoisted(() => {
  const routerCalls: string[] = [];
  const pushBehavior: { throwOnPush: boolean } = { throwOnPush: false };
  return {
    routerCalls,
    pushBehavior,
    router: {
      push: (href: string) => {
        routerCalls.push(`push:${href}`);
        // A real App Router push resolves by unmounting this tree. Here it
        // deliberately never does — the wizard must settle regardless.
        if (pushBehavior.throwOnPush) throw new Error('navigation blew up');
      },
      refresh: () => {
        routerCalls.push('refresh');
      },
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    },
  };
});

vi.mock('next/navigation', () => ({ useRouter: () => router }));

const BILLING_SNAPSHOT: BillingSnapshot = {
  basePriceCents: 9900,
  includedLocations: 1,
  overagePriceCents: 1500,
  overageUnits: 0,
  totalCents: 9900,
};

const PROPS: Props = {
  accountId: '019fd4b6-6ff1-71bb-b329-087f7077b692',
  billingSnapshot: BILLING_SNAPSHOT,
  activeLocationCount: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Routes the hook's two mount-time GETs; POST /api/locations/add is per-test. */
function makeFetchMock(addResponse: () => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/settings/voice') return jsonResponse({ locations: [] });
    if (url === '/api/locations/existing-place-ids') return jsonResponse({ placeIds: [] });
    if (url === '/api/locations/add') return addResponse();
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <LocationProvider locations={[]} initialScope="all" multiLocationEnabled>
      {children}
    </LocationProvider>
  );
}

async function renderWizard() {
  const view = renderHook(() => useAddLocationWizard(PROPS), { wrapper });
  // Let the two mount-time fetches settle so their state updates don't leak
  // into the submit assertions.
  await waitFor(() => expect(view.result.current.voiceLoading).toBe(false));
  return view;
}

beforeEach(() => {
  routerCalls.length = 0;
  pushBehavior.throwOnPush = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useAddLocationWizard submit — terminal state (#781)', () => {
  it('settles into a terminal success phase after a 201, though navigation never completes', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(async () => jsonResponse({ businessId: NEW_LOCATION_ID }, 201)),
    );

    const { result } = await renderWizard();
    await act(() => result.current.handleSubmit());

    // The whole bug in one assertion: the wizard is out of the loading state
    // even though the router never took the owner anywhere.
    expect(result.current.submitPhase).toBe('succeeded');
    expect(result.current.submitting).toBe(false);
    expect(result.current.submitted).toBe(true);
    expect(result.current.submitError).toBeNull();
    expect(result.current.connectHref).toBe(CONNECT_HREF);
  });

  it('issues no router call after the push — a trailing refresh aborts the navigation', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(async () => jsonResponse({ businessId: NEW_LOCATION_ID }, 201)),
    );

    const { result } = await renderWizard();
    await act(() => result.current.handleSubmit());

    const pushIndex = routerCalls.indexOf(`push:${CONNECT_HREF}`);
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    // setLocationScope's refresh must still happen — before the push, where it
    // invalidates the layout the owner is leaving rather than cancelling the
    // navigation.
    expect(routerCalls.slice(0, pushIndex)).toContain('refresh');
    // Nothing may follow the push. This is the assertion that goes red if the
    // trailing router.refresh() comes back.
    expect(routerCalls.slice(pushIndex + 1)).toEqual([]);
  });

  it('leaves the loading state when navigation throws, without inviting a retry', async () => {
    pushBehavior.throwOnPush = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      makeFetchMock(async () => jsonResponse({ businessId: NEW_LOCATION_ID }, 201)),
    );

    const { result } = await renderWizard();
    await act(() => result.current.handleSubmit());

    expect(result.current.submitPhase).toBe('succeeded');
    expect(result.current.submitting).toBe(false);
    // The location exists — a "please try again" error here would produce a
    // duplicate.
    expect(result.current.submitError).toBeNull();
    expect(result.current.connectHref).toBe(CONNECT_HREF);
    expect(consoleError).toHaveBeenCalled();
  });

  it('reaches a terminal success phase even when the API omits businessId', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(async () => jsonResponse({}, 201)),
    );

    const { result } = await renderWizard();
    await act(() => result.current.handleSubmit());

    expect(result.current.submitPhase).toBe('succeeded');
    expect(result.current.connectHref).toBe('/dashboard/connect');
    expect(routerCalls).toEqual(['push:/dashboard/connect']);
  });

  it('stays on step 4 in the failed phase when the API rejects the add', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(async () => jsonResponse({ error: 'quota_exceeded' }, 402)),
    );

    const { result } = await renderWizard();
    const stepBefore = result.current.step;
    await act(() => result.current.handleSubmit());

    expect(result.current.submitPhase).toBe('failed');
    expect(result.current.submitting).toBe(false);
    expect(result.current.submitError).toBeTruthy();
    // VAL-LOC-064: the wizard stays put and shows the error inline.
    expect(result.current.step).toBe(stepBefore);
    expect(routerCalls).toEqual([]);
  });

  it('reports a network failure as a retryable error and navigates nowhere', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const { result } = await renderWizard();
    await act(() => result.current.handleSubmit());

    expect(result.current.submitPhase).toBe('failed');
    expect(result.current.submitError).toBe('Network error — please try again.');
    expect(routerCalls).toEqual([]);
  });
});
