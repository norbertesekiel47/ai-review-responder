# Settings IA Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three flag-driven settings tab layouts with one canonical IA navigated by a grouped vertical sidebar (native `<select>` on mobile): Brand Voice becomes a real route instead of an anchor, Subscription/Billing gets its own `/settings/billing` tab, and the Account page is split into a thin **Profile** page plus a **Billing** page.

**Architecture:** A new nested `/settings/layout.tsx` owns a persistent `SettingsSidebar` (active item from `usePathname()`), so every settings page renders only its own content + `TopBar`. The legacy flag-off layout is retired — `MULTI_LOCATION_ENABLED` must stay `true` in prod. `/settings` server-redirects to `/settings/voice`; the voice route is un-gated so single-location accounts reach it. The current `AccountPanel` is split: business-profile fields → `ProfilePanel` (`/settings/profile`), subscription/quota/tier-change → `BillingPanel` (`/settings/billing`). The unified `AccountOffboardingPanel` is split by category — **Cancel subscription** → Billing, **Delete data** → Profile — both reading one shared `useOffboardingStatus()` hook; the DB's `UNIQUE(account_id) WHERE terminal_at IS NULL` one-active-offboarding constraint keeps the two panels coherent across routes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), Vitest + Testing Library, class-based CSS in `src/app/(authenticated)/_styles/settings.css` (Warm Editorial tokens: `--rw-recess`, `--rw-blue-700`, `--rw-app-text`, `--rw-app-text-muted`, `--rw-app-border`). No new visual system — reuses existing `.set-section`, `.plan-card`, `.quota-bar`, `.btn*`, `.input` classes.

**Spec:** Locked via `/grill-me` session 2026-06-20 — decisions captured in "Locked Design Decisions" below.

---

## Locked Design Decisions

1. **Scope:** IA reorg + new settings sidebar + targeted visual cleanup of panels we move (e.g. inline-styled tier buttons). No full panel redesign.
2. **One canonical IA**, all accounts (flag-off layout retired). Hard constraint: `MULTI_LOCATION_ENABLED` stays `true` in prod; if flipped off, settings breaks by design.
3. **Sidebar groups/order:**
   - **RESPONSES** — Brand Voice (`/settings/voice`), Auto-approval (`/settings/auto-approval`), Notifications (`/settings/channels`)
   - **ACCOUNT** — Locations (`/settings/locations`), Profile (`/settings/profile`), Billing (`/settings/billing`), Security (`/settings/security`)
4. **Index:** `/settings` → server `redirect('/settings/voice')`. No content at the bare index.
5. **Nav:** desktop = grouped vertical sidebar (2nd rail inside `.main`); mobile (≤768px) = native `<select>` with `<optgroup>` that routes on change.
6. **Account item renamed to "Profile";** route `/settings/profile`. "Voice"/"Brand Voice" standardized to **Brand Voice**.
7. **Offboarding split by category** off a shared `useOffboardingStatus()`:
   - Billing "Cancel": none → Cancel button; `cancel_only` active → reactivate UI + access-end date; `delete_data`/`purge` active → Cancel disabled, "Data deletion in progress."
   - Profile "Delete data": none → Delete button; `delete_data`/`purge` active → in-progress; `cancel_only` active → blocked ("reactivate or wait before deleting data").
8. **Stripe portal `return_url`** → `/settings/billing`.

---

## File Structure

**Create**
- `src/components/dashboard/settings/SettingsSidebar.tsx` — grouped desktop sidebar + mobile grouped `<select>`; active from `usePathname()`.
- `src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx`
- `src/app/(authenticated)/settings/layout.tsx` — nested layout rendering the sidebar + detail column.
- `src/hooks/useOffboardingStatus.ts` — shared `/api/account/offboarding/status` fetch.
- `src/hooks/__tests__/useOffboardingStatus.test.ts`
- `src/components/dashboard/settings/DeleteDataPanel.tsx` — danger-zone delete (split from `AccountOffboardingPanel`).
- `src/components/dashboard/settings/__tests__/DeleteDataPanel.test.tsx`
- `src/components/dashboard/settings/CancelSubscriptionPanel.tsx` — cancel + reactivate (split from `AccountOffboardingPanel`).
- `src/components/dashboard/settings/__tests__/CancelSubscriptionPanel.test.tsx`
- `src/components/dashboard/settings/ProfilePanel.tsx` — locked business-profile fields (replaces `GeneralPanel`) + `DeleteDataPanel`.
- `src/components/dashboard/settings/BillingPanel.tsx` — `PlanCard`/`QuotaBar`/`TierChangeModal`/tier-change + `CancelSubscriptionPanel` (extracted from `AccountPanel`).
- `src/app/(authenticated)/settings/profile/page.tsx` + `ProfileClient.tsx` + `__tests__/ProfileClient.test.tsx`
- `src/app/(authenticated)/settings/billing/page.tsx` + `BillingClient.tsx` + `__tests__/BillingClient.test.tsx`

**Modify**
- `src/components/dashboard/settings/SettingsShell.tsx` — remove `SettingsTabs` render + `activeTab`/`locationsSettingsEnabled`/`multiLocationEnabled` props; keep save-bar + live-region + toast.
- `src/app/(authenticated)/settings/page.tsx` — replace with `redirect('/settings/voice')`.
- `src/app/(authenticated)/settings/voice/page.tsx` — remove both `notFound()` gates; subtitle "Brand Voice".
- `src/app/(authenticated)/settings/voice/VoiceClient.tsx` — drop `activeTab`/`multiLocationEnabled` from `SettingsShell` (3 sites).
- `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx` — drop tab props on `SettingsShell` (keep content flags).
- `src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx` — drop tab props on `SettingsShell` (3 sites; keep content flags).
- `src/app/(authenticated)/settings/locations/LocationsClient.tsx` — drop tab props on `SettingsShell` (keep content flags).
- `src/app/(authenticated)/settings/security/page.tsx` — drop `SettingsShell` tab props + the now-unused flag computation.
- `src/app/(authenticated)/_styles/settings.css` — add sidebar/2-col classes.
- `src/app/api/billing/portal/route.ts:138` — `return_url` → `/settings/billing`.
- `src/app/api/billing/__tests__/portal.test.ts` — assert `/settings/billing` return_url.

**Delete**
- `src/components/dashboard/shell/SettingsTabs.tsx` + `src/components/dashboard/__tests__/SettingsTabs.test.tsx`
- `src/components/dashboard/settings/GeneralPanel.tsx`
- `src/components/dashboard/settings/AccountPanel.tsx`
- `src/components/dashboard/settings/AccountOffboardingPanel.tsx`
- `src/app/(authenticated)/settings/SettingsClient.tsx` + `src/app/(authenticated)/settings/__tests__/SettingsClient.test.tsx`
- `src/components/dashboard/settings/__tests__/AccountPanel.test.tsx` (if present) and any `AccountOffboardingPanel` test.

---

