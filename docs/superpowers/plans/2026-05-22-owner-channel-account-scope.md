# Owner Channel Enrollment — Account-Scope Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make org-default owner channel enrollment account-scoped end-to-end so multi-location accounts work correctly on Telegram + WhatsApp, and remove the WhatsApp single-location interim guard.

**Architecture:** Replace `business_id = user.locationId` with `account_id = <accountId> AND channel = <ch> AND location_id IS NULL` in every org-default read/write path (shared status GET, both enrollment helpers, owner routes), make the enrollment advisory lock account-scoped (owner + Telegram/WhatsApp admin), and revert the WhatsApp guard. `business_id` stays a NOT-NULL legacy FK written on INSERT (= the enrolling owner's `locationId`) but is never read for lookup. **Query-only — no migration, no backfill.**

**Tech Stack:** Next.js App Router route handlers, Postgres via `postgres` (Postgres.js) with advisory-lock transactions, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`

**Branch:** `fix/owner-channel-account-scope` (already created off the post-#53 `main`).

---

## Scope Check

Single, coherent correctness fix. SMS owner self-service does not exist and is **not** built here (the corrected pattern is documented for when it is). SMS admin lock is **deferred** (no owner-SMS path → no race today; `withMobileEnrollmentLock` spans 5+ routes). No migration.

## File Structure

- **Helpers** own the account-scoped predicates: `src/lib/channels/telegram-enrollment.ts`, `whatsapp-enrollment.ts`.
- **Routes** orchestrate: resolve `accountId`, take the account-scoped lock, call helpers. Owner Telegram + WhatsApp `start/cancel/disable`; the shared status GET; Telegram + WhatsApp admin `start` (lock key only).
- **UI**: revert the WhatsApp multi-location gating in `page.tsx` + `ChannelsClient.tsx`.
- **Tests** live beside each unit; the regression scenario goes in the WhatsApp + (new) Telegram owner integration tests.

---

## Task 1: Telegram enrollment helpers → account-scoped

**Files:**
- Modify: `src/lib/channels/telegram-enrollment.ts`
- Test: `src/lib/channels/__tests__/telegram-enrollment.test.ts`

- [ ] **Step 1: Update the helper tests first (red).**

Open `src/lib/channels/__tests__/telegram-enrollment.test.ts`. The existing tests assert SQL text and pass `businessId`. Update them so:
- Any assertion matching the SELECT/UPDATE predicate changes from `business_id = ` to include `account_id = ` and `location_id IS NULL`. Concretely, where a test asserts the cancel/disable/start SQL, the new predicate substrings to assert are `account_id = ` and `location_id IS NULL` (and the existing `channel = 'telegram'`, `status = …`, `archived_at IS NULL`).
- `cancelTelegramEnrollment` / `disableTelegramEnrollment` calls change from `(tx, 'biz-1')` to `(tx, 'acct-1')` (now account-keyed). `startTelegramEnrollment(tx, businessId, accountId, …)` keeps both args; assert the INSERT still carries `business_id` AND `account_id`, and that the SELECT filters by `account_id` + `location_id IS NULL` (not `business_id`).

Run: `pnpm test src/lib/channels/__tests__/telegram-enrollment.test.ts`
Expected: FAIL (helpers still use `business_id`).

- [ ] **Step 2: Implement — `startTelegramEnrollment` SELECT predicate.**

In `src/lib/channels/telegram-enrollment.ts`, change the SELECT in `startTelegramEnrollment` (the `business_id` lookup) to account scope. Replace:
```ts
  const existing = (await tx`
    SELECT id, status FROM channel_enrollments
    WHERE business_id = ${businessId} AND channel = 'telegram' AND archived_at IS NULL
    FOR UPDATE
  `) as Array<{ id: string; status: string }>;
```
with:
```ts
  const existing = (await tx`
    SELECT id, status FROM channel_enrollments
    WHERE account_id = ${accountId} AND channel = 'telegram'
      AND location_id IS NULL AND archived_at IS NULL
    FOR UPDATE
  `) as Array<{ id: string; status: string }>;
```
The INSERT branch is unchanged — it still writes `business_id = ${businessId}` and `account_id = ${accountId}` (and leaves `location_id` unset → NULL). Update the doc comment's "SELECT FOR UPDATE … row lock" note to say it locks the **org-default** row for the account.

- [ ] **Step 3: Implement — `cancelTelegramEnrollment` signature + predicate.**

Replace the function with the account-keyed version:
```ts
export async function cancelTelegramEnrollment(
  sql: TxLike,
  accountId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET status = 'disabled',
        disabled_at = NOW(),
        verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = 'telegram'
      AND status = 'pending_verification'
      AND location_id IS NULL
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
```
Update its doc comment: caller MUST hold the `mobile_enroll:${accountId}` lock.

- [ ] **Step 4: Implement — `disableTelegramEnrollment` signature + predicate.**

```ts
export async function disableTelegramEnrollment(
  sql: TxLike,
  accountId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET status = 'disabled',
        handle = NULL,
        disabled_at = NOW(),
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = 'telegram'
      AND status = 'verified'
      AND location_id IS NULL
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
```

- [ ] **Step 5: Run the helper tests (green).**

Run: `pnpm test src/lib/channels/__tests__/telegram-enrollment.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/lib/channels/telegram-enrollment.ts src/lib/channels/__tests__/telegram-enrollment.test.ts
git commit -m "refactor(channels): account-scope Telegram enrollment helpers"
```

---

## Task 2: WhatsApp enrollment helpers → account-scoped

**Files:**
- Modify: `src/lib/channels/whatsapp-enrollment.ts`
- Test: `src/lib/channels/__tests__/whatsapp-enrollment.test.ts`

- [ ] **Step 1: Update the helper tests first (red).**

In `src/lib/channels/__tests__/whatsapp-enrollment.test.ts`, mirror Task 1 Step 1: change `cancelWhatsAppEnrollment`/`disableWhatsAppEnrollment` calls from `(tx, 'biz-1')` → `(tx, 'acct-1')`; assert predicates use `account_id = ` + `location_id IS NULL` (not `business_id`); keep the INSERT carrying both `business_id` and `account_id`; keep the 23505 classification tests (constraint-name based — unaffected).

Run: `pnpm test src/lib/channels/__tests__/whatsapp-enrollment.test.ts` → Expected: FAIL.

- [ ] **Step 2: Implement — `startWhatsAppEnrollment` SELECT predicate.**

Replace the SELECT (lines ~43-47) with:
```ts
  const existing = (await tx`
    SELECT id, status FROM channel_enrollments
    WHERE account_id = ${accountId} AND channel = 'whatsapp'
      AND location_id IS NULL AND archived_at IS NULL
    FOR UPDATE
  `) as Array<{ id: string; status: string }>;
```
INSERT branch unchanged (writes `business_id` + `account_id`, leaves `location_id` NULL).

- [ ] **Step 3: Implement — `cancelWhatsAppEnrollment` signature + predicate.**
```ts
export async function cancelWhatsAppEnrollment(
  tx: TxLike,
  accountId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await tx`
    UPDATE channel_enrollments
    SET status = 'disabled',
        disabled_at = NOW(),
        verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = 'whatsapp'
      AND status = 'pending_verification'
      AND location_id IS NULL
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
```

- [ ] **Step 4: Implement — `disableWhatsAppEnrollment` signature + predicate.**
```ts
export async function disableWhatsAppEnrollment(
  sql: TxLike,
  accountId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET status = 'disabled',
        handle = NULL,
        disabled_at = NOW(),
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = 'whatsapp'
      AND status = 'verified'
      AND location_id IS NULL
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
```
Update the file header comment (`mobile_enroll:${businessId}` → `mobile_enroll:${accountId}`).

- [ ] **Step 5: Run (green).** `pnpm test src/lib/channels/__tests__/whatsapp-enrollment.test.ts` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/lib/channels/whatsapp-enrollment.ts src/lib/channels/__tests__/whatsapp-enrollment.test.ts
git commit -m "refactor(channels): account-scope WhatsApp enrollment helpers"
```

---

## Task 3: Shared status GET → account-scoped

**Files:**
- Modify: `src/app/api/dashboard/channels/route.ts`

- [ ] **Step 1: Resolve accountId in the existing lookup.**

Change the subscription lookup (line ~68) from `SELECT a.subscription_status` to `SELECT a.id, a.subscription_status`, and type it `{ id: string; subscription_status: string }[]`. After the `subscription_status` checks, add `const accountId = accountRow.id;`.

- [ ] **Step 2: Re-key the enrollment query.**

Replace:
```ts
    FROM channel_enrollments e
    WHERE e.business_id = ${user.locationId}
      AND e.archived_at IS NULL
    ORDER BY e.created_at ASC
```
with:
```ts
    FROM channel_enrollments e
    WHERE e.account_id = ${accountId}
      AND e.location_id IS NULL
      AND e.archived_at IS NULL
    ORDER BY e.created_at ASC
```

- [ ] **Step 3: Verify.**

Run: `pnpm test src/app/api/dashboard/channels` (the route tests under this dir, if any) and `pnpm typecheck`.
Expected: PASS (no behavior change for single-location; the enroll-e2e test is updated in Task 5).

- [ ] **Step 4: Commit.**
```bash
git add src/app/api/dashboard/channels/route.ts
git commit -m "fix(channels): account-scope owner channel status GET"
```

---

## Task 4: Owner Telegram routes → accountId + account-scoped lock

**Files:**
- Modify: `src/app/api/dashboard/channels/telegram/{start,cancel,disable}/route.ts`

- [ ] **Step 1: `start` route — lock key.**

In `telegram/start/route.ts` the route already resolves `accountId` (`const accountId = accountRow.id`) and passes it to `startTelegramEnrollment(tx, locationId, accountId, …)` (keep that — it still needs `locationId` for the INSERT's `business_id`). Change only the advisory-lock line:
```ts
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${locationId}`}, 0))`;
```
→
```ts
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
```

- [ ] **Step 2: `cancel` route — resolve accountId, lock + helper by accountId.**

In `telegram/cancel/route.ts`: change the subscription lookup to also select `a.id` (`SELECT a.id, a.subscription_status`), capture `const accountId = accountRow.id;` after the active check. Then replace the tx block:
```ts
  const locationId = user.locationId;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${locationId}`}, 0))`;
    return cancelTelegramEnrollment(tx, locationId);
  });
```
with:
```ts
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
    return cancelTelegramEnrollment(tx, accountId);
  });
