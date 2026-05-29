# select-location TopBar chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `/dashboard/connect/select-location` page the Console app chrome it currently lacks by rendering the existing branded `<TopBar>` above the connect-flow `<LocationPicker>`.

**Architecture:** One JSX change to the server page `src/app/(authenticated)/dashboard/connect/select-location/page.tsx` — wrap the success return in a fragment with `<TopBar>`. The page already sits under `(authenticated)/layout.tsx`, which provides `LocationContext`, so `TopBar`'s `useLocationScope()` resolves. Guarded by a new page test that renders the happy path and asserts the chrome renders above the picker.

**Tech Stack:** Next.js (App Router server component), React, TypeScript, Vitest + Testing Library. Spec: `docs/superpowers/specs/2026-05-29-select-location-topbar-chrome-design.md`.

**Worktree/branch:** `fix/launch-p1-16-select-location-topbar` (isolated worktree, created via superpowers:using-git-worktrees at execution time).

> **Note:** The VoiceClient/`SettingsShell` half of audit item #16 is already shipped (`VoiceClient.tsx` wraps `<SettingsShell>`; `settings/voice/page.tsx` already renders `<TopBar>`). This plan only covers the open `select-location` half.

---

### Task 0: Land the spec on the branch

**Files:**
- Already created: `docs/superpowers/specs/2026-05-29-select-location-topbar-chrome-design.md`

- [ ] **Step 1: Commit the spec as the first commit on the worktree branch**

```bash
git add docs/superpowers/specs/2026-05-29-select-location-topbar-chrome-design.md \
        docs/superpowers/plans/2026-05-29-select-location-topbar-chrome.md
git commit -m "docs(connect): spec + plan for select-location TopBar chrome (P1 #16)"
```

---

### Task 1: Add TopBar chrome to the select-location page (TDD)

**Files:**
- Create: `src/app/(authenticated)/dashboard/connect/select-location/__tests__/page.test.tsx`
- Modify: `src/app/(authenticated)/dashboard/connect/select-location/page.tsx` (add import + wrap the success return)

- [ ] **Step 1: Write the failing test**

Create `src/app/(authenticated)/dashboard/connect/select-location/__tests__/page.test.tsx` with exactly this content. It mirrors the real-`LocationProvider` pattern from `src/components/dashboard/__tests__/TopBar.test.tsx` and the server-dep mocking style from `dashboard/connect/__tests__/page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocationProvider } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';

const { mockCookieGet, mockRedisGet, mockVerify } = vi.hoisted(() => ({
  mockCookieGet: vi.fn(),
  mockRedisGet: vi.fn(),
  mockVerify: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/connect/select-location',
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: mockRedisGet }),
}));

vi.mock('@/lib/zernio/connect-session-cookie', () => ({
  ZERNIO_CONNECT_COOKIE_NAME: 'zernio_connect_session',
  verifySignedConnectSessionValue: (value: string | undefined) => mockVerify(value),
}));

vi.mock('@/lib/zernio/connect-state', () => ({
  locationsKey: (sessionId: string) => `connect:locations:${sessionId}`,
}));

import SelectLocationPage from '../page';

const LOC = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as LocationId;

function wrap(ui: ReactElement) {
  return h(LocationProvider, {
    locations: [{ id: LOC, name: 'Test Biz', displayLabel: null, isPrimary: true }],
    initialScope: LOC,
    multiLocationEnabled: false,
    children: ui,
  });
}

describe('select-location page chrome', () => {
  beforeEach(() => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    mockCookieGet.mockReturnValue({ value: 'signed-cookie' });
    mockVerify.mockReturnValue('session-id');
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        locations: [{ id: 'loc-1', name: 'Acme Coffee', address: '123 Main St' }],
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the TopBar chrome above the location picker', async () => {
    const ui = await SelectLocationPage();
    render(wrap(ui));

    // TopBar chrome
    expect(screen.getByText('Connect Google Business')).toBeInTheDocument();
    expect(screen.getByText('Back to dashboard')).toBeInTheDocument();

    // Existing picker still renders
    expect(screen.getByText('Pick a Google Business location')).toBeInTheDocument();
    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/app/\(authenticated\)/dashboard/connect/select-location/__tests__/page.test.tsx`
Expected: FAIL — `getByText('Connect Google Business')` / `getByText('Back to dashboard')` throw because the page currently returns a bare `<LocationPicker>` with no TopBar. (The "Pick a Google Business location" / "Acme Coffee" assertions would pass — only the chrome assertions fail.)

- [ ] **Step 3: Add the TopBar import**

In `src/app/(authenticated)/dashboard/connect/select-location/page.tsx`, add this import alongside the existing `import { LocationPicker } from './LocationPicker';`:

```ts
import { TopBar } from '@/components/dashboard/TopBar';
```

- [ ] **Step 4: Wrap the success return with TopBar**

Replace the final return (currently `return <LocationPicker locations={blob.locations} />;`) with:

```tsx
  return (
    <>
      <TopBar
        title="Connect Google Business"
        subtitle="Select location"
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <LocationPicker locations={blob.locations} />
    </>
  );
```

Leave every redirect/guard branch above the return untouched.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/app/\(authenticated\)/dashboard/connect/select-location/__tests__/page.test.tsx`
Expected: PASS — all four assertions resolve (TopBar title + rightLink, picker heading + location name).

- [ ] **Step 6: Run the full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: lint 0 errors, typecheck clean, full suite green. (No DB/RLS/tenant-scope surface is touched.)

- [ ] **Step 7: Commit**

```bash
git add src/app/\(authenticated\)/dashboard/connect/select-location/page.tsx \
        src/app/\(authenticated\)/dashboard/connect/select-location/__tests__/page.test.tsx
git commit -m "feat(connect): add TopBar chrome to select-location page (P1 #16)"
```

---

## Self-Review

- **Spec coverage:** "add TopBar to select-location" → Task 1 Steps 3–4. Context-availability and no-heading-conflict reasoning from the spec require no code (they are satisfied by the existing layout and `TopBar`'s `<div>` title). The accepted multi-location quirk needs no handling. VoiceClient half is explicitly already done (no task). LocationPicker body restyle is explicitly out of scope (no task).
- **Placeholder scan:** No TBD/TODO; the test file is complete and the JSX edit is shown in full.
- **Type consistency:** `TopBar` props used (`title`, `subtitle`, `rightLink`) match its `Props` interface in `src/components/dashboard/TopBar.tsx`. `LocationProvider` props (`locations`, `initialScope`, `multiLocationEnabled`, `children`) match the usage in `TopBar.test.tsx`. `SelectLocationPage` is the default export of `../page`. Mocked module shapes (`cookies`, `getCacheRedis().get`, `verifySignedConnectSessionValue`, `locationsKey`, `ZERNIO_CONNECT_COOKIE_NAME`) match what `page.tsx` imports and calls.

## Finishing

After Task 1, follow superpowers:finishing-a-development-branch to push the branch and open a PR (target `main`; 4 CI checks must be green). Then update `docs/launch-ready-part2.md` P1 #16 — mark the select-location half done and note the VoiceClient half was already shipped — consistent with prior entries.
