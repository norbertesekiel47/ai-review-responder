# Brand + Complete the Approval Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin and complete the public approval loop (`approve/[token]/page.tsx` + `approval-client.tsx`) into the RepWorth island system, with an action-aware success state, recovery on every error state, and `robots: noindex`.

**Architecture:** Reuse the existing `PageShell` island (no `overflow:hidden`) with a minimal teal brand header. A new shared presentational `ApprovalErrorState` owns the error+recovery UX for both the server page (token pre-check failures) and the client (post-load failures). The client gains an action-aware success state and a labeled edit textarea, and drops the dashboard-private `Icon` import for an inline SVG.

**Tech Stack:** Next.js 16 App Router (server + `'use client'` components), `motion/react`, Tailwind (RepWorth tokens), Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-05-28-approval-loop-brand-design.md`

**Conventions for every task:**
- Run a single test file with `pnpm vitest run <path>` (use quotes around the bracketed route path).
- Recovery/success links are plain `<a href>` anchors (matching `SiteNav`'s `<a href="/pricing">`) — these are cross-context hard navigations, and it keeps unit tests router-free.
- Only RepWorth tokens (`#D2E0D3` sage, `#97B3AE` teal, `#F2C3B9`, `#D6CBBF`, `#F0EEEA`, `#2a2a2a`, `#6a6a6a`). Semantic red `#dc2626`/`#b91c1c` is allowed for error glyphs only (auth-island precedent). No amber/orange/yellow.

---

### Task 1: `ApprovalErrorState` shared component

**Files:**
- Create: `src/components/approval/ApprovalErrorState.tsx`
- Test: `src/components/approval/__tests__/ApprovalErrorState.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/approval/__tests__/ApprovalErrorState.test.tsx`:

```tsx
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApprovalErrorState } from '../ApprovalErrorState';

describe('ApprovalErrorState', () => {
  it('shows the message plus dashboard and support recovery links', () => {
    render(<ApprovalErrorState message="This approval link has expired." />);

    expect(
      screen.getByText('This approval link has expired.'),
    ).toBeInTheDocument();

    const dashboard = screen.getByRole('link', { name: /dashboard/i });
    expect(dashboard).toHaveAttribute('href', '/dashboard');

    const support = screen.getByRole('link', { name: /contact support/i });
    expect(support).toHaveAttribute('href', '/help/contact');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/approval/__tests__/ApprovalErrorState.test.tsx`
Expected: FAIL — cannot resolve `../ApprovalErrorState`.

- [ ] **Step 3: Write the component**

Create `src/components/approval/ApprovalErrorState.tsx`:

```tsx
// Branded error + recovery island body for the public approval page.
// Shared by the server page (token pre-check failures) and the client
// component (post-load fetch/session failures) so the recovery UX has one owner.
// Presentational only — no hooks, no 'use client' — so it renders on both sides.

const DASHBOARD_HREF = '/dashboard';
const SUPPORT_HREF = '/help/contact';

export function ApprovalErrorState({ message }: { message: string }) {
  return (
    <div role="alert" className="text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#dc2626]/10">
        <svg
          className="h-7 w-7 text-[#dc2626]"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
          />
        </svg>
      </div>
      <p className="text-lg font-medium leading-relaxed text-[#2a2a2a]">
        {message}
      </p>
      <a
        href={DASHBOARD_HREF}
        className="mt-6 inline-block rounded-full bg-[#97B3AE] px-6 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-[#97B3AE]/90"
      >
        Go to your dashboard →
      </a>
      <p className="mt-4 text-sm text-[#6a6a6a]">
        Need a hand?{' '}
        <a href={SUPPORT_HREF} className="font-semibold text-[#97B3AE] underline">
          Contact support
        </a>
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/approval/__tests__/ApprovalErrorState.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/components/approval/ApprovalErrorState.tsx src/components/approval/__tests__/ApprovalErrorState.test.tsx
git commit -m "feat(approval): add shared ApprovalErrorState recovery component"
```

---

### Task 2: Re-skin + complete `approval-client.tsx`

**Files:**
- Modify: `src/components/approval/approval-client.tsx` (full rewrite of imports + render; fetch/session/action logic preserved)
- Test: `src/components/approval/__tests__/approval-client.test.tsx` (keep existing test, add four)

This task covers: token re-skin, inline location SVG (drop `@/components/dashboard/Icon`), labeled edit textarea, `sr-only` star rating, action-aware success state with dashboard link, and error-state delegation to `ApprovalErrorState`.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/components/approval/__tests__/approval-client.test.tsx` with:

```tsx
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalClient from '../approval-client';