```
Then simplify the cache-invalidation block: it currently does a separate `SELECT account_id FROM businesses WHERE id = …`. Replace that whole block with a direct call using the `accountId` we now have:
```ts
  await safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.telegram.cancel');
```
(Remove the now-unused `acctRow`/businesses lookup.)

- [ ] **Step 3: `disable` route — resolve accountId, helper + cache by accountId.**

In `telegram/disable/route.ts`: change the lookup to `SELECT a.id, a.subscription_status`, capture `accountId`. Replace `disableTelegramEnrollment(sql, user.locationId)` → `disableTelegramEnrollment(sql, accountId)`. Replace the separate `SELECT account_id FROM businesses …` + cache call with `await safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.telegram.disable');`.

- [ ] **Step 4: Verify.**

Run: `pnpm typecheck && pnpm lint`. (Owner Telegram routes have no unit tests; correctness is covered by the helper tests + the Task 8 integration regression.)
Expected: clean.

- [ ] **Step 5: Commit.**
```bash
git add src/app/api/dashboard/channels/telegram
git commit -m "fix(channels): account-scope owner Telegram routes + lock"
```

---

## Task 5: Owner WhatsApp routes → accountId + lock + remove guard

**Files:**
- Modify: `src/app/api/dashboard/channels/whatsapp/{start,cancel,disable}/route.ts`
- Test: `src/app/api/dashboard/channels/whatsapp/__tests__/{start,cancel,disable,enroll-e2e.integration}.test.ts`

