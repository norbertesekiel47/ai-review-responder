# Multi-Location Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each fix is TDD: write the failing regression test FIRST, watch it fail, implement, watch it pass, commit.

**Goal:** Make RepWorth's already-merged multi-location feature launch-safe by closing seven lifecycle/billing/settings defects plus a price-change tripwire, and add an E2E kit that verifies the full loop without a real Google Business Profile account.

**Architecture:** Hybrid — surgical SQL predicates where the defect is a missing filter (the query owns its predicate); shared-module extraction ONLY where the review found proven duplication (`findOverageItem` ×3) or an invariant needing one owner (exactly-one-primary repair). No pre-launch centralization of the ingest path. Skip-as-success everywhere in the pipeline gates; transient/terminal split at the Stripe boundary mirrors cost-guard PR #255.

**Tech Stack:** Next.js 16 (UI), Railway worker (Fastify + BullMQ), Postgres.js (transactional writes) + Supabase (auth/reads), dual Redis (Railway queue / Upstash cache), Stripe, Zernio, Vitest, Playwright. pnpm.

**Source spec:** `docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md` (single source of truth for WHAT). This plan adds the HOW. If this plan and the spec disagree, the spec wins; if the spec and `.claude/CLAUDE.md` disagree, CLAUDE.md wins. A genuine defect in the spec → STOP and ask the user.

---

## Delivery order & gates (NON-NEGOTIABLE)

| PR | Contents | Extra gates |
|---|---|---|
| **A** | Fix 1 spend-leak predicates + Fix 5.3 scheduler `archived_at` filters | Worker-only. **Lands first — stops the active LLM-spend leak.** |
| **B** | Fix 2 primary invariant + archived-approval gate | Parallel with C after A merges. |
| **C** | Fix 7 duplicate `google_place_id` (migration 061 + 23505 mapping) | `pnpm ci:tenant-scope && pnpm ci:rls-audit`. Pre-flight dupe query on staging **and** prod before the index. |
| **D** | Fix 3 + price-change guard (recovery enqueues, shared `findOverageItem`, transient-error outbox semantics) | |
| **E** | Fix 5 remainder (accounts migration 062 + reader moves) + Fix 6 (override visibility/cascade/atomicity) | `pnpm ci:tenant-scope && pnpm ci:rls-audit`. Post-deploy backfill re-run. |
| **F** | E2E kit (seeder, Playwright spec, fixture server, mock-transport param) + runbook | Launch sign-off = one two-location full-loop run, documented. |

**Per-PR commands (all must be green before opening the PR):**
```bash
pnpm lint && pnpm typecheck && pnpm test
```
**Branch/workspace:** branches in the main checkout (NO git worktrees — they poison lint/test here). Branch naming: `feat/multi-loc-<letter>-<slug>`.

**Promotion rhythm for every PR touching the worker or a migration:**
1. Push branch → open PR → CI green.
2. Merge the spec/branch onto `staging` (or push to `staging`) → staging auto-deploys full stack → verify.
3. Migrations: apply to **staging Supabase first, then prod Supabase**, both in lockstep.
4. Merge PR → `main`. Then `git checkout staging && git merge --ff-only main` so staging never drifts.

**Skip-as-success contract (applies to every pipeline gate below):** a skip COMPLETES the job (`markOutboxCompleted(outboxId, attempt)`) with a structured log reason. It NEVER calls `markOutboxFailed`, never throws, never burns a retry. Budget/business decisions stay terminal; only transport/infra failures retry.

---

## File-structure overview (what each PR creates / modifies)

**PR A (modify only):**
- `worker/ingress/zernio/zernio.ts` — add `JOIN businesses … archived_at IS NULL` to both INSERT…SELECT blocks (location-scoped + account-wide) shared by `review.new`/`review.updated`.
- `worker/jobs/zernio/ZernioReviewIngestWorker.ts` — step-1 query selects `b.archived_at`; archived → skip-as-success.
- `worker/jobs/response-generation/load-context.ts` — SELECT `b.archived_at`; new `LoadOutcome` variant `archived_location`.
- `worker/jobs/ResponseGeneratorWorker.ts` — handle `archived_location` (mirror `subscription_blocked`).
- `worker/background/schedulers/WeeklySummaryScheduler.ts`, `MonthlyImpactScheduler.ts` — add `AND b.archived_at IS NULL`.
- `worker/jobs/summary-report-helpers.ts` — `loadSummaryReportBusiness` selects `archived_at`; `completeOrFailSkippedSummaryReport` skips archived.

**PR B (modify only):**
- `src/lib/locations/archive-location-tx.ts` — `lockArchiveContext` returns `isPrimary`; `applyArchiveLocationUpdate` gains `blockPrimary`; owner caller throws race-proof `promote_first`; `reactivateLocationTransaction` takes account lock + self-promotes into zero-primary accounts.
- `src/lib/locations/promote-primary-tx.ts` — tolerate demoting 0 rows; `oldPrimaryId` nullable.
- `src/app/api/locations/promote-primary/route.ts` — remove `no current primary` → 409 mapping.
- `src/lib/approval/locks.ts` — `lockPendingResponse` returns `archived_at`.
- `src/lib/approval/token-mode.ts`, `callback-mode.ts` — reject archived-location responses.

**PR C:**
- Create `supabase/migrations/061_businesses_account_place_uniq.sql`.
- Modify `src/lib/locations/add-location-tx.ts`, `src/app/api/locations/add/route.ts`, `src/app/api/locations/reactivate/route.ts`, `src/lib/admin/csv-import.ts`, `worker/jobs/PlaceIdValidationWorker.ts`.
- Create `src/lib/locations/duplicate-location-error.ts` (typed error).

**PR D:**
- Create `src/lib/payments/overage-item.ts`.
- Modify `worker/ingress/stripe/invoice-paid.ts`, `worker/ingress/stripe/checkout-completed.ts`, `worker/jobs/billing/UpdateStripeOverageWorker.ts`, `worker/background/pollers/billing-reconciliation/stripe-overage.ts`, `src/app/api/billing/tier-change/route.ts`, `worker/index.ts`.

**PR E:**
- Create `supabase/migrations/062_account_digest_toggles.sql`.
- Modify `src/app/api/settings/route.ts`, both schedulers, `src/lib/dashboard/service.ts` + `service-mappers.ts`, `src/app/admin/runbook/page.tsx`, `src/components/dashboard/settings/PerLocationOverridePanel.tsx`, `src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx`, `src/app/(authenticated)/settings/channels/page.tsx`, `src/app/api/settings/channels/overrides/route.ts`, `src/app/api/settings/channels/override/route.ts`, `src/lib/channels/telegram-enrollment.ts`, `src/lib/channels/whatsapp-enrollment.ts` + their disconnect-route callers.

**PR F:**
- Modify `e2e/seed.ts`, `src/lib/zernio/client/transport.ts`, `scripts/zernio-fire-webhook.sh`.
- Create `e2e/multi-location.spec.ts`, `e2e/fixtures/zernio-fixture-server.ts`, a new runbook section under `docs/runbooks/`.

---

# PR A — Archived-location spend leak (lands first)

**Branch:** `feat/multi-loc-A-spend-leak`. Worker-only, no migration. This stops paid LLM drafts + ingest for archived locations.

> Reconnaissance note: the webhook fan-out in `worker/ingress/zernio/zernio.ts` has **two** INSERT…SELECT blocks — a location-scoped one (`WHERE zc.zernio_account_id = … AND zc.zernio_location_id = … AND zc.status='active'`, ~lines 275–298) and an account-wide fallback (`WHERE zc.zernio_account_id = … AND zc.status='active'`, ~lines 300–322). Both are reached by `review.new` and `review.updated`. The `JOIN businesses … archived_at IS NULL` goes on **both**.

## Task A1: Fan-out excludes archived locations

**Files:**
- Modify: `worker/ingress/zernio/zernio.ts` (both INSERT…SELECT `FROM zernio_connections zc` clauses)
- Test: `worker/ingress/zernio/__tests__/zernio.test.ts` (create if absent; otherwise add cases)

