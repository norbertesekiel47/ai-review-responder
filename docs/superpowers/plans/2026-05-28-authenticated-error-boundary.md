# Branded Error Boundaries for the Owner App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners never hit an unbranded Next.js error page in the authenticated app — add a Console-styled `(authenticated)/error.tsx` for page throws and rebrand `global-error.tsx` as a self-contained island fallback for catastrophic throws.

**Architecture:** A Next.js segment `error.tsx` renders *inside* its layout's children slot, so `(authenticated)/error.tsx` keeps the Console shell (Sidebar/MobileTabBar) and fills `.main` using `console.css` classes. It does **not** catch throws from `(authenticated)/layout.tsx` itself — those bubble to `global-error.tsx`, which replaces the root layout (own `<html>`/`<body>`, no app CSS in scope) and is therefore styled with fully self-contained inline styles in the public island palette. Both boundaries report to Sentry and surface a reference ID + recovery actions.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), `@sentry/nextjs`, Console design tokens (`src/app/(authenticated)/_styles/{tokens,console}.css`), Vitest + Testing Library (jsdom), pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-authenticated-error-boundary-design.md`

**Worktree:** `/private/tmp/repworth-error-boundary` (branch `fix/launch-p0-error-boundary`). Run all commands there.

---

## File structure

| File | Responsibility |
|---|---|
| `src/app/(authenticated)/_styles/console.css` *(modify)* | Add the `.error-state*` block — the one authoritative owner of the Console error-state visual pattern |
| `src/app/(authenticated)/error.tsx` *(create)* | Console error boundary for owner-app page throws; recovery actions + Sentry capture |
| `src/app/(authenticated)/__tests__/error.test.tsx` *(create)* | Behavior tests for the above |
| `src/app/global-error.tsx` *(modify)* | Rebrand the catastrophic root fallback; self-contained island styling |
| `src/app/__tests__/global-error.test.tsx` *(create)* | Behavior tests for the above |

No DB/schema changes → `pnpm ci:tenant-scope` / `pnpm ci:rls-audit` are **not** required.

---

### Task 1: Add the `.error-state` CSS block

CSS has no unit test; it is verified by lint + typecheck + the component rendering with these class names. Add the block once, here, so Task 2's component is complete.

**Files:**
- Modify: `src/app/(authenticated)/_styles/console.css` (append after the `.empty-*` block, ~line 825)

- [ ] **Step 1: Append the `.error-state` block**

Insert immediately after the `.empty-sub { … }` rule (the existing empty-state block ends ~line 825), before the `/* ---------- Charts ---------- */` comment:

```css

/* ---------- Error boundary state ---------- */
.error-state {
  min-height: 70vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 48px 24px;
  gap: 14px;
}
.error-state-icon {
  width: 56px;
  height: 56px;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--rw-red-50);
  color: var(--rw-red-600);
}
.error-state-title {
  font-family: var(--rw-font-display);
  font-weight: 700;
  font-size: 20px;
  letter-spacing: -0.01em;
  color: var(--rw-app-text);
  margin: 0;
}
.error-state-title:focus { outline: none; }
.error-state-title:focus-visible {
  outline: 2px solid var(--rw-blue-500);
  outline-offset: 4px;
  border-radius: 4px;
}
.error-state-sub {
  font-size: 14px;
  color: var(--rw-app-text-muted);
  max-width: 360px;
  margin: 0;
  line-height: 1.5;
}
.error-state-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 6px;
}
.error-state-ref {
  font-family: var(--rw-font-mono);
  font-size: 12px;
  color: var(--rw-app-text-soft);
  margin: 8px 0 0;
}
```

- [ ] **Step 2: Lint the stylesheet**