- [ ] **Step 1: `start` route — remove the single-location guard.**

In `whatsapp/start/route.ts`:
- Delete the import `import { getActiveLocationCount } from '@/lib/locations/repo';` (line 20).
- Delete the guard block (the comment + `const activeLocationCount` + the `if (activeLocationCount > 1) …` return), BUT keep the `const noStore = { 'Cache-Control': 'no-store, private' };` line — move it to just above the `rawToken` generation so the later branches still reference it.
- Change the advisory-lock line `mobile_enroll:${locationId}` → `mobile_enroll:${accountId}`. (`startWhatsAppEnrollment(tx, locationId, accountId, …)` already passes both — keep it.)

- [ ] **Step 2: `cancel` + `disable` routes — accountId.**

Mirror Task 4 Steps 2-3 for the WhatsApp routes: resolve `accountId` (add `a.id` to the lookup), lock by `mobile_enroll:${accountId}`, call `cancelWhatsAppEnrollment(tx, accountId)` / `disableWhatsAppEnrollment(sql, accountId)`, and replace the separate businesses `account_id` lookups with direct `safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.whatsapp.{cancel,disable}')`.

- [ ] **Step 3: Update the WhatsApp owner route tests.**

In `whatsapp/__tests__/start.test.ts`:
- Remove the `vi.mock('@/lib/locations/repo', …)` mock and the **multi-location 403** test case (the guard is gone).
- The accounts lookup now returns `{ id, subscription_status }` (it already did for start). The success/already_verified/409 cases: the start route no longer makes a `getActiveLocationCount` call, so remove the `[{ count: 1 }]` queue push from those cases. Keep flag-off 404, env 503, auth 401, subscription 403, success, already_verified, multiple_mobile_channels.

