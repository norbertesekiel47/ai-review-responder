# Portal Audit PR 1 — Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the owner sign-out dead end, the Telegram blank-username deep-link divergence, the two self-contradicting DB fan-outs, and the duplicated auto-approval threshold labels.

**Architecture:** Five independent fixes, no new modules and no new seams. Two existing modules are deepened (`src/lib/competitors/named-rival.ts` gains `loadRivalPickerViews`; `src/lib/auto-approval/types.ts` gains the threshold-label map). The other three changes are a constant, an expression, and statement re-sequencing inside existing implementations.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest + Testing Library, Postgres.js.

Spec: `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §3.
Intake: `docs/superpowers/plans/fix-portal-audit-pr1-correctness-intake.json`.
Deviations: `docs/superpowers/plans/fix-portal-audit-pr1-correctness-deviations.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/components/dashboard/shell/Sidebar.tsx` | Owner shell nav + sign-out | Redirect target `/admin/login` → `/login` |
| `src/components/dashboard/shell/__tests__/Sidebar.test.tsx` | Pins sign-out destination + error branch | **Create** |
| `src/app/api/admin/channels/telegram/start/route.ts` | Admin Telegram enrolment start | Blank-username fallback |
| `src/app/api/admin/channels/telegram/__tests__/start.test.ts` | Route behaviour | Add 2 cases |
| `src/lib/competitors/named-rival.ts` | Rival picker data loading | **Deepen**: add `loadRivalPickerViews` |
| `src/lib/competitors/__tests__/named-rival.test.ts` | Rival loader unit tests | Add 2 cases |
| `src/app/(authenticated)/settings/competitors/page.tsx` | Competitors settings composition root | Loop → one loader call |
| `src/app/(authenticated)/settings/competitors/__tests__/page-source.test.ts` | Pins no-fan-out invariant | **Create** |
| `src/app/admin/businesses/[id]/page.tsx` | Admin business detail composition root | `Promise.all` → sequential |
| `src/app/admin/businesses/[id]/__tests__/page-source.test.ts` | Pins no-fan-out invariant | **Create** |
| `src/lib/auto-approval/types.ts` | Auto-approval domain types + constants | **Deepen**: add `AUTO_APPROVAL_THRESHOLD_LABELS` |
| `src/lib/auto-approval/__tests__/threshold-labels.test.ts` | Label map exhaustiveness | **Create** |
| `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx` | Owner auto-approval settings UI | Import shared labels |
| `src/app/admin/businesses/[id]/_components/AutoApprovalDiagnosticsPanel.tsx` | Admin diagnostics UI | Import shared labels |
| `src/app/api/account/settings/route.ts` | Account settings read | Comment only |
| `src/app/api/locations/add/route.ts` | Location add write path | Comment only |
| `src/app/(authenticated)/dashboard/add-location/page.tsx` | Add-location wizard root | Comment only |

**Blocking edges:** Task 1 (evals) blocks everything. Tasks 2–6 are mutually
independent (disjoint file sets, no shared edges) and may be dispatched in
parallel after Task 1's enforcement spot check passes. Task 7 is comment-only
and independent.

---

## Task 1: Eval task — author every promised test as failing

**Files:**
- Create: `src/components/dashboard/shell/__tests__/Sidebar.test.tsx`
- Modify: `src/app/api/admin/channels/telegram/__tests__/start.test.ts`
- Modify: `src/lib/competitors/__tests__/named-rival.test.ts`
- Create: `src/app/(authenticated)/settings/competitors/__tests__/page-source.test.ts`
- Create: `src/app/admin/businesses/[id]/__tests__/page-source.test.ts`
- Create: `src/lib/auto-approval/__tests__/threshold-labels.test.ts`

The ten `tests_to_add` titles must appear **verbatim** — the gate's
`promised-tests` row matches on exact strings.

- [ ] **Step 1: Read the two precedent test files before writing anything**

Read these to match existing mocking style — do not invent a new one:

```bash
cat src/app/admin/autonomy/__tests__/page-source.test.ts
cat src/app/api/admin/channels/telegram/__tests__/start.test.ts
cat src/lib/competitors/__tests__/named-rival.test.ts
```

- [ ] **Step 2: Create the Sidebar test**

`src/components/dashboard/shell/__tests__/Sidebar.test.tsx`. The component is
`'use client'` and depends on `next/navigation`, the browser Supabase client,
`LocationContext`, and `PendingCountContext` — mock all four.

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const push = vi.fn();
const refresh = vi.fn();
const signOut = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/dashboard',
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut } }),
}));

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ isMultiLocation: false }),
}));

vi.mock('@/contexts/PendingCountContext', () => ({
  usePendingCount: () => 0,
}));

import { Sidebar } from '@/components/dashboard/shell/Sidebar';

function renderSidebar() {
  return render(
    <Sidebar
      businessName="Bella Vista Dental"
      ownerName="Ada Lovelace"
      ownerEmail="ada@example.com"
      solicitationEnabled={false}
    />,
  );
}

describe('Sidebar sign out', () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    signOut.mockReset();
  });

  it('pushes /login after a successful sign out', async () => {
    signOut.mockResolvedValue({ error: null });
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    expect(push).not.toHaveBeenCalledWith('/admin/login');
  });

  it('does not navigate when sign out fails', async () => {
    signOut.mockResolvedValue({ error: { message: 'nope' } });
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(screen.getByText('Sign out failed')).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
  });

  it('does not navigate when sign out throws', async () => {
    signOut.mockRejectedValue(new Error('network down'));
    renderSidebar();

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(screen.getByText('Sign out failed')).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Add the two Telegram fallback cases**

Append to the existing `describe` in
`src/app/api/admin/channels/telegram/__tests__/start.test.ts`, reusing whatever
config mock that file already establishes. Assert on the returned `deepLink`:

```ts
  it('falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is blank', async () => {
    const body = await startWithBotUsername('');
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/RepWorthBot\?start=/);
  });

  it('falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is whitespace only', async () => {
    const body = await startWithBotUsername('   ');
    expect(body.deepLink).toMatch(/^https:\/\/t\.me\/RepWorthBot\?start=/);
  });
