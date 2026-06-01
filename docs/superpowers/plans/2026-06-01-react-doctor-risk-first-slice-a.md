# React Doctor Risk-First Slice A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Slice A from the React Doctor risk-first cleanup spec: fix real lifecycle cleanup leaks, protect the approval GET route from unsafe lint appeasement, and classify the remaining Tier 0 state-reset findings without changing behavior mechanically.

**Architecture:** Use test-first, narrowly scoped React hook/component changes. Timer cleanup changes preserve the existing state machines; the approval route remains read-only GET with cookie setup; state-reset diagnostics are classified unless a focused regression test proves the refactor is safe.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, Vitest, Testing Library, jsdom, React Doctor.

---

## Scope Check

This plan covers only **Slice A: Error Cleanup** from `docs/superpowers/specs/2026-06-01-react-doctor-risk-first-cleanup-design.md`.

It intentionally does not implement:

- Slice B accessibility cleanup
- Slice C dynamic key / hydration cleanup
- Slice D async triage
- copy/style/bundle cleanup

Those should be planned after this slice lands and verifies cleanly.

## File Structure

Modify:

- `src/app/api/approve/[token]/__tests__/route.test.ts`
  - Adds a regression test proving successful GET remains read-only and still calls `setDeviceCookie` / `setCsrfCookie`.
- `src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx`
  - Adds polling regression tests for recursive timeout behavior and cleanup on unmount.
- `src/components/dashboard/edit-reply/useEditReplyDraft.ts`
  - Tracks the active polling timeout id and clears it in effect cleanup.
- `src/components/__tests__/DashboardContent.test.tsx`
  - Adds dashboard hash-scroll timeout cleanup regression coverage.
- `src/components/DashboardContent.tsx`
  - Clears the deferred hash-scroll timeout on unmount.
- `src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx`
  - Creates aggregate-dashboard hash-scroll timeout cleanup regression coverage.
- `src/components/dashboard/aggregate/AggregateDashboardContent.tsx`
  - Clears the deferred aggregate hash-scroll timeout on unmount.
- `src/components/__tests__/PlaceAutocomplete.test.tsx`
  - Creates Google Places web-component listener cleanup regression coverage.
- `src/components/PlaceAutocomplete.tsx`
  - Uses a named `gmp-select` listener and removes it during cleanup.

Do not modify:

- `src/app/api/approve/[token]/route.ts`
  - The React Doctor finding is a false positive. The GET handler must keep read-only validation and cookie setup.
- Worker, poller, queue, billing, audit, third-party ingress, and `sql.begin()` code.

## Task 1: Approval GET False-Positive Guard

**Files:**

- Modify: `src/app/api/approve/[token]/__tests__/route.test.ts`
- Do not modify: `src/app/api/approve/[token]/route.ts`

- [ ] **Step 1: Extend mocks for approval cookies and SQL**

Update the import line in `src/app/api/approve/[token]/__tests__/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
```

Update the hoisted mocks at the top of `src/app/api/approve/[token]/__tests__/route.test.ts` to this shape:

```ts
const {
  mockCheckRateLimit,
  mockSetDeviceCookie,
  mockSetCsrfCookie,
  mockVerifyDeviceCookie,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockSetDeviceCookie: vi.fn(),
  mockSetCsrfCookie: vi.fn(),
  mockVerifyDeviceCookie: vi.fn(),
}));

vi.mock('@/lib/approval/cookies', () => ({
  setDeviceCookie: (...args: unknown[]) => mockSetDeviceCookie(...args),
  setCsrfCookie: (...args: unknown[]) => mockSetCsrfCookie(...args),
  verifyDeviceCookie: (...args: unknown[]) => mockVerifyDeviceCookie(...args),
}));
```

Keep the existing `checkRateLimit` and `sql` mocks.

- [ ] **Step 2: Add reset coverage in `beforeEach`**

Add this `beforeEach` inside the test file:

```ts
beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyDeviceCookie.mockReturnValue(false);
});
```

- [ ] **Step 3: Add a successful GET regression test**