Run: `cd /private/tmp/repworth-error-boundary && pnpm lint 2>&1 | tail -5`
Expected: no new errors (CSS is not linted by ESLint, but this confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
cd /private/tmp/repworth-error-boundary
git add "src/app/(authenticated)/_styles/console.css"
git commit -m "feat(console): add .error-state styles for owner-app error boundary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `(authenticated)/error.tsx` — Console error boundary (TDD)

**Files:**
- Test: `src/app/(authenticated)/__tests__/error.test.tsx` (create)
- Create: `src/app/(authenticated)/error.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/(authenticated)/__tests__/error.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import AuthenticatedError from '../error';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function makeError(digest?: string): Error & { digest?: string } {
  const error = new Error('boom') as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe('AuthenticatedError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the branded heading inside an alert region', () => {
    render(<AuthenticatedError error={makeError()} reset={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /something went wrong/i }),
    ).toBeInTheDocument();
  });

  it('calls reset when "Try again" is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<AuthenticatedError error={makeError()} reset={reset} />);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('offers back-to-dashboard and contact-support recovery links', () => {
    render(<AuthenticatedError error={makeError()} reset={vi.fn()} />);
    expect(
      screen.getByRole('link', { name: /back to dashboard/i }),
    ).toHaveAttribute('href', '/dashboard');
    expect(
      screen.getByRole('link', { name: /contact support/i }),
    ).toHaveAttribute('href', 'mailto:support@repworth.com');
  });

  it('shows the reference id when the error has a digest', () => {
    render(<AuthenticatedError error={makeError('abc123')} reset={vi.fn()} />);
    expect(screen.getByText(/reference:\s*abc123/i)).toBeInTheDocument();
  });

  it('omits the reference id when there is no digest', () => {
    render(<AuthenticatedError error={makeError()} reset={vi.fn()} />);
    expect(screen.queryByText(/reference:/i)).not.toBeInTheDocument();
  });

  it('reports the error to Sentry on mount', () => {
    const error = makeError();
    render(<AuthenticatedError error={error} reset={vi.fn()} />);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /private/tmp/repworth-error-boundary && pnpm vitest run "src/app/(authenticated)/__tests__/error.test.tsx" 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "../error"` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/app/(authenticated)/error.tsx`:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import * as Sentry from '@sentry/nextjs';

export default function AuthenticatedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="error-state" role="alert">
      <div className="error-state-icon" aria-hidden="true">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <h1 className="error-state-title" tabIndex={-1} ref={headingRef}>
        Something went wrong
      </h1>
      <p className="error-state-sub">
        We couldn&apos;t load this page. This one&apos;s on us — try again, or head
        back to your dashboard.
      </p>
      <div className="error-state-actions">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
        <a className="btn btn-secondary" href="/dashboard">
          Back to dashboard
        </a>
        <a className="btn btn-tertiary" href="mailto:support@repworth.com">
          Contact support
        </a>
      </div>
      {error.digest ? (
        <p className="error-state-ref">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /private/tmp/repworth-error-boundary && pnpm vitest run "src/app/(authenticated)/__tests__/error.test.tsx" 2>&1 | tail -20`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
cd /private/tmp/repworth-error-boundary
git add "src/app/(authenticated)/error.tsx" "src/app/(authenticated)/__tests__/error.test.tsx"
git commit -m "feat(authenticated): branded Console error boundary (launch P0 #9)

Adds (authenticated)/error.tsx so an owner-app server-component throw renders
a branded, recoverable error inside the Console shell instead of the unstyled
Next.js fallback. Try again / Back to dashboard / Contact support + reference
id; reports to Sentry. role=alert; heading focused on mount.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rebrand `global-error.tsx` — self-contained island fallback (TDD)

The file already exists (bare `system-ui` markup). Write tests that assert the *new* branded behavior (which currently fails: no reference id, no home/support links, no wordmark), then rebrand to pass.

**Files:**
- Test: `src/app/__tests__/global-error.test.tsx` (create)
- Modify: `src/app/global-error.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/__tests__/global-error.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import GlobalError from '../global-error';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

function makeError(digest?: string): Error & { digest?: string } {
  const error = new Error('catastrophe') as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe('GlobalError', () => {
  // The component returns <html>/<body>; React logs an expected DOM-nesting
  // warning when rendered into the test container. Suppress it so output stays
  // clean — it is not a failure.
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders the branded fallback with the RepWorth wordmark and reports to Sentry', () => {
    const error = makeError();
    render(<GlobalError error={error} reset={vi.fn()} />);
    expect(
      screen.getByRole('heading', { name: /something went wrong/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('calls reset when "Try again" is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<GlobalError error={makeError()} reset={reset} />);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('links to home and support and shows the reference id', () => {
    render(<GlobalError error={makeError('ref-789')} reset={vi.fn()} />);
    expect(
      screen.getByRole('link', { name: /go to repworth home/i }),
    ).toHaveAttribute('href', '/');
    expect(
      screen.getByRole('link', { name: /contact support/i }),
    ).toHaveAttribute('href', 'mailto:support@repworth.com');
    expect(screen.getByText(/reference:\s*ref-789/i)).toBeInTheDocument();
  });
});
```

> **Contingency:** if this React/RTL version throws (not just warns) when rendering `<html>` into the container, switch these three tests to assert against `renderToStaticMarkup(<GlobalError … />)` from `react-dom/server` for the static checks (wordmark, links, reference id, heading), and keep the reset-click test by rendering only after stubbing — but try the RTL approach first; it is expected to work with the console suppression above.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /private/tmp/repworth-error-boundary && pnpm vitest run src/app/__tests__/global-error.test.tsx 2>&1 | tail -25`
Expected: FAIL — the "links to home and support and shows the reference id" test fails (`Unable to find role "link"` / no reference id) because the current bare component renders none of these.

- [ ] **Step 3: Rebrand the implementation**

Replace the entire contents of `src/app/global-error.tsx`:

```tsx
'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

const FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <div
          style={{
            minHeight: '100vh',
            background: '#D2E0D3',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            fontFamily: FONT_STACK,
          }}
        >
          <div
            role="alert"
            style={{
              maxWidth: '28rem',
              width: '100%',
              background: '#fff',
              borderRadius: '2rem',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
              padding: '2.5rem',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                marginBottom: '1.5rem',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: '2rem',
                  height: '2rem',
                  borderRadius: '9999px',
                  background:
                    'linear-gradient(135deg, #97B3AE, rgba(151, 179, 174, 0.8))',
                  display: 'inline-block',
                }}
              />
              <span
                style={{
                  fontSize: '0.875rem',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#97B3AE',
                }}
              >
                RepWorth
              </span>
            </div>
            <h1
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: '#2a2a2a',
                margin: '0 0 0.75rem',
              }}
            >
              Something went wrong
            </h1>
            <p style={{ color: '#6a6a6a', margin: '0 0 1.5rem', lineHeight: 1.6 }}>
              An unexpected error interrupted RepWorth. Please try again.
            </p>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                background: '#97B3AE',
                color: '#fff',
                border: 'none',
                padding: '0.625rem 1.5rem',
                borderRadius: '9999px',
                fontSize: '0.95rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <p style={{ fontSize: '0.8125rem', color: '#6a6a6a', marginTop: '1.25rem' }}>
              <a href="/" style={{ color: '#97B3AE' }}>
                Go to RepWorth home
              </a>
              {' · '}
              <a href="mailto:support@repworth.com" style={{ color: '#97B3AE' }}>
                Contact support
              </a>
            </p>
            {error.digest ? (
              <p
                style={{
                  fontSize: '0.75rem',
                  color: '#9CA3AF',
                  marginTop: '0.75rem',
                  fontFamily: 'monospace',
                }}
              >
                Reference: {error.digest}
              </p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /private/tmp/repworth-error-boundary && pnpm vitest run src/app/__tests__/global-error.test.tsx 2>&1 | tail -20`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
cd /private/tmp/repworth-error-boundary
git add src/app/global-error.tsx src/app/__tests__/global-error.test.tsx
git commit -m "feat(global-error): branded self-contained island fallback

Rebrands the catastrophic root fallback (fires on root/layout throws) from the
bare system-ui page to a self-contained sage-island card with the RepWorth
wordmark, Try again, Go to home + Contact support, and a reference id. Keeps
Sentry capture; no motion/external CSS so it stays resilient.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the two new test files together**

Run: `cd /private/tmp/repworth-error-boundary && pnpm vitest run "src/app/(authenticated)/__tests__/error.test.tsx" src/app/__tests__/global-error.test.tsx 2>&1 | tail -20`
Expected: PASS — 9 tests passing, 0 failures.

- [ ] **Step 2: Lint**

Run: `cd /private/tmp/repworth-error-boundary && pnpm lint 2>&1 | tail -15`
Expected: no errors (no `react/no-unescaped-entities`, no unused vars).

- [ ] **Step 3: Typecheck**

Run: `cd /private/tmp/repworth-error-boundary && pnpm typecheck 2>&1 | tail -15`
Expected: `tsc --noEmit` exits clean (no output).

- [ ] **Step 4: Full test suite**

Run: `cd /private/tmp/repworth-error-boundary && pnpm test 2>&1 | tail -25`
Expected: full suite green; the two new files included; no pre-existing tests regressed.

- [ ] **Step 5: Confirm clean working tree**

Run: `cd /private/tmp/repworth-error-boundary && git status --porcelain && git log --oneline -4`
Expected: empty working tree; four commits on `fix/launch-p0-error-boundary` (spec + 3 feature commits).

---

## Done criteria

- `(authenticated)/error.tsx` exists, Console-styled, role=alert, reset/dashboard/support actions, reference id, Sentry capture (closes launch-ready P0 #9).
- `global-error.tsx` rebranded as a self-contained island fallback.
- `.error-state` block lives in `console.css` as the single owner of the pattern.
- 9 new tests passing; `pnpm lint && pnpm typecheck && pnpm test` all green.
- No amber/orange/stone; no external icon lib; no inline Tailwind in the Console component.