## Phase 1 — Nav shell (sidebar + layout)

### Task 1: `SettingsSidebar` component

**Files:**
- Create: `src/components/dashboard/settings/SettingsSidebar.tsx`
- Test: `src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsSidebar } from '../SettingsSidebar';

const push = vi.fn();
let mockPath = '/settings/voice';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ push }),
}));

describe('SettingsSidebar', () => {
  beforeEach(() => { push.mockClear(); mockPath = '/settings/voice'; });

  it('renders both group labels and all items', () => {
    render(<SettingsSidebar />);
    expect(screen.getByText('Responses')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    for (const label of ['Brand Voice', 'Auto-approval', 'Notifications', 'Locations', 'Profile', 'Billing', 'Security']) {
      expect(screen.getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('marks Brand Voice active on /settings/voice', () => {
    render(<SettingsSidebar />);
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('aria-current', 'page');
  });

  it('treats the bare /settings index as Brand Voice active', () => {
    mockPath = '/settings';
    render(<SettingsSidebar />);
    expect(screen.getByRole('link', { name: /brand voice/i })).toHaveAttribute('aria-current', 'page');
  });

  it('marks Billing active on a nested billing path', () => {
    mockPath = '/settings/billing';
    render(<SettingsSidebar />);
    expect(screen.getByRole('link', { name: /billing/i })).toHaveAttribute('aria-current', 'page');
  });

  it('mobile select navigates on change', () => {
    render(<SettingsSidebar />);
    fireEvent.change(screen.getByRole('combobox', { name: /settings section/i }), {
      target: { value: '/settings/billing' },
    });
    expect(push).toHaveBeenCalledWith('/settings/billing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx`
Expected: FAIL — cannot find module `../SettingsSidebar`.

- [ ] **Step 3: Write the component**

```tsx
// src/components/dashboard/settings/SettingsSidebar.tsx
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';

interface NavItem {
  label: string;
  href: string;
  icon: IconName;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Responses',
    items: [
      { label: 'Brand Voice', href: '/settings/voice', icon: 'sparkle' },
      { label: 'Auto-approval', href: '/settings/auto-approval', icon: 'shield' },
      { label: 'Notifications', href: '/settings/channels', icon: 'inbox' },
    ],
  },
  {
    label: 'Account',
    items: [
      { label: 'Locations', href: '/settings/locations', icon: 'location' },
      { label: 'Profile', href: '/settings/profile', icon: 'home' },
      { label: 'Billing', href: '/settings/billing', icon: 'chart' },
      { label: 'Security', href: '/settings/security', icon: 'shield' },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

/** `/settings` redirects to `/settings/voice`, so treat the bare index as Brand Voice. */
function resolveActiveHref(pathname: string): string {
  if (pathname === '/settings' || pathname === '/settings/voice') return '/settings/voice';
  const match = ALL_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  return match?.href ?? '/settings/voice';
}

export function SettingsSidebar() {
  const pathname = usePathname() ?? '/settings/voice';
  const router = useRouter();
  const activeHref = resolveActiveHref(pathname);

  return (
    <nav className="settings-sidebar" aria-label="Settings">
      {/* Mobile: native grouped select */}
      <div className="settings-mobile-select-wrap">
        <select
          className="input settings-mobile-select"
          aria-label="Settings section"
          value={activeHref}
          onChange={(event) => router.push(event.target.value)}
        >
          {NAV_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <option key={item.href} value={item.href}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Desktop: grouped vertical list */}
      <div className="settings-sidebar-groups">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <div className="settings-nav-group-label">{group.label}</div>
            {group.items.map((item) => {
              const active = item.href === activeHref;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`settings-nav-item ${active ? 'active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/settings/SettingsSidebar.tsx src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx
git commit -m "feat(settings): grouped settings sidebar + mobile select nav"
```

---

### Task 2: Sidebar CSS (2-col shell + responsive swap)

**Files:**
- Modify: `src/app/(authenticated)/_styles/settings.css` (append a new block)

- [ ] **Step 1: Append the styles**

Add to the end of `src/app/(authenticated)/_styles/settings.css`:

```css
/* ── Settings 2-column shell + sidebar nav ───────────────────────────── */
.settings-shell-2col {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}
.settings-sidebar {
  flex: 0 0 200px;
}
.settings-detail {
  flex: 1 1 auto;
  min-width: 0;
}

.settings-mobile-select-wrap { display: none; }

.settings-sidebar-groups {
  display: flex;
  flex-direction: column;
  gap: 20px;
  position: sticky;
  top: 16px;
}
.settings-nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.settings-nav-group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--rw-app-text-muted);
  padding: 0 10px 4px;
}
.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--rw-app-text-muted);
  text-decoration: none;
  transition: background 0.12s ease, color 0.12s ease;
}
.settings-nav-item:hover {
  background: var(--rw-recess);
  color: var(--rw-app-text);
}
.settings-nav-item.active {
  background: var(--rw-recess);
  color: var(--rw-blue-700);
  font-weight: 600;
}

@media (max-width: 768px) {
  .settings-shell-2col { flex-direction: column; gap: 0; }
  .settings-sidebar { flex: none; width: 100%; }
  .settings-sidebar-groups { display: none; }
  .settings-mobile-select-wrap { display: block; margin-bottom: 12px; }
  .settings-mobile-select { width: 100%; }
}
```

- [ ] **Step 2: Verify the tokens exist**

Run: `grep -nE "rw-recess|rw-blue-700|rw-app-text-muted|rw-app-text\b" src/app/(authenticated)/_styles/*.css | head`
Expected: each token appears (already used by existing settings panels). If `--rw-blue-700` is missing, substitute `--rw-blue-600`.

- [ ] **Step 3: Commit**

```bash
git add src/app/(authenticated)/_styles/settings.css
git commit -m "style(settings): sidebar + 2-col shell css"
```

---

### Task 3: Nested `/settings/layout.tsx`

**Files:**
- Create: `src/app/(authenticated)/settings/layout.tsx`

- [ ] **Step 1: Write the layout**

```tsx
// src/app/(authenticated)/settings/layout.tsx
import type { ReactNode } from 'react';
import { SettingsSidebar } from '@/components/dashboard/settings/SettingsSidebar';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="settings-shell-2col">
      <SettingsSidebar />
      <div className="settings-detail">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/(authenticated)/settings/layout.tsx
git commit -m "feat(settings): nested layout hosting the settings sidebar"
```

---

### Task 4: Strip tabs from `SettingsShell` and all call sites

**Files:**
- Modify: `src/components/dashboard/settings/SettingsShell.tsx`
- Modify: `src/app/(authenticated)/settings/voice/VoiceClient.tsx`
- Modify: `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx`
- Modify: `src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx`
- Modify: `src/app/(authenticated)/settings/locations/LocationsClient.tsx`
- Modify: `src/app/(authenticated)/settings/security/page.tsx`

- [ ] **Step 1: Rewrite `SettingsShell` to drop the tab nav**

Replace the entire body of `src/components/dashboard/settings/SettingsShell.tsx` with:

```tsx
'use client';

import { Icon } from '@/components/dashboard/shell/Icon';
import { LiveRegion } from '@/components/ui/LiveRegion';

interface Props {
  children: React.ReactNode;
  saveBar?: {
    visible: boolean;
    dirtyCount: number;
    saving: boolean;
    onSave: () => void;
    onDiscard: () => void;
  };
  savedFlash?: boolean;
  /** Latest save-error message; announced assertively to screen readers. */
  saveError?: string;
}

