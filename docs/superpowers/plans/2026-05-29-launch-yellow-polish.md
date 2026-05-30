# Launch-Ready Yellow Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining yellow (🟡) items from `docs/launch-ready-part2.md` — domain unification to `.net`, past-replies first-run empty state, admin flagged-queue total, FinishSignup visible labels, a bounded aria-live pass — all presentational/copy/a11y, no behavioral logic changed.

**Architecture:** Five focused, independent changes. Each edits a tight set of files with a colocated test. No new modules, no new runtime deps. The one DB touch (Task 3) is a read-only `COUNT` on an already-allowlisted admin cross-tenant query.

**Tech Stack:** Next.js 16 (App Router), React, TypeScript (strict), Postgres.js, Vitest + Testing Library (jsdom).

> ⚠️ **VALIDATION GATE = PR CI.** Per `.claude/CLAUDE.md`, **never run `pnpm` (lint/test/build) from this nested worktree** — module resolution leaks into the parent `node_modules`/eslintrc and poisons it. Every "run test" step below states the *expected* red/green outcome; the authoritative confirmation is the PR CI run in **Task 6**. Commit per task; push + read the runner at the end.

> 📁 **Worktree path gotcha:** This branch lives in `.claude/worktrees/launch-yellow-polish/`. When editing, always use the full path including that segment, or Write/Edit will silently hit `main`'s checkout.

---

### Task 1: Domain unification → `repworth.net`

Collapse the user-facing `.com`/`.net` email split onto `.net` (canonical, per legal "Website: repworth.net"). Pure string swaps + a guard test. The live sending domain (`RESEND_FROM_EMAIL`) is **not** touched — that's an ops/Resend-verification concern (flag it in the PR body).

**Files:**
- Modify: `src/app/(authenticated)/error.tsx` (`mailto:support@repworth.com`)
- Modify: `src/app/(public)/login/error.tsx` (`mailto:support@repworth.com`)
- Modify: `src/app/(public)/signup/error.tsx` (`mailto:support@repworth.com`)
- Modify: `src/app/global-error.tsx` (`mailto:support@repworth.com`)
- Modify: `src/app/mfa/challenge/page.tsx` (`const SUPPORT_EMAIL = 'support@repworth.com'`)
- Modify: `src/app/onboarding/error.tsx` (`mailto:support@repworth.com`)
- Modify: `src/app/onboarding/payment-success/PaymentSuccessClient.tsx` (`mailto:support@repworth.com`)
- Modify: `src/components/sections/how-it-works/HowItWorksContent.tsx` (`<drafts@repworth.com>`)
- Modify: `src/lib/notifications/contact-notify.ts` (`COMPANY_NOREPLY = 'noreply@repworth.com'`)
- Modify: `.claude/reference/env-vars.md` (the `noreply@repworth.com` mention in the `CONTACT_NOTIFY_TO` row)
- Create: `src/__tests__/domain-canonical.test.ts`

- [ ] **Step 1: Write the failing guard test**

Create `src/__tests__/domain-canonical.test.ts` (mirrors the `page-metadata.test.ts` file-scan precedent — recursive content scan, no imports):

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Launch audit (lines 75, 126): user-facing emails/URLs must use the canonical
// .net apex. The live sender is RESEND_FROM_EMAIL (env, Resend-verified) and is
// intentionally not asserted here. This scans non-test src for the .com apex.
const SRC = resolve(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') return [];
      return walk(full);
    }
    if (!/\.(ts|tsx)$/.test(entry)) return [];
    if (/\.test\.(ts|tsx)$/.test(entry)) return [];
    return [full];
  });
}