```

Add the helper next to the file's existing setup, matching its mocking style:

```ts
  async function startWithBotUsername(botUsername: string) {
    vi.mocked(getServerConfig).mockReturnValue({
      ...baseConfig,
      TELEGRAM_BOT_USERNAME: botUsername,
    } as ReturnType<typeof getServerConfig>);
    const res = await POST(buildRequest({ businessId: BUSINESS_ID }));
    expect(res.status).toBe(200);
    return (await res.json()) as { deepLink: string };
  }
```

If the existing file names its config mock or request builder differently, use
its names — do not rename existing helpers.

- [ ] **Step 4: Add the two rival-loader cases**

Append to `src/lib/competitors/__tests__/named-rival.test.ts`. Sequential means
**no second call starts before the first resolves** — assert that directly with
an in-flight counter, not by inspecting implementation:

```ts
describe('loadRivalPickerViews', () => {
  it('loads each location rival view sequentially', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sql = makeSequentialSpySql(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return () => { inFlight -= 1; };
    });

    const views = await loadRivalPickerViews(sql, {
      accountId: ACCOUNT_ID,
      businessIds: [LOCATION_A, LOCATION_B, LOCATION_C],
    });

    expect(views).toHaveLength(3);
    expect(maxInFlight).toBe(1);
  });

  it('issues no rival-view queries when the account has no active locations', async () => {
    const sql = makeSequentialSpySql(() => () => {});
    const views = await loadRivalPickerViews(sql, {
      accountId: ACCOUNT_ID,
      businessIds: [],
    });

    expect(views).toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });
});
```

Build `makeSequentialSpySql` on top of whatever mock-sql helper this file
already uses. If it has none, add one locally that returns `[]` for every
tagged-template call and invokes the enter/exit callbacks around an `await
Promise.resolve()`.

- [ ] **Step 5: Create the two page-source tests**

Follow `src/app/admin/autonomy/__tests__/page-source.test.ts` exactly — this
repo has no executing server-page test precedent, so do not invent one.

`src/app/admin/businesses/[id]/__tests__/page-source.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('admin business detail page source', () => {
  it('keeps the admin business detail page free of Promise.all fan-out', async () => {
    const source = await readFile('src/app/admin/businesses/[id]/page.tsx', 'utf8');

    expect(source).not.toContain('Promise.all');
    expect(source).toContain('getBusinessDetail');
    expect(source).toContain('getBusinessChannelEnrollments');
  });
});
```

`src/app/(authenticated)/settings/competitors/__tests__/page-source.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('competitors settings page source', () => {
  it('keeps the competitors settings page free of Promise.all fan-out', async () => {
    const source = await readFile(
      'src/app/(authenticated)/settings/competitors/page.tsx',
      'utf8',
    );

    expect(source).not.toContain('Promise.all');
    expect(source).toContain('loadRivalPickerViews');
  });
});
```

- [ ] **Step 6: Create the threshold-label test**

`src/lib/auto-approval/__tests__/threshold-labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AUTO_APPROVAL_THRESHOLD_LABELS,
  autoApprovalThresholdLabel,
} from '@/lib/auto-approval/types';