In `cancel.test.ts` / `disable.test.ts`:
- The accounts lookup now selects `a.id` too — update the fixture row to `{ id: 'acct-1', subscription_status: 'active' }`.
- The routes no longer do the separate `SELECT account_id FROM businesses` — remove that queue entry from the success cases (sequence becomes: accounts lookup → [advisory lock for cancel] → UPDATE RETURNING).

In `enroll-e2e.integration.test.ts`:
- Remove the `getActiveLocationCount` queue entry (`[{ count: 1 }]`) that step 2 pushed.
- The start route's SELECT-FOR-UPDATE inside the helper now keys by `account_id`/`location_id IS NULL` — no fixture value change needed (the mock returns queued arrays regardless of predicate), but update the inline comments describing the SQL order.

Run: `pnpm test src/app/api/dashboard/channels/whatsapp` → Expected: PASS (after the edits).

- [ ] **Step 4: Commit.**
```bash
git add src/app/api/dashboard/channels/whatsapp
git commit -m "fix(channels): account-scope owner WhatsApp routes + remove single-location guard"
```

---

## Task 6: Admin Telegram + WhatsApp `start` — account-scoped lock

**Files:**
- Modify: `src/app/api/admin/channels/telegram/start/route.ts`, `src/app/api/admin/channels/whatsapp/start/route.ts`
- Test (regression): the existing `admin/channels/{telegram,whatsapp}/__tests__/start.test.ts`

- [ ] **Step 1: Change the lock key in both admin start routes.**

Both files resolve `accountId` (from their accounts lookup) before the `sql.begin`. Change:
```ts
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${businessId}`}, 0))`;
```
→
```ts
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
```
Confirm `accountId` is in scope at that point in each file (the subscription lookup selects it). If a file only selected `subscription_status`, add `a.id` to that SELECT and capture `accountId`. Update the WhatsApp admin start comment that says "mutually exclusive per business" → "per account". Leave SMS (`withMobileEnrollmentLock`) unchanged — deferred per spec.

- [ ] **Step 2: Verify the admin start tests still pass.**