describe('canonical domain (.net) — no user-facing @repworth.com', () => {
  const files = walk(SRC);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)('%s contains no @repworth.com literal', (file) => {
    const src = readFileSync(file, 'utf-8');
    // Substring match; @repworth.example.com (the deliberate unsubscribe
    // placeholder) does NOT contain "@repworth.com" and is unaffected.
    expect(src.includes('@repworth.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/__tests__/domain-canonical.test.ts` — Expected: **FAIL** (several files still contain `@repworth.com`). *(Confirmed in CI — do not run locally in the worktree.)*

- [ ] **Step 3: Swap every user-facing `.com` → `.net`**

In each file below, change the `@repworth.com` occurrence to `@repworth.net` (text otherwise unchanged):

```
src/app/(authenticated)/error.tsx                       mailto:support@repworth.com   → mailto:support@repworth.net
src/app/(public)/login/error.tsx                        mailto:support@repworth.com   → mailto:support@repworth.net
src/app/(public)/signup/error.tsx                       mailto:support@repworth.com   → mailto:support@repworth.net
src/app/global-error.tsx                                mailto:support@repworth.com   → mailto:support@repworth.net
src/app/mfa/challenge/page.tsx                          'support@repworth.com'        → 'support@repworth.net'
src/app/onboarding/error.tsx                            mailto:support@repworth.com   → mailto:support@repworth.net
src/app/onboarding/payment-success/PaymentSuccessClient.tsx  mailto:support@repworth.com → mailto:support@repworth.net
src/components/sections/how-it-works/HowItWorksContent.tsx   &lt;drafts@repworth.com&gt; → &lt;drafts@repworth.net&gt;
src/lib/notifications/contact-notify.ts                 const COMPANY_NOREPLY = 'noreply@repworth.com'; → 'noreply@repworth.net';
```

In `.claude/reference/env-vars.md`, the `CONTACT_NOTIFY_TO` row ends with `→ noreply@repworth.com` — change to `→ noreply@repworth.net`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/__tests__/domain-canonical.test.ts` — Expected: **PASS** (zero `@repworth.com` in non-test src). *(Confirmed in CI.)* If a straggler appears, fix that file too.

- [ ] **Step 5: Commit**

```bash
git add src docs .claude/reference/env-vars.md
git commit -m "fix(launch-yellow): unify user-facing email domain to .net (#dom)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Past-replies first-run empty state (TODO P2 #28)

Differentiate the brand-new-account empty state from the filter-empty state.

**Files:**
- Modify: `src/app/(authenticated)/dashboard/past-replies/PastRepliesClient.tsx` (`Empty()` ~line 286; gap call site ~line 167; hist call site ~line 195)
- Test: `src/app/(authenticated)/dashboard/past-replies/__tests__/PastRepliesClient.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to the top-level `describe('PastRepliesClient', …)` block (after the first `it`):

```tsx
it('shows first-run copy for a brand-new account with zero replies and no filter', () => {
  render(
    <PastRepliesClient
      {...baseProps}
      gapRows={[]}
      histRows={[]}
      gapTotal={0}
      histTotal={0}
      hasHistoricalSection={false}
    />,
  );

  expect(screen.getByText('No replies yet')).toBeInTheDocument();
  expect(
    screen.getByText('Approved replies will appear here as you respond to your reviews.'),
  ).toBeInTheDocument();
  expect(screen.queryByText('No replies match this filter')).not.toBeInTheDocument();
});

it('shows filter-empty copy (not first-run) when a filter matches nothing', async () => {
  const user = userEvent.setup();
  render(
    <PastRepliesClient
      {...baseProps}
      gapRows={[row({ star_rating: 5 })]}
      gapTotal={1}
      histTotal={0}
      hasHistoricalSection={false}
    />,
  );

  // Filter to a rating with no matches → gap section empties.
  await user.click(screen.getByRole('button', { name: /^1$/ }));

  expect(screen.getByText('No replies match this filter')).toBeInTheDocument();
  expect(screen.queryByText('No replies yet')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run "src/app/(authenticated)/dashboard/past-replies/__tests__/PastRepliesClient.test.tsx"` — Expected: **FAIL** (first test: "No replies yet" not found; `Empty` is prop-less). *(Confirmed in CI.)*

- [ ] **Step 3: Parameterize `Empty` and pass `firstRun` at the gap call site**

Replace the `Empty()` function (and its `TODO(P2 #28)` comment block) with:

```tsx
function Empty({ firstRun }: { firstRun: boolean }) {
  return (
    <div className="pr-empty">
      <div className="pr-empty-icon">
        <Icon name="history" size={28} />
      </div>
      <div className="pr-empty-title">
        {firstRun ? 'No replies yet' : 'No replies match this filter'}
      </div>
      <div className="pr-empty-sub">
        {firstRun
          ? 'Approved replies will appear here as you respond to your reviews.'
          : 'Try clearing your search, or pick a different rating chip.'}
      </div>
    </div>
  );
}
```

Update the **gap** call site (~line 167) from `<Empty />` to:

```tsx
<Empty firstRun={!hasActiveFilter && totalReplies === 0} />
```

Update the **historical** call site (~line 195) from `<Empty />` to:

```tsx
<Empty firstRun={false} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run "src/app/(authenticated)/dashboard/past-replies/__tests__/PastRepliesClient.test.tsx"` — Expected: **PASS** (all existing + 2 new). *(Confirmed in CI.)*

- [ ] **Step 5: Commit**

```bash
git add "src/app/(authenticated)/dashboard/past-replies"
git commit -m "fix(launch-yellow): first-run empty state for past-replies (P2 #28)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Admin flagged-queue — total count + disposition aria-live

Show `Showing X–Y of Z`, and make the existing disposition error region announce to screen readers.

**Files:**
- Modify: `src/app/api/admin/flagged/route.ts` (GET handler, ~lines 84–116)
- Modify: `src/app/admin/flagged/page.tsx` (query type ~line 44; error `<p>` ~line 85; pagination span ~line 157)
- Test: `src/app/api/admin/flagged/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing API test**

Add to `describe('GET /api/admin/flagged', …)` in `route.test.ts`:

```ts
it('returns the total open-flag count alongside the page', async () => {
  // 1st sql call → page rows; 2nd sql call → COUNT.
  mockSql.mockResolvedValueOnce([
    {
      id: 'flag-1', response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1',
      review_id: 'rev-1', source: 'local_regex', reason: 'refund_discount', severity: 'high',
      status: 'open', created_at: '2026-05-26T00:00:00.000Z', response_text: 'x',
      version: 1, reviewer_name: 'Jane', star_rating: 2, business_name: 'Bella Italia',
    },
  ]);
  mockSql.mockResolvedValueOnce([{ total: 137 }]);

  const res = await GET(getReq());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { flagged: unknown[]; total: number };
  expect(body.total).toBe(137);
  expect(body.flagged).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/app/api/admin/flagged/__tests__/route.test.ts` — Expected: **FAIL** (`body.total` is `undefined`). *(Confirmed in CI.)*

- [ ] **Step 3: Add the COUNT query + `total` to the GET response**

In `route.ts`, immediately **after** the existing `const rows = await sql<FlaggedRow[]>\`…LIMIT ${limit} OFFSET ${offset}\`;` block and **before** `const flagged = rows.map(…)`, insert:

```ts
  // Total OPEN flags for the "Showing X–Y of Z" pagination footer.
  const countRows = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'
  `;
  const total = countRows[0]?.total ?? 0;
```

Change the final return from `{ flagged, limit, offset }` to include `total`:

```ts
  return NextResponse.json({ flagged, limit, offset, total }, { headers: NO_STORE });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/app/api/admin/flagged/__tests__/route.test.ts` — Expected: **PASS** (new test green; existing "lists open flags" still green because its single `mockResolvedValueOnce` feeds the rows query and the COUNT falls through to the default `[]` → `total` 0, which it does not assert). *(Confirmed in CI.)*

- [ ] **Step 5: Render the total + announce disposition errors (page.tsx)**

Add the import at the top of `src/app/admin/flagged/page.tsx`:

```tsx
import { LiveRegion } from '@/components/ui/LiveRegion';
```

Widen the query result type (~line 44) — both the `useQuery` generic and the `queryFn` cast:

```tsx
  const { data, isLoading, isError } = useQuery<{ flagged: FlaggedItem[]; total: number }>({
    queryKey: ['admin-flagged', offset],
    queryFn: async () => {
      const res = await fetch(`/api/admin/flagged?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error(`Failed to fetch flagged queue: ${res.status}`);
      return res.json() as Promise<{ flagged: FlaggedItem[]; total: number }>;
    },
    refetchInterval: 30_000,
  });
```

Make the existing error paragraph announce — add `role="alert"` to the `<p>` at ~line 86, and add a hidden polite live region. Replace the `{actionError && (…)}` block with:

```tsx
        {actionError && (
          <p role="alert" className="mt-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {actionError}
          </p>
        )}
        <LiveRegion level="polite" message={disposition.isSuccess ? 'Disposition applied.' : ''} />
```

Update the pagination span (~line 157) to include the total:

```tsx
            <span className="text-xs text-gray-400">
              Showing {offset + 1}–{offset + data.flagged.length} of {data.total}
            </span>
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/flagged src/app/admin/flagged
git commit -m "fix(launch-yellow): flagged-queue total + disposition aria-live (audit #107/#112)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: FinishSignup visible labels + error aria-live

Make the three already-associated `sr-only` labels **visible**, and announce submission errors. (Form stays in its current neutral style — the full auth-island rebrand is out of scope, audit line 78.)

**Files:**
- Modify: `src/components/auth/FinishSignupClient.tsx`
- Create: `src/components/auth/__tests__/FinishSignupClient.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/auth/__tests__/FinishSignupClient.test.tsx`:

```tsx
// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinishSignupClient } from '../FinishSignupClient';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('FinishSignupClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders visible (non-sr-only) labels for each field', () => {
    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);

    for (const text of [/email/i, /your name/i, /phone/i]) {
      const label = screen.getByText(text);
      expect(label.className).not.toContain('sr-only');
    }
  });

  it('announces a submission error via an assertive live region', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ message: 'Submission failed' }),
      })) as unknown as typeof fetch,
    );

    render(<FinishSignupClient defaultEmail="owner@example.com" defaultName="Owner" />);
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Submission failed');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/components/auth/__tests__/FinishSignupClient.test.tsx` — Expected: **FAIL** (labels are `sr-only`; no `role="alert"` region). *(Confirmed in CI.)*

- [ ] **Step 3: Make labels visible + add the live region**

In `FinishSignupClient.tsx`:

1. Add the import:

```tsx
import { LiveRegion } from '@/components/ui/LiveRegion';
```

2. Change each of the three labels' `className="sr-only"` to a visible label class (keep `htmlFor`/text):

```tsx
className="block text-sm font-medium text-gray-700 mb-1"
```

(Apply to `finish-email`, `finish-name`, and `finish-phone` labels. The redundant `placeholder="Your name"` / `placeholder="Phone (optional)"` may be removed since the visible label now carries the text.)

3. Replace the error line `{error && <p className="text-sm text-red-600">{error}</p>}` with an announced version:

```tsx
          {error && <p className="text-sm text-red-600">{error}</p>}
          <LiveRegion level="assertive" message={error} />
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/components/auth/__tests__/FinishSignupClient.test.tsx` — Expected: **PASS**. *(Confirmed in CI.)*

- [ ] **Step 5: Commit**

```bash
git add src/components/auth
git commit -m "fix(launch-yellow): FinishSignup visible labels + error aria-live (audit #112/#115)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Doc-ticks in `docs/launch-ready-part2.md`

Reflect the shipped work and flip the three verified-stale 🟡 markers to ✅. **Copy edit only — no code.**

**Files:**
- Modify: `docs/launch-ready-part2.md`

- [ ] **Step 1: Update the audit markers**

- **Line 75** (`SiteNav` logo / domain mix): mark the domain-mix half DONE — note all user-facing emails unified to `.net` (this branch); the live sender (`RESEND_FROM_EMAIL`) is an ops/Resend-verification follow-up.
- **Line 82** (Legal pages): flip 🟡→✅ — `generateMetadata` "pending" was stale; all 5 `legal/*` pages already export static `metadata` (correct for static pages; verified this branch).
- **Line 96** (Payment-success): flip 🟡→✅ — timeout support link landed in #20 (`PaymentSuccessClient.tsx`); verified.
- **Line 107** (admin runbook / flagged pagination): mark the flagged-queue-total half DONE (this branch); `min-h-screen` already done in #181.
- **Line 112** (aria-live): keep 🟡 (still PARTIAL) but add this branch's additions — FinishSignup error (`LiveRegion`) + flagged disposition error (`role="alert"`); note login/forgot/reset + add-location wizard remain pending.
- **Line 115** (FinishSignup labels): flip 🟡→✅ — labels now visible + associated (this branch).
- **Line 126** (domain mix copy bug): flip ✅ — unified to `.net`.
- **Line 136** (#3 noindex auth): flip 🟡→✅ — auth pages noindex landed in #19/PR #180; verified.
- **Line 165** (#28): update — first-run empty-state copy now differentiated (`TODO(P2 #28)` removed, this branch).

- [ ] **Step 2: Commit**

```bash
git add docs/launch-ready-part2.md
git commit -m "docs(launch-yellow): tick resolved audit items (#75/#82/#96/#107/#112/#115/#126/#136/#165)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Push + PR + CI validation (the verification gate)

Local `pnpm` is forbidden in this nested worktree, so CI is where red/green is confirmed.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin worktree-launch-yellow-polish
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --title "fix(launch-yellow): remaining yellow polish (#19-domain, #28, flagged total, FinishSignup labels, aria-live)" --body "$(cat <<'EOF'
Closes the remaining 🟡 items from docs/launch-ready-part2.md (frontend polish bundle).

- Domain unification → repworth.net (user-facing emails/URLs; guard test)
- Past-replies first-run empty state (P2 #28; TODO removed)
- Admin flagged-queue "Showing X–Y of Z" total
- FinishSignup visible labels + error aria-live
- Bounded aria-live: FinishSignup error + flagged disposition error
- Doc-ticks for verified-stale markers

OPS FOLLOW-UP: the live email sender is RESEND_FROM_EMAIL (env, Resend-verified).
Moving live sends to .net requires verifying the .net domain in Resend and
ensuring support@/billing@/security@/noreply@ .net mailboxes receive — not in
this PR. Excludes #23b (Zernio reconnect-queue backend feature).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Watch the 4 CI checks**

```bash
gh pr checks --watch
```

Expected: `lint`, `typecheck`, `test`, `build` all green. If any fail, read the runner log, fix in the worktree, commit, push, re-watch. **Do not** run the suite locally.

- [ ] **Step 4: Report** the PR URL + green CI status to the user for merge decision.

---

## Self-Review

**Spec coverage:**
- Item 1 (domain) → Task 1 ✅
- Item 2 (first-run empty) → Task 2 ✅
- Item 3 (flagged total) → Task 3 ✅
- Item 4 (FinishSignup labels) → Task 4 ✅
- Item 5 (bounded aria-live) → Task 3 (flagged `role="alert"`) + Task 4 (FinishSignup `LiveRegion`) ✅ — **deliberate narrowing:** the flagged half uses `role="alert"` on the already-rendered error region (not a new `LiveRegion` + react-query test harness) because it's an internal-admin tool and that keeps the change un-speculative and testable; documented in Task 5 line-112 note.
- 3 doc-ticks → Task 5 ✅
- Non-goals (Zernio #23b, auth rebrand, RESEND_FROM_EMAIL migration, app-wide aria-live) → preserved; flagged in PR body + Task 5 ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step shows complete code. The only `TODO` referenced is the existing `TODO(P2 #28)` being *removed*.

**Type consistency:** `firstRun: boolean` prop used identically at both call sites and the definition. `{ flagged; total }` shape matches between `route.ts` return, `route.test.ts` assertion, and `page.tsx` query generic + `queryFn` cast. `LiveRegion` import path `@/components/ui/LiveRegion` and props (`message`, `level`) match the component signature.