describe('auto-approval threshold labels', () => {
  it('maps every auto-approval threshold to its label', () => {
    expect(AUTO_APPROVAL_THRESHOLD_LABELS).toEqual({ 4: '4–5★', 5: '5★ only' });
    expect(autoApprovalThresholdLabel(null)).toBe('Off');
    expect(autoApprovalThresholdLabel(5)).toBe('5★ only');
    expect(autoApprovalThresholdLabel(4)).toBe('4–5★');
  });
});
```

- [ ] **Step 7: Run the evals and confirm they fail for the right reasons**

Run:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && pnpm vitest run src/components/dashboard/shell/__tests__/Sidebar.test.tsx src/app/api/admin/channels/telegram/__tests__/start.test.ts src/lib/competitors/__tests__/named-rival.test.ts "src/app/(authenticated)/settings/competitors/__tests__/page-source.test.ts" "src/app/admin/businesses/[id]/__tests__/page-source.test.ts" src/lib/auto-approval/__tests__/threshold-labels.test.ts 2>&1 | tail -30
```

Expected failures, each for its own reason:
- Sidebar: received `/admin/login`, expected `/login`
- Telegram: `deepLink` is `https://t.me/?start=…`
- named-rival: `loadRivalPickerViews is not a function`
- both page-source: source still contains `Promise.all`
- threshold-labels: `AUTO_APPROVAL_THRESHOLD_LABELS` is not exported

A test failing with an import/mock-wiring error rather than the reason above is
a broken test, not a red eval — fix it now.

- [ ] **Step 8: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && git add -A && git commit -m "test(portal-audit): failing evals for PR1 correctness fixes"
```

---

## Task 2: Owner sign-out lands on /login

**Files:**
- Modify: `src/components/dashboard/shell/Sidebar.tsx:82`

- [ ] **Step 1: Change the redirect target**

Replace line 82's `router.push('/admin/login');` with:

```tsx
      router.push('/login');
```

Do **not** touch `require-owner-access.ts` or `(authenticated)/layout.tsx` —
their `/admin/login` targets are deliberate and pinned by
`src/lib/auth/__tests__/require-owner-access.test.ts:137,145`.

- [ ] **Step 2: Run the test**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && pnpm vitest run src/components/dashboard/shell/__tests__/Sidebar.test.tsx 2>&1 | tail -15
```

Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && git add -A && git commit -m "fix(dashboard): send owner sign-out to /login, not the admin portal"
```

---

## Task 3: Telegram blank-username fallback

**Files:**
- Modify: `src/app/api/admin/channels/telegram/start/route.ts:19-23`

- [ ] **Step 1: Align the fallback with the owner route**

Replace the body of `buildTelegramDeepLink`:

```ts
function buildTelegramDeepLink(rawToken: string): string {
  // `||` (not `??`) so a blank TELEGRAM_BOT_USERNAME falls back too — the var is
  // declared `rawOpt` (src/lib/config/server.ts), which preserves ''/'   '
  // byte-for-byte, and an empty string would otherwise produce a broken
  // https://t.me/?start=... link. Mirrors the owner route.
  const botUsername = getServerConfig().TELEGRAM_BOT_USERNAME?.trim() || 'RepWorthBot';
  return `https://t.me/${botUsername}?start=${rawToken}`;
}
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && pnpm vitest run src/app/api/admin/channels/telegram/__tests__/start.test.ts 2>&1 | tail -15
```

Expected: all pass, including the 2 new cases.

- [ ] **Step 3: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && git add -A && git commit -m "fix(channels): fall back to RepWorthBot when the bot username is blank"
```

---

## Task 4: Sequential rival-view loading

**Files:**
- Modify: `src/lib/competitors/named-rival.ts` (add export)
- Modify: `src/app/(authenticated)/settings/competitors/page.tsx:24-29`

- [ ] **Step 1: Add `loadRivalPickerViews` to `named-rival.ts`**

Place it directly beneath the existing `loadRivalPickerView`. Follow the
`loadLocationsSettingsView` precedent in `src/lib/locations/settings-view.ts` —
the loader owns the sequencing, the page does not:

```ts
/**
 * Every active location's rival-picker view, loaded SEQUENTIALLY — one query in
 * flight at a time (#773). Do NOT reintroduce a `Promise.all` here or in the
 * page: `loadRivalPickerView` is itself a 3-query chain, so an account with N
 * locations would put N chains in flight against a 3-connection pool, and the
 * width grows with the customer. Mirrors `loadLocationsSettingsView`.
 */
export async function loadRivalPickerViews(
  sql: Sql,
  { accountId, businessIds }: { accountId: string; businessIds: LocationId[] },
): Promise<RivalPickerView[]> {
  const views: RivalPickerView[] = [];
  for (const businessId of businessIds) {
    views.push(await loadRivalPickerView(sql, { accountId, businessId }));
  }
  return views;
}
```

Use the exact parameter and return types `loadRivalPickerView` already declares
— if its view type is named something other than `RivalPickerView`, use that
name. Do not introduce a new type.

- [ ] **Step 2: Collapse the page's loop into one call**

In `src/app/(authenticated)/settings/competitors/page.tsx`, replace the
`const views = await Promise.all(...)` block with:

```tsx
  const views = await loadRivalPickerViews(sql, {
    accountId: access.accountId,
    businessIds: locations.map((location) => asLocationId(location.id)),
  });
```

Update the import on line 10 from `loadRivalPickerView` to
`loadRivalPickerViews`. Leave `asLocationId` imported — it is still used.

- [ ] **Step 3: Run both tests**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && pnpm vitest run src/lib/competitors/__tests__/named-rival.test.ts "src/app/(authenticated)/settings/competitors/__tests__/page-source.test.ts" 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && git add -A && git commit -m "perf(competitors): load rival views sequentially, not N-wide"
```

---

## Task 5: Sequential business-detail loading

**Files:**
- Modify: `src/app/admin/businesses/[id]/page.tsx:25-30`

- [ ] **Step 1: Replace the fan-out and correct the comment**

The current comment claims "Concurrent, not serialized" and contradicts
`src/lib/admin/business-detail/queries.ts:97,214`. Replace both:

```tsx
  // SEQUENTIAL — do NOT re-introduce a Promise.all here. `getBusinessDetail` is
  // itself a 13-query chain that sequences deliberately (see
  // business-detail/queries.ts), and racing it against the channel read put two
  // chains in flight against a 3-connection pool — the fan-out width #773
  // measured wedging a pool of 3. Mirrors admin/costs and admin/overview.
  const detail = await getBusinessDetail(sql, businessId);
  const channels = await getBusinessChannelEnrollments(sql, businessId);
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && pnpm vitest run "src/app/admin/businesses/[id]/__tests__/page-source.test.ts" 2>&1 | tail -15
```

Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && git add -A && git commit -m "perf(admin): sequence business-detail reads, matching its own service"
```

---

## Task 6: One owner for the threshold labels

**Files:**
- Modify: `src/lib/auto-approval/types.ts`
- Modify: `src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:27-31`
- Modify: `src/app/admin/businesses/[id]/_components/AutoApprovalDiagnosticsPanel.tsx:19-26`

- [ ] **Step 1: Add the label map to `types.ts`**

Place it immediately after the `AutoApprovalThreshold` type on line 7, beside
the existing runtime constants (`APPROVAL_METHOD`):

```ts
/**
 * Threshold vocabulary, shared by the owner settings screen and the admin
 * diagnostics panel so the two cannot drift. The two
 * `AutoApprovalReadinessBlockReason` maps are deliberately NOT shared — admin
 * renders terse ops labels, owner renders explanatory sentences.
 */
export const AUTO_APPROVAL_THRESHOLD_LABELS: Record<AutoApprovalThreshold, string> = {
  4: '4–5★',
  5: '5★ only',
};

/** `null` means auto-approval is off for that scope. */
export function autoApprovalThresholdLabel(threshold: AutoApprovalThreshold | null): string {
  return threshold === null ? 'Off' : AUTO_APPROVAL_THRESHOLD_LABELS[threshold];
}
```

If `AutoApprovalThreshold` does not resolve to the literal union `4 | 5`, stop
and record it in the deviations file rather than widening the `Record` key type
— the exhaustiveness is the point.

- [ ] **Step 2: Use it in the owner client**

In `AutoApprovalClient.tsx`, replace the `THRESHOLD_OPTIONS` literal with one
derived from the shared owner:

```tsx
const THRESHOLD_OPTIONS: Array<{ value: AutoApprovalThreshold | null; label: string }> = [
  { value: null, label: autoApprovalThresholdLabel(null) },
  { value: 5, label: autoApprovalThresholdLabel(5) },
  { value: 4, label: autoApprovalThresholdLabel(4) },
];
```

Add `autoApprovalThresholdLabel` to the file's existing
`@/lib/auto-approval/types` import. Leave `BLOCK_REASON_COPY` untouched.