Run: `pnpm test src/app/api/admin/channels/telegram src/app/api/admin/channels/whatsapp`
Expected: PASS. The lock is one tx call regardless of key, so the mocked `sqlQueue` ordering is unchanged. If any test asserts the literal `mobile_enroll:<businessId>` string, update it to `mobile_enroll:<accountId>`.

- [ ] **Step 3: Commit.**
```bash
git add src/app/api/admin/channels/telegram/start/route.ts src/app/api/admin/channels/whatsapp/start/route.ts
git commit -m "fix(channels): account-scope admin Telegram/WhatsApp enrollment lock"
```

---

## Task 7: Remove the WhatsApp multi-location UI guard

**Files:**
- Modify: `src/app/(authenticated)/settings/channels/page.tsx`, `ChannelsClient.tsx`

- [ ] **Step 1: `page.tsx` — restore unconditional WhatsApp availability.**

Change the WhatsApp availability passed to `ChannelsTabClient` (line ~188) from:
```ts
          whatsapp: whatsappAvailable() && activeLocationCount <= 1,
```
to:
```ts
          whatsapp: whatsappAvailable(),
```
and delete the `whatsappMultiLocationBlocked={whatsappAvailable() && activeLocationCount > 1}` prop line (~190). Leave the `activeLocationCount` variable and its `getActiveLocationCount` import — they are still used by `multiLocationEnabled` (line ~72).

- [ ] **Step 2: `ChannelsClient.tsx` — drop the prop + multi-location reason.**

- Remove `whatsappMultiLocationBlocked?: boolean;` from `ChannelsClientProps` (line ~23) and from the destructured params (line ~30).
- In the WhatsApp coming-soon branch, revert the reason to the static string (drop the `whatsappMultiLocationBlocked ? … : …` ternary):
```tsx
        {initialAvailability.whatsapp ? (
          <OwnerWhatsAppWidget initialEnrollment={findChannel(initialEnrollments, 'whatsapp')} />
        ) : (
          <ComingSoonChannelRow
            icon="🟢"
            name="WhatsApp"
            reason="Available once Meta business verification clears"
          />
        )}
```
`ChannelsTabClient` needs no change (it spreads `{...props}` — the removed prop simply stops being passed).

- [ ] **Step 3: Verify.**

Run: `pnpm typecheck && pnpm lint && pnpm test "src/app/(authenticated)/settings/channels" src/components/dashboard`
Expected: PASS. If a test referenced `whatsappMultiLocationBlocked`, update/remove it.

- [ ] **Step 4: Commit.**
```bash
git add "src/app/(authenticated)/settings/channels/page.tsx" "src/app/(authenticated)/settings/channels/ChannelsClient.tsx"
git commit -m "fix(channels): restore WhatsApp owner widget for multi-location accounts"
```

---

## Task 8: Regression tests — the exact multi-location bug

**Files:**
- Test: `src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts` (extend), and a new sibling for Telegram if a Telegram owner integration harness is warranted.

- [ ] **Step 1: Add the cross-owner regression case (WhatsApp).**

In `enroll-e2e.integration.test.ts`, add a test that encodes the bug: the requester's `locationId` differs from the `business_id` stored on the existing org-default row, but `account_id` matches.

```ts
it('reads/writes the org-default row by account even when business_id differs from the requester location', async () => {
  // requester is at L2; the existing verified org-default row was created at L1.
  mockRequireRole.mockResolvedValue({ userId: 'owner-2', role: 'owner', locationId: 'L2', accountId: 'acct-1' });

  // status GET / disable now key by account_id + location_id IS NULL, so the
  // L1-created row IS found for the L2 requester.
  // disable: accounts lookup → UPDATE RETURNING (matched by account, returns the row)
  sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
  sqlReturnQueue.push([{ id: 'e_orgdefault' }]);                          // disable UPDATE RETURNING (matched)

  const { POST: disablePOST } = await import('../disable/route');
  const res = await disablePOST(/* mkReq() */ ownerStartReq() as any);
  expect(res.status).toBe(200); // NOT 404 — the pre-fix bug returned 404 here
});
```
Adapt the request helper / import to the file's existing patterns. The assertion that matters: **200, not 404** — that is exactly what the pre-fix `business_id = L2` lookup got wrong.