export function SettingsShell({ children, saveBar, savedFlash, saveError }: Props) {
  return (
    <div className="settings-content">
      {children}

      {saveBar?.visible && (
        <div className="save-bar visible">
          <span className="save-bar-text">
            <strong>
              {saveBar.dirtyCount} unsaved {saveBar.dirtyCount === 1 ? 'change' : 'changes'}
            </strong>{' '}
            · Discard or save below
          </span>
          <div className="save-bar-spacer" />
          <button type="button" className="btn btn-secondary" onClick={saveBar.onDiscard} disabled={saveBar.saving}>
            Discard
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={saveBar.onSave}
            disabled={saveBar.saving}
            style={{ background: 'var(--rw-blue-600)' }}
          >
            {saveBar.saving ? (
              'Saving…'
            ) : (
              <>
                <Icon name="check" size={14} /> Save changes
              </>
            )}
          </button>
        </div>
      )}

      <LiveRegion message={savedFlash ? 'Settings saved' : ''} />
      <LiveRegion message={saveError ?? ''} level="assertive" />
      <div className={`saved-toast ${savedFlash ? 'visible' : ''}`}>
        <Icon name="check" size={14} /> Settings saved
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Remove the three tab props from each `SettingsShell` JSX usage**

In each of these files, delete only `activeTab=...`, `locationsSettingsEnabled=...`, and `multiLocationEnabled=...` **on the `<SettingsShell>` element** (leave `saveBar`/`savedFlash`/`saveError` and any non-shell usage of those flags intact):
- `voice/VoiceClient.tsx` — 3 `<SettingsShell>` sites (error, loading, main).
- `auto-approval/AutoApprovalClient.tsx` — 1 site (line ~164).
- `channels/ChannelsTabClient.tsx` — 3 sites (lines ~85, ~101, ~115).
- `locations/LocationsClient.tsx` — 1 site (line ~37).

In `security/page.tsx`, change the render to drop the shell tab props **and** the now-unused flag computation:

```tsx
// security/page.tsx — replace the component body
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { SecurityClient } from './SecurityClient';

export default async function SettingsSecurityPage() {
  await requireOwnerAccess();
  return (
    <>
      <TopBar
        title="Security"
        subtitle="Manage sign-in verification for this account."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <SettingsShell>
        <SecurityClient />
      </SettingsShell>
    </>
  );
}
```

- [ ] **Step 3: Typecheck + run the settings client tests**

Run: `pnpm typecheck && pnpm vitest run src/app/(authenticated)/settings`
Expected: typecheck PASS. `SettingsClient.test.tsx` and `SettingsTabs.test.tsx` may now FAIL — that is expected (both are deleted in Phase 4). Confirm the failures are only those two files.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/settings/SettingsShell.tsx src/app/(authenticated)/settings
git commit -m "refactor(settings): SettingsShell drops tab nav; layout owns it"
```

---

### Task 5: `/settings` redirect + voice un-gate

**Files:**
- Modify: `src/app/(authenticated)/settings/page.tsx`
- Modify: `src/app/(authenticated)/settings/voice/page.tsx`

- [ ] **Step 1: Replace `/settings/page.tsx` with a redirect**

```tsx
// src/app/(authenticated)/settings/page.tsx
import { redirect } from 'next/navigation';

export default function SettingsIndexPage() {
  redirect('/settings/voice');
}
```

- [ ] **Step 2: Un-gate `voice/page.tsx`**

Replace its body with (removes both `notFound()` blocks; the voice data API is account-scoped, so single-location accounts return one config):

```tsx
// src/app/(authenticated)/settings/voice/page.tsx
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { VoiceClient } from './VoiceClient';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  await requireOwnerAccess();
  return (
    <>
      <TopBar
        title="Brand Voice"
        subtitle="How RepWorth writes replies for your business."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <VoiceClient />
    </>
  );
}
```

- [ ] **Step 3: Manual smoke (single-location, flag on)**

Run: `MULTI_LOCATION_ENABLED=true MOCK_EXTERNAL_APIS=true pnpm dev` then visit `http://localhost:3000/settings`.
Expected: redirects to `/settings/voice`; Brand Voice panel renders with no location selector; sidebar shows Brand Voice active.

- [ ] **Step 4: Commit**

```bash
git add src/app/(authenticated)/settings/page.tsx src/app/(authenticated)/settings/voice/page.tsx
git commit -m "feat(settings): /settings redirects to Brand Voice; un-gate voice route"
```

---

## Phase 2 — Shared offboarding hook

### Task 6: `useOffboardingStatus`

**Files:**
- Create: `src/hooks/useOffboardingStatus.ts`
- Test: `src/hooks/__tests__/useOffboardingStatus.test.ts`

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/__tests__/useOffboardingStatus.test.ts
import { renderHook, waitFor, act } from '@testing-library/react';
import { useOffboardingStatus } from '../useOffboardingStatus';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

it('loads status on mount', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ enabled: true, activeOffboarding: null }),
  });
  const { result } = renderHook(() => useOffboardingStatus());
  await waitFor(() => expect(result.current.status).not.toBeNull());
  expect(result.current.status).toEqual({ enabled: true, activeOffboarding: null });
});

it('surfaces a load error', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'boom' }) });
  const { result } = renderHook(() => useOffboardingStatus());
  await waitFor(() => expect(result.current.loadError).toBe('boom'));
});

it('setStatus updates the local snapshot without a fetch', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ enabled: true, activeOffboarding: null }),
  });
  const { result } = renderHook(() => useOffboardingStatus());
  await waitFor(() => expect(result.current.status).not.toBeNull());
  act(() => {
    result.current.setStatus({
      enabled: true,
      activeOffboarding: { id: 'x', mode: 'cancel_only', status: 'pending' },
    });
  });
  expect(result.current.status?.activeOffboarding?.mode).toBe('cancel_only');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/hooks/__tests__/useOffboardingStatus.test.ts`
Expected: FAIL — cannot find module `../useOffboardingStatus`.

- [ ] **Step 3: Implement the hook**

```tsx
// src/hooks/useOffboardingStatus.ts
'use client';

import { useCallback, useEffect, useState } from 'react';

export interface ActiveOffboarding {
  id: string;
  mode: string;
  status: string;
  accessEndsAt?: string | Date | null;
}

export interface OffboardingStatus {
  enabled: boolean;
  activeOffboarding: ActiveOffboarding | null;
}