Add this test inside the existing `describe('GET /api/approve/[token]', () => { })` block:

```ts
it('keeps successful GET read-only and sets approval cookies', async () => {
  mockCheckRateLimit.mockResolvedValueOnce({ allowed: true });

  const { sql } = await import('@/lib/db/server');
  const sqlMock = vi.mocked(sql);
  sqlMock
    .mockResolvedValueOnce([
      {
        id: 'link-1',
        response_id: 'resp-1',
        business_id: 'biz-1',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
        revoked_at: null,
      },
    ])
    .mockResolvedValueOnce([
      {
        response_text: 'Thanks for visiting.',
        version: 1,
        status: 'pending_approval',
        reviewer_name: 'Pat',
        star_rating: 5,
        review_text: 'Great.',
        review_date: '2026-05-01T00:00:00.000Z',
        business_name: 'Cafe Test',
        display_label: null,
        account_id: 'acct-1',
        is_archived: false,
      },
    ]);

  const { GET } = await import('../route');
  const res = await GET(requestWithLegacyIp(), {
    params: Promise.resolve({ token: 'raw-token' }),
  });

  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({
    review: { reviewerName: 'Pat', starRating: 5 },
    response: { responseText: 'Thanks for visiting.', status: 'pending_approval' },
    businessName: 'Cafe Test',
  });

  expect(mockVerifyDeviceCookie).toHaveBeenCalledTimes(1);
  expect(mockSetDeviceCookie).toHaveBeenCalledTimes(1);
  expect(mockSetCsrfCookie).toHaveBeenCalledTimes(1);

  const sqlText = sqlMock.mock.calls
    .map((call) => Array.from(call[0] as TemplateStringsArray).join(' '))
    .join('\n');
  expect(sqlText).toMatch(/\bSELECT\b/i);
  expect(sqlText).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
});
```

- [ ] **Step 4: Run the route test and verify failure if the route is changed unsafely**

Run:

```bash
pnpm exec vitest run 'src/app/api/approve/[token]/__tests__/route.test.ts'
```