- [ ] **Step 1: Write the failing test.** SQL-level integration assertion that an archived business's connection produces NO ingest outbox row, while an active one does. Mirror the existing webhook-handler test harness (hoisted `mockSql` queue). If no integration DB is wired for this file, assert at the query-shape level: capture the SQL string passed to `sql` and assert it contains `archived_at IS NULL` and the businesses join.

```typescript
// worker/ingress/zernio/__tests__/zernio.test.ts (add to existing describe)
it('fan-out INSERT…SELECT joins businesses and excludes archived locations', async () => {
  const captured: string[] = [];
  // mockSql records the template strings of each query it receives
  mockSql.mockImplementation((s: TemplateStringsArray, ..._v: unknown[]) => {
    captured.push(s.join('?'));
    return Promise.resolve(Object.assign([], { count: 0 }));
  });

  await handleZernioWebhook(makeSignedRequest('review.new')); // existing helper

  const fanoutQueries = captured.filter((q) => q.includes("'ingest_zernio_review'"));
  expect(fanoutQueries.length).toBeGreaterThan(0);
  for (const q of fanoutQueries) {
    expect(q).toContain('JOIN businesses b ON b.id = zc.business_id');
    expect(q).toContain('b.archived_at IS NULL');
  }
});
```

- [ ] **Step 2: Run it — expect FAIL** (`archived_at IS NULL` not present yet).
```bash
pnpm test -- worker/ingress/zernio/__tests__/zernio.test.ts
```

- [ ] **Step 3: Implement.** In BOTH INSERT…SELECT blocks, add the join immediately after `FROM zernio_connections zc`:
```sql
FROM zernio_connections zc
JOIN businesses b ON b.id = zc.business_id AND b.archived_at IS NULL
WHERE zc.zernio_account_id = ${parsed.accountId}
  …
```
Do not touch the `ON CONFLICT … DO NOTHING` clause (the conflict predicate is unaffected).

- [ ] **Step 4: Run it — expect PASS.**
- [ ] **Step 5: Commit.**
```bash
git add worker/ingress/zernio/zernio.ts worker/ingress/zernio/__tests__/zernio.test.ts
git commit -m "fix(zernio): exclude archived locations from review fan-out (spend leak)"
```

## Task A2: Ingest worker skips archived (already-queued jobs)

**Files:**
- Modify: `worker/jobs/zernio/ZernioReviewIngestWorker.ts` (step-1 query ~98–116)
- Test: `worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts`

