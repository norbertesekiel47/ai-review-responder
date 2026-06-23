# Billing Audit Remediation — PR A (safety + quick wins + nits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the low-risk half of the 2026-06-23 core-billing-audit remediation — the FIND-ENV safety fix, four quick-win P2s, and three safe P3 nits — with no money-path logic changes.

**Architecture:** Each task is an isolated, independently-revertable change on branch `billing/audit-remediation-pr-a` (already created; spec + audit already committed at `2161e68a`). PR B (the money-path applier consolidation + reconcile robustness) is a SEPARATE plan written after PR A merges. Source-of-truth spec: `docs/superpowers/specs/2026-06-23-core-billing-audit-remediation-design.md`.

**Tech Stack:** Next.js 16 (App Router, server components), Fastify/BullMQ worker, Postgres.js, Vitest, Stripe SDK, `@sentry/node`, pnpm.

**Commit convention:** every `git commit` in this plan MUST end with the two required trailers:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016B88q6AJQKwLASiUXGg5Rt
```
Steps show `-m "<subject>"` for brevity — append the trailers (use a HEREDOC `-F -` as in the spec commit).

**Pre-flight (run once before Task 1):**
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth
git branch --show-current   # expect: billing/audit-remediation-pr-a
git log --oneline -1        # expect: 2161e68a docs(billing): core-audit remediation spec + source audit
```
If not on that branch: `git checkout billing/audit-remediation-pr-a`.

---

## Task 1: FIND-ENV — repoint local dev DB off prod + document the rule