Expected: PASS against current route behavior.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/approve/[token]/__tests__/route.test.ts'
git commit -m "test: guard approval get route semantics"
```

## Task 2: Edit Reply Polling Timeout Cleanup

**Files:**

- Modify: `src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx`
- Modify: `src/components/dashboard/edit-reply/useEditReplyDraft.ts`

- [ ] **Step 1: Add a recursive polling regression test**

In `src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx`, add this test inside the existing `describe('useEditReplyDraft — regenerate + polling', () => { })` block:

```ts
it('continues recursive polling through repeated generating statuses', async () => {
  vi.useFakeTimers();
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-loop' }))
    .mockResolvedValueOnce(jsonResponse({ status: 'generating' }))
    .mockResolvedValueOnce(jsonResponse({ status: 'generating' }))
    .mockResolvedValueOnce(jsonResponse({ response_id: 'resp-loop', response_text: 'Loop draft' }));

  const { result } = setup();

  await act(async () => { await result.current.actions.startRegenerate(); });
  expect(result.current.state).toEqual({ kind: 'regenerating', outboxId: 'ob-loop' });

  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result.current.state).toEqual({ kind: 'regenerating', outboxId: 'ob-loop' });

  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result.current.state).toEqual({ kind: 'regenerating', outboxId: 'ob-loop' });

  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result.current.state).toEqual({
    kind: 'preview',
    draftResponseId: 'resp-loop',
    text: 'Loop draft',
  });
});
```

- [ ] **Step 2: Add an unmount cleanup regression test**

Add this test in the same `describe` block:

```ts
it('clears the scheduled poll timeout when unmounted while regenerating', async () => {
  vi.useFakeTimers();
  fetchMock.mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-cleanup' }));

  const { result, unmount } = setup();

  await act(async () => { await result.current.actions.startRegenerate(); });
  expect(result.current.state).toEqual({ kind: 'regenerating', outboxId: 'ob-cleanup' });
  expect(vi.getTimerCount()).toBe(1);

  unmount();

  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run the focused test and verify the cleanup test fails before implementation**

Run:

```bash
pnpm exec vitest run src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx
```

Expected before implementation: the new cleanup test FAILS because one timeout remains scheduled after unmount.

- [ ] **Step 4: Track and clear the active poll timeout**

In `src/components/dashboard/edit-reply/useEditReplyDraft.ts`, replace the entire polling effect whose dependency array is `[state]` with this implementation:

```ts
useEffect(() => {
  if (state.kind !== 'regenerating') return;
  const outboxId = state.outboxId;
  const startedAt = Date.now();
  let cancelled = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) return;
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      setState({
        kind: 'regenerate_poll_error',
        outboxId,
        message: 'Generation is taking longer than expected. The draft may still arrive.',
      });
      return;
    }
    try {
      const res = await fetch(
        `/api/dashboard/past-replies/draft-status?outbox_id=${encodeURIComponent(outboxId)}`,
        { credentials: 'same-origin' },
      );
      const body = (await res.json().catch(() => null)) as
        | { status?: string; error?: string; response_id?: string; response_text?: string | null }
        | null;
      if (cancelled) return;
      if (!res.ok || !body) {
        setState({
          kind: 'regenerate_poll_error',
          outboxId,
          message: body?.error ?? `Status check failed (${res.status}). The worker may still finish.`,
        });
        return;
      }
      if (body.status === 'generating') {
        timerId = setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      if (body.status === 'failed') {
        setState({
          kind: 'error',
          message: body.error ?? 'Generation failed. Try again.',
        });
        return;
      }
      if (body.response_id) {
        setState({
          kind: 'preview',
          draftResponseId: body.response_id,
          text: body.response_text ?? '',
        });
        return;
      }
      setState({ kind: 'error', message: 'Unexpected response from server.' });
    } catch (err) {
      if (cancelled) return;
      setState({
        kind: 'regenerate_poll_error',
        outboxId,
        message: err instanceof Error ? err.message : 'Network error while polling.',
      });
    }
  };

  timerId = setTimeout(tick, POLL_INTERVAL_MS);
  return () => {
    cancelled = true;
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  };
}, [state]);
```

- [ ] **Step 5: Run the focused test**

Run:

```bash
pnpm exec vitest run src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/edit-reply/useEditReplyDraft.ts src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx
git commit -m "fix: clear edit reply polling timeout"
```

## Task 3: Dashboard Hash-Scroll Timeout Cleanup

**Files:**

- Modify: `src/components/__tests__/DashboardContent.test.tsx`
- Modify: `src/components/DashboardContent.tsx`
- Create: `src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx`
- Modify: `src/components/dashboard/aggregate/AggregateDashboardContent.tsx`

- [ ] **Step 1: Add cleanup handling to the existing dashboard test file**

In `src/components/__tests__/DashboardContent.test.tsx`, update the import line:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

Add this `afterEach` below the existing `beforeEach`:

```ts
afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
});
```

- [ ] **Step 2: Add a hash-scroll cleanup test for `DashboardContent`**

Add this test inside the existing `describe('DashboardContent announcements (P1 #18)', () => { })` block:

```ts
it('clears the deferred needs-action hash scroll timer on unmount', () => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '/dashboard#needs-action');
  mockUseDashboardData.mockReturnValue({
    data: null,
    error: null,
    loading: true,
    refresh: vi.fn(),
    scopeFallback: null,
  });

  const { unmount } = render(<DashboardContent />);

  expect(vi.getTimerCount()).toBe(1);

  unmount();

  expect(vi.getTimerCount()).toBe(0);
});
```

- [ ] **Step 3: Create aggregate dashboard cleanup test**

Create `src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx` with this content:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { AggregateDashboardContent } from '../AggregateDashboardContent';

vi.mock('@/components/dashboard/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/dashboard/PendingCountContext', () => ({
  useSetPendingCount: () => vi.fn(),
}));

const aggregateData: AggregateDashboardData = {
  scope: 'aggregate',
  valueSummary: {
    totalReviewsHandled: 0,
    totalTimeSavedMinutes: 0,
    currentResponseRate: 0,
    baselineResponseRate: null,
  },
  reviewVelocity: [],
  perLocationVelocity: [],
  ranking: null,
  perLocationRanking: [],
  recentReviews: [],
  perLocationBriefs: [],
  locationKpis: [],
  activeLocationCount: 2,
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
});

describe('AggregateDashboardContent', () => {
  it('clears the deferred needs-action hash scroll timer on unmount', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/dashboard#needs-action');

    const { unmount } = render(
      <AggregateDashboardContent data={aggregateData} refresh={vi.fn()} />,
    );

    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 4: Run the dashboard tests and verify the new tests fail before implementation**

Run:

```bash
pnpm exec vitest run src/components/__tests__/DashboardContent.test.tsx src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx
```

Expected before implementation: both new cleanup tests FAIL because one timeout remains scheduled after unmount.

- [ ] **Step 5: Clear the `DashboardContent` timer**

In `src/components/DashboardContent.tsx`, replace the hash-scroll effect with:

```ts
// OQ-3 — read URL hash on mount; auto-select Needs Action + scroll into view.
useEffect(() => {
  if (typeof window === 'undefined') return;
  if (window.location.hash !== '#needs-action') return;

  setInitialTab('needs');
  // Defer until layout settles.
  const timeoutId = setTimeout(() => {
    if (reviewsRef.current) {
      const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }, 100);

  return () => clearTimeout(timeoutId);
}, []);
```

- [ ] **Step 6: Clear the `AggregateDashboardContent` timer**

In `src/components/dashboard/aggregate/AggregateDashboardContent.tsx`, replace the hash-scroll effect with:

```ts
// Read URL hash on mount — auto-select Needs Action + scroll into view
useEffect(() => {
  if (typeof window === 'undefined') return;
  if (window.location.hash !== '#needs-action') return;

  setInitialTab('needs');
  const timeoutId = setTimeout(() => {
    if (reviewsRef.current) {
      const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }, 100);

  return () => clearTimeout(timeoutId);
}, []);
```

- [ ] **Step 7: Run the dashboard tests**

Run:

```bash
pnpm exec vitest run src/components/__tests__/DashboardContent.test.tsx src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/DashboardContent.tsx src/components/__tests__/DashboardContent.test.tsx src/components/dashboard/aggregate/AggregateDashboardContent.tsx src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx
git commit -m "fix: clear dashboard hash scroll timers"
```

## Task 4: PlaceAutocomplete Listener Cleanup

**Files:**

- Create: `src/components/__tests__/PlaceAutocomplete.test.tsx`
- Modify: `src/components/PlaceAutocomplete.tsx`

- [ ] **Step 1: Create the failing listener cleanup test**

Create `src/components/__tests__/PlaceAutocomplete.test.tsx` with this content:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const {
  importLibraryMock,
  setOptionsMock,
  addEventListenerMock,
  removeEventListenerMock,
} = vi.hoisted(() => ({
  importLibraryMock: vi.fn(),
  setOptionsMock: vi.fn(),
  addEventListenerMock: vi.fn(),
  removeEventListenerMock: vi.fn(),
}));

vi.mock('@googlemaps/js-api-loader', () => ({
  importLibrary: (...args: unknown[]) => importLibraryMock(...args),
  setOptions: (...args: unknown[]) => setOptionsMock(...args),
}));

import { PlaceAutocomplete } from '../PlaceAutocomplete';

function makeAutocompleteElement(): HTMLElement {
  const element = document.createElement('div');
  element.addEventListener = addEventListenerMock as unknown as typeof element.addEventListener;
  element.removeEventListener = removeEventListenerMock as unknown as typeof element.removeEventListener;
  return element;
}

describe('PlaceAutocomplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importLibraryMock.mockResolvedValue({
      PlaceAutocompleteElement: function MockPlaceAutocompleteElement() {
        return makeAutocompleteElement();
      },
    });
  });

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('removes the gmp-select listener on unmount', async () => {
    const { unmount } = render(<PlaceAutocomplete onPlaceSelect={vi.fn()} />);

    await waitFor(() => {
      expect(addEventListenerMock).toHaveBeenCalledWith('gmp-select', expect.any(Function));
    });
    const handler = addEventListenerMock.mock.calls[0]![1];

    unmount();

    expect(removeEventListenerMock).toHaveBeenCalledWith('gmp-select', handler);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails before implementation**

Run:

```bash
pnpm exec vitest run src/components/__tests__/PlaceAutocomplete.test.tsx
```

Expected before implementation: FAIL because `removeEventListener` is not called.

- [ ] **Step 3: Use a named listener and remove it during cleanup**

In `src/components/PlaceAutocomplete.tsx`, replace the entire `useEffect` body with this implementation:

```ts
useEffect(() => {
  let cancelled = false;
  let element: HTMLElement | null = null;
  let handleSelect: ((event: Event) => Promise<void>) | null = null;

  // Force light theme on the web component (system may be in dark mode)
  const styleId = 'gmp-autocomplete-light';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      gmp-place-autocomplete {
        color-scheme: light only !important;
        border-radius: 0.375rem;
      }
      gmp-place-autocomplete::part(input) {
        font-size: 0.875rem;
        line-height: 1.25rem;
      }
    `;
    document.head.appendChild(style);
  }

  importLibrary('places')
    .then((placesLib) => {
      if (cancelled || !containerRef.current) return;

      const PlaceAutocompleteElement = (placesLib as any).PlaceAutocompleteElement;

      element = new PlaceAutocompleteElement({
        includedPrimaryTypes: ['establishment'],
      }) as HTMLElement;

      element.setAttribute('placeholder', placeholder);
      element.style.width = '100%';

      handleSelect = async (event: Event) => {
        try {
          const { placePrediction } = event as any;
          if (!placePrediction) {
            setError('Failed to get place prediction');
            return;
          }

          const place = placePrediction.toPlace();
          await place.fetchFields({
            fields: ['id', 'formattedAddress', 'location'],
          });

          if (!place.location || !place.id) {
            setError('Place has no location data');
            return;
          }

          const result: PlaceSelection = {
            placeId: place.id,
            formattedAddress: place.formattedAddress ?? '',
            lat: place.location.lat(),
            lng: place.location.lng(),
          };

          setSelection(result);
          setError(null);
          onPlaceSelect(result);
        } catch (err: unknown) {
          setError('Failed to load place details');
          console.error('[PlaceAutocomplete]', err);
        }
      };

      element.addEventListener('gmp-select', handleSelect);

      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(element);
    })
    .catch((err: unknown) => {
      setError('Failed to load Google Maps — use the URL input instead');
      console.error('[PlaceAutocomplete] Load error:', err);
    });

  return () => {
    cancelled = true;
    if (element && handleSelect) {
      element.removeEventListener('gmp-select', handleSelect);
    }
    element?.remove();
  };
}, [placeholder, onPlaceSelect]);
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm exec vitest run src/components/__tests__/PlaceAutocomplete.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/PlaceAutocomplete.tsx src/components/__tests__/PlaceAutocomplete.test.tsx
git commit -m "fix: clean up place autocomplete listener"
```

## Task 5: Tier 0 State-Reset Classification

**Files:**

- Read: `src/components/dashboard/PastDueModal.tsx`
- Read: `src/components/dashboard/settings/ToneChipPicker.tsx`
- Read: `src/components/sections/landing/TickerBar.tsx`
- Read: `src/components/sections/landing/Hero.tsx`
- Read: `src/hooks/useDashboardData.ts`
- Read: `src/lib/notifications/channels/use-enrollment.ts`

- [ ] **Step 1: Confirm existing focused tests for state-reset-sensitive code**

Run:

```bash
pnpm exec vitest run src/components/dashboard/__tests__/PastDueModal.test.tsx src/components/dashboard/settings/__tests__/ToneChipPicker.test.tsx src/hooks/__tests__/useDashboardData.test.ts
```

Expected: PASS.

- [ ] **Step 2: Classify each no-adjust-state finding in the implementation notes**

Use this exact classification table in the PR description or final implementation summary:

```md
Tier 0 no-adjust-state diagnostics reviewed:

- `src/components/dashboard/PastDueModal.tsx`: classified intentional for Slice A. The effect reads browser-only `localStorage` from a date/account dismissal key and existing tests cover show/dismiss/read-only behavior.
- `src/components/dashboard/settings/ToneChipPicker.tsx`: classified intentional for Slice A. The effect distinguishes external parent changes from local picker writes; existing tests cover the Discard/external-reset behavior.
- `src/components/sections/landing/TickerBar.tsx`: deferred from Slice A. The flagged state is visibility/animation state tied to `IntersectionObserver`, not product-critical owner workflow state.
- `src/components/sections/landing/Hero.tsx`: deferred from Slice A. The flagged state is landing-page typing animation state; it should be handled in a separate animation cleanup pass with visual verification.
- `src/hooks/useDashboardData.ts`: classified intentional for Slice A. The effect clears stale dashboard data immediately on scope change before refetch; existing tests assert that behavior.
- `src/lib/notifications/channels/use-enrollment.ts`: classified intentional for Slice A. The effect clears the TTL countdown when enrollment leaves `awaiting_scan`; this hook is backed by reducer tests and Playwright channel coverage.
```

- [ ] **Step 3: Do not change state-reset source in this slice**

Run:

```bash
git diff -- src/components/dashboard/PastDueModal.tsx src/components/dashboard/settings/ToneChipPicker.tsx src/components/sections/landing/TickerBar.tsx src/components/sections/landing/Hero.tsx src/hooks/useDashboardData.ts src/lib/notifications/channels/use-enrollment.ts
```

Expected: no diff.

## Task 6: Slice A Verification

**Files:**

- All files touched in Tasks 1 through 4.

- [ ] **Step 1: Run the focused Slice A test set**

Run:

```bash
pnpm exec vitest run 'src/app/api/approve/[token]/__tests__/route.test.ts' src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx src/components/__tests__/DashboardContent.test.tsx src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx src/components/__tests__/PlaceAutocomplete.test.tsx src/components/dashboard/__tests__/PastDueModal.test.tsx src/components/dashboard/settings/__tests__/ToneChipPicker.test.tsx src/hooks/__tests__/useDashboardData.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the full unit test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 6: Run React Doctor diff**