const REVIEW_DATA = {
  review: {
    reviewerName: 'Alex',
    starRating: 5,
    reviewText: 'Great visit.',
    reviewDate: '2026-05-25T12:00:00Z',
  },
  response: {
    responseText: 'Thanks for visiting.',
    version: 2,
    status: 'pending_approval',
  },
  businessName: 'RepWorth Demo',
  locationLabel: 'Main Street',
  isArchived: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

// fetch mock: GET token -> review data, POST /session -> ok,
// POST /<action> -> the provided action response.
function stubFetch(actionResponse?: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/session')) {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (url.endsWith('/approve') || url.endsWith('/edit') || url.endsWith('/regenerate')) {
      const r = actionResponse ?? { ok: true, status: 200, body: {} };
      return { ok: r.ok, status: r.status, json: async () => r.body } as Response;
    }
    return { ok: true, status: 200, json: async () => REVIEW_DATA } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ApprovalClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('discloses that the draft was generated by AI before approval actions', async () => {
    stubFetch();
    render(<ApprovalClient token="raw-token" />);

    expect(
      await screen.findByText(
        'Draft generated by AI. Review carefully before approving.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('exposes the star rating to screen readers', async () => {
    stubFetch();
    render(<ApprovalClient token="raw-token" />);

    expect(await screen.findByText('5 out of 5 stars')).toBeInTheDocument();
  });

  it('labels the edit textarea', async () => {
    stubFetch();
    render(<ApprovalClient token="raw-token" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Edit your response')).toBeInTheDocument();
  });

  it('shows an action-aware success state with a dashboard link after approving', async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: { success: true, message: "Response approved! We'll post it to Google shortly." },
    });
    render(<ApprovalClient token="raw-token" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Response approved!')).toBeInTheDocument();
    expect(
      screen.getByText("Response approved! We'll post it to Google shortly."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /view your reviews/i }),
    ).toHaveAttribute('href', '/dashboard');
  });

  it('renders dashboard + support recovery when the page fails to load', async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: false, status: 410, json: async () => ({ error: 'This link has expired' }) }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ApprovalClient token="raw-token" />);

    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /dashboard/i }),
    ).toHaveAttribute('href', '/dashboard');
    expect(
      screen.getByRole('link', { name: /contact support/i }),
    ).toHaveAttribute('href', '/help/contact');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/approval/__tests__/approval-client.test.tsx`
Expected: the AI-disclosure test still PASSES; the four new tests FAIL (no `5 out of 5 stars` text, no `Edit your response` label, no success heading, no recovery links).

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `src/components/approval/approval-client.tsx` with:

```tsx
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
import { ApprovalErrorState } from './ApprovalErrorState';

interface ReviewData {
  review: {
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
    reviewDate: string;
  };
  response: {
    responseText: string;
    version: number;
    status: string;
  };
  businessName: string;
  locationLabel: string;
  isArchived: boolean;
  expiresAt: string;
}

type ApprovalAction = 'approve' | 'edit' | 'regenerate';

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)__csrf=([^;]*)/);
  return match?.[1] ?? '';
}