- [ ] **Step 3: Use it in the admin panel**

In `AutoApprovalDiagnosticsPanel.tsx`, delete the local `thresholdLabel`
function (lines 19–26) and import the shared one, adding
`autoApprovalThresholdLabel` to the existing
`@/lib/auto-approval/types` import. Replace every `thresholdLabel(` call site
with `autoApprovalThresholdLabel(`.

Add above `BLOCK_REASON_LABELS`:

```tsx
// Deliberately NOT shared with the owner UI's BLOCK_REASON_COPY: admin renders
// terse ops labels, owner renders explanatory sentences. Both are exhaustive
// over AutoApprovalReadinessBlockReason, so neither can silently miss a reason.
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && pnpm vitest run src/lib/auto-approval/__tests__/threshold-labels.test.ts "src/app/(authenticated)/settings/auto-approval/__tests__/AutoApprovalClient.test.tsx" 2>&1 | tail -15
```

Expected: all pass. The existing `AutoApprovalClient` test must pass
**unmodified** — the rendered labels are unchanged.

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && git add -A && git commit -m "refactor(auto-approval): one owner for the threshold labels"
```

---

## Task 7: Record why the three fixed-width fan-outs stay

**Files:**
- Modify: `src/app/api/account/settings/route.ts:69`
- Modify: `src/app/api/locations/add/route.ts:123`
- Modify: `src/app/(authenticated)/dashboard/add-location/page.tsx:35`

Spec §3.6 keeps these deliberately. Without a note the next audit re-raises them.

- [ ] **Step 1: Add the note above each `Promise.all`**

`src/app/api/account/settings/route.ts` — replace the existing "Fetch
independent account metrics" comment with:

```ts
  // Fetch independent account metrics after the account existence check.
  // Fixed width 2 on a read path — deliberately NOT sequentialised (spec
  // 2026-08-15-portal-audit-remediation §3.6). Unlike the competitors page,
  // this width does not grow with the customer.
```

`src/app/api/locations/add/route.ts` — replace the "Gather pre-transaction
data" comment with:

```ts
  // Gather pre-transaction data needed by addLocationTransaction.
  // Fixed width 3 on a customer-visible WRITE path — deliberately NOT
  // sequentialised (spec 2026-08-15-portal-audit-remediation §3.6):
  // serialising it adds latency to a write for no safety gain.
```

`src/app/(authenticated)/dashboard/add-location/page.tsx` — replace the "Fetch
billing snapshot" comment with:

```tsx
  // Fetch billing snapshot for the confirm-and-pay step.
  // Fixed width 2 on a read path — deliberately NOT sequentialised (spec
  // 2026-08-15-portal-audit-remediation §3.6).
```

- [ ] **Step 2: Verify nothing else changed**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && git diff --stat
```

Expected: 3 files, comment lines only, no logic change.

- [ ] **Step 3: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && git add -A && git commit -m "docs(fan-out): record why three fixed-width Promise.alls stay"
```

---

## Task 8: Full gate

- [ ] **Step 1: Run the review-mode gate**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && bash scripts/verify-gate.sh --review 2>&1 | tail -30
```

Expected: every row PASS, including `promised-tests` (all ten titles found),
`diff-coverage` (≥80%), and `reclassify` (within 2× of 70 prod / 180 test).

- [ ] **Step 2: On any failure, read only the failing log tail**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness && tail -40 .feature/logs/<failing-row>.log
```

Fix, re-run Step 1. If the same failure class recurs twice, stop patching and
dispatch a `diagnosing-bugs` subagent per the workflow's anti-thrash rule.

---

## Self-Review

**Spec coverage:** §3.1 → Task 2. §3.2 → Task 3. §3.3 → Task 5. §3.4 → Task 4.
§3.5 → Task 6. §3.6 → Task 7. All ten `tests_to_add` → Task 1. No spec section
in PR 1's scope is unassigned.

**Placeholder scan:** no TBD/TODO; every code step carries real code; no "similar
to Task N" references.

**Type consistency:** `AUTO_APPROVAL_THRESHOLD_LABELS` and
`autoApprovalThresholdLabel` are defined in Task 6 Step 1 and used under those
exact names in Task 1 Step 6, Task 6 Step 2, and Task 6 Step 3.
`loadRivalPickerViews` is defined in Task 4 Step 1 and used under that name in
Task 1 Step 4, Task 4 Step 2, and the competitors page-source assertion.

**Known deviation risk:** Task 4 Step 1 and Task 6 Step 1 both carry an explicit
stop-and-record instruction if the real type names differ from what this plan
assumes.