Run:

```bash
pnpm doctor -- --verbose --diff
```

Expected:

- No new diagnostics in touched files.
- `effect-needs-cleanup` is gone for `PlaceAutocomplete`, `DashboardContent`, `AggregateDashboardContent`, and `useEditReplyDraft`.
- `nextjs-no-side-effect-in-get-handler` may still report `src/app/api/approve/[token]/route.ts`; keep it classified as a false positive.
- `no-adjust-state-on-prop-change` may still report the reviewed state-reset files; keep them classified by the table in Task 5.

- [ ] **Step 7: Final commit if verification required follow-up edits**

If verification required code/test edits after the task commits, commit only those edits:

```bash
git add src/app/api/approve/[token]/__tests__/route.test.ts src/components/dashboard/edit-reply/useEditReplyDraft.ts src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx src/components/DashboardContent.tsx src/components/__tests__/DashboardContent.test.tsx src/components/dashboard/aggregate/AggregateDashboardContent.tsx src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx src/components/PlaceAutocomplete.tsx src/components/__tests__/PlaceAutocomplete.test.tsx
git commit -m "test: verify react doctor slice a cleanup"
```

Expected: commit is created only if there were verification follow-up edits.

## Final Handoff Notes

When reporting completion, include:

- focused test command result
- `pnpm lint` result
- `pnpm typecheck` result
- `pnpm test` result
- `pnpm build` result
- `pnpm doctor -- --verbose --diff` result
- the Task 5 no-adjust-state classification table
- a note that the approval GET route was intentionally not changed