function renderStars(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function LocationPin() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

const PRIMARY_BTN =
  'flex-1 rounded-full bg-[#97B3AE] px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-[#97B3AE]/90 disabled:opacity-50';
const GHOST_BTN =
  'flex-1 rounded-full border border-[#97B3AE]/30 bg-white px-4 py-3 text-sm font-semibold text-[#97B3AE] transition hover:bg-[#F0EEEA] disabled:opacity-50';

export default function ApprovalClient({ token }: { token: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editedText, setEditedText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [successAction, setSuccessAction] = useState<ApprovalAction | null>(null);
  // Guard against same-tick double-click: setActionLoading(true) queues a
  // re-render, so between the first click and the button becoming disabled
  // a second click can fire. The ref reads synchronously and closes that gap.
  const actionLockRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const res = await fetch(`/api/approve/${token}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const json: ReviewData = await res.json();
        if (cancelled) return;
        setData(json);
        setEditedText(json.response.responseText);

        // Bind device session — fail the page if binding fails
        const csrf = getCsrfToken();
        const sessionRes = await fetch(`/api/approve/${token}/session`, {
          method: 'POST',
          headers: { 'x-csrf-token': csrf },
        });
        if (!sessionRes.ok) {
          const sessionBody = await sessionRes.json().catch(() => ({}));
          throw new Error(sessionBody.error ?? 'Session binding failed');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAction = useCallback(
    async (action: ApprovalAction) => {
      if (actionLockRef.current) return;
      actionLockRef.current = true;
      setActionLoading(true);
      setError(null);

      try {
        const csrf = getCsrfToken();
        const url = `/api/approve/${token}/${action}`;
        const body =
          action === 'edit' ? JSON.stringify({ editedText }) : undefined;

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'x-csrf-token': csrf,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body,
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }

        setSuccessAction(action);
        setSuccessMessage(json.message);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setActionLoading(false);
        actionLockRef.current = false;
      }
    },
    [token, editedText],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#97B3AE] border-t-transparent" />
      </div>
    );
  }

  if (successMessage) {
    const heading =
      successAction === 'regenerate'
        ? 'New draft on the way'
        : 'Response approved!';
    return (
      <motion.div
        role="status"
        aria-live="polite"
        className="text-center"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#97B3AE]/15">
          <svg
            className="h-7 w-7 text-[#97B3AE]"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4.5 12.75l6 6 9-13.5"
            />
          </svg>
        </div>
        <h2 className="text-xl font-medium text-[#2a2a2a]">{heading}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[#6a6a6a]">
          {successMessage}
        </p>
        <a
          href="/dashboard"
          className="mt-6 inline-block text-sm font-semibold text-[#97B3AE] underline"
        >
          View your reviews →
        </a>
      </motion.div>
    );
  }

  if (error && !data) {
    return <ApprovalErrorState message={error} />;
  }

  if (!data) return null;

  const { review, response } = data;
  const timeLeft = new Date(data.expiresAt).getTime() - Date.now();
  const hoursLeft = Math.max(0, Math.round(timeLeft / 3_600_000));

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-[#dc2626]/30 bg-[#dc2626]/5 p-3 text-sm text-[#b91c1c]"
        >
          {error}
        </div>
      )}

      {/* Location context chip — VAL-APPROVAL-001/004 */}
      <div className="flex items-center gap-2">
        <span className="inline-flex max-w-[180px] items-center gap-1 truncate whitespace-nowrap rounded-full bg-[#97B3AE]/15 px-2.5 py-0.5 text-[11px] font-semibold text-[#5e7d77]">
          <LocationPin />
          {data.locationLabel}
        </span>
        {data.isArchived && (
          <span className="inline-flex items-center rounded-full bg-[#D6CBBF]/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#6a6a6a]">
            Archived
          </span>
        )}
      </div>

      {/* Review card */}
      <div className="rounded-2xl border border-[#97B3AE]/15 bg-[#F0EEEA]/60 p-4">
        <div className="text-lg tracking-wider text-[#97B3AE]" aria-hidden="true">
          {renderStars(review.starRating)}
        </div>
        <span className="sr-only">{review.starRating} out of 5 stars</span>
        <p className="mt-1 text-sm font-semibold text-[#2a2a2a]">
          {review.reviewerName} &middot; {formatDate(review.reviewDate)}
        </p>
        {review.reviewText ? (
          <p className="mt-2 text-sm leading-relaxed text-[#6a6a6a]">
            {review.reviewText}
          </p>
        ) : (
          <p className="mt-2 text-sm italic text-[#6a6a6a]/70">
            Rating only — no written review
          </p>
        )}
      </div>

      {/* Response */}
      <div className="rounded-2xl border border-[#97B3AE]/30 bg-white p-4">
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-[#97B3AE]/30 bg-[#D2E0D3]/40 px-3 py-2 text-xs leading-relaxed text-[#6a6a6a]">
          <svg
            className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[#97B3AE]"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" d="M12 8h.01M11 12h1v4h1" />
          </svg>
          <span>{AI_DRAFT_DISCLOSURE}</span>
        </div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[#97B3AE]">
          Draft response (v{response.version})
        </p>
        {isEditing ? (
          <div>
            <label
              htmlFor="approval-edit"
              className="mb-1 block text-xs font-medium text-[#2a2a2a]"
            >
              Edit your response
            </label>
            <textarea
              id="approval-edit"
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              className="w-full rounded-lg border border-[#97B3AE]/30 p-3 text-sm leading-relaxed text-[#2a2a2a] focus:border-[#97B3AE] focus:outline-none focus:ring-2 focus:ring-[#97B3AE]/30"
              rows={5}
            />
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-[#2a2a2a]">
            {response.responseText}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 sm:flex-row">
        {isEditing ? (
          <>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleAction('edit')}
              disabled={actionLoading || editedText.trim().length === 0}
              className={PRIMARY_BTN}
            >
              {actionLoading ? 'Saving…' : 'Save & Approve'}
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => {
                setIsEditing(false);
                setEditedText(response.responseText);
              }}
              disabled={actionLoading}
              className={GHOST_BTN}
            >
              Cancel
            </motion.button>
          </>
        ) : (
          <>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleAction('approve')}
              disabled={actionLoading}
              className={PRIMARY_BTN}
            >
              {actionLoading ? 'Approving…' : 'Approve'}
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setIsEditing(true)}
              disabled={actionLoading}
              className={GHOST_BTN}
            >
              Edit
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleAction('regenerate')}
              disabled={actionLoading}
              className={GHOST_BTN}
            >
              {actionLoading ? 'Requesting…' : 'Regenerate'}
            </motion.button>
          </>
        )}
      </div>

      <p className="text-center text-xs italic text-[#97B3AE]">
        This link expires in {hoursLeft} hour{hoursLeft !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/approval/__tests__/approval-client.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/approval/approval-client.tsx src/components/approval/__tests__/approval-client.test.tsx
git commit -m "feat(approval): brand the approval client + add success/recovery/label/inline-icon"
```

---

### Task 3: Re-skin `approve/[token]/page.tsx` + add `noindex`

**Files:**
- Modify: `src/app/(public)/approve/[token]/page.tsx` (full rewrite)
- Test: `src/app/(public)/approve/[token]/__tests__/page.test.tsx` (keep h1 test, add error-branch + metadata tests + PageShell mock)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/app/(public)/approve/[token]/__tests__/page.test.tsx` with:

```tsx
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApprovalPage, { metadata } from '../page';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

// Keep the unit test focused on page branching — render PageShell as a passthrough.
vi.mock('@/components/ui/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-shell">{children}</div>
  ),
}));

vi.mock('@/components/approval/approval-client', () => ({
  default: ({ token }: { token: string }) => (
    <div data-testid="approval-client">approval client {token}</div>
  ),
}));

describe('ApprovalPage', () => {
  it('renders a real h1 heading for the approval page shell', async () => {
    mockSql.mockResolvedValueOnce([
      {
        response_id: 'resp-1',
        business_id: 'biz-1',
        expires_at: new Date(Date.now() + 3_600_000),
        consumed_at: null,
        revoked_at: null,
      },
    ]);

    render(await ApprovalPage({ params: Promise.resolve({ token: 'raw-token' }) }));

    expect(
      screen.getByRole('heading', { level: 1, name: 'Review a draft response' }),
    ).toBeDefined();
    expect(screen.getByTestId('approval-client')).toBeInTheDocument();
  });

  it('is marked noindex (sensitive token-keyed data)', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it.each([
    ['missing link', [], /invalid or has expired/i],
    [
      'consumed link',
      [{ response_id: 'r', business_id: 'b', expires_at: new Date(Date.now() + 3_600_000), consumed_at: new Date(), revoked_at: null }],
      /already been approved/i,
    ],
    [
      'revoked link',
      [{ response_id: 'r', business_id: 'b', expires_at: new Date(Date.now() + 3_600_000), consumed_at: null, revoked_at: new Date() }],
      /has been revoked/i,
    ],
    [
      'expired link',
      [{ response_id: 'r', business_id: 'b', expires_at: new Date(Date.now() - 1_000), consumed_at: null, revoked_at: null }],
      /has expired/i,
    ],
  ])('renders a recovery path for a %s', async (_label, rows, messageRe) => {
    mockSql.mockResolvedValueOnce(rows);

    render(await ApprovalPage({ params: Promise.resolve({ token: 'raw-token' }) }));

    expect(screen.getByText(messageRe)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /dashboard/i }),
    ).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByTestId('approval-client')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run "src/app/(public)/approve/[token]/__tests__/page.test.tsx"`
Expected: the h1 test still PASSES (text unchanged); the metadata test FAILS (no `metadata` export) and the four recovery cases FAIL (current `ErrorPage` has no dashboard link).

- [ ] **Step 3: Rewrite the page**

Replace the entire contents of `src/app/(public)/approve/[token]/page.tsx` with:

```tsx
import { createHash } from 'node:crypto';
import type { Metadata } from 'next';
import { sql } from '@/lib/db/server';
import { PageShell } from '@/components/ui/PageShell';
import { ApprovalErrorState } from '@/components/approval/ApprovalErrorState';
import ApprovalClient from '@/components/approval/approval-client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Review a draft response · RepWorth',
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ token: string }>;
}

function BrandHeaderRow() {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
      <span className="text-sm uppercase tracking-wider text-[#97B3AE]">
        RepWorth
      </span>
    </div>
  );
}

export default async function ApprovalPage({ params }: PageProps) {
  const { token: rawToken } = await params;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // Minimal server-side check — just enough to render shell or error
  const [link] = await sql<
    {
      response_id: string;
      business_id: string;
      expires_at: Date;
      consumed_at: Date | null;
      revoked_at: Date | null;
    }[]
  >`
    SELECT response_id, business_id, expires_at, consumed_at, revoked_at
    FROM approval_links WHERE token_hash = ${tokenHash}
  `;

  let errorMessage: string | null = null;
  if (!link) {
    errorMessage = 'This approval link is invalid or has expired.';
  } else if (link.consumed_at) {
    errorMessage = 'This response has already been approved.';
  } else if (link.revoked_at) {
    errorMessage =
      'This approval link has been revoked. A new link may have been sent to your email.';
  } else if (new Date(link.expires_at) <= new Date()) {
    errorMessage =
      'This approval link has expired. Please contact us for a new one.';
  }

  return (
    <PageShell sections={[]}>
      <div className="px-6 py-8 sm:px-10 sm:py-12">
        <BrandHeaderRow />
        <div className="mx-auto mt-8 max-w-xl">
          {errorMessage ? (
            <ApprovalErrorState message={errorMessage} />
          ) : (
            <>
              <h1 className="text-3xl font-medium leading-tight text-[#2a2a2a]">
                Review a draft response
              </h1>
              {/* Location chip and archived badge render in the client after
                  it fetches the token-bound review data. */}
              <div className="mt-6">
                <ApprovalClient token={rawToken} />
              </div>
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run "src/app/(public)/approve/[token]/__tests__/page.test.tsx"`
Expected: PASS (h1 + metadata + 4 recovery cases = 6 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/approve/[token]/page.tsx" "src/app/(public)/approve/[token]/__tests__/page.test.tsx"
git commit -m "feat(approval): brand the approval page shell + error states + add robots:noindex"
```

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the dashboard `Icon` import is gone**

Run: `grep -rn "@/components/dashboard/Icon" src/components/approval src/app/'(public)'/approve`
Expected: **no output** (the cross-boundary import is fully removed).

- [ ] **Step 2: Confirm no banned colors remain in the two files**

Run: `grep -rniE "amber|yellow|bg-blue|gray-50|text-blue" src/components/approval src/app/'(public)'/approve`
Expected: **no output**.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: clean (0 errors). Fix any issues, then re-run.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: clean (0 errors).

- [ ] **Step 5: Full test suite**

Run: `pnpm test`
Expected: all suites pass (the three touched test files + the rest of the suite unchanged).

- [ ] **Step 6: Manual visual smoke check (optional but recommended)**

Run `pnpm dev`, open an approval URL against seed/mock data, and confirm: island renders on sage; teal stars/CTAs; AI note is sage (not amber); Approve → teal success + "View your reviews"; an expired/invalid token shows the recovery island with a working "Go to your dashboard". (No DB/schema change, so `pnpm ci:tenant-scope` / `pnpm ci:rls-audit` are not required.)

---

## Self-Review (completed)

**Spec coverage:**
- Island layout via `PageShell` → Task 3. Minimal brand header → Task 3.
- Action-aware success + dashboard CTA → Task 2 (success state) + test.
- Recovery on every error state → Task 1 (`ApprovalErrorState`) + Task 2 (client no-data) + Task 3 (4 server branches).
- Remove amber/yellow → Tasks 2 & 3 + Task 4 grep.
- Labeled edit textarea → Task 2 + test.
- Inline location icon / drop dashboard `Icon` → Task 2 + Task 4 grep.
- `robots: noindex` (P0 #3) → Task 3 + metadata test.
- a11y (role=status/alert, sr-only stars) → Tasks 1 & 2.

**Placeholder scan:** none — every step has full code or an exact command + expected output.

**Type/name consistency:** `ApprovalErrorState({ message })` defined in Task 1 is imported identically in Tasks 2 and 3. `ApprovalAction` union, `successAction`/`successMessage`, `PRIMARY_BTN`/`GHOST_BTN`, and `BrandHeaderRow` are each defined once and used consistently. The server `metadata` export name matches the test import in Task 3.

**Out of scope (unchanged):** `globals.css` / `auth-island.css` (`overflow:hidden` P0 #7, `min-height` M9), all `/api/approve/**` routes, the approval service, and the `AI_DRAFT_DISCLOSURE` constant.