- [ ] **Step 2: Confirm it would fail pre-fix (sanity, optional).**

Optional: `git stash` the production changes, run the new test, confirm it FAILS (404), `git stash pop`. This proves the test guards the bug.

- [ ] **Step 3: Run + commit.**
```bash
pnpm test src/app/api/dashboard/channels/whatsapp
git add src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts
git commit -m "test(channels): regression for multi-location owner enrollment desync"
```

---

## Task 9: Docs — mark the issue resolved

**Files:**
- Modify: `docs/known-issues.md`, `.claude/skills/feature-flags.md`, `.claude/CLAUDE.md`

- [ ] **Step 1: `docs/known-issues.md`.**

Update the "Owner channel enrollment desyncs…" entry: change **Status** to `Resolved (PR <this PR#>)` for Telegram + WhatsApp; note the org-default paths are now account-scoped and the WhatsApp single-location guard was removed. Keep a short note that SMS owner self-service, when built, must use the same account-scoped pattern (and bring the SMS admin lock to account scope then).

- [ ] **Step 2: `.claude/skills/feature-flags.md`.**

In the `CHANNELS_WHATSAPP_ENABLED` section, remove the "single-location-only (interim guard)" paragraph (the guard is gone). Keep the "set on BOTH platforms" + shared `whatsappEnvReady()` notes.

- [ ] **Step 3: `.claude/CLAUDE.md`.**

Update the gotcha bullet added in PR #53: it currently says WhatsApp owner self-service is single-location-only. Replace with a one-liner that owner channel enrollment (org-default) is **account-scoped** (`account_id` + `location_id IS NULL`), and that `business_id` is a legacy FK not used for org-default lookup — pointer to the design doc.

- [ ] **Step 4: Commit.**
```bash
git add docs/known-issues.md .claude/skills/feature-flags.md .claude/CLAUDE.md
git commit -m "docs: mark owner-enrollment account-scope desync resolved (Telegram + WhatsApp)"
```

---

## Task 10: Full regression sweep

**Files:** none.

- [ ] **Step 1: Run the full suite + typecheck + lint.**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green. Pay attention to: admin SMS/Telegram/WhatsApp suites (lock change), notification dispatch (resolve-channels reads enrollments — confirm unaffected: dispatch reads via `resolve-channels.ts` which already groups by account; this fix only touches the owner self-service read/write paths), and the channels page/widget suites.

- [ ] **Step 2: Commit only if a fix was needed.**

---

## Self-Review (completed during plan authoring)

**Spec coverage:** status GET → Task 3; helpers → Tasks 1-2; owner routes + lock → Tasks 4-5; remove WhatsApp guard → Tasks 5+7; admin lock (Telegram+WhatsApp only, SMS deferred) → Task 6; regression → Task 8; docs → Task 9; sweep → Task 10. SMS owner self-service intentionally absent (non-goal).

**Type/signature consistency:** `cancelXEnrollment`/`disableXEnrollment` change to `(sql, accountId)` in Tasks 1-2 and are called with `accountId` in Tasks 4-5. `startXEnrollment` keeps `(tx, businessId, accountId, …)` (businessId only for the INSERT's legacy FK) — callers unchanged except the lock key. The status GET's new `accountId` (Task 3) and the routes' `accountId` (Tasks 4-5) all come from the existing `accounts`-join lookup.

**No-migration invariant:** every change is a query predicate, a lock key, a function signature, or UI — no schema/DDL. Existing rows read correctly because reads stop filtering by `business_id`.

**Placeholder scan:** the only narrative latitude is Task 8 Step 1 (adapt the request helper to the file's existing pattern) and the existing-test-assertion updates in Tasks 1/2/5 (the executor edits assertions to the new predicate substrings, which are given explicitly) — these require reading the current test file, which is expected for an edit-in-place task.