**Why:** local `.env.local` points `DATABASE_URL` / `DATABASE_POOL_URL` / `NEXT_PUBLIC_SUPABASE_URL` at the **prod** Supabase project (`udeyaqnvpojbwgoaxwdg`) with `MOCK_EXTERNAL_APIS=false`. Any unmocked local run reads/writes prod. (Confirmed P1; prod backend isn't deployed yet so prod is empty today — fix before real data exists.)

**Files:**
- Modify (local, gitignored — NOT committed): `.env.local`
- Modify (committed): `docs/runbooks/deployment-guide.md` (§1.3), `.claude/reference/env-vars.md`

- [ ] **Step 1: Start a local Supabase stack**

```bash
# If supabase/config.toml does not exist yet, initialize first:
test -f supabase/config.toml || pnpm dlx supabase init
pnpm dlx supabase start
```
Expected: prints local `API URL` (http://127.0.0.1:54321), `DB URL` (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`), `anon key`, and `service_role key`. Copy these.

- [ ] **Step 2: Repoint `.env.local` at the local stack (local only — do NOT git add)**

Set these keys in `.env.local` to the values printed by `supabase start` (replace the prod `udeyaqnvpojbwgoaxwdg` values):
```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase start>
SUPABASE_SERVICE_KEY=<service_role key from supabase start>
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DATABASE_POOL_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```
Leave `MOCK_EXTERNAL_APIS` as-is (the local DB now makes unmocked runs safe).

- [ ] **Step 3: Verify no `.env.local` var still points at prod**

```bash
grep -n 'udeyaqnvpojbwgoaxwdg' .env.local || echo "CLEAN: no prod ref"
```
Expected: `CLEAN: no prod ref`.

- [ ] **Step 4: Add the dev-DB rule to the docs (committed artifact)**

In `docs/runbooks/deployment-guide.md`, under the §1.3 "don't share prod with dev" subsection, add:
```markdown
> **Local dev DB must never be a deployed project.** `.env.local` `DATABASE_URL`,
> `DATABASE_POOL_URL`, and `NEXT_PUBLIC_SUPABASE_URL` must point at a local
> Supabase stack (`supabase start`), never at the prod or staging project ref.
> With `MOCK_EXTERNAL_APIS=false`, an unmocked `pnpm dev`/`pnpm worker`/seed
> reads AND writes whatever DB these resolve to. (Audit FIND-ENV, 2026-06-23.)
```
In `.claude/reference/env-vars.md`, add the same one-line warning next to the `DATABASE_URL` / `DATABASE_POOL_URL` entries.

- [ ] **Step 5: Commit (docs only)**

```bash
git add docs/runbooks/deployment-guide.md .claude/reference/env-vars.md
git commit -m "docs(env): local dev DB must be a local Supabase stack, never prod (FIND-ENV)"
```

---

## Task 2: OVERAGE-F2 — page Sentry when an overage item is ambiguous

**Why:** `UpdateStripeOverageWorker.ts:151-157` terminal-fails the outbox row on an `ambiguous` overage match with only `logger.error` — no Sentry. That account's location growth silently stops being billed until someone notices.

**Files:**
- Modify: `worker/jobs/billing/UpdateStripeOverageWorker.ts`
- Test: `worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts`

- [ ] **Step 1: Add the Sentry mock + extend the existing AMBIGUOUS test (failing)**

In the test file's `vi.hoisted` block (currently ends at `mockRecordOutboxTransientError`), add a `mockCaptureMessage`:
```typescript
const {
  mockSql,
  mockStripeSubscriptionsRetrieve,
  mockStripeSubscriptionItemsUpdate,
  mockStripeSubscriptionItemsCreate,
  mockStripeSubscriptionItemsDel,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockRecordOutboxTransientError,
  mockCaptureMessage,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockStripeSubscriptionsRetrieve: vi.fn(),
  mockStripeSubscriptionItemsUpdate: vi.fn(),
  mockStripeSubscriptionItemsCreate: vi.fn(),
  mockStripeSubscriptionItemsDel: vi.fn(),
  mockMarkOutboxCompleted: vi.fn(),
  mockMarkOutboxFailed: vi.fn(),
  mockRecordOutboxTransientError: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));
```
Add this mock next to the others (after the `vi.mock('stripe', …)` block):
```typescript
vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  captureException: vi.fn(),
}));
```
Add `mockCaptureMessage.mockReset();` inside `beforeEach` (next to the other resets). Then extend the existing AMBIGUOUS test (`'AMBIGUOUS: a descriptor-only (keyword) match never mutates Stripe; outbox failed with ambiguous_overage_item'`) by adding, before its closing brace:
```typescript
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ambiguous'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          feature: 'stripe_overage',
          drift_type: 'ambiguous_overage_item',
        }),
      }),
    );
```

- [ ] **Step 2: Run the test — verify it FAILS**

```bash
pnpm vitest run worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts -t "AMBIGUOUS"
```
Expected: FAIL — `mockCaptureMessage` was not called.

- [ ] **Step 3: Implement the Sentry page in the worker**

In `worker/jobs/billing/UpdateStripeOverageWorker.ts`, add the import after line 14 (`import { UnrecoverableError, type Job } from 'bullmq';`):
```typescript
import { captureMessage } from '@sentry/node';
```
Replace the ambiguous branch (currently lines 151-157):
```typescript
  if (outcome.kind === 'ambiguous') {
    // No Stripe mutation happened. Terminal-fail the outbox row so ops sees it.
    // Also page Sentry directly (OVERAGE-F2): an ambiguous match silently stops
    // billing this account's location growth until someone notices — logger.error
    // alone is not an alert. The reconcile poller also surfaces the underlying
    // drift, but at warning level on an hourly cadence.
    logger.error(`${outcome.detail} (account ${account_id})`);
    captureMessage(
      `Overage sync ambiguous — billing halted for account ${account_id}: ${outcome.detail}`,
      {
        level: 'error',
        tags: {
          feature: 'stripe_overage',
          account_id,
          drift_type: 'ambiguous_overage_item',
        },
      },
    );
    await markOutboxFailed(outboxId, outcome.detail, outboxAttempt);
    return;
  }
```

- [ ] **Step 4: Run the test — verify it PASSES**

```bash
pnpm vitest run worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
```
Expected: PASS (all tests in the file, including the extended AMBIGUOUS one).

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/billing/UpdateStripeOverageWorker.ts worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
git commit -m "fix(billing): alert Sentry on ambiguous overage dead-letter (OVERAGE-F2)"
```

---

## Task 3: STATUS-1.1 — fix trialing-Basic locked copy via a tested helper

**Why:** `settings/locations/page.tsx:54` uses a raw `=== SubscriptionStatus.ACTIVE` to choose WHICH locked copy to show, so a trialing-Basic owner sees "subscription must be active" instead of "Upgrade to add locations." No entitlement leak (the real gate is `canAddLocationForAccount` → `subscriptionGrantsFullAccess`). Fix: move the copy decision into the module that already owns `canAddLocationForAccount`, and make the page consume it.

**Files:**
- Modify: `src/lib/locations/multi-location-mode.ts`
- Test: `src/lib/locations/__tests__/multi-location-mode.test.ts`
- Modify: `src/app/(authenticated)/settings/locations/page.tsx`

- [ ] **Step 1: Write the failing test for `lockedAddLocationReason`**

Append to `src/lib/locations/__tests__/multi-location-mode.test.ts` (and add `lockedAddLocationReason` to the existing import from `'../multi-location-mode'`):
```typescript
describe('lockedAddLocationReason', () => {
  // The STATUS-1.1 bug: a trialing Basic owner is entitled (full access) but on a
  // tier with no multi-location allowance → must see the UPGRADE copy, not "inactive".
  it('returns "upgrade" for a trialing Basic owner (entitled, no multi-loc tier)', () => {
    expect(
      lockedAddLocationReason(SubscriptionTier.BASIC, SubscriptionStatus.TRIALING),
    ).toBe('upgrade');
  });

  it('returns "upgrade" for an active Basic owner', () => {
    expect(
      lockedAddLocationReason(SubscriptionTier.BASIC, SubscriptionStatus.ACTIVE),
    ).toBe('upgrade');
  });

  it.each([
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELLED,
    SubscriptionStatus.PENDING_PAYMENT,
  ] as const)('returns "inactive" when the subscription does not grant access (%s)', (status) => {
    expect(lockedAddLocationReason(SubscriptionTier.BASIC, status)).toBe('inactive');
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

```bash
pnpm vitest run src/lib/locations/__tests__/multi-location-mode.test.ts -t "lockedAddLocationReason"
```
Expected: FAIL — `lockedAddLocationReason is not a function`.

- [ ] **Step 3: Implement the helper**

Append to `src/lib/locations/multi-location-mode.ts` (it already imports `lookupTierConfig` and `subscriptionGrantsFullAccess`):
```typescript
/**
 * Which "locked" reason to surface when add-location is NOT available (i.e.
 * canAddLocationForAccount returned false). One tested owner for the copy
 * decision, so the page never re-derives entitlement from a raw status compare:
 *   - 'upgrade'  — the account IS entitled (full access) but its tier has no
 *                  multi-location allowance (Basic). Show the upgrade CTA.
 *   - 'inactive' — the subscription does not grant full access. Show the
 *                  "subscription must be active" CTA.
 * A trialing account grants full access, so trialing-Basic yields 'upgrade'
 * (fixes STATUS-1.1). Only meaningful in the locked branch.
 */
export function lockedAddLocationReason(
  subscriptionTier: string,
  subscriptionStatus: string,
): 'upgrade' | 'inactive' {
  if (
    subscriptionGrantsFullAccess(subscriptionStatus)
    && lookupTierConfig(subscriptionTier)?.multiLocAllowed !== true
  ) {
    return 'upgrade';
  }
  return 'inactive';
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

```bash
pnpm vitest run src/lib/locations/__tests__/multi-location-mode.test.ts
```
Expected: PASS.

- [ ] **Step 5: Wire the page to the helper**

In `src/app/(authenticated)/settings/locations/page.tsx`, add `lockedAddLocationReason` to the existing `'@/lib/locations/multi-location-mode'` import:
```typescript
import {
  canAddLocationForAccount,
  lockedAddLocationReason,
  shouldShowLocationsSettings,
} from '@/lib/locations/multi-location-mode';
```
Replace the `addLocationState` block (currently lines 48-69) with:
```typescript
  const canAdd = canAddLocationForAccount(
    featureEnabled,
    account?.subscription_tier ?? '',
    account?.subscription_status ?? '',
  );
  const addLocationState: AddLocationState = canAdd
    ? { kind: 'enabled' }
    : lockedAddLocationReason(
          account?.subscription_tier ?? '',
          account?.subscription_status ?? '',
        ) === 'upgrade'
      ? {
          kind: 'locked',
          title: 'Upgrade to add locations',
          description: 'Basic includes one location. Upgrade to Standard or Premium to add more.',
          ctaHref: '/settings/billing',
          ctaLabel: 'View plan options',
        }
      : {
          kind: 'locked',
          title: 'Location additions unavailable',
          description: 'Your subscription must be active before adding another location.',
          ctaHref: '/settings/billing',
          ctaLabel: 'Review billing',
        };
```
Then remove the now-unused imports `SubscriptionStatus` (line 21) and `SubscriptionTier` (line 20) **only if** lint flags them (next step confirms).

- [ ] **Step 6: Typecheck + lint + build**

```bash
pnpm typecheck && pnpm lint && pnpm build
```
Expected: clean. If lint reports `SubscriptionStatus`/`SubscriptionTier` unused in `page.tsx`, delete those two import lines and re-run. (A server-component render test is disproportionate for a copy string; the decision logic is now unit-tested in Step 1-4 and the page is a thin mapping.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/locations/multi-location-mode.ts src/lib/locations/__tests__/multi-location-mode.test.ts "src/app/(authenticated)/settings/locations/page.tsx"
git commit -m "fix(billing): trialing-Basic shows upgrade copy, not 'must be active' (STATUS-1.1)"
```

---

## Task 4: FIND-001 — delete the orphaned admin payment-success route + page

**Why:** verified orphaned — real Checkout `success_url` is `/onboarding/payment-success`; that page polls `/api/auth/signup-status`. The ONLY caller of `/api/admin/payment-success` is the admin page itself, which 404s on an account-vs-business id mismatch. Delete it and clean every reference.

**Files:**
- Delete: `src/app/api/admin/payment-success/route.ts`, `src/app/admin/payment-success/page.tsx`, `src/app/admin/payment-success/__tests__/page.test.tsx`
- Modify: `src/components/admin/AdminNav.tsx`, `scripts/ci/tenant-scope-allowlist.ts`, `src/__tests__/console-admin-palette.test.ts`, `docs/directory.md`

- [ ] **Step 1: Delete the route, page, and page test**

```bash
git rm src/app/api/admin/payment-success/route.ts \
       src/app/admin/payment-success/page.tsx \
       src/app/admin/payment-success/__tests__/page.test.tsx
```

- [ ] **Step 2: Remove the AdminNav path branch**

In `src/components/admin/AdminNav.tsx`, change lines 24-27 from:
```typescript
  // Don't show nav on login or payment-success pages
  if (pathname === '/admin/login' || pathname?.startsWith('/admin/payment-success')) {
    return null;
  }
```
to:
```typescript
  // Don't show nav on the login page
  if (pathname === '/admin/login') {
    return null;
  }
```

- [ ] **Step 3: Remove the tenant-scope allowlist entry**

In `scripts/ci/tenant-scope-allowlist.ts`, delete the whole object (the one whose `file` is `"src/app/api/admin/payment-success/route.ts"`, table `inbound_events`, around lines 2694-2700) — the full `{ … }` block including its trailing comma.

- [ ] **Step 4: Remove the command-palette test entry**

In `src/__tests__/console-admin-palette.test.ts`, delete the line (≈28):
```typescript
  'src/app/admin/payment-success/page.tsx',
```

- [ ] **Step 5: Fix `docs/directory.md`**

- Delete line ≈157 (admin section): `| `payment-success/page.tsx` | Post-Stripe confirmation page. |`
- Delete line ≈273 (admin api section): `| `payment-success/route.ts` | POST Stripe payment confirmation (writes to `job_outbox`). |`
- Correct the stale onboarding line ≈173 — replace:
  `| `payment-success/PaymentSuccessClient.tsx` | Polls `/api/admin/payment-success` until `subscription_status` flips to `active`. |`
  with:
  `| `payment-success/PaymentSuccessClient.tsx` | Polls `/api/auth/signup-status` until the subscription grants full access (paid or trial). |`

- [ ] **Step 6: Verify deletion is clean**

```bash
# No dangling references anywhere in source/scripts/docs:
rg -n --no-ignore -g '!node_modules' -g '!graphify-out/**' -g '!*.tsbuildinfo' 'admin/payment-success' src/ scripts/ docs/ && echo "FOUND REFS (must be empty)" || echo "CLEAN"
pnpm ci:tenant-scope
pnpm vitest run src/__tests__/console-admin-palette.test.ts
pnpm build
```
Expected: `CLEAN`; tenant-scope green; palette test green; build emits no `/admin/payment-success` or `/api/admin/payment-success` route.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(billing): delete orphaned /admin/payment-success route+page (FIND-001)"
```

---

## Task 5: OVERAGE-F5 — document the intentional archive exemption

**Why:** `/api/locations/archive` has no offboarding gate while `add`/`reactivate` do — and that's correct (the gate freezes billing-EXPANDING mutations; archive is billing-CONTRACTING). Make the omission intentional in the code, not accidental-looking.

**Files:**
- Modify: `src/app/api/locations/archive/route.ts`

- [ ] **Step 1: Add the explanatory comment**

In `src/app/api/locations/archive/route.ts`, immediately before `const reqCtx = await readLocationActionRequest(...)` (line 58), add:
```typescript
  // Intentionally NOT offboarding-gated (OVERAGE-F5). The isBillingMutationBlocked
  // gate on add/reactivate freezes billing-EXPANDING mutations during offboarding.
  // Archive is billing-CONTRACTING (it decrements overage quantity) — gating it
  // would trap an offboarding customer at a higher bill. Exempt by design.
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```
Expected: clean (comment-only change).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/locations/archive/route.ts
git commit -m "docs(billing): document archive's intentional offboarding-gate exemption (OVERAGE-F5)"
```

---

## Task 6: RECONCILE-F4 — only log "Corrected stuck trialing row" on a real change

**Why:** `reconcile-account.ts:155-173` discards the applier's `TransitionResult` and logs `warn('Corrected stuck trialing row…')` unconditionally — even when the applier was a no-op (`changed:false`), inflating the "stuck trial" signal.

**Files:**
- Modify: `worker/background/pollers/billing-reconciliation/reconcile-account.ts`
- Test: `worker/background/pollers/__tests__/reconcile-account-trial-correction.test.ts`

- [ ] **Step 1: Add a logger mock + two failing tests**

In `reconcile-account-trial-correction.test.ts`, extend the `vi.hoisted` block to add a warn spy and mock the logger module:
```typescript
const { mockSql, mockApplyStripeSubscriptionState, mockLoggerWarn } = vi.hoisted(() => {
  const mockSql: any = vi.fn(() => Promise.resolve(Object.assign([], { count: 0 })));
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));
  return {
    mockSql,
    mockApplyStripeSubscriptionState: vi.fn().mockResolvedValue({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    }),
    mockLoggerWarn: vi.fn(),
  };
});
```
Add this mock next to the existing `vi.mock` calls:
```typescript
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({ warn: mockLoggerWarn, error: vi.fn(), log: vi.fn() }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));
```
Add `mockLoggerWarn.mockClear();` to `beforeEach`. Then add these tests inside the `describe('reconcileAccount — trial correction', …)` block:
```typescript
  it('logs the correction when the applier actually changed the row', async () => {
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    });
    await reconcileAccount(makeStripe('active'), makeAccount());
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Corrected stuck trialing row to match Stripe',
      expect.objectContaining({ account_id: 'acct-1' }),
    );
  });

  it('does NOT log a correction when the applier was a no-op (changed:false)', async () => {
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'trialing',
      changed: false, activated: false, primaryBusinessId: null,
    });
    await reconcileAccount(makeStripe('active'), makeAccount());
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      'Corrected stuck trialing row to match Stripe',
      expect.anything(),
    );
  });
```

- [ ] **Step 2: Run the tests — verify the no-op one FAILS**

```bash
pnpm vitest run worker/background/pollers/__tests__/reconcile-account-trial-correction.test.ts -t "no-op"
```
Expected: FAIL — warn was called despite `changed:false`.

- [ ] **Step 3: Implement the conditional log**

In `reconcile-account.ts`, replace the trial-correction block (currently lines 155-173):
```typescript
  if (dbTrialing && !stripeTrialing && account.stripe_subscription_id) {
    const transition = await sql.begin(async (tx) =>
      applyStripeSubscriptionState(
        tx,
        {
          mode: 'subscription',
          stripeCustomerId: extractStripeCustomerId(subscription.customer) ?? account.stripe_customer_id ?? '',
          stripeSubscriptionId: account.stripe_subscription_id!,
        },
        subscription,
      ),
    );
    if (transition.changed) {
      logger.warn('Corrected stuck trialing row to match Stripe', {
        account_id: account.id,
        stripe_status: subscription.status,
      });
    }
    // The row is now consistent; skip the remaining drift checks this cycle.
    return { accountsChecked: 1, drifts, errors };
  }
```

- [ ] **Step 4: Run the tests — verify they PASS**

```bash
pnpm vitest run worker/background/pollers/__tests__/reconcile-account-trial-correction.test.ts
```
Expected: PASS (including the pre-existing correction tests).

- [ ] **Step 5: Commit**

```bash
git add worker/background/pollers/billing-reconciliation/reconcile-account.ts worker/background/pollers/__tests__/reconcile-account-trial-correction.test.ts
git commit -m "fix(billing): only log trial correction when the applier changed the row (RECONCILE-F4)"
```

---

## Task 7: OVERAGE-F4 — attempt-guard `recordOutboxTransientError`

**Why:** `recordOutboxTransientError` (`outbox.ts:116-126`) is the only outbox helper NOT attempt-guarded, so a stale BullMQ retry can overwrite `last_error` with an older message. Mirror `markOutboxFailed`'s attempt-guard (with the legacy fallback).

**Files:**
- Modify: `src/lib/shared/outbox.ts`
- Modify: `worker/jobs/billing/UpdateStripeOverageWorker.ts` (call site line 139)
- Test: `worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts`

- [ ] **Step 1: Update the worker test's TRANSIENT assertion to expect the attempt (failing)**

In `UpdateStripeOverageWorker.test.ts`, the TRANSIENT test (`'TRANSIENT: a Stripe rate-limit error leaves the outbox row dispatched (no markOutboxFailed)'`) currently asserts:
```typescript
    expect(mockRecordOutboxTransientError).toHaveBeenCalledWith(
      'outbox-1',
      expect.stringContaining('Too many requests'),
    );
```
Change it to include the attempt:
```typescript
    expect(mockRecordOutboxTransientError).toHaveBeenCalledWith(
      'outbox-1',
      expect.stringContaining('Too many requests'),
      1,
    );
```

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm vitest run worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts -t "TRANSIENT: a Stripe rate-limit"
```
Expected: FAIL — called with 2 args, expected 3.

- [ ] **Step 3: Thread `attempt` through the helper + call site**

In `src/lib/shared/outbox.ts`, replace `recordOutboxTransientError` (lines 116-134) with the attempt-guarded version (mirrors `markOutboxFailed`):
```typescript
export async function recordOutboxTransientError(
  outboxId: string,
  error: string,
  attempt?: number,
): Promise<void> {
  try {
    if (typeof attempt === 'number' && Number.isFinite(attempt)) {
      await sql`
        UPDATE job_outbox
        SET last_error = ${error}
        WHERE id = ${outboxId}
          AND status = 'dispatched'
          AND attempts = ${attempt}
      `;
      return;
    }
    // Legacy path: attempt unknown. Still guard on status.
    await sql`
      UPDATE job_outbox
      SET last_error = ${error}
      WHERE id = ${outboxId}
        AND status = 'dispatched'
    `;
  } catch (recordErr) {
    console.warn(
      `[outbox] recordOutboxTransientError failed for ${outboxId} — observability only, swallowing: ${
        recordErr instanceof Error ? recordErr.message : String(recordErr)
      }`,
    );
  }
}
```
Update the call site in `UpdateStripeOverageWorker.ts` (line 139):
```typescript
      await recordOutboxTransientError(outboxId, message, outboxAttempt);
```

- [ ] **Step 4: Run — verify PASS**

```bash
pnpm vitest run worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/outbox.ts worker/jobs/billing/UpdateStripeOverageWorker.ts worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
git commit -m "fix(billing): attempt-guard recordOutboxTransientError so a stale retry can't stomp last_error (OVERAGE-F4)"
```

---

## Task 8: SELECTPLAN-1 — make the tier-config invariant explicit, drop dead fallbacks

**Why:** `select-plan/route.ts:206-216` snapshots `locations_included`/`overage_price_cents`/`base_price_cents` from `TIER_CONFIG[tier]` with `?? 1 / ?? 2500 / ?? 7900` fallbacks. `tier` is schema-validated (`SelectPlanSchema`), so the fallbacks are unreachable — and silently snapshotting wrong prices would be a billing bug, not a safe default. Replace the silent fallbacks with one explicit guard above the tx (behavior-preserving for valid tiers).

**Files:**
- Modify: `src/app/api/onboarding/select-plan/route.ts`

- [ ] **Step 1: Hoist + guard `tierConfig` above the transaction, drop the fallbacks**

In `src/app/api/onboarding/select-plan/route.ts`, immediately before `const result = await sql.begin(async (tx) => {` (line 173), add:
```typescript
  // SELECTPLAN-1: tier is validated by SelectPlanSchema, so this lookup always
  // resolves — the guard makes the invariant explicit (and refuses to snapshot a
  // wrong price) instead of papering over an impossible state with `?? 1/2500/7900`.
  const tierConfig = TIER_CONFIG[tier as SubscriptionTierValue];
  if (!tierConfig) {
    return NextResponse.json(
      { error: 'checkout_unavailable', detail: `Unknown tier: ${tier}` },
      { status: 502, headers: NO_STORE },
    );
  }
```
Then inside the tx, delete the now-duplicate `const tierConfig = …` (line 206) and change the UPDATE's snapshot columns (lines 210-212) to drop the fallbacks:
```typescript
      UPDATE accounts
      SET subscription_tier = ${tier},
          locations_included = ${tierConfig.included},
          locations_overage_price_cents = ${tierConfig.overageCents},
          base_price_cents = ${tierConfig.baseCents},
          updated_at = NOW()
```

- [ ] **Step 2: Typecheck + run the select-plan suite (if any) + build**

```bash
pnpm typecheck
pnpm vitest run src/app/api/onboarding/select-plan 2>/dev/null || echo "no select-plan unit test — relying on typecheck+build (behavior-preserving for valid tiers)"
pnpm build
```
Expected: typecheck clean (the guard narrows `tierConfig` to non-null so `.included/.overageCents/.baseCents` typecheck without `?`); build clean. This task is behavior-preserving dead-code removal — verified by the type-narrowing + green suite, not red-green TDD.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/onboarding/select-plan/route.ts
git commit -m "refactor(billing): explicit tier-config guard, drop dead price fallbacks (SELECTPLAN-1)"
```

---

## Task 9: A7 — comment-only clarifications (OVERAGE-F3, NOTE-B)

**Why:** two findings are "make the rationale explicit," not logic changes.

**Files:**
- Modify: `src/lib/payments/overage-item.ts` (≈line 99)
- Modify: `worker/ingress/stripe/apply-subscription-state.ts` (≈lines 66-70)

- [ ] **Step 1: OVERAGE-F3 — note the real defense**

In `src/lib/payments/overage-item.ts`, expand the comment above the `if (originalCount > 1 && storedOveragePriceCents > 0) {` guard (line 96-99):
```typescript
  // Priority 3 — unit-amount match (multi-item subscriptions only). The
  // high-confidence path for legacy/rotated-price items: the stored cents are
  // the account's own grandfathered snapshot. OVERAGE-F3: the `originalCount > 1`
  // guard means a solo-location sub whose ONLY line is the overage item can't
  // match here — by design. The `billing_role` metadata stamp (Priority 2) is the
  // primary defense for that case; this unit-amount pass is intentionally narrow.
```

- [ ] **Step 2: NOTE-B — confirm the incomplete_expired mapping is intentional**

In `worker/ingress/stripe/apply-subscription-state.ts`, add a comment in `mapStripeStatus` above the `case 'past_due':` group (line 66):
```typescript
    // NOTE-B: incomplete_expired maps to PAST_DUE (not CANCELLED) on purpose —
    // it preserves the 7-day grace/dunning window rather than hard-cancelling.
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return SubscriptionStatus.PAST_DUE;
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm typecheck
git add src/lib/payments/overage-item.ts worker/ingress/stripe/apply-subscription-state.ts
git commit -m "docs(billing): clarify overage unit-amount guard + incomplete_expired mapping (OVERAGE-F3, NOTE-B)"
```

---

## Task 10: PR A final verification gate + open PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run the full local gate (same as CI)**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
Expected: all green. (The pre-push hook runs the cheap subset automatically; this is the full sweep.)

- [ ] **Step 2: Push the branch**

```bash
git push -u origin billing/audit-remediation-pr-a
```

- [ ] **Step 3: Open PR A → `main`**

```bash
gh pr create --base main --head billing/audit-remediation-pr-a \
  --title "billing: safety + quick wins + nits (audit PR A)" \
  --body "$(cat <<'EOF'
PR A of the 2026-06-23 core-billing-audit remediation (low-risk half). Spec:
docs/superpowers/specs/2026-06-23-core-billing-audit-remediation-design.md

- FIND-ENV: local dev DB rule documented (repointed off prod locally)
- OVERAGE-F2: Sentry alert on ambiguous overage dead-letter
- STATUS-1.1: trialing-Basic shows upgrade copy (tested helper)
- FIND-001: delete orphaned /admin/payment-success route+page + refs
- OVERAGE-F5: document archive's intentional offboarding-gate exemption
- RECONCILE-F4: only log trial correction on a real change
- OVERAGE-F4: attempt-guard recordOutboxTransientError
- SELECTPLAN-1: explicit tier-config guard, drop dead price fallbacks
- OVERAGE-F3 / NOTE-B: rationale comments

No money-path logic changes. PR B (applier consolidation + reconcile robustness)
follows as a separate branch after this merges.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opens; the 4 CI checks (lint/typecheck/test/build) start.

- [ ] **Step 4: After CI green + merge → fast-forward staging**

```bash
git checkout staging && git merge --ff-only main && git push origin staging
git checkout billing/audit-remediation-pr-a   # or main, per next work
```
(Per CLAUDE.md: keep `staging` from drifting after promotion.)

---

## Self-review notes (author)

- **Spec coverage:** PR A items A1–A7 from the spec all have tasks (FIND-ENV→T1, OVERAGE-F2→T2, STATUS-1.1→T3, FIND-001→T4, OVERAGE-F5→T5, RECONCILE-F4→T6, OVERAGE-F4→T7, SELECTPLAN-1→T8, OVERAGE-F3+NOTE-B→T9, gate→T10). OVERAGE-F6 is a staging integration-test TODO tracked in the spec (no PR-A code change) — intentionally omitted here.
- **PR B (deferred):** QUALITY-OBS applier consolidation, OVERAGE-F1 advisory lock, RECONCILE-F5 abort, RECONCILE-F1 drift check, RECONCILE-F3/F6, CONFIG-1 — written as a separate plan after PR A merges (it rebases on A; the applier refactor needs grounding against the post-A tree).
- **Type/name consistency:** `lockedAddLocationReason(tier, status)` used identically in T3 helper + page; `recordOutboxTransientError(outboxId, error, attempt?)` signature matches caller in T7; `TransitionResult.changed` (confirmed `apply-subscription-state.ts:45`) used in T6.
- **File overlap with PR B:** `UpdateStripeOverageWorker.ts` (T2/T7) and `reconcile-account.ts` (T6) are also touched by PR B — PR B rebases on A; edits here are small and localized to minimize the rebase surface.