export interface UseOffboardingStatus {
  status: OffboardingStatus | null;
  loadError: string | null;
  setStatus: (next: OffboardingStatus) => void;
  refetch: () => void;
}

export function useOffboardingStatus(): UseOffboardingStatus {
  const [status, setStatus] = useState<OffboardingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const res = await fetch('/api/account/offboarding/status');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? body.error ?? 'Unable to load cancellation status');
      }
      const body = (await res.json()) as OffboardingStatus;
      if (!signal?.cancelled) setStatus(body);
    } catch (err) {
      if (!signal?.cancelled) {
        setLoadError(err instanceof Error ? err.message : 'Unable to load cancellation status');
      }
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  return { status, loadError, setStatus, refetch: () => void load() };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/hooks/__tests__/useOffboardingStatus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOffboardingStatus.ts src/hooks/__tests__/useOffboardingStatus.test.ts
git commit -m "feat(settings): shared useOffboardingStatus hook"
```

---

## Phase 3 — Profile route

### Task 7: `DeleteDataPanel`

**Files:**
- Create: `src/components/dashboard/settings/DeleteDataPanel.tsx`
- Test: `src/components/dashboard/settings/__tests__/DeleteDataPanel.test.tsx`

Reference: lift the delete-data half + `DeleteDataOffboardingModal` wiring from `AccountOffboardingPanel.tsx` (the `openDeleteDataModal`, `deleteDataIdempotencyKey`, `DeleteDataOffboardingModal` usage). Add the cross-tab guard for an active `cancel_only`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/dashboard/settings/__tests__/DeleteDataPanel.test.tsx
import { render, screen } from '@testing-library/react';
import { DeleteDataPanel } from '../DeleteDataPanel';
import type { OffboardingStatus } from '@/hooks/useOffboardingStatus';

vi.mock('@/hooks/useOffboardingStatus', () => ({
  useOffboardingStatus: () => mockHook,
}));
vi.mock('../DeleteDataOffboardingModal', () => ({
  DeleteDataOffboardingModal: () => <div data-testid="delete-modal" />,
}));

let mockHook: { status: OffboardingStatus | null; loadError: string | null; setStatus: () => void; refetch: () => void };
const base = { loadError: null, setStatus: vi.fn(), refetch: vi.fn() };

it('renders nothing when offboarding disabled', () => {
  mockHook = { ...base, status: { enabled: false, activeOffboarding: null } };
  const { container } = render(<DeleteDataPanel />);
  expect(container).toBeEmptyDOMElement();
});

it('shows the Delete data button when no offboarding is active', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: null } };
  render(<DeleteDataPanel />);
  expect(screen.getByRole('button', { name: /delete data/i })).toBeInTheDocument();
});

it('blocks delete when a cancellation is scheduled', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: { id: '1', mode: 'cancel_only', status: 'scheduled' } } };
  render(<DeleteDataPanel />);
  expect(screen.queryByRole('button', { name: /delete data/i })).not.toBeInTheDocument();
  expect(screen.getByText(/scheduled cancellation/i)).toBeInTheDocument();
});

it('shows in-progress when a deletion is already active', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: { id: '1', mode: 'delete_data', status: 'pending' } } };
  render(<DeleteDataPanel />);
  expect(screen.getByText(/deletion is in progress/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/components/dashboard/settings/__tests__/DeleteDataPanel.test.tsx`
Expected: FAIL — cannot find module `../DeleteDataPanel`.

- [ ] **Step 3: Implement the panel**

```tsx
// src/components/dashboard/settings/DeleteDataPanel.tsx
'use client';

import { useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { useOffboardingStatus } from '@/hooks/useOffboardingStatus';
import { DeleteDataOffboardingModal } from '@/components/dashboard/settings/DeleteDataOffboardingModal';

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `offboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function DeleteDataPanel() {
  const { status, loadError, setStatus } = useOffboardingStatus();
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  if (loadError) {
    return (
      <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
        <div style={{ fontSize: 13, color: '#B91C1C' }}>{loadError}</div>
      </div>
    );
  }
  if (!status?.enabled) return null;

  const active = status.activeOffboarding;
  const isDeleting = active?.mode === 'delete_data' || active?.mode === 'purge';
  const isCancelScheduled = active?.mode === 'cancel_only';

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon amber">
          <Icon name="alert" size={18} />
        </div>
        <div>
          <div className="set-section-title">Danger zone</div>
          <div className="set-section-sub">Permanently delete your RepWorth data.</div>
        </div>
      </div>

      {isDeleting ? (
        <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
          Data deletion is in progress. We&apos;ll email you when it completes.
        </p>
      ) : isCancelScheduled ? (
        <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
          You have a scheduled cancellation. Reactivate it, or wait until it completes, before deleting data.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
            This removes your account data and cannot be undone.
          </p>
          <button
            type="button"
            className="btn btn-danger"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setIdempotencyKey(createIdempotencyKey())}
          >
            Delete data
          </button>
        </div>
      )}

      {idempotencyKey && (
        <DeleteDataOffboardingModal
          idempotencyKey={idempotencyKey}
          onClose={() => setIdempotencyKey(null)}
          onConfirmed={(offboarding) => {
            setStatus({
              enabled: true,
              activeOffboarding: { id: offboarding.id, mode: offboarding.mode, status: offboarding.status },
            });
            setIdempotencyKey(null);
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/components/dashboard/settings/__tests__/DeleteDataPanel.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/settings/DeleteDataPanel.tsx src/components/dashboard/settings/__tests__/DeleteDataPanel.test.tsx
git commit -m "feat(settings): DeleteDataPanel danger zone (offboarding split)"
```

---

### Task 8: `ProfilePanel` + `ProfileClient` + route

**Files:**
- Create: `src/components/dashboard/settings/ProfilePanel.tsx`
- Create: `src/app/(authenticated)/settings/profile/ProfileClient.tsx`
- Create: `src/app/(authenticated)/settings/profile/page.tsx`
- Test: `src/app/(authenticated)/settings/profile/__tests__/ProfileClient.test.tsx`

- [ ] **Step 1: Write `ProfilePanel`** (locked business-profile fields from `GeneralPanel` + the danger zone)

```tsx
// src/components/dashboard/settings/ProfilePanel.tsx
'use client';

import { useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import { DeleteDataPanel } from '@/components/dashboard/settings/DeleteDataPanel';

interface Props {
  data: DashboardDataActive;
}

export function ProfilePanel({ data }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.settings.googlePlaceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <>
      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon blue">
            <Icon name="home" size={18} />
          </div>
          <div>
            <div className="set-section-title">Business profile</div>
            <div className="set-section-sub">
              Identity details from your Google listing. Reach out to support to update locked fields.
            </div>
          </div>
        </div>

        <div className="two-col">
          <div className="field">
            <label className="field-label" htmlFor="profile-business-name">
              Business name <span className="locked-pill">Locked</span>
            </label>
            <input id="profile-business-name" className="input locked" value={data.business.name} disabled readOnly />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="profile-business-category">
              Category <span className="locked-pill">Locked</span>
            </label>
            <input id="profile-business-category" className="input locked" value={data.settings.category} disabled readOnly />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="profile-google-place-id">
            Google Place ID <span className="locked-pill">Locked</span>
          </label>
          <div className="copy-row">
            <input
              id="profile-google-place-id"
              className="input locked"
              value={data.settings.googlePlaceId}
              disabled
              readOnly
              style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
            />
            <button type="button" className={`copy-btn ${copied ? 'copied' : ''}`} onClick={copy}>
              {copied ? (
                <>
                  <Icon name="check" size={12} /> Copied
                </>
              ) : (
                <>📋 Copy</>
              )}
            </button>
          </div>
        </div>
      </div>

      <DeleteDataPanel />
    </>
  );
}
```

- [ ] **Step 2: Write `ProfileClient`** (reuses `useSettingsForm` for the dashboard data)

```tsx
// src/app/(authenticated)/settings/profile/ProfileClient.tsx
'use client';

import { useSettingsForm } from '@/hooks/useSettingsForm';
import { ProfilePanel } from '@/components/dashboard/settings/ProfilePanel';
import { SettingsSkeleton } from '@/components/dashboard/settings/SettingsSkeleton';

export function ProfileClient() {
  const f = useSettingsForm();

  if (f.fetchError) {
    return (
      <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
        <div className="set-section-title" style={{ color: '#991B1B' }}>Error</div>
        <p style={{ fontSize: 13, color: '#B91C1C' }}>{f.fetchError}</p>
      </div>
    );
  }
  if (!f.data) {
    return <SettingsSkeleton />;
  }
  return <ProfilePanel data={f.data} />;
}
```

- [ ] **Step 3: Write the route page**

```tsx
// src/app/(authenticated)/settings/profile/page.tsx
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { ProfileClient } from './ProfileClient';

export default async function ProfilePage() {
  await requireOwnerAccess();
  return (
    <>
      <TopBar
        title="Profile"
        subtitle="Your business identity and account."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <ProfileClient />
    </>
  );
}
```

- [ ] **Step 4: Write the render test**

```tsx
// src/app/(authenticated)/settings/profile/__tests__/ProfileClient.test.tsx
import { render, screen } from '@testing-library/react';
import { ProfileClient } from '../ProfileClient';

const mockForm = { fetchError: null as string | null, data: null as unknown };
vi.mock('@/hooks/useSettingsForm', () => ({ useSettingsForm: () => mockForm }));
vi.mock('@/components/dashboard/settings/DeleteDataPanel', () => ({
  DeleteDataPanel: () => <div data-testid="delete-data" />,
}));

it('renders the skeleton while loading', () => {
  mockForm.data = null;
  mockForm.fetchError = null;
  render(<ProfileClient />);
  expect(document.querySelector('.set-section, [class*="skeleton"]')).toBeTruthy();
});

it('renders locked profile fields + danger zone once loaded', () => {
  mockForm.fetchError = null;
  mockForm.data = {
    business: { name: 'Acme Cafe' },
    settings: { category: 'Cafe', googlePlaceId: 'ChIJ123' },
  };
  render(<ProfileClient />);
  expect(screen.getByDisplayValue('Acme Cafe')).toBeInTheDocument();
  expect(screen.getByDisplayValue('ChIJ123')).toBeInTheDocument();
  expect(screen.getByTestId('delete-data')).toBeInTheDocument();
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/app/(authenticated)/settings/profile`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/components/dashboard/settings/ProfilePanel.tsx "src/app/(authenticated)/settings/profile"
git commit -m "feat(settings): Profile route (business profile + delete-data danger zone)"
```

---

## Phase 4 — Billing route

### Task 9: `CancelSubscriptionPanel`

**Files:**
- Create: `src/components/dashboard/settings/CancelSubscriptionPanel.tsx`
- Test: `src/components/dashboard/settings/__tests__/CancelSubscriptionPanel.test.tsx`

Reference: lift the cancel + reactivate half from `AccountOffboardingPanel.tsx` (the `confirmState` modal with `REASON_OPTIONS`, `confirmCancellation`, `reactivate`, `formatAccessEnd`, the `isScheduledCancelOnly`/`isPendingCancelOnly` branches). Add the `delete_data`-active guard.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/dashboard/settings/__tests__/CancelSubscriptionPanel.test.tsx
import { render, screen } from '@testing-library/react';
import { CancelSubscriptionPanel } from '../CancelSubscriptionPanel';
import type { OffboardingStatus } from '@/hooks/useOffboardingStatus';

let mockHook: { status: OffboardingStatus | null; loadError: string | null; setStatus: () => void; refetch: () => void };
const base = { loadError: null, setStatus: vi.fn(), refetch: vi.fn() };
vi.mock('@/hooks/useOffboardingStatus', () => ({ useOffboardingStatus: () => mockHook }));

it('renders nothing when offboarding disabled', () => {
  mockHook = { ...base, status: { enabled: false, activeOffboarding: null } };
  const { container } = render(<CancelSubscriptionPanel accountTimeZone="UTC" />);
  expect(container).toBeEmptyDOMElement();
});

it('shows the Cancel subscription button when no offboarding is active', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: null } };
  render(<CancelSubscriptionPanel accountTimeZone="UTC" />);
  expect(screen.getByRole('button', { name: /cancel subscription/i })).toBeInTheDocument();
});

it('shows reactivate UI when a cancellation is scheduled', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: { id: '1', mode: 'cancel_only', status: 'scheduled', accessEndsAt: '2026-07-01T00:00:00Z' } } };
  render(<CancelSubscriptionPanel accountTimeZone="UTC" />);
  expect(screen.getByRole('button', { name: /keep subscription active/i })).toBeInTheDocument();
});

it('disables cancel when a data deletion is active', () => {
  mockHook = { ...base, status: { enabled: true, activeOffboarding: { id: '1', mode: 'delete_data', status: 'pending' } } };
  render(<CancelSubscriptionPanel accountTimeZone="UTC" />);
  expect(screen.queryByRole('button', { name: /cancel subscription/i })).not.toBeInTheDocument();
  expect(screen.getByText(/deletion is in progress/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/components/dashboard/settings/__tests__/CancelSubscriptionPanel.test.tsx`
Expected: FAIL — cannot find module `../CancelSubscriptionPanel`.

- [ ] **Step 3: Implement the panel**

```tsx
// src/components/dashboard/settings/CancelSubscriptionPanel.tsx
'use client';

import { useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { useOffboardingStatus } from '@/hooks/useOffboardingStatus';

type ReasonCode = 'too_expensive' | 'missing_features' | 'switched_service' | 'unused' | 'other';

const REASON_OPTIONS: Array<{ value: ReasonCode; label: string }> = [
  { value: 'too_expensive', label: 'Too expensive' },
  { value: 'missing_features', label: 'Missing features' },
  { value: 'switched_service', label: 'Switched service' },
  { value: 'unused', label: 'Not using it enough' },
  { value: 'other', label: 'Other' },
];

interface Props {
  accountTimeZone?: string | null;
  onAccountRefetch?: () => void;
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `offboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatAccessEnd(value: string | Date | null | undefined, timeZone?: string | null): string {
  if (!value) return 'the paid-through date';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'the paid-through date';
  // react-doctor-disable-next-line react-doctor/js-hoist-intl
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: timeZone || 'UTC', timeZoneName: 'short',
  }).format(date);
}

export function CancelSubscriptionPanel({ accountTimeZone, onAccountRefetch }: Props) {
  const { status, loadError, setStatus } = useOffboardingStatus();
  const [confirmState, setConfirmState] = useState<{
    idempotencyKey: string;
    reasonCode: ReasonCode | null;
    submitting: boolean;
    error: string | null;
  } | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [reactivateError, setReactivateError] = useState<string | null>(null);

  if (loadError) {
    return (
      <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
        <div style={{ fontSize: 13, color: '#B91C1C' }}>{loadError}</div>
      </div>
    );
  }
  if (!status?.enabled) return null;

  const active = status.activeOffboarding;
  const isScheduledCancelOnly = active?.mode === 'cancel_only' && active.status === 'scheduled';
  const isPendingCancelOnly = active?.mode === 'cancel_only' && active.status === 'pending';
  const isDeleting = active?.mode === 'delete_data' || active?.mode === 'purge';
  const accessEndLabel = isScheduledCancelOnly ? formatAccessEnd(active?.accessEndsAt, accountTimeZone) : null;

  async function confirmCancellation() {
    if (!confirmState) return;
    setConfirmState({ ...confirmState, submitting: true, error: null });
    try {
      const res = await fetch('/api/account/offboarding/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': confirmState.idempotencyKey },
        body: JSON.stringify({ mode: 'cancel_only', ...(confirmState.reasonCode ? { reasonCode: confirmState.reasonCode } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? body.error ?? 'Unable to schedule cancellation');
      setStatus({ enabled: true, activeOffboarding: body.offboarding ?? { id: 'pending', mode: 'cancel_only', status: 'pending' } });
      setConfirmState(null);
      onAccountRefetch?.();
    } catch (err) {
      setConfirmState((current) => current ? { ...current, submitting: false, error: err instanceof Error ? err.message : 'Unable to schedule cancellation' } : current);
    }
  }

  async function reactivate() {
    setReactivating(true);
    setReactivateError(null);
    try {
      const res = await fetch('/api/account/offboarding/reactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': createIdempotencyKey() },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? body.error ?? 'Unable to reactivate subscription');
      setStatus({ enabled: true, activeOffboarding: null });
      onAccountRefetch?.();
    } catch (err) {
      setReactivateError(err instanceof Error ? err.message : 'Unable to reactivate subscription');
    } finally {
      setReactivating(false);
    }
  }

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon amber">
          <Icon name="alert" size={18} />
        </div>
        <div>
          <div className="set-section-title">Cancel subscription</div>
          <div className="set-section-sub">Schedule cancellation for the end of your current paid period.</div>
        </div>
      </div>

      {isDeleting ? (
        <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
          Data deletion is in progress; there is nothing left to cancel.
        </p>
      ) : isScheduledCancelOnly ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
            Access stays active until {accessEndLabel}. You can keep your subscription active before that time.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn btn-primary" onClick={() => void reactivate()} disabled={reactivating}>
              {reactivating ? 'Reactivating…' : 'Keep subscription active'}
            </button>
            {reactivateError && <span style={{ fontSize: 12, color: '#DC2626' }}>{reactivateError}</span>}
          </div>
        </div>
      ) : isPendingCancelOnly ? (
        <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
          Cancellation is being scheduled with Stripe. Your account remains active while we confirm the paid-through date.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
            You keep full access through the paid-through period. At the end, RepWorth stops processing reviews and keeps your account data retained.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setConfirmState({ idempotencyKey: createIdempotencyKey(), reasonCode: null, submitting: false, error: null })}
          >
            Cancel subscription
          </button>
        </div>
      )}

      {confirmState && (
        <SettingsModal title="Cancel subscription" closeLabel="Close cancellation dialog" onClose={() => { if (!confirmState.submitting) setConfirmState(null); }}>
          <div className="set-section-title" style={{ marginBottom: 8 }}>Cancel at period end?</div>
          <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.5, marginBottom: 12 }}>
            You keep normal access until the paid-through date from Stripe. You can reactivate before access ends.
          </p>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <legend style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Main reason</legend>
            <div style={{ display: 'grid', gap: 6 }}>
              {REASON_OPTIONS.map((option) => (
                <label key={option.value} style={{ display: 'flex', gap: 8, fontSize: 13, color: '#374151' }}>
                  <input
                    type="radio"
                    name="offboarding-reason"
                    value={option.value}
                    checked={confirmState.reasonCode === option.value}
                    onChange={() => setConfirmState({ ...confirmState, reasonCode: option.value })}
                    disabled={confirmState.submitting}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          {confirmState.error && <div style={{ fontSize: 12, color: '#DC2626', marginBottom: 12 }}>{confirmState.error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmState(null)} disabled={confirmState.submitting}>Keep account</button>
            <button type="button" className="btn btn-danger" onClick={() => void confirmCancellation()} disabled={confirmState.submitting}>
              {confirmState.submitting ? 'Scheduling…' : 'Confirm cancellation'}
            </button>
          </div>
        </SettingsModal>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/components/dashboard/settings/__tests__/CancelSubscriptionPanel.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/settings/CancelSubscriptionPanel.tsx src/components/dashboard/settings/__tests__/CancelSubscriptionPanel.test.tsx
git commit -m "feat(settings): CancelSubscriptionPanel (offboarding split)"
```

---

### Task 10: `BillingPanel` + `BillingClient` + route

**Files:**
- Create: `src/components/dashboard/settings/BillingPanel.tsx`
- Create: `src/app/(authenticated)/settings/billing/BillingClient.tsx`
- Create: `src/app/(authenticated)/settings/billing/page.tsx`
- Test: `src/app/(authenticated)/settings/billing/__tests__/BillingClient.test.tsx`

- [ ] **Step 1: Build `BillingPanel`** by extracting from `AccountPanel.tsx`

Create `BillingPanel.tsx`. Move **verbatim** from `AccountPanel.tsx`: the `TIER_OPTIONS` const, the `BillingPreview`/`TierChangeState`/`TierChangeAction` types, `initialTierChangeState`, `tierChangeReducer`, `TierChangeModal`, `QuotaBar`, and `PlanCard`. Then the panel body is the **Subscription & billing** `set-section` plus the tier-change handlers — lifted from `AccountPanel` minus the business-profile section and the old `AccountOffboardingPanel`, with `CancelSubscriptionPanel` appended:

```tsx
// src/components/dashboard/settings/BillingPanel.tsx
'use client';

import { useReducer } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { AccountSettingsData } from '@/hooks/useAccountData';
import { SubscriptionTier, type SubscriptionTierValue, TIER_CONFIG } from '@/lib/accounts/tier-config';
import { CancelSubscriptionPanel } from '@/components/dashboard/settings/CancelSubscriptionPanel';

// ── MOVE VERBATIM FROM AccountPanel.tsx ───────────────────────────────────
// TIER_OPTIONS, BillingPreview, TierChangeState, TierChangeAction,
// initialTierChangeState, tierChangeReducer, TierChangeModal, QuotaBar, PlanCard
// (paste them here unchanged)
// ──────────────────────────────────────────────────────────────────────────

interface Props {
  accountData: AccountSettingsData | null;
  accountLoading: boolean;
  accountError: string | null;
  onAccountRefetch: () => void;
}

export function BillingPanel({ accountData, accountLoading, accountError, onAccountRefetch }: Props) {
  const [tierChange, dispatch] = useReducer(tierChangeReducer, initialTierChangeState);
  const { selectedTier, billingPreview, previewLoading, previewError, changing, tierChangeError } = tierChange;

  async function openTierChangeModal(newTier: SubscriptionTierValue) {
    if (!accountData) return;
    dispatch({ type: 'previewStart', selectedTier: newTier });
    try {
      const res = await fetch('/api/billing/tier-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accountData.accountId, newTier, preview: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        dispatch({ type: 'previewError', previewError: body.error ?? body.detail ?? `Tier change not allowed (${res.status})` });
        dispatch({ type: 'previewFinish' });
        return;
      }
      const result = await res.json();
      dispatch({ type: 'previewSuccess', billingPreview: result.newBilling ?? null });
    } catch (err) {
      dispatch({ type: 'previewError', previewError: err instanceof Error ? err.message : 'Failed to preview tier change' });
    } finally {
      dispatch({ type: 'previewFinish' });
    }
  }

  async function confirmTierChange() {
    if (!accountData || !selectedTier) return;
    dispatch({ type: 'confirmStart' });
    try {
      const res = await fetch('/api/billing/tier-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ accountId: accountData.accountId, newTier: selectedTier }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? body.detail ?? 'Tier change failed');
      }
      dispatch({ type: 'confirmSuccess' });
      onAccountRefetch();
    } catch (err) {
      dispatch({ type: 'confirmError', tierChangeError: err instanceof Error ? err.message : 'Failed to change tier' });
    } finally {
      dispatch({ type: 'confirmFinish' });
    }
  }

  const currentTier = (accountData?.subscription?.tier ?? 'standard') as SubscriptionTierValue;
  const otherTiers = TIER_OPTIONS.filter((t) => t !== currentTier);
  const upgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents > TIER_CONFIG[currentTier].baseCents);
  const downgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents < TIER_CONFIG[currentTier].baseCents);

  return (
    <>
      <div id="subscription-billing" className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon violet">
            <Icon name="chart" size={18} />
          </div>
          <div>
            <div className="set-section-title">Subscription &amp; billing</div>
            <div className="set-section-sub">Your plan, billing details, and location quota.</div>
          </div>
        </div>

        {accountLoading && (
          <p style={{ textAlign: 'center', color: 'var(--rw-app-text-muted)', padding: '24px 0' }}>Loading account data…</p>
        )}
        {accountError && <div style={{ fontSize: 13, color: 'var(--rw-danger)', padding: '8px 0' }}>{accountError}</div>}
        {accountData && (
          <>
            <PlanCard subscription={accountData.subscription} billing={accountData.billing} accountId={accountData.accountId} />

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-app-text)', marginBottom: 8 }}>Locations quota</div>
              <QuotaBar activeLocations={accountData.quota.activeLocations} included={accountData.quota.included} overage={accountData.quota.overage} />
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-app-text)', marginBottom: 8 }}>Change plan</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {downgradableTiers.map((tier) => (
                  <button key={tier} type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => openTierChangeModal(tier)}>
                    Downgrade to {tier.charAt(0).toUpperCase() + tier.slice(1)} (${(TIER_CONFIG[tier].baseCents / 100).toFixed(0)}/mo)
                  </button>
                ))}
                {upgradableTiers.map((tier) => (
                  <button key={tier} type="button" className="btn btn-primary" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => openTierChangeModal(tier)}>
                    Upgrade to {tier.charAt(0).toUpperCase() + tier.slice(1)} (${(TIER_CONFIG[tier].baseCents / 100).toFixed(0)}/mo)
                  </button>
                ))}
              </div>
              {tierChangeError && <div style={{ fontSize: 12, color: 'var(--rw-danger)', marginTop: 4 }}>{tierChangeError}</div>}
            </div>
          </>
        )}
      </div>

      <CancelSubscriptionPanel accountTimeZone={accountData?.timeZone ?? 'UTC'} onAccountRefetch={onAccountRefetch} />

      {selectedTier && accountData && (
        <TierChangeModal
          currentTier={currentTier}
          newTier={selectedTier}
          accountId={accountData.accountId}
          billingPreview={billingPreview}
          previewLoading={previewLoading}
          previewError={previewError}
          onConfirm={confirmTierChange}
          onCancel={() => dispatch({ type: 'closeModal' })}
          changing={changing}
        />
      )}
    </>
  );
}
```

> Note: keep the `SubscriptionTier` import only if a moved subcomponent references it; otherwise drop it to satisfy `no-unused-vars`. Run typecheck after pasting.

- [ ] **Step 2: Build `BillingClient`**

```tsx
// src/app/(authenticated)/settings/billing/BillingClient.tsx
'use client';

import { useAccountData } from '@/hooks/useAccountData';
import { BillingPanel } from '@/components/dashboard/settings/BillingPanel';

export function BillingClient() {
  const account = useAccountData();
  return (
    <BillingPanel
      accountData={account.data}
      accountLoading={account.loading}
      accountError={account.error}
      onAccountRefetch={account.refetch}
    />
  );
}
```

- [ ] **Step 3: Build the route page**

```tsx
// src/app/(authenticated)/settings/billing/page.tsx
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { BillingClient } from './BillingClient';

export default async function BillingPage() {
  await requireOwnerAccess();
  return (
    <>
      <TopBar
        title="Billing"
        subtitle="Your plan, location quota, and subscription."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <BillingClient />
    </>
  );
}
```

- [ ] **Step 4: Write the render test**

```tsx
// src/app/(authenticated)/settings/billing/__tests__/BillingClient.test.tsx
import { render, screen } from '@testing-library/react';
import { BillingClient } from '../BillingClient';

const accountData = {
  accountId: 'acc1',
  displayName: 'Acme',
  subscription: { tier: 'standard', tierLabel: 'Standard', status: 'active', statusLabel: 'Active', stripeCustomerId: 'cus_1', activatedAt: null, trialEndsAt: null },
  quota: { activeLocations: 1, included: 3, paid: 3, overage: 0 },
  billing: { basePriceCents: 9900, overagePriceCents: 0, overageUnits: 0, totalCents: 9900 },
  timeZone: 'UTC',
};
vi.mock('@/hooks/useAccountData', () => ({
  useAccountData: () => ({ data: accountData, loading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@/components/dashboard/settings/CancelSubscriptionPanel', () => ({
  CancelSubscriptionPanel: () => <div data-testid="cancel-sub" />,
}));

it('renders the plan + quota + cancel panel', () => {
  render(<BillingClient />);
  expect(screen.getByText(/subscription & billing/i)).toBeInTheDocument();
  expect(screen.getByText(/locations quota/i)).toBeInTheDocument();
  expect(screen.getByTestId('cancel-sub')).toBeInTheDocument();
});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run src/app/(authenticated)/settings/billing && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/settings/BillingPanel.tsx "src/app/(authenticated)/settings/billing"
git commit -m "feat(settings): Billing route (plan, quota, tier change, cancel)"
```

---

### Task 11: Stripe portal `return_url`

**Files:**
- Modify: `src/app/api/billing/portal/route.ts:138`
- Modify: `src/app/api/billing/__tests__/portal.test.ts:232`

- [ ] **Step 1: Update the return_url**

In `src/app/api/billing/portal/route.ts`, change:

```ts
      return_url: `${baseUrl}/settings`,
```
to:
```ts
      return_url: `${baseUrl}/settings/billing`,
```

- [ ] **Step 2: Update the test expectation**

In `portal.test.ts`, change the assertion `expect.stringContaining('/settings')` to `expect.stringContaining('/settings/billing')`.

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run src/app/api/billing/__tests__/portal.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/billing/portal/route.ts src/app/api/billing/__tests__/portal.test.ts
git commit -m "fix(billing): return from Stripe portal to /settings/billing"
```

---

## Phase 5 — Delete legacy + verify

### Task 12: Delete the retired files

**Files (delete):**
- `src/components/dashboard/shell/SettingsTabs.tsx`
- `src/components/dashboard/__tests__/SettingsTabs.test.tsx`
- `src/components/dashboard/settings/GeneralPanel.tsx`
- `src/components/dashboard/settings/AccountPanel.tsx`
- `src/components/dashboard/settings/AccountOffboardingPanel.tsx`
- `src/app/(authenticated)/settings/SettingsClient.tsx`
- `src/app/(authenticated)/settings/__tests__/SettingsClient.test.tsx`
- any `__tests__/AccountPanel.test.tsx` / `AccountOffboardingPanel.test.tsx`

- [ ] **Step 1: Confirm no remaining importers**

Run:
```bash
grep -rn "SettingsTabs\|GeneralPanel\|AccountPanel\|AccountOffboardingPanel\|settings/SettingsClient" src --include="*.ts" --include="*.tsx" | grep -v "settings/SettingsSidebar"
```
Expected: no matches outside the files being deleted. If any appear (e.g. a stray import), fix them before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm src/components/dashboard/shell/SettingsTabs.tsx \
  src/components/dashboard/__tests__/SettingsTabs.test.tsx \
  src/components/dashboard/settings/GeneralPanel.tsx \
  src/components/dashboard/settings/AccountPanel.tsx \
  src/components/dashboard/settings/AccountOffboardingPanel.tsx \
  "src/app/(authenticated)/settings/SettingsClient.tsx" \
  "src/app/(authenticated)/settings/__tests__/SettingsClient.test.tsx"
# also remove AccountPanel/AccountOffboardingPanel tests if present:
git rm -f src/components/dashboard/settings/__tests__/AccountPanel.test.tsx 2>/dev/null || true
git rm -f src/components/dashboard/settings/__tests__/AccountOffboardingPanel.test.tsx 2>/dev/null || true
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no dangling imports).

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(settings): remove legacy tab nav + Account/General panels"
```

---

### Task 13: Update the directory map + final verification

**Files:**
- Modify: `docs/directory.md` (settings routes section — add `profile/`, `billing/`, `layout.tsx`; note Brand Voice is the index redirect target).

- [ ] **Step 1: Update `docs/directory.md`**

Find the settings rows and reflect: `/settings` → redirect to `/settings/voice`; new `settings/layout.tsx` (sidebar); new `settings/profile/` and `settings/billing/`; voice no longer flag-gated; `SettingsTabs`/`GeneralPanel`/`AccountPanel`/`AccountOffboardingPanel` removed; offboarding split into `DeleteDataPanel` (Profile) + `CancelSubscriptionPanel` (Billing).

- [ ] **Step 2: Full local gate**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm test
```
Expected: all PASS. No references to the deleted components remain.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: succeeds; `/settings`, `/settings/voice`, `/settings/profile`, `/settings/billing` all compile.

- [ ] **Step 4: E2E (best-effort, skips without DB)**

Run: `pnpm test:e2e`
Expected: PASS or graceful skip. If `e2e/multi-location.spec.ts` asserts the old anchor/tab nav or a voice-route 404, update it to the new sidebar + un-gated voice.

- [ ] **Step 5: Commit + open PR**

```bash
git add docs/directory.md
git commit -m "docs(directory): settings IA — sidebar, profile + billing routes"
git push -u origin <branch>
gh pr create --fill
```

---

## Self-Review

**Spec coverage:**
- Separate Account & Brand Voice → Tasks 5, 8 (Brand Voice is its own un-gated route; Profile is a distinct route). ✓
- Billing in its own tab → Tasks 9, 10. ✓
- Optimize UX (one IA + sidebar) → Tasks 1–4 (sidebar/layout), Task 12 (kill divergence). ✓
- Offboarding split with cross-tab coherence → Tasks 6, 7, 9. ✓
- Stripe portal return → Task 11. ✓

**Type consistency:** `OffboardingStatus`/`ActiveOffboarding` defined in Task 6 are imported by Tasks 7 & 9. `AccountSettingsData` (from `useAccountData`) used by `BillingPanel`/`BillingClient`. `DashboardDataActive` used by `ProfilePanel`/`ProfileClient`. `SettingsShell` prop shape (Task 4) matches the `saveBar`/`savedFlash`/`saveError` usage left in `VoiceClient`/`AutoApprovalClient`/`ChannelsTabClient`/`LocationsClient`.

**Constraint check:** `MULTI_LOCATION_ENABLED` must stay `true` in prod (voice un-gated, single canonical IA). Vercel-UI-only invariant respected (all UI routes; no LLM/external calls added). No new `NEXT_PUBLIC_*` flag; no client access to `auto_approval_policies`.

**Open follow-up (not in scope):** `AutoApprovalClient`/`ChannelsTabClient`/`LocationsClient` still receive `locationsSettingsEnabled`/`multiLocationEnabled` for their content — unchanged here. If a later pass removes flag-driven content branching, revisit those props then.