- [ ] **Step 1: Failing test** — mirror the existing "cancelled subscription → skip" test (lines ~290–303). Archived business → `markOutboxCompleted` called, `listReviews`/`processReview` NOT called.
```typescript
it('marks outbox completed and skips when the location is archived', async () => {
  sqlReturnQueue.push([{
    subscription_status: 'active',
    past_due_at: null,
    account_flags: {},
    archived_at: '2026-06-01T00:00:00Z', // ← new selected column
  }]);

  await handleZernioReviewIngest(makeJob());

  expect(mockListReviews).not.toHaveBeenCalled();
  expect(mockProcessReview).not.toHaveBeenCalled();
  expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Add `b.archived_at` to the SELECT (it already does `FROM businesses b JOIN accounts a`); after the subscription check, before listing reviews:
```typescript
if (acct.archived_at) {
  logger.log(`Business ${business_id} archived — skipping ingest (archived_location)`);
  await markOutboxCompleted(outboxId, attempt);
  return;
}
```
Place this AFTER the existing subscription guard so the skip reasons don't interleave; it is skip-as-success (no `markOutboxFailed`).

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**
```bash
git commit -am "fix(zernio): ingest worker skips archived locations (skip-as-success)"
```

## Task A3: Generator gate — archived → terminal skip

**Files:**
- Modify: `worker/jobs/response-generation/load-context.ts` (business SELECT ~70–108; `LoadOutcome` type ~37–42)
- Modify: `worker/jobs/ResponseGeneratorWorker.ts` (skip switch ~41–44)
- Test: `worker/jobs/response-generation/__tests__/load-context.test.ts` (create/extend) and the generator worker test

- [ ] **Step 1: Failing test (load-context).** Archived business row → outcome `{ kind: 'archived_location' }`.
```typescript
it('returns archived_location when the business is archived', async () => {
  pushReviewRow();                 // existing helper: review found
  sqlReturnQueue.push([{ id: BID, account_id: AID, archived_at: '2026-06-01T00:00:00Z',
                         subscription_status: 'active', subscription_tier: 'standard',
                         /* …other selected cols… */ }]);
  const out = await loadGenerationContext({ reviewId: RID, businessId: BID });
  expect(out.kind).toBe('archived_location');
});
```

- [ ] **Step 2: Failing test (generator worker).** `archived_location` outcome → `markOutboxCompleted`, no draft generated.
```typescript
it('skips generation as success when the location is archived', async () => {
  mockLoad.mockResolvedValue({ kind: 'archived_location' });
  await handleGenerateResponse(makeJob());
  expect(mockGenerateDraft).not.toHaveBeenCalled();
  expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run — expect FAIL (both).**
- [ ] **Step 4: Implement.**
  - In `load-context.ts`: add `b.archived_at` to the business SELECT; add `| { kind: 'archived_location' }` to `LoadOutcome`; after loading the business row and before the subscription/offboarding branches, `if (row.archived_at) return { kind: 'archived_location' };`.
  - In `ResponseGeneratorWorker.ts`, add a case mirroring `subscription_blocked`:
```typescript
case 'archived_location':
  logger.log(`Business ${businessId} archived — skipping generation (archived_location)`);
  await markOutboxCompleted(outboxId, outboxAttempt);
  return;
```

- [ ] **Step 5: Run — expect PASS.**
- [ ] **Step 6: Commit.**
```bash
git commit -am "fix(generator): archived location → terminal skip-as-success"
```

## Task A4: Scheduler + summary-helper archived filters (Fix 5.3 scheduler slice)

**Files:**
- Modify: `worker/background/schedulers/WeeklySummaryScheduler.ts` (~51–62), `worker/background/schedulers/MonthlyImpactScheduler.ts` (~38–49)
- Modify: `worker/jobs/summary-report-helpers.ts` (`loadSummaryReportBusiness` ~42–56; `completeOrFailSkippedSummaryReport` ~58–92)
- Test: the schedulers' existing test files + `summary-report-helpers` test

- [ ] **Step 1: Failing tests.** (a) Each scheduler's candidate query string contains `b.archived_at IS NULL`. (b) `completeOrFailSkippedSummaryReport` returns "skip" (true) when `archived_at` is set, calling `markOutboxCompleted`.
```typescript
// summary-report-helpers test
it('skips an archived business as success', async () => {
  const skipped = await completeOrFailSkippedSummaryReport({
    business: { archived_at: '2026-06-01T00:00:00Z', subscription_status: 'active', /* … */ },
    outboxId: 'o1', attempt: 1, logger: fakeLogger,
  });
  expect(skipped).toBe(true);
  expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('o1', 1);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - Both schedulers: add `AND b.archived_at IS NULL` to the WHERE clause.
  - `loadSummaryReportBusiness`: add `b.archived_at` to the SELECT.
  - `completeOrFailSkippedSummaryReport`: add, before the subscription check, `if (business.archived_at) { logger.log('archived — skipping summary'); await markOutboxCompleted(outboxId, attempt); return true; }`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Full gate + commit.**
```bash
pnpm lint && pnpm typecheck && pnpm test
git commit -am "fix(schedulers): exclude archived locations from weekly/monthly digests"
```

## Task A5: PR A close-out

- [ ] Open PR `feat/multi-loc-A-spend-leak` → `main`. CI green.
- [ ] Promote to `staging`; verify worker boots and a webhook for an archived location produces no ingest job (staging log check).
- [ ] **Ops note (post-deploy, informational only — NO mutation):** run a count of inert accumulated drafts:
```sql
SELECT b.id AS business_id, count(*) AS pending_drafts
FROM responses r
JOIN reviews rv ON rv.id = r.review_id
JOIN businesses b ON b.id = rv.business_id
WHERE b.archived_at IS NOT NULL AND r.status = 'pending_approval'
GROUP BY b.id;
-- Rows are inert: notification/auto-approval/publisher already gate on archived;
-- PR B adds the missing approval-link gate. Do NOT hand-delete.
```
- [ ] Merge PR → `main`; `git checkout staging && git merge --ff-only main`.

---

# PR B — Exactly-one-primary invariant + archived-approval gate

**Branch:** `feat/multi-loc-B-primary-invariant`. No migration. Depends on A merged (but can develop in parallel).

> Reconnaissance: `archive-location-tx.ts` — guard `assertCanArchiveLocation` (62–100, includes a pre-tx `promote_first`); `lockArchiveContext` (209–245, row-locks the location, returns `{ archivedAt, activeLocationsBefore }`); `applyArchiveLocationUpdate` (247–302, owner caller at 154–165 throws `last_active_location` on `activeLocationsBefore <= 1`); teardown caller at 184–196; `reactivateLocationTransaction` (339–442, NO account lock). `promote-primary-tx.ts` demotion at 130–146 throws on 0 rows. Approval: dashboard session path already filters `b.archived_at IS NULL` (`http-routes.ts` 152–236); token-mode (`token-mode.ts` 40–162) + callback-mode (`callback-mode.ts` 46–127) both go through `lockPendingResponse` (`locks.ts` 68–81) which does NOT load the business.

## Task B1: Lock snapshot carries `is_primary`; race-proof owner archive

**Files:**
- Modify: `src/lib/locations/archive-location-tx.ts`
- Test: `src/lib/locations/__tests__/archive-location-tx.test.ts` (+ an integration race test gated on `TEST_DATABASE_POOL_URL`, mirroring `src/lib/approval/__tests__/audit-snapshot.integration.test.ts`)

- [ ] **Step 1: Failing tests.**
  - Unit: owner archive of a primary location with `activeLocationsBefore > 1` throws `promote_first`, branching on the **locked snapshot** `isPrimary`, not the UPDATE rowcount.
  - Unit: owner path's UPDATE includes `AND is_primary = FALSE`; a 0-row UPDATE from a concurrent already-archived race surfaces as `location_archive_conflict`, NOT `promote_first`.
  - Unit: teardown path (`blockPrimary:false`) archives a primary without throwing.
```typescript
it('owner archive of the primary throws promote_first from the locked snapshot', async () => {
  // lockArchiveContext returns isPrimary:true, activeLocationsBefore:2
  txQueue.push([{ archived_at: null, is_primary: true }]); // location lock SELECT
  txQueue.push([{ count: 2 }]);                             // active-count
  await expect(archiveLocationTransaction({ locationId: L, accountId: A, actorUserId: U }))
    .rejects.toThrow('promote_first');
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - `lockArchiveContext`: change the location-lock SELECT to also return `is_primary`; widen `ArchiveContext` to `{ archivedAt; activeLocationsBefore; isPrimary }`.
  - `applyArchiveLocationUpdate`: add param `blockPrimary: boolean`; when `true`, the UPDATE WHERE gains `AND is_primary = FALSE`. (Keep the `RETURNING id`; 0 rows → `location_archive_conflict` as today.)
  - Owner caller (`archiveLocationTransaction`): pass `blockPrimary: true`; AFTER the existing `last_active_location` check, add:
    ```typescript
    if (context.isPrimary && context.activeLocationsBefore > 1) {
      throw new Error('promote_first');
    }
    ```
  - Teardown caller (`archiveLocationForAccountOffboardingTeardownTransaction`): pass `blockPrimary: false`; no `promote_first` throw (archiving the primary is intentional there).

- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(locations): race-proof primary archive via locked snapshot + blockPrimary"
```

## Task B2: Promote becomes the zero-primary repair path

**Files:**
- Modify: `src/lib/locations/promote-primary-tx.ts` (demotion 130–146; result type 40–44)
- Modify: `src/app/api/locations/promote-primary/route.ts` (remove `no current primary` → 409, ~111–115)
- Test: `src/lib/locations/__tests__/promote-primary-tx.test.ts`

- [ ] **Step 1: Failing test.** Promoting an active location in a zero-primary account succeeds and returns `oldPrimaryId: null` (no throw).
```typescript
it('promotes successfully when the account currently has no primary', async () => {
  txQueue.push([{ id: A }]);  // account lock
  txQueue.push([{ id: NEW, is_primary: false, archived_at: null }]); // target lock
  txQueue.push([]);           // demotion: 0 rows (no current primary) — must NOT throw
  txQueue.push([{ id: NEW }]); // promotion: 1 row
  const res = await promotePrimaryTransaction({ accountId: A, newPrimaryId: NEW, actorUserId: U });
  expect(res.oldPrimaryId).toBeNull();
  expect(res.newPrimaryId).toBe(NEW);
});
```

- [ ] **Step 2: Run — expect FAIL** (currently throws "no current primary location found").
- [ ] **Step 3: Implement.**
  - Demotion: remove the `if (!demoted) throw …`; set `oldPrimaryId = demoted?.id ?? null`.
  - Result type: `{ oldPrimaryId: string | null; newPrimaryId: string }`.
  - Route: delete the `no current primary` → 409 branch. (Keep `already the primary`→400, `not found`→404, `archived`→400.)

- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(locations): promote-primary repairs zero-primary accounts (oldPrimaryId nullable)"
```

## Task B3: Reactivation self-heals into zero-primary accounts

**Files:**
- Modify: `src/lib/locations/archive-location-tx.ts` (`reactivateLocationTransaction` 339–442; input/result types 306–320)
- Test: `src/lib/locations/__tests__/archive-location-tx.test.ts` (+ integration concurrent-reactivation test gated on DB)

- [ ] **Step 1: Failing tests.**
  - Reactivating into an account with no active primary self-promotes the reactivated location (`is_primary = TRUE` UPDATE issued, `writeAccountAuditLog` called in-tx, result flag `selfPromoted: true`).
  - Reactivating into an account that already has a primary does NOT self-promote (`selfPromoted: false`).
  - (Integration, DB-gated) two concurrent reactivations don't both become primary (the account `FOR UPDATE` serializes them).
```typescript
it('self-promotes the reactivated location when the account has no active primary', async () => {
  txQueue.push([{ id: A }]);          // accounts FOR UPDATE (NEW)
  txQueue.push([{ id: L }]);          // un-archive UPDATE RETURNING
  txQueue.push([{ count: 0 }]);       // active-primary count → 0
  txQueue.push([{ id: L }]);          // is_primary=TRUE UPDATE
  // …audit + overage/backfill enqueues…
  const res = await reactivateLocationTransaction({ locationId: L, accountId: A, actorUserId: U });
  expect(res.selfPromoted).toBe(true);
  expect(mockWriteAccountAuditLog).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Inside the existing `sql.begin`:
  1. FIRST take the account lock: `SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE` (establishes accounts→businesses lock ordering, matching archive/promote).
  2. Run the existing un-archive UPDATE.
  3. After un-archiving, count active primaries: `SELECT count(*)::int AS count FROM businesses WHERE account_id = ${accountId} AND is_primary = TRUE AND archived_at IS NULL`. If `0`, `UPDATE businesses SET is_primary = TRUE WHERE id = ${locationId}` and `await writeAccountAuditLog({ accountId, locationId, actorUserId, eventType: 'primary_promoted', payload: { reason: 'reactivation_self_heal' } }, tx)`.
  4. Result type gains `selfPromoted: boolean`. Keep existing overage + zernio-backfill enqueues.
  - Route `/api/locations/reactivate`: pass `result.selfPromoted` through into the JSON response (no new UI pre-launch).

- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(locations): reactivation self-heals zero-primary under account lock"
```

## Task B4: Approval token/callback paths reject archived locations

**Files:**
- Modify: `src/lib/approval/locks.ts` (`lockPendingResponse` 68–81)
- Modify: `src/lib/approval/token-mode.ts` (40–162), `src/lib/approval/callback-mode.ts` (46–127)
- Create: `src/lib/approval/archived-location-error.ts` (typed error) — OR reuse an existing approval error class if one maps cleanly to the deny path (verify in `src/lib/approval/errors.ts` at execution; prefer reuse).
- Test: `src/lib/approval/__tests__/token-mode.test.ts`, `callback-mode.test.ts`

- [ ] **Step 1: Failing tests.** Approve/edit/regenerate via token AND via callback, when the response's location is archived, throw the archived-location denial (NOT a successful mutation); the response status is not changed and no publish is enqueued. Non-archived path still succeeds (regression guard).
```typescript
it('token approve rejects when the response location is archived', async () => {
  // lockPendingResponse now returns archived_at set
  txQueue.push([{ status: 'pending_approval', response_text: 'x', version: 1,
                  review_id: RID, archived_at: '2026-06-01T00:00:00Z' }]);
  await expect(approve(mockTx, link, deviceHash, audit)).rejects.toThrow(/archived/i);
  expect(mockEnqueuePublish).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - `lockPendingResponse`: JOIN `reviews rv ON rv.id = r.review_id JOIN businesses b ON b.id = rv.business_id`; add `b.archived_at` to the returned columns. (The `FOR UPDATE` stays on `responses`; add `FOR UPDATE OF r` if needed so the join targets aren't locked — verify Postgres syntax at execution.)
  - In `token-mode.ts` (all three ops) and `callback-mode.ts` (both ops), immediately after `lockAndConsumeTokenResponse` / `claimCallbackResponse`: `if (locked.archived_at) throw new ArchivedLocationError();` BEFORE any status mutation/enqueue.
  - Map `ArchivedLocationError` in the approve route to the same deny response the dashboard archived path yields (verify the dashboard maps archived → 404/409; mirror it). Keep semantics: deny, do not 500.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Full gate + PR.**
```bash
pnpm lint && pnpm typecheck && pnpm test
git commit -am "fix(approval): reject token/callback approval for archived locations"
```
- [ ] Open PR → CI green → staging verify (approve link for an archived location is denied) → merge → ff `staging`.

---

# PR C — Server-side duplicate `google_place_id` enforcement

**Branch:** `feat/multi-loc-C-dup-place-id`. **Migration 061.** Extra gates: `pnpm ci:tenant-scope && pnpm ci:rls-audit`.

> Migration head is 060; next is **061**. Follow the migration-031 playbook (non-transactional apply, pre-flight dupe query, INVALID-index recovery). No `ON CONFLICT` is added (we only catch error code `23505`), so the byte-for-byte predicate gotcha does not apply.

## Task C1: Pre-flight dupe query (run BEFORE writing the migration anywhere)

- [ ] Run this read-only query against **staging Supabase AND prod Supabase** (via Supabase MCP or `psql`). Expected: **0 rows** (client-side validation has been live).
```sql
SELECT account_id, google_place_id, count(*) AS n
FROM businesses
WHERE archived_at IS NULL AND google_place_id IS NOT NULL
GROUP BY account_id, google_place_id
HAVING count(*) > 1;
```
- [ ] If any rows exist, STOP — do not apply the migration. Resolve each pair by the written rule: archive the duplicate **without** a Zernio connection; if both or neither have one, archive the newer; reviews are preserved. The migration never auto-mutates data. Re-run until empty, then proceed.

## Task C2: Migration 061 (partial unique index, CONCURRENTLY)

**Files:**
- Create: `supabase/migrations/061_businesses_account_place_uniq.sql`
- Modify: `.claude/reference/migrations-log.md` (add the 061 entry + bump head)

- [ ] **Step 1: Write the migration**, header modeled on migration 031:
```sql
-- supabase/migrations/061_businesses_account_place_uniq.sql
-- IMPORTANT: this file uses CREATE INDEX CONCURRENTLY — apply NON-transactionally
-- (uncheck "single transaction" in the Supabase SQL editor). Apply staging-first,
-- then production, both Supabase projects in lockstep.
--
-- See docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md Fix 7.
--
-- ── PRE-FLIGHT CHECK (run BEFORE applying) ─────────────────────────────
--   SELECT account_id, google_place_id, count(*) FROM businesses
--     WHERE archived_at IS NULL AND google_place_id IS NOT NULL
--     GROUP BY account_id, google_place_id HAVING count(*) > 1;
--   -- expect: 0 rows. If non-empty, BLOCK and resolve per the written rule.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS businesses_account_place_uniq
  ON businesses (account_id, google_place_id)
  WHERE archived_at IS NULL AND google_place_id IS NOT NULL;

-- ── POST-MIGRATION VERIFICATION (run AFTER applying) ───────────────────
--   SELECT indexrelid::regclass AS index, indisvalid
--     FROM pg_index WHERE indexrelid = 'businesses_account_place_uniq'::regclass;
--   -- expect: indisvalid = true. If false, the CONCURRENTLY build was
--   -- interrupted (pre-existing dup): DROP INDEX businesses_account_place_uniq; re-run.
```

- [ ] **Step 2:** Add a migrations-log entry for 061 and bump "Current head" to 061 / next to 062.
- [ ] **Step 3: Commit (code only — DB apply happens in the promotion step).**
```bash
git add supabase/migrations/061_businesses_account_place_uniq.sql .claude/reference/migrations-log.md
git commit -m "feat(db): migration 061 — unique (account_id, google_place_id) for active locations"
```

## Task C3: Typed `duplicate_location` error + add/reactivate mapping

**Files:**
- Create: `src/lib/locations/duplicate-location-error.ts`
- Modify: `src/lib/locations/add-location-tx.ts`, `src/app/api/locations/add/route.ts`, `src/app/api/locations/reactivate/route.ts`, `reactivateLocationTransaction` (in `archive-location-tx.ts`)
- Test: `src/lib/locations/__tests__/add-location-tx.test.ts`, route tests for add + reactivate

- [ ] **Step 1: Failing tests.** A `23505` on `businesses_account_place_uniq` from `addLocationTransaction` → `DuplicateLocationError`; `/api/locations/add` maps it → HTTP 409 `{ error: 'duplicate_location' }`; same for `/api/locations/reactivate`.
```typescript
it('maps a 23505 on businesses_account_place_uniq to duplicate_location 409', async () => {
  mockAddLocationTransaction.mockRejectedValue(
    Object.assign(new Error('dup'), { code: '23505', constraint_name: 'businesses_account_place_uniq' }),
  );
  const res = await POST(makeRequest({ displayLabel: 'B', googlePlaceId: 'PID' }));
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: 'duplicate_location' });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - `duplicate-location-error.ts`: `export class DuplicateLocationError extends Error { code = 'duplicate_location'; constructor() { super('duplicate_location'); } }`.
  - `addLocationTransaction`: wrap the `sql.begin` so a caught `{ code: '23505' }` whose constraint is `businesses_account_place_uniq` re-throws `new DuplicateLocationError()`; other errors re-throw unchanged.
  - `reactivateLocationTransaction`: same 23505→`DuplicateLocationError` guard around its un-archive UPDATE.
  - Routes `/api/locations/add` and `/api/locations/reactivate`: catch `DuplicateLocationError` → `NextResponse.json({ error: 'duplicate_location' }, { status: 409, headers: NO_STORE })` (place this branch before the generic 500). Also defensively catch raw `{ code: '23505' }` on this constraint as a fallback.

- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "feat(locations): map duplicate google_place_id (23505) to 409 duplicate_location"
```

## Task C4: CSV import — in-file + per-row duplicate handling

**Files:**
- Modify: `src/lib/admin/csv-import.ts` (`processRow` ~223–285; the pre-processing pass)
- Test: `src/lib/admin/__tests__/csv-import.test.ts`

- [ ] **Step 1: Failing tests.** (a) Two rows with the same `google_place_id` in one file → the second is reported as a per-file duplicate BEFORE any insert. (b) A row whose place ID collides with an existing active location → `processRow` returns `{ reason: 'duplicate_location' }` (catches 23505), not a generic transaction error.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - Add a pre-pass over parsed rows that detects in-file duplicate non-null place IDs and emits a failure (`reason: 'duplicate_location'`) for the later occurrences, excluding them from processing.
  - `processRow`: in its catch, if `{ code: '23505' }` on `businesses_account_place_uniq`, return `{ reason: 'duplicate_location' }`; else keep the generic reason.

- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "feat(admin): CSV import rejects in-file + existing duplicate place IDs"
```

## Task C5: URL-mode closure — enqueue `validate_place_id`; validation worker tolerates 23505

**Files:**
- Modify: `src/lib/locations/add-location-tx.ts` (enqueue `validate_place_id` when a Maps URL is provided without a verified place ID — mirror the onboarding `/start` enqueue with the `WHERE NOT EXISTS` dedup guard)
- Modify: `worker/jobs/PlaceIdValidationWorker.ts` (resolved-place-ID UPDATE ~39–62; failure handling ~64–85)
- Test: `src/lib/locations/__tests__/add-location-tx.test.ts`, `worker/jobs/__tests__/PlaceIdValidationWorker.test.ts`

- [ ] **Step 1: Failing tests.** (a) `addLocationTransaction` with `googleMapsUrl` set and no verified place ID enqueues a `validate_place_id` outbox row in the same tx. (b) When the validation worker's resolved-place-ID UPDATE raises `23505` on `businesses_account_place_uniq`, it logs `duplicate_location`, leaves the location unverified, and `markOutboxCompleted` (does NOT `markOutboxFailed`/throw).
```typescript
it('leaves the location unverified (no job failure) when the resolved place_id duplicates', async () => {
  mockResolvePlaceId.mockResolvedValue('PID');
  mockSql.mockRejectedValueOnce(Object.assign(new Error('dup'),
    { code: '23505', constraint_name: 'businesses_account_place_uniq' })); // the UPDATE
  await handlePlaceIdValidation(makeJob());
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  expect(mockMarkOutboxCompleted).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - `addLocationTransaction`: inside the tx, when `googleMapsUrl && !placeIdVerified`, INSERT a `validate_place_id` outbox row using the onboarding `/start` pattern (the `INSERT … SELECT … WHERE NOT EXISTS (… status IN ('pending','dispatching','dispatched'))` dedup guard, payload `{ business_id, google_maps_url }`).
  - `PlaceIdValidationWorker`: wrap both resolved-place-ID UPDATEs; on `{ code: '23505' }` for `businesses_account_place_uniq`, `logger.log('duplicate_location — leaving unverified')` and `await markOutboxCompleted(outboxId, outboxAttempt); return;` (skip-as-success). Transient SerpAPI errors keep their existing retry-by-throw path; other permanent errors keep the existing `review_exceptions` + `markOutboxFailed`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Full gate (incl. DB audits) + PR.**
```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit
git commit -am "feat(locations): URL-mode add enqueues validate_place_id; worker tolerates dup 23505"
```
- [ ] PR → CI green. **Apply migration 061 staging-first, then prod** (non-transactional; pre-flight already empty). Verify `indisvalid=true` both. Merge → ff `staging`.

---

# PR D — Billing recovery + price-change guard

**Branch:** `feat/multi-loc-D-billing-guard`. Invoke the `cost-guard` skill first — its transient/terminal classification is the template.

> Reconnaissance: `invoice-paid.ts` flips `past_due→active` in a tx (~32–38) but does NOT enqueue overage recompute. `checkout-completed.ts` reactivates `pending_payment|past_due→active` (~91–135), also no enqueue. `UpdateStripeOverageWorker.ts` (61–216) calls `markOutboxFailed` on the FIRST error (forfeits the watchdog) and uses operation-scoped idempotency keys. A `findOverageItem(subscription, overagePriceIds, expectedOverageUnitPriceCents)` ALREADY exists in `worker/background/pollers/billing-reconciliation/stripe-overage.ts` (41–75) — the new shared module changes the signature (items + options object, base-exclusion first) and the poller becomes a swap. `tier-change/route.ts` (173–175) uses an any-non-base fallback; base item is swapped before the overage step. The worker is registered in `worker/index.ts` with no explicit concurrency (BullMQ default 1).

## Task D1: Shared `findOverageItem` module (base-exclusion first)

**Files:**
- Create: `src/lib/payments/overage-item.ts`
- Test: `src/lib/payments/__tests__/overage-item.test.ts`

- [ ] **Step 1: Failing tests** (the contract the review fought over):
  - Matches by env overage price ID.
  - Matches by `lookup_key`/`nickname`/`metadata.billing_role|role` keyword.
  - Matches a legacy/rotated item by unit-amount == `storedOveragePriceCents` (multi-item only).
  - **Never selects the base item even on a unit-amount collision** (base-exclusion runs FIRST).
  - Returns `undefined` when nothing matches.
```typescript
it('never selects the base item even when its unit_amount collides with stored overage cents', () => {
  const base = item({ id: 'si_base', priceId: 'price_base', unit_amount: 2500 });
  const items = [base];
  const found = findOverageItem(items, {
    overagePriceIds: new Set<string>(),
    basePriceIds: new Set(['price_base']),
    storedOveragePriceCents: 2500,
  });
  expect(found).toBeUndefined();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `findOverageItem(items, { overagePriceIds, basePriceIds, storedOveragePriceCents })`:
  1. Exclude any item whose `price.id` ∈ `basePriceIds` (and the already-identified base item if the caller passes it) — BEFORE any heuristic.
  2. Among the rest: env overage price-ID match → keyword descriptor match (`overage|additional|extra|add-on|addon`) → unit-amount == `storedOveragePriceCents` (only when more than one item remains). Return the first match or `undefined`.

- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "feat(payments): shared findOverageItem with base-item exclusion first"
```

## Task D2: Three consumers converge on `findOverageItem`

**Files:**
- Modify: `worker/background/pollers/billing-reconciliation/stripe-overage.ts` (swap), `worker/jobs/billing/UpdateStripeOverageWorker.ts`, `src/app/api/billing/tier-change/route.ts`
- Test: each consumer's test file (`worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts`, tier-change route test, reconcile poller test)

- [ ] **Step 1: Failing tests.**
  - Poller: behavior-preserving swap (existing tests still pass after the call-site change).
  - Worker: when a matched item carries a **legacy** price, the worker **updates quantity on that legacy item at its legacy price** (no second item created). When nothing matches and overage is needed, it creates one. **This worker test was missing — add it.**
  - Tier-change: no matched overage item + zero overage needed → touches nothing (no delete/re-price). No match + `newOverageUnits > 0` → creates at the target tier's env price. Missing target-tier overage env → hard error thrown BEFORE any Stripe mutation (assert `subscriptionItems.update` for the base was NOT called).
```typescript
it('updates the legacy overage item at its legacy price instead of creating a duplicate', async () => {
  mockStripeSubscriptionsRetrieve.mockResolvedValue(subscriptionWith([
    baseItem('si_base', 'price_base'),
    legacyOverageItem('si_leg', 'price_legacy_overage', /*unit_amount*/ 2500),
  ]));
  await handleUpdateStripeOverage(mockJob({ /* activeLocations forces qty 2 */ }));
  expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith('si_leg',
    expect.objectContaining({ quantity: expect.any(Number) }), expect.anything());
  expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - Poller: import the new `findOverageItem`; build `{ overagePriceIds, basePriceIds, storedOveragePriceCents }` from existing inputs (it already reads `overagePriceIds` and the expected unit price); pass `subscription.items.data`. Delete the local `findOverageItem`/`isOverageItem`.
  - Worker: replace its env-set-only lookup with the shared helper; if matched item's `price.id` is NOT in the env overage set (legacy/grandfathered), call `subscriptionItems.update(matched.id, { quantity }, …)` at the legacy price (do NOT switch price). Only `subscriptionItems.create` when nothing matched and `quantity > 0`. Keep delete-when-0 on a matched item.
  - Tier-change: replace lines ~173–175 with `findOverageItem(subscription.items.data, { overagePriceIds, basePriceIds, storedOveragePriceCents })`. Apply the no-match rules. Move the target-tier overage-env presence check to BEFORE the first Stripe mutation (before the base swap); throw a typed hard error if missing.

- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "feat(payments): worker/poller/tier-change converge on findOverageItem (grandfathering safe)"
```

## Task D3: Recovery enqueues overage recompute

**Files:**
- Modify: `worker/ingress/stripe/invoice-paid.ts` (after `past_due→active` UPDATE), `worker/ingress/stripe/checkout-completed.ts` (reactivation branch)
- Test: the ingress tests for both files

- [ ] **Step 1: Failing tests.** The `past_due→active` recovery tx (invoice-paid) AND the `pending_payment|past_due→active` reactivation tx (checkout-completed) each INSERT one `update_stripe_overage_quantity` outbox row (`aggregate_type='account'`, `status='pending'`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Inside each recovery tx, after the status UPDATE, INSERT the outbox row using the existing convention (`topic='update_stripe_overage_quantity'`, `aggregate_type='account'`, `aggregate_id=account uuid`, `payload = jsonb({ account_id, correlation_id })`, `status='pending'`). The worker recomputes from committed location count, so the enqueue is idempotent convergence. For checkout-completed, only enqueue when the UPDATE actually activated a previously pending/past_due account (guard on rowcount).
- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(billing): recompute overage on past_due→active recovery (invoice-paid + checkout)"
```

## Task D4: Worker error classification (transient retries; terminal fails) + single-consumer assertion

**Files:**
- Modify: `worker/jobs/billing/UpdateStripeOverageWorker.ts` (error handling 210–215; idempotency keys keep operation scope), `worker/index.ts` (explicit `concurrency: 1` + registration-time assertion)
- Test: `worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts`

- [ ] **Step 1: Failing tests** (mirror cost-guard PR #255 semantics):
  - Transient (`StripeConnectionError`/`StripeAPIError`/`StripeRateLimitError`, any 5xx, 429, 409 in-flight idempotency conflict): the worker re-throws WITHOUT touching the outbox row (asserts `markOutboxFailed` NOT called; row stays `dispatched` → BullMQ retry + 1h watchdog).
  - Terminal (account not found, unknown tier, missing price env, `StripeAuthenticationError`, 400 `idempotency_error`, other 4xx `StripeInvalidRequestError`): `markOutboxFailed` IS called.
  - Classification branches on error class AND `statusCode`/`code`, never class alone.
  - Keys stay operation-scoped: a delete→re-add within 24h yields a fresh key (asserts the key string includes the per-outbox scope).
```typescript
it('leaves the outbox row dispatched on a transient Stripe rate-limit error', async () => {
  mockStripeSubscriptionItemsUpdate.mockRejectedValue(
    Object.assign(new Error('rate limited'), { type: 'StripeRateLimitError', statusCode: 429 }));
  await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow();
  expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
});
it('marks the outbox row failed on a terminal 400 idempotency_error', async () => {
  mockStripeSubscriptionItemsUpdate.mockRejectedValue(
    Object.assign(new Error('key reuse'), { type: 'StripeInvalidRequestError', code: 'idempotency_error', statusCode: 400 }));
  await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow();
  expect(mockMarkOutboxFailed).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - Add a `classifyStripeOverageError(err): 'transient' | 'terminal'` helper (branch on `.type` AND `.statusCode`/`.code` — reuse the inspection shape from `src/lib/account-offboarding/reactivate.ts`; 409 in-flight idempotency conflict = transient; 400 `idempotency_error` = terminal).
  - Replace the catch: `transient` → log + re-throw (no outbox write); `terminal` → `markOutboxFailed(outboxId, message, attempt)` + re-throw.
  - Keep operation-scoped idempotency keys exactly as-is (add an explicit comment: single-consumer + BullMQ ~15s retry window never overlaps the 1h watchdog; a stable per-subscription create key was rejected — would 400 deterministically on delete→re-add within Stripe's ~24h key TTL).
  - `worker/index.ts`: register the worker with explicit `{ concurrency: 1 }`, plus a registration-time assertion that there is exactly one consumer (e.g. assert the configured concurrency is 1 and document the one-Railway-instance assumption).

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Full gate + PR.**
```bash
pnpm lint && pnpm typecheck && pnpm test
git commit -am "fix(billing): transient/terminal outbox semantics for overage worker (mirrors #255)"
```
- [ ] PR → CI green → staging verify (trigger a recovery; confirm a recompute job runs) → merge → ff `staging`.

---

# PR E — Digests account-level + channel override visibility/cascade

**Branch:** `feat/multi-loc-E-digests-channels`. **Migration 062.** Extra gates: `pnpm ci:tenant-scope && pnpm ci:rls-audit`. Invoke `repworth-brand-design` before the UI edits, `supabase-postgres-best-practices` before the migration.

> Reconnaissance: digest columns currently live on `businesses` (migration 014); `PUT /api/settings` writes only the primary location via dynamic `sql.unsafe`; readers are the two schedulers, `src/lib/dashboard/service.ts`+`service-mappers.ts`, and `src/app/admin/runbook/page.tsx`. There is **no GET handler inside `src/app/api/settings/route.ts`** — the settings UI reads via the dashboard service (already in the move list); verify at execution and move any GET reader you find. `accounts` has no column collision. Channels: `PerLocationOverridePanel.tsx` self-hides at `locationOptions.length <= 1` (line 192); `ChannelsTabClient.tsx` gates the panel on `multiLocationEnabled && length > 1` (118–127); override create/delete routes write `account_audit_log` OUTSIDE any tx (atomicity gap); `disable{Telegram,WhatsApp}Enrollment(sql, accountId)` disable only the org-default (`location_id IS NULL`), no cascade.

## Task E1: Migration 062 — account-level digest toggles + backfill

**Files:**
- Create: `supabase/migrations/062_account_digest_toggles.sql`
- Modify: `.claude/reference/migrations-log.md`
- Test: a migration-shape test if the repo has them (e.g. `supabase/migrations/__tests__/` or `scripts/ci`), else covered by the reader/writer tests below.

- [ ] **Step 1: Write the migration** (transactional — `accounts` is small):
```sql
-- supabase/migrations/062_account_digest_toggles.sql
-- Account-level digest toggles (Fix 5). Additive. Apply staging-first, then prod,
-- both Supabase projects in lockstep. The backfill UPDATE is re-run once post-deploy
-- (idempotent in shape) to close the write-path window. See spec Fix 5.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS weekly_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS monthly_impact_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill from each account's ACTIVE primary business row; accounts with no active
-- primary use a conservative aggregate across ALL businesses (active or archived) so
-- any recorded opt-out survives. Accounts with no businesses keep the TRUE default.
UPDATE accounts a SET
  weekly_summary_enabled = COALESCE(p.weekly_summary_enabled, agg.weekly_all, TRUE),
  monthly_impact_enabled = COALESCE(p.monthly_impact_enabled, agg.monthly_all, TRUE)
FROM (SELECT id FROM accounts) a2
LEFT JOIN LATERAL (
  SELECT b.weekly_summary_enabled, b.monthly_impact_enabled
  FROM businesses b
  WHERE b.account_id = a2.id AND b.is_primary = TRUE AND b.archived_at IS NULL
  LIMIT 1
) p ON TRUE
LEFT JOIN LATERAL (
  SELECT bool_and(COALESCE(b.weekly_summary_enabled, TRUE)) AS weekly_all,
         bool_and(COALESCE(b.monthly_impact_enabled, TRUE)) AS monthly_all
  FROM businesses b WHERE b.account_id = a2.id
) agg ON TRUE
WHERE a.id = a2.id;
```
> At execution, verify this UPDATE shape against Postgres semantics (the `FROM (SELECT id FROM accounts)` self-join is to attach the LATERALs); simplify to a correlated-subquery form if cleaner. The CONTRACT is: active-primary value wins; else `bool_and` across all the account's businesses; else TRUE.

- [ ] **Step 2:** Migrations-log entry for 062; bump head.
- [ ] **Step 3: Commit.**
```bash
git commit -am "feat(db): migration 062 — account-level digest toggles + backfill"
```

## Task E2: Settings PUT splits account-scoped vs business-scoped in one tx

**Files:**
- Modify: `src/app/api/settings/route.ts` (PUT 9–86)
- Test: `src/app/api/settings/__tests__/route.test.ts`

- [ ] **Step 1: Failing test.** `PUT { weeklySummaryEnabled: false, tone: 'x' }` issues an `accounts` UPDATE for `weekly_summary_enabled` AND a `businesses` UPDATE for `tone`, both inside one `sql.begin`.
```typescript
it('writes digest toggles to accounts and voice to businesses in one transaction', async () => {
  mockRequireRole.mockResolvedValue(ownerUser());
  const res = await PUT(makeRequest({ weeklySummaryEnabled: false, tone: 'warm' }));
  expect(res.status).toBe(200);
  const queries = mockTxQueries(); // captured template strings from the begin() tx
  expect(queries.some((q) => q.includes('UPDATE accounts') && q.includes('weekly_summary_enabled'))).toBe(true);
  expect(queries.some((q) => q.includes('UPDATE businesses') && q.includes('tone'))).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Split `FIELD_TO_COLUMN` into `ACCOUNT_FIELD_TO_COLUMN` (`weeklySummaryEnabled`, `monthlyImpactEnabled`) and `BUSINESS_FIELD_TO_COLUMN` (voice/contact). In `sql.begin`, run an `UPDATE accounts SET … WHERE id = ${owner.accountId}` for present account fields and an `UPDATE businesses SET … WHERE id = ${owner.locationId}` for present business fields. Skip an UPDATE if its field-set is empty.

- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(settings): digest toggles write to accounts, voice/contact to businesses (one tx)"
```

## Task E3: All readers move to the account columns

**Files:**
- Modify: `worker/background/schedulers/WeeklySummaryScheduler.ts`, `MonthlyImpactScheduler.ts` (read `a.weekly_summary_enabled` / `a.monthly_impact_enabled`), `src/lib/dashboard/service.ts` + `service-mappers.ts`, `src/app/admin/runbook/page.tsx`, and any settings GET reader found in/around `src/app/api/settings/route.ts`.
- Test: the schedulers' tests, dashboard mapper test, settings GET test if present.

- [ ] **Step 1: Failing tests.** Schedulers select the digest flag from `accounts` (query contains `a.weekly_summary_enabled` / `a.monthly_impact_enabled`, not `b.`). Dashboard `buildDashboardSettings` reads the account columns. (Schedulers also already gained `AND b.archived_at IS NULL` in PR A — keep it.)
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Swap every reader from `b.<col>` to `a.<col>` (the queries already JOIN `accounts a`). Update `DashboardBusinessRow`/mapper field sources to the account columns. Per-business columns stay in the schema (deprecated, not dropped).
- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(digests): all readers (schedulers, dashboard, runbook, settings) use account columns"
```

## Task E4: Channel override visibility (render list regardless of mode; creation stays gated)

**Files:**
- Modify: `src/components/dashboard/settings/PerLocationOverridePanel.tsx` (self-hide 192; render 233–290), `src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx` (gate 118–127)
- Test: a component/RTL test if the repo has them for this panel; otherwise a unit test of the visibility predicate. Verify test infra at execution.

- [ ] **Step 1: Failing test.** With `overrides.length > 0` and a single location (`locationOptions.length === 1`), the panel renders the override list + delete; the "Add override" creation controls are NOT rendered (creation stays mode-gated).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Replace the `locationOptions.length <= 1 → return null` with: render the existing-overrides list (+ delete) whenever `overrides.length > 0`, regardless of mode; gate ONLY the creation controls on multi-location mode. In `ChannelsTabClient.tsx`, render `<PerLocationOverridePanel/>` when `overrides.length > 0 || (multiLocationEnabled && locationOptions.length > 1)`. Follow `repworth-brand-design` for any markup.
- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(channels): overrides list stays visible after archive back to single location"
```

## Task E5: Archived locations show "(archived)" in the name map (SSR + API)

**Files:**
- Modify: `src/app/(authenticated)/settings/channels/page.tsx` (location map 113–166), `src/app/api/settings/channels/overrides/route.ts` (map 43–60)
- Test: the overrides route test

- [ ] **Step 1: Failing test.** An override whose `location_id` points to an archived business renders `locationName` with an "(archived)" suffix (and not a raw UUID) in the API response.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Build the location-name map from active AND archived businesses; for archived ones, append `' (archived)'` to the display label. Apply in both the SSR page data and the overrides API. This also fixes the raw-UUID display for archived locations.
- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(channels): archived locations show (archived) label in override views"
```

## Task E6: Disconnect cascade + same-tx audit (tx-level disable helper)

**Files:**
- Modify: `src/lib/channels/telegram-enrollment.ts` (`disableTelegramEnrollment`), `src/lib/channels/whatsapp-enrollment.ts` (`disableWhatsAppEnrollment`), and their disconnect-route callers (owner + admin Telegram/WhatsApp routes — find via `codebase-memory` `who-calls disableTelegramEnrollment`)
- Test: `src/lib/channels/__tests__/*-enrollment.test.ts`

- [ ] **Step 1: Failing tests.**
  - Disabling an org-default channel ALSO disables every per-location override row for that `account_id`+channel in the SAME tx, and writes `writeAccountAuditLog` rows.
  - The cascade runs INDEPENDENTLY of the org-default row's state: an already-disabled or missing org default still cascades; the result is `not_found` (404) ONLY when neither the org default nor any override changed.
  - Reconnect does NOT auto-re-enable overrides (no code path re-enables them — assert by absence).
```typescript
it('cascades to per-location overrides and audits even when the org default is already disabled', async () => {
  txQueue.push([]);                       // org-default UPDATE → 0 rows (already disabled)
  txQueue.push([{ id: 'ov1' }, { id: 'ov2' }]); // override UPDATE → 2 rows
  const res = await disableTelegramEnrollment(mockTx, { accountId: A, actorUserId: U });
  expect(res.kind).toBe('ok'); // something changed → not 404
  expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(/* org(0) + 2 overrides or a summary row */ expect.any(Number));
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Change the disable helpers to take `(tx, { accountId, actorUserId, ip?, userAgent?, requestId? })` and, in one tx: (1) disable the org-default row (`location_id IS NULL`), (2) disable ALL per-location override rows for `account_id`+channel (`location_id IS NOT NULL AND status='verified' AND archived_at IS NULL`), (3) write `writeAccountAuditLog` rows for the changes. Return `{ kind: 'ok' }` if org-default OR any override changed, else `{ kind: 'not_found' }`. Update all callers (owner + admin disconnect routes) to wrap in `sql.begin` and pass actor context; invalidate the per-location notification cache (`safeInvalidateChannelCache(accountId, …)`) AFTER commit.
- [ ] **Step 4: Run — expect PASS.** Commit.
```bash
git commit -am "fix(channels): org-default disconnect cascades to override rows with same-tx audit"
```

## Task E7: Override create/delete route atomicity

**Files:**
- Modify: `src/app/api/settings/channels/override/route.ts` (create 113–157, delete 216–248 — move the raw `INSERT INTO account_audit_log` into a `sql.begin`)
- Test: `src/app/api/settings/channels/override/__tests__/route.test.ts`

- [ ] **Step 1: Failing test.** Create and delete each perform the enrollment write + `writeAccountAuditLog` inside ONE `sql.begin`; if the audit write throws, the enrollment change is rolled back (no partial commit). Cache invalidation runs only after commit.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Wrap each handler's enrollment mutation + audit in `sql.begin(async (tx) => { … writeAccountAuditLog(input, tx) … })`, replacing the standalone `INSERT INTO account_audit_log`. Move `safeInvalidateChannelCache` to after the `begin` resolves.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Full gate (incl. DB audits) + PR.**
```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit
git commit -am "fix(channels): override create/delete write enrollment + audit atomically"
```
- [ ] PR → CI green. **Apply migration 062 staging-first, then prod.** **Post-deploy: re-run the 062 backfill UPDATE once** against both Supabase projects (closes the write-path window). Verify a secondary-location opt-out now suppresses its digest. Merge → ff `staging`.

---

# PR F — E2E verification kit (no GBP required)

**Branch:** `feat/multi-loc-F-e2e-kit`. The full-loop run is the launch sign-off gate.

> Reconnaissance: `e2e/seed.ts` graceful-skip via `isE2eConfigured`; `seedOwnerOffboardingAccount` (118–243) is the multi-table template (users → accounts w/ `locations_included`/`locations_overage_price_cents`/`base_price_cents` → businesses w/ `is_primary` → zernio_connections). Playwright specs gate with `test.skip(!isE2eConfigured, …)`. Mock transport hardcodes one location at `src/lib/zernio/client/transport.ts:116–119`. Real client interface in `src/lib/zernio/client/locations.ts`; types in `src/lib/zernio/types.ts` (`ZernioReview.name = accounts/{a}/locations/{loc}/reviews/{r}`). Ingest parses location via `extractLocationFromReviewName` (`src/lib/reviews/zernio-normalize.ts:81–85`) and FAILS CLOSED on mismatch/unparseable (`ZernioReviewIngestWorker.ts:197–209`). Signing in `scripts/zernio-fire-webhook.sh` (HMAC-SHA256, `ZERNIO_WEBHOOK_SECRET`). `assertStripeWorkerEnv` no-ops only when `NODE_ENV!=='production' && MOCK_EXTERNAL_APIS==='true'`; with mocks OFF it requires the full Stripe price env set.

## Task F1: `seedMultiLocationAccount`

**Files:**
- Modify: `e2e/seed.ts`
- Test: exercised by F2; optionally a thin unit assertion that the seeder is exported and respects `isE2eConfigured`.

- [ ] **Step 1:** Add `seedMultiLocationAccount(options?)` mirroring `seedOwnerOffboardingAccount`'s `sql.begin` + `SET CONSTRAINTS ALL DEFERRED` pattern: one `accounts` row (standard tier, `locations_included` per options default 1, `locations_overage_price_cents=2500`, `base_price_cents=7900`), TWO `businesses` (primary + secondary, distinct `google_place_id`, distinct `display_label`), TWO `zernio_connections` (distinct `zernio_location_id`), an owner user, and an org-default channel enrollment. Return all IDs (accountId, both businessIds, both zernioLocationIds, userId, ownerEmail). Add a matching `cleanupMultiLocationAccount`.
- [ ] **Step 2:** Commit.
```bash
git commit -am "test(e2e): seedMultiLocationAccount (two locations, two connections)"
```

## Task F2: `e2e/multi-location.spec.ts`

**Files:**
- Create: `e2e/multi-location.spec.ts`

- [ ] **Step 1:** New spec gated with `test.skip(!isE2eConfigured, …)`, using try/finally cleanup. Cover: location switcher shows both locations; per-location scoping of dashboard + past-replies; settings tabs render the multi-location set; archive flow (archived location leaves the switcher; **archiving the primary is blocked**); promote-primary; add-location wizard eligibility gate. Auth via the documented session-cookie injection pattern (see `e2e/README.md` / `zernio-connect.spec.ts`); mark any step that needs an authed session `.fixme()` only if the harness genuinely can't inject one.
- [ ] **Step 2: Run** (skips cleanly without DB):
```bash
pnpm test:e2e -- multi-location.spec.ts
```
- [ ] **Step 3:** Commit.
```bash
git commit -am "test(e2e): two-location Playwright spec (switcher, scoping, archive/promote/add gate)"
```

## Task F3: Fixture server + mock-transport param + webhook script

**Files:**
- Create: `e2e/fixtures/zernio-fixture-server.ts`
- Modify: `src/lib/zernio/client/transport.ts` (mock `list_locations`), `scripts/zernio-fire-webhook.sh`
- Test: a small unit test for the mock-location generator (deterministic `mock-loc-1..n`).

- [ ] **Step 1 (mock transport, TDD):** Failing test — `MOCK_ZERNIO_LOCATION_COUNT=2` makes the mock `list_locations` return two deterministic, distinct entries (`mock-loc-1`, `mock-loc-2`) with stable names/addresses, all accepted by select-location. Implement by replacing the hardcoded single-element array with a generator over `Number(process.env.MOCK_ZERNIO_LOCATION_COUNT ?? 1)`. The ingest mock short-circuit stays as-is.
- [ ] **Step 2 (fixture server):** Small Node HTTP server implementing `list_locations` (configurable count), `list_reviews` per `zernio_location_id` (seedable via a control endpoint), `publish_reply`, `delete_reply`. Reviews MUST carry location-scoped resource names `accounts/{a}/locations/{loc}/reviews/{r}` matching each seeded connection's `zernio_location_id` (the ingest worker fails closed otherwise). Match the real client contract in `src/lib/zernio/client/locations.ts` + `types.ts`.
- [ ] **Step 3 (webhook script):** Add a per-location parameter to `scripts/zernio-fire-webhook.sh` and inject it into the `review.new`/`review.updated` body field the handler reads as the location (verify which field — the handler uses `parsed.locationIdFromPayload`). Keep the existing HMAC-SHA256 signing.
- [ ] **Step 4:** Commit.
```bash
git commit -am "test(e2e): fake Zernio fixture server + MOCK_ZERNIO_LOCATION_COUNT + per-location webhook"
```

## Task F4: Runbook section + the full-loop sign-off run

**Files:**
- Create/append: a new section under `docs/runbooks/` (e.g. extend `docs/runbooks/multi-location.md` or add `docs/runbooks/multi-location-e2e-full-loop.md`), house style matching `edit-existing-replies-testing-runbook.md`.

- [ ] **Step 1:** Document the full-loop procedure: local stack with `MOCK_EXTERNAL_APIS=false` and `ZERNIO_API_BASE` → fixture server; seed two locations; fire signed per-location webhooks; the whole ingest → draft → notify → approve → publish loop runs for two locations. Enumerate the FULL non-mock credential set the worker boot requires (Stripe TEST keys — `assertStripeWorkerEnv` fires with mocks off — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the six `STRIPE_PRICE_*`; ZERNIO_*; a notification strategy: a Resend test key OR approve via the authed dashboard session and accept failed `send_notification` outbox rows as expected). Use real LLM keys with a low `GLOBAL_DAILY_COST_LIMIT_CENTS` (pennies on gpt-4o-mini). Mark it manual, NOT CI. Note what stays untestable without a real GBP (real Google reply propagation, OAuth consent/picker, Google error shapes) — those remain on the "one careful first post in production" discipline.
- [ ] **Step 2: Execute one successful two-location full-loop run** locally per the runbook; capture the outcome (both locations: review ingested → draft generated → approved → `publish_response` job ran) into the runbook as the sign-off record.
- [ ] **Step 3:** Commit + PR.
```bash
pnpm lint && pnpm typecheck && pnpm test
git commit -am "docs(runbook): two-location E2E full-loop procedure + sign-off run"
```
- [ ] PR → CI green → merge → ff `staging`.

---

## Definition of done (verify before notifying the user)

- [ ] Six PRs (A–F) merged to `main`; each worker/migration PR staging-verified.
- [ ] All spec regression tests green (`pnpm lint && pnpm typecheck && pnpm test` clean on `main`; PRs C and E also `pnpm ci:tenant-scope && pnpm ci:rls-audit`).
- [ ] Migration 061 pre-flight dupe query run against staging AND prod (empty), index `indisvalid=true` on both.
- [ ] Migration 062 applied to both Supabase projects; backfill re-run once post-deploy.
- [ ] One successful two-location full-loop run via the PR F fixture server, documented in the runbook.
- [ ] Notify the user — a separate session holds the review context and performs the final code review.

## Self-review notes (spec coverage)

- Fix 1 → A1–A3. Fix 5.3 scheduler slice → A4. Fix 2 → B1–B3. Approval archived gate → B4. Fix 7 → C1–C5 (+ migration 061). Fix 3 → D3. Price-change guard / Fix 4 → D1–D2 (+ D4 outbox semantics). Fix 5 remainder → E1–E3. Fix 6 → E4–E7 (+ migration 062). E2E kit → F1–F4.
- Out-of-scope items (account cost ceilings, LocationContext prop sync, `placeIdVerified` trust beyond the URL-mode enqueue, offboarding Zernio-snapshot leaks, aggregate-view nits, dropping deprecated per-business columns) are NOT in this plan — deferred to a fast-follow spec per the spec's Out-of-scope section.
