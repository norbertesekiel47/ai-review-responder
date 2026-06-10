# Complete SMS Channel Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove SMS as a notification channel from RepWorth entirely — code, schema, config, living docs — in one atomic PR, per spec `docs/superpowers/specs/2026-06-09-sms-removal-design.md`.

**Architecture:** SMS is feature-flagged off (`CHANNELS_SMS_ENABLED`, never enabled in prod), so this is dead-code removal. WhatsApp keeps the shared Twilio foundation (`twilio` npm package, `TWILIO_ACCOUNT_SID`/`AUTH_TOKEN`, `twilio-verify.ts`, `twilio-intent.ts`, `twilio-delivery-status.ts`, `parse-inbound.ts`, `WORKER_PUBLIC_URL`). One migration (061) drops the two SMS tables and rewrites two partial indexes. A runtime guard makes stale `'sms'` TEXT rows harmless (no approval link, no send, no crash).

**Tech Stack:** Next.js 16, Fastify worker, Postgres.js + Supabase, Vitest, pnpm.

**Working directory:** `/Users/norbertesekiel/Developer/startups/RepWorth/.claude/worktrees/remove-sms-channel` (git worktree, branch `worktree-remove-sms-channel`). ALL paths below are relative to this root. NEVER use paths through the parent checkout — a parent-absolute path silently edits `main`'s working tree.

**Verification posture:** run targeted `pnpm vitest run <file>` locally per task; the authoritative full gate is CI on the pushed branch (worktrees poison full lint runs here — see CLAUDE.md).

---

### Task 0: Worktree setup

**Files:** none (environment only)

- [ ] **Step 1: Install dependencies in the worktree**

Run: `pnpm install`
Expected: completes; `node_modules/` exists in the worktree root.

- [ ] **Step 2: Baseline sanity check**

Run: `pnpm typecheck`
Expected: PASS (zero errors) — confirms the worktree is healthy before any change.

---

### Task 1: Migration 061 + structure test (TDD)

**Files:**
- Create: `supabase/migrations/061_remove_sms_schema.sql`
- Test: `src/lib/shared/__tests__/migration-061-remove-sms-schema.test.ts`

- [ ] **Step 1: Write the failing structure test**

Create `src/lib/shared/__tests__/migration-061-remove-sms-schema.test.ts` (mirrors the migration-035 file-structure test pattern — reads the SQL file, NOT a live DB):

```typescript
/**
 * Structural validation test for migration 061_remove_sms_schema.sql
 *
 * SMS channel removal: validates the migration archives stale sms
 * enrollments, replaces the sms+whatsapp handle index with a whatsapp-only
 * one, rebuilds one_mobile_per_scope without 'sms', and drops both
 * sms_sender_opt_out tables (events first — it holds the FK).
 *
 * NOT a database integration test — catches accidental edits to the
 * archive predicate, index predicates, or drop order.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/061_remove_sms_schema.sql',
);

let sql: string;
let sqlNoComments: string;

beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  sqlNoComments = sql.replace(/--.*$/gm, '');
});

describe('migration 061 — stale enrollment archive', () => {
  it('archives active sms enrollments defensively', () => {
    expect(sqlNoComments).toMatch(
      /UPDATE channel_enrollments\s+SET archived_at = NOW\(\)[\s\S]*?WHERE channel = 'sms'\s+AND archived_at IS NULL/i,
    );
  });
});

describe('migration 061 — handle index replacement', () => {
  it('drops the sms+whatsapp handle index', () => {
    expect(sqlNoComments).toMatch(/DROP INDEX IF EXISTS idx_channel_enrollments_sms_handle/i);
  });

  it('creates a whatsapp-only handle index with the same shape', () => {
    expect(sqlNoComments).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_channel_enrollments_whatsapp_handle\s+ON channel_enrollments\(handle\)\s+WHERE channel = 'whatsapp' AND handle IS NOT NULL AND archived_at IS NULL/i,
    );
  });
});

describe('migration 061 — one_mobile_per_scope rebuild', () => {
  it('drops the old index', () => {
    expect(sqlNoComments).toMatch(/DROP INDEX IF EXISTS channel_enrollments_one_mobile_per_scope/i);
  });

  it('recreates it without sms, preserving scope key and status exclusions', () => {
    expect(sqlNoComments).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_one_mobile_per_scope[\s\S]*?COALESCE\(location_id, '00000000-0000-0000-0000-000000000000'\)[\s\S]*?WHERE channel IN \('telegram','whatsapp'\)\s+AND status IN \('pending_verification','verified'\)\s+AND archived_at IS NULL/i,
    );
  });

  it('does not reference sms in the rebuilt predicate', () => {
    const rebuilt = sqlNoComments.split('one_mobile_per_scope')[2] ?? '';
    expect(rebuilt).not.toMatch(/'sms'/);
  });
});

describe('migration 061 — table drops', () => {
  it('drops events before parent (FK direction)', () => {
    const eventsIdx = sqlNoComments.indexOf('DROP TABLE IF EXISTS sms_sender_opt_out_events');
    const parentIdx = sqlNoComments.indexOf('DROP TABLE IF EXISTS sms_sender_opt_outs');
    expect(eventsIdx).toBeGreaterThan(-1);
    expect(parentIdx).toBeGreaterThan(-1);
    expect(eventsIdx).toBeLessThan(parentIdx);
  });

  it('is wrapped in a transaction', () => {
    expect(sqlNoComments).toMatch(/BEGIN;/i);
    expect(sqlNoComments).toMatch(/COMMIT;/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/migration-061-remove-sms-schema.test.ts`
Expected: FAIL — `ENOENT` reading `061_remove_sms_schema.sql`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/061_remove_sms_schema.sql`:

```sql
-- ==============================================================================
-- Migration 061: Remove SMS channel schema
--
-- SMS is removed as a notification channel (spec:
-- docs/superpowers/specs/2026-06-09-sms-removal-design.md). It was never live
-- in production — CHANNELS_SMS_ENABLED defaulted off and 10DLC registration
-- (the flip precondition) never happened — so the opt-out tables hold no real
-- TCPA evidence. Pre-flight gate (run against prod BEFORE applying): zero rows
-- across sms enrollments / opt-out tables / sms approval_links / sms
-- notification_deliveries / sms inbound_events / pending sms outbox payloads.
--
-- 1. Defensively archive any stray sms enrollment rows (expected 0 in prod).
-- 2. Replace the sms+whatsapp handle index with a whatsapp-only one — the
--    surviving consumer is the WhatsApp STOP handler's handle-wide UPDATE
--    (worker/ingress/twilio/twilio-whatsapp-inbound.ts).
-- 3. Rebuild one_mobile_per_scope without 'sms' (telegram/whatsapp only).
-- 4. Drop both opt-out tables — events first (it has no FK TO the parent, but
--    keep the child-before-parent order for clarity). RLS policies
--    (sms_sender_opt_*_owner_select, migration 035) drop implicitly.
--
-- channel_enrollments.channel / notification_deliveries.channel stay TEXT
-- with app-layer enforcement; historical 'sms' delivery rows are untouched.
--
-- Deploy: apply to staging Supabase first, verify, then production — both
-- projects in lockstep, staging first. Transactional (no CONCURRENTLY).
-- ==============================================================================

BEGIN;

-- 1. Defensive archive of stray sms enrollments (expected 0 rows in prod)
UPDATE channel_enrollments
SET archived_at = NOW(),
    updated_at = NOW()
WHERE channel = 'sms'
  AND archived_at IS NULL;

-- 2. Handle index: sms+whatsapp → whatsapp-only
DROP INDEX IF EXISTS idx_channel_enrollments_sms_handle;
CREATE INDEX IF NOT EXISTS idx_channel_enrollments_whatsapp_handle
  ON channel_enrollments(handle)
  WHERE channel = 'whatsapp' AND handle IS NOT NULL AND archived_at IS NULL;

-- 3. one_mobile_per_scope: drop 'sms' from the predicate
DROP INDEX IF EXISTS channel_enrollments_one_mobile_per_scope;
CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_one_mobile_per_scope
  ON channel_enrollments (
    account_id,
    COALESCE(location_id, '00000000-0000-0000-0000-000000000000')
  )
  WHERE channel IN ('telegram','whatsapp')
    AND status IN ('pending_verification','verified')
    AND archived_at IS NULL;

-- 4. Drop the SMS opt-out tables (child first; RLS policies drop with them)
DROP TABLE IF EXISTS sms_sender_opt_out_events;
DROP TABLE IF EXISTS sms_sender_opt_outs;

COMMIT;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/shared/__tests__/migration-061-remove-sms-schema.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/061_remove_sms_schema.sql src/lib/shared/__tests__/migration-061-remove-sms-schema.test.ts
git commit --no-verify -m "feat(db): migration 061 — drop SMS schema, whatsapp-only handle index"
```

---

### Task 2: Notification core — delete SMS implementation, shrink ChannelId

**Files:**
- Delete: `src/lib/notifications/channels/sms-channel.ts`, `src/lib/notifications/sms-body.ts`, `src/lib/costs/sms-tracker.ts`, `worker/jobs/notification/sms-budget.ts`
- Delete: `src/lib/notifications/channels/__tests__/sms-channel.test.ts`, `src/lib/notifications/__tests__/sms-body.test.ts`, `src/lib/costs/__tests__/sms-tracker.test.ts`
- Modify: `src/lib/notifications/channels/types.ts:10`, `src/lib/notifications/channels/index.ts`, `src/lib/notifications/channels/enrollment-reducer.ts:24`
- Modify: `src/lib/notifications/channels/__tests__/factory.test.ts`, `src/lib/notifications/__tests__/enrollments.test.ts`

- [ ] **Step 1: Delete the SMS implementation files and their tests**

```bash
git rm src/lib/notifications/channels/sms-channel.ts \
       src/lib/notifications/sms-body.ts \
       src/lib/costs/sms-tracker.ts \
       worker/jobs/notification/sms-budget.ts \
       src/lib/notifications/channels/__tests__/sms-channel.test.ts \
       src/lib/notifications/__tests__/sms-body.test.ts \
       src/lib/costs/__tests__/sms-tracker.test.ts
```

- [ ] **Step 2: Shrink the ChannelId union**

In `src/lib/notifications/channels/types.ts` line 10:

```typescript
// OLD
export type ChannelId = 'email' | 'sms' | 'telegram' | 'whatsapp';
// NEW
export type ChannelId = 'email' | 'telegram' | 'whatsapp';
```

In `src/lib/notifications/channels/enrollment-reducer.ts` line 24 (`ChannelEnrollmentRow`):

```typescript
// OLD
channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
// NEW
channel: 'email' | 'telegram' | 'whatsapp';
```

- [ ] **Step 3: Remove SMS from the channel factory**

In `src/lib/notifications/channels/index.ts`:
- Delete line 9: `export { SmsRecipientUnsubscribedError } from './sms-channel';`
- Delete line 26: `import { SmsChannel } from './sms-channel';`
- Delete the factory branch (lines 32–37):

```typescript
  if (id === 'sms') {
    if (process.env.CHANNELS_SMS_ENABLED !== 'true') {
      throw new Error('SMS channel disabled by CHANNELS_SMS_ENABLED env flag');
    }
    return new SmsChannel();
  }
```

The trailing `throw new Error(\`Unknown channel "${id}"\`)` at the function end STAYS — it is the defense-in-depth guard for stale TEXT values.

- [ ] **Step 4: Update factory + enrollment fixture tests**

In `src/lib/notifications/channels/__tests__/factory.test.ts`: delete the three SMS cases (`'throws for sms when CHANNELS_SMS_ENABLED is unset'`, `'throws for sms when CHANNELS_SMS_ENABLED=false'`, `'returns SmsChannel instance when flag is on'`) and any `SmsChannel` import. If the file asserts the unknown-channel throw, keep that assertion; if not, add:

```typescript
it('throws for an unknown channel string (stale DB row defense)', () => {
  expect(() => getChannel('sms' as never)).toThrow(/Unknown channel/);
});
```

In `src/lib/notifications/__tests__/enrollments.test.ts` (lines ~28, 35): change fixture rows using `channel: 'sms'` to `channel: 'telegram'` (keep handles/shape otherwise identical).

- [ ] **Step 5: Run the touched suites**

Run: `pnpm vitest run src/lib/notifications`
Expected: factory + enrollments PASS. (`worker/` suites still broken — fixed in Task 3; that's fine, don't run them yet.)

- [ ] **Step 6: Commit**

```bash
git add -A src/lib/notifications src/lib/costs worker/jobs/notification/sms-budget.ts
git commit --no-verify -m "feat(notifications): remove SMS channel implementation and shrink ChannelId"
```

---

### Task 3: Dispatcher + errors — remove SMS cost/opt-out paths

**Files:**
- Modify: `worker/jobs/notification/dispatch.ts`, `worker/jobs/notification/errors.ts`
- Delete: `worker/jobs/notification/__tests__/NotificationWorker-sms.test.ts`
- Modify: `worker/jobs/notification/__tests__/NotificationWorker.test.ts`, `worker/jobs/notification/__tests__/NotificationWorker-telegram.test.ts`

- [ ] **Step 1: Delete the SMS worker test file**

```bash
git rm worker/jobs/notification/__tests__/NotificationWorker-sms.test.ts
```

- [ ] **Step 2: Strip SMS from dispatch.ts**

In `worker/jobs/notification/dispatch.ts`:

1. Delete the import block (lines 20–24):
```typescript
import {
  reserveSmsCost,
  refundSmsCost,
  DailySmsLimitExceededError,
} from './sms-budget';
```

2. Delete the SMS reservation branch (lines ~260–280) — the whole block from `let smsReservationDate: string | null = null;` through the closing `}` of `if (channelId === 'sms') { ... }`.

3. Delete the `sms_unsubscribed` directive handler (lines ~355–393): the entire `if (directive.kind === 'sms_unsubscribed') { ... }` block (TWILIO_MESSAGING_SERVICE_SID check, `sms_sender_opt_outs` upsert, `sms_sender_opt_out_events` insert, enrollment flip, `accountIdsToInvalidate` assignment). Convert the following `} else if (` to `if (`.

4. Simplify the finally block (lines ~456–460):
```typescript
// OLD
} finally {
  if (channelId === 'sms' && smsReservationDate && !sendAccepted) {
    await refundSmsCost(ctx.businessId, smsReservationDate);
  }
}
// NEW — if nothing else lives in the finally, remove the finally entirely
}
```
Check whether `sendAccepted` is still read anywhere after this; if its only consumer was the refund, delete its declaration too.

5. Delete the stale comment line `// The outer finally still runs on \`continue\`, refunding SMS cost.` inside the approval-link try/catch comment block.

- [ ] **Step 3: Strip SMS from errors.ts**

In `worker/jobs/notification/errors.ts`:
- Remove `SmsRecipientUnsubscribedError` from the import list (line ~10).
- Delete the `if (err instanceof SmsRecipientUnsubscribedError) { ... return { kind: 'sms_unsubscribed', ... } }` branch in `classifyChannelError`.
- Remove `'sms_unsubscribed'` from the `ChannelErrorDirective` kind union (search the file for the union/type definition).

- [ ] **Step 4: Fix mocks in the surviving worker tests**

In `worker/jobs/notification/__tests__/NotificationWorker.test.ts` and `NotificationWorker-telegram.test.ts`: in the `vi.hoisted()` / `vi.mock('.../src/lib/notifications/channels', ...)` blocks, delete the `SmsRecipientUnsubscribedError` mock class entries and any `sms-budget`/`reserveSmsCost`/`refundSmsCost` mocks. If fixtures enroll an `'sms'` channel, change to `'telegram'` or remove the row.

- [ ] **Step 5: Run the worker notification suites**

Run: `pnpm vitest run worker/jobs/notification`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A worker/jobs/notification
git commit --no-verify -m "feat(worker): remove SMS cost reservation and 21610 opt-out paths from dispatcher"
```

---

### Task 4: Runtime stale-row guard + cache namespace bump (TDD)

**Files:**
- Modify: `src/lib/notifications/resolve-channels.ts`
- Modify: `worker/jobs/notification/dispatch.ts`
- Test: `src/lib/notifications/__tests__/resolve-channels.test.ts`, `worker/jobs/notification/__tests__/NotificationWorker.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/notifications/__tests__/resolve-channels.test.ts`, add:

```typescript
it('filters the enrollment query to supported channels only', async () => {
  // Use the existing sql-mock pattern in this file: capture the query text
  // issued by resolveChannels and assert the supported-channel filter.
  // (Adapt capture mechanism to the file's existing mock helpers.)
  const queryText = await captureResolveChannelsQuery();
  expect(queryText).toContain("channel IN ('email', 'telegram', 'whatsapp')");
});

it('uses the v2 cache namespace so stale sms-era entries are never read', () => {
  // Adapt to the file's existing cache-key assertion pattern.
  expect(cacheKeyFor('acct-1', 'loc-1')).toBe('rch:channels:v2:acct-1:loc-1');
});
```

In `worker/jobs/notification/__tests__/NotificationWorker.test.ts`, add (using the file's existing harness that mocks `resolveChannels` and `createApprovalLink`):

```typescript
it('skips a stale unsupported channel row before approval-link creation', async () => {
  // resolveChannels mocked to return a stale 'sms' row alongside a valid email row
  mockResolveChannels.mockResolvedValueOnce([
    { channel: 'sms' as never, handle: '+15555550123', location_id: null },
    { channel: 'email' as never, handle: 'owner@example.com', location_id: null },
  ]);

  await runDispatch(); // the file's existing job-invocation helper

  // No approval link, no send for the stale channel — and no crash:
  const linkChannels = mockCreateApprovalLink.mock.calls.map(([args]) => args.channel);
  expect(linkChannels).not.toContain('sms');
  expect(linkChannels).toContain('email'); // other channels unaffected
});
```

(Exact helper names differ — mirror the surrounding tests' setup precisely; the assertions above are the contract.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/notifications/__tests__/resolve-channels.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts`
Expected: the three new tests FAIL (no SQL filter, old cache prefix, sms reaches createApprovalLink).

- [ ] **Step 3: Implement the guard**

In `src/lib/notifications/resolve-channels.ts`:

1. Cache prefix (line ~31):
```typescript
// OLD
const CACHE_PREFIX = 'rch:channels:';
// NEW — v2: SMS removal; old namespace may contain stale 'sms' resolutions
const CACHE_PREFIX = 'rch:channels:v2:';
```

2. SQL filter (the SELECT at lines ~86–102) — add one predicate:
```sql
      AND channel IN ('email', 'telegram', 'whatsapp')
```
after `AND unsubscribed_at IS NULL`.

In `worker/jobs/notification/dispatch.ts`, at the very top of the per-enrollment loop body (before the approval-link try block), insert:

```typescript
const DISPATCHABLE_CHANNELS: ReadonlySet<string> = new Set(['email', 'telegram', 'whatsapp']);
```
(module scope, near other constants), and in the loop:

```typescript
    // channel_enrollments.channel is TEXT — a stale value (e.g. 'sms' after
    // its removal) must not create an approval link or reach getChannel().
    if (!DISPATCHABLE_CHANNELS.has(channelId)) {
      logger.warn(`Skipping unsupported channel "${channelId}" for response ${ctx.responseId} (stale enrollment row)`);
      continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/notifications/__tests__/resolve-channels.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts`
Expected: PASS (including pre-existing tests — fix any cache-key assertions that hard-code the old prefix).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/resolve-channels.ts worker/jobs/notification/dispatch.ts src/lib/notifications/__tests__/resolve-channels.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts
git commit --no-verify -m "feat(notifications): runtime guard for stale channel rows + v2 cache namespace"
```

---

### Task 5: Worker ingress + boot + startup assertions

**Files:**
- Delete: `worker/ingress/twilio/twilio.ts`, `worker/ingress/twilio/__tests__/twilio-inbound.test.ts`, `worker/ingress/twilio/__tests__/twilio-status.test.ts`
- Modify: `worker/index.ts`, `worker/config/startup-assert.ts`

KEEP UNTOUCHED (WhatsApp-shared): `twilio-verify.ts`, `twilio-intent.ts`, `twilio-delivery-status.ts`, `parse-inbound.ts`, `twilio-whatsapp*.ts`, `whatsapp-shared.ts`, and their tests (`twilio-intent.test.ts`, `twilio-verify.test.ts`, `parse-inbound.test.ts`, `twilio-whatsapp.test.ts`).

- [ ] **Step 1: Delete SMS ingress + tests**

```bash
git rm worker/ingress/twilio/twilio.ts \
       worker/ingress/twilio/__tests__/twilio-inbound.test.ts \
       worker/ingress/twilio/__tests__/twilio-status.test.ts
```

- [ ] **Step 2: Unregister SMS routes in worker/index.ts**

- Delete line 34: `import { handleTwilioStatusCallback, handleTwilioInbound } from './ingress/twilio/twilio';`
- Delete lines 310–312:
```typescript
  // Twilio webhooks — status callbacks + inbound SMS (STOP/START)
  app.post('/ingress/twilio/status', { config: { rawBody: true } }, handleTwilioStatusCallback);
  app.post('/ingress/twilio/inbound', { config: { rawBody: true } }, handleTwilioInbound);
```
(WhatsApp routes at ~317–318 stay.)
- Line 38: remove `assertChannelsSmsEnv` from the import list.
- Delete line 268: `assertChannelsSmsEnv();`
- Line 277: delete the SMS segment from the feature-flag log line:
```typescript
// DELETE this line from the template string:
`SMS=${process.env.CHANNELS_SMS_ENABLED === 'true' ? 'on' : 'off'}, ` +
```

- [ ] **Step 3: Remove the startup assertion**

In `worker/config/startup-assert.ts`: delete the whole `assertChannelsSmsEnv()` function (lines 161–175). If line 251 of `worker/index.ts` (or any barrel) re-exports it, remove `assertChannelsSmsEnv` from that export list. Check for a startup-assert test file (`rg -l assertChannelsSmsEnv worker/`) and delete its SMS cases.

- [ ] **Step 4: Run worker suites + typecheck**

Run: `pnpm vitest run worker/ingress worker/config && pnpm typecheck`
Expected: PASS / substantially fewer errors (remaining typecheck errors must only be in files scheduled for Tasks 6–8 — verify each remaining error's file is in this plan).

- [ ] **Step 5: Commit**

```bash
git add -A worker/index.ts worker/config worker/ingress
git commit --no-verify -m "feat(worker): remove SMS ingress routes and startup assertion"
```

---

### Task 6: Offboarding purge — remove the SMS stage

**Files:**
- Modify: `worker/jobs/account-offboarding/PurgeWorker.ts`, `worker/jobs/account-offboarding/purge-stages.ts`, `worker/jobs/account-offboarding/purge-helpers.ts`
- Modify: `src/lib/account-offboarding/table-disposition.ts`, `src/lib/account-offboarding/purge-verification.ts`
- Modify tests: `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts`, `src/lib/account-offboarding/__tests__/purge-verification.test.ts`

- [ ] **Step 1: Remove the stage from the orchestrator**

In `worker/jobs/account-offboarding/PurgeWorker.ts`: delete `runSmsOptOutPurgeStage,` from the import (line 26) and the call `await runSmsOptOutPurgeStage(offboarding);` (line 78). The strictly-ordered sequence comment stays.

- [ ] **Step 2: Delete the stage + helpers**

In `worker/jobs/account-offboarding/purge-stages.ts`: delete the whole `runSmsOptOutPurgeStage` function (lines ~414–506), the `smsOptOutScrubScopeRecord` import (line 18), and `type SmsHandleRow` import (line 19).

In `worker/jobs/account-offboarding/purge-helpers.ts`: delete `SmsHandleRow` (lines 13–16), `SmsOptOutScrubScopeRecord` (lines 18–23), and the `smsOptOutScrubScopeRecord` function (lines 49+). If a `ProviderDispositionRecord`-style union references `SmsOptOutScrubScopeRecord`, remove that member.

- [ ] **Step 3: Remove the table dispositions**

In `src/lib/account-offboarding/table-disposition.ts`: delete both entries (lines 256–269) for `sms_sender_opt_outs` and `sms_sender_opt_out_events` (the two `retain_compliance_limited_pii` objects).

- [ ] **Step 4: Remove verification branches**

In `src/lib/account-offboarding/purge-verification.ts`:
- Delete the two early-dispatch ifs (lines 80–85) for both sms tables.
- Delete the `case 'sms_sender_opt_outs': case 'sms_sender_opt_out_events':` arms (lines ~477–478) and their forwarding body.
- Delete the entire `countSmsOptOutViolations` function (lines ~561–601).
- If a table-name union type lists the sms tables, remove them.

- [ ] **Step 5: Update the tests**

In `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts`: remove the SMS-handle query mock (line ~76, the `account_handles AS` + `sms_sender_opt_out_events` matcher returning `[{ messaging_service_sid: 'MG123', handle: '+15555550123' }]`) and any assertions counting the SMS stage.

In `src/lib/account-offboarding/__tests__/purge-verification.test.ts`: remove the `sms_opt_out_scrub_scope` mocks (lines ~69–79) and the assertions on `FROM sms_sender_opt_outs` / `FROM sms_sender_opt_out_events` (lines ~137–150).

- [ ] **Step 6: Run the suites**

Run: `pnpm vitest run worker/jobs/account-offboarding src/lib/account-offboarding`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A worker/jobs/account-offboarding src/lib/account-offboarding
git commit --no-verify -m "feat(offboarding): remove SMS opt-out purge stage and table dispositions"
```

---

### Task 7: Admin surfaces — routes, widget, panels, filters

**Files:**
- Delete: `src/app/api/admin/channels/sms/` (entire directory, includes `__tests__/`)
- Delete: `src/components/admin/SmsEnrollmentWidget.tsx`
- Modify: `src/app/admin/businesses/[id]/_components/ChannelsPanel.tsx`, `src/lib/admin/business-detail/mappers.ts:299`, `src/app/admin/businesses/[id]/types.ts:47`, `src/app/api/admin/businesses/[id]/channels/route.ts:123`
- Modify: `src/app/admin/notifications/page.tsx:131-133`, `src/app/api/admin/notifications/route.ts:85-88`

- [ ] **Step 1: Delete the admin SMS API directory and widget**

```bash
git rm -r src/app/api/admin/channels/sms
git rm src/components/admin/SmsEnrollmentWidget.tsx
```

- [ ] **Step 2: ChannelsPanel + business detail**

In `src/app/admin/businesses/[id]/_components/ChannelsPanel.tsx`: delete the import (line 3) `import { SmsEnrollmentWidget } from '@/components/admin/SmsEnrollmentWidget';` and the whole flag-gated SMS section (lines 71–83, the `{business.smsEnabled && ( <section ...>SMS enrollment...</section> )}` block).

In `src/lib/admin/business-detail/mappers.ts`: delete line 299 `smsEnabled: process.env.CHANNELS_SMS_ENABLED === 'true',` AND remove `smsEnabled` from the `BusinessDetail` type it feeds (`pnpm typecheck` will point at the type file; remove the field there).

In `src/app/admin/businesses/[id]/types.ts` line 47 (`ChannelEnrollmentRow`):
```typescript
// OLD
channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
// NEW
channel: 'email' | 'telegram' | 'whatsapp';
```

In `src/app/api/admin/businesses/[id]/channels/route.ts` `maskHandle` (line ~123):
```typescript
// OLD
if (channel === 'sms' || channel === 'whatsapp') {
// NEW
if (channel === 'whatsapp') {
```

- [ ] **Step 3: Admin notifications filter — UI and backend**

In `src/app/admin/notifications/page.tsx` (lines 131–133): delete `<option value="sms">SMS</option>`.

In `src/app/api/admin/notifications/route.ts` (lines 85–88):
```typescript
// OLD
if (channel === 'email' || channel === 'sms') {
// NEW
if (channel === 'email') {
```

- [ ] **Step 4: Run admin tests + typecheck**

Run: `pnpm vitest run src/app/api/admin src/lib/admin && pnpm typecheck`
Expected: PASS / remaining typecheck errors only in Task 8 files.

- [ ] **Step 5: Commit**

```bash
git add -A src/app/api/admin src/app/admin src/components/admin src/lib/admin
git commit --no-verify -m "feat(admin): remove SMS enrollment routes, widget, and filters"
```

---

### Task 8: Owner surfaces — settings UI, override API, dashboard channels, e2e

**Files:**
- Modify: `src/app/api/settings/channels/override/route.ts:37,189`, `src/app/api/settings/channels/overrides/route.ts:33`
- Modify: `src/app/(authenticated)/settings/channels/page.tsx:31-33,51`, `src/components/dashboard/settings/PerLocationOverridePanel.tsx:23,55,62`
- Modify: `src/app/(authenticated)/settings/channels/ChannelsClient.tsx:8,72-78`, `ChannelsTabClient.tsx:6`, `src/components/dashboard/channels/ComingSoonChannelRow.tsx:8`
- Modify: `src/app/api/dashboard/channels/route.ts:21,34,115-122`
- Modify: `e2e/owner-channels.spec.ts:49,154-157`
- Test: the override route's existing test file (add rejection case)

- [ ] **Step 1: Write the failing override-rejection test**

In the override route's existing test file (`rg -l "override" src/app/api/settings --include="*.test.ts"` to locate; follow its existing request-builder pattern):

```typescript
it('rejects channel "sms" with 400 (channel removed)', async () => {
  const res = await postOverride({ locationId: validLocationId, channel: 'sms' });
  expect(res.status).toBe(400);
});
```

Run: `pnpm vitest run <that test file>` — Expected: FAIL (currently accepts sms → not 400).

- [ ] **Step 2: Shrink the zod enums + add defense-in-depth filter**

In `src/app/api/settings/channels/override/route.ts` lines 37 AND 189:
```typescript
// OLD (both occurrences)
channel: z.enum(['email', 'telegram', 'sms', 'whatsapp']),
// NEW
channel: z.enum(['email', 'telegram', 'whatsapp']),
```

In `src/app/api/settings/channels/overrides/route.ts` — add a channel filter to the per-location query (line ~33):
```sql
      SELECT e.id, e.channel, e.handle, e.status, e.verified_at, e.location_id
      FROM channel_enrollments e
      WHERE e.account_id = ${user.accountId}::uuid
        AND e.location_id IS NOT NULL
        AND e.archived_at IS NULL
        AND e.channel IN ('email', 'telegram', 'whatsapp')
      ORDER BY e.location_id, e.channel
```

- [ ] **Step 3: Settings page + override panel**

In `src/app/(authenticated)/settings/channels/page.tsx`:
- Lines 31–33: delete the two-line comment about `'sms' stays known` and shrink the set:
```typescript
const KNOWN_CHANNELS = new Set<string>(['email', 'telegram', 'whatsapp']);
```
- Line 51 (`PerLocationOverride`): `channel: 'email' | 'telegram' | 'whatsapp';`

In `src/components/dashboard/settings/PerLocationOverridePanel.tsx`:
- Line 23: `channel: 'email' | 'telegram' | 'whatsapp';`
- Line 55: delete `sms: 'SMS',` from `CHANNEL_LABELS`.
- Line 62: delete `sms: '📱',` from `CHANNEL_ICONS`.

- [ ] **Step 4: Channels client + coming-soon row**

In `src/app/(authenticated)/settings/channels/ChannelsClient.tsx`:
- Line 8: `channel: 'email' | 'telegram' | 'whatsapp';`
- Lines 72–78: delete the SMS block (comment + row):
```tsx
{/* SMS — owner self-service is post-launch. The CHANNELS_SMS_ENABLED flag
    gates backend dispatch + admin enrollment, NOT this owner row, so the
    row is intentionally flag-independent. */}
<ComingSoonChannelRow
  icon="📱"
  name="SMS"
  reason="SMS notifications are coming soon"
/>
```

In `ChannelsTabClient.tsx` line 6: update the comment to `//   1. The existing ChannelsClient (Email + Telegram + WhatsApp rows) — org-level defaults.`

In `src/components/dashboard/channels/ComingSoonChannelRow.tsx` line 8:
```typescript
// OLD
const iconClass = name === 'SMS' ? 'ch-sms' : name === 'WhatsApp' ? 'ch-wa' : 'ch-tg';
// NEW
const iconClass = name === 'WhatsApp' ? 'ch-wa' : 'ch-tg';
```
(If a `.ch-sms` CSS rule exists — `rg 'ch-sms' src/` — delete it.)

- [ ] **Step 5: Dashboard channels route**

In `src/app/api/dashboard/channels/route.ts`:
- Line 21 (`maskHandle`): `if (channel === 'sms' || channel === 'whatsapp') {` → `if (channel === 'whatsapp') {`
- Line 34: delete the whole `smsAvailable()` function.
- Lines 115–122: remove the sms keys:
```typescript
available: {
  telegram: telegramAvailable(),
  whatsapp: whatsappAvailable(),
},
reasons: {
  whatsapp: 'pending_meta_verification',
},
```
Update this route's tests if they assert `available.sms`.

- [ ] **Step 6: E2E spec**

In `e2e/owner-channels.spec.ts`:
- Line 49: delete `await expect(page.getByText('SMS')).toBeVisible();`
- Lines 154–157 (`'coming-soon rows have no button'` fixme): retarget from SMS to WhatsApp:
```typescript
const waRow = page.getByText('WhatsApp').locator('xpath=ancestor::*[contains(@class,"rounded-lg")]');
await expect(waRow.getByRole('button')).toHaveCount(0);
```

- [ ] **Step 7: Run tests + full typecheck**

Run: `pnpm vitest run src/app/api/settings src/app/api/dashboard && pnpm typecheck`
Expected: ALL PASS, typecheck ZERO errors (every code surface is now converted).

- [ ] **Step 8: Commit**

```bash
git add -A src/app e2e src/components
git commit --no-verify -m "feat(settings): remove SMS from owner channel surfaces and override API"
```

---

### Task 9: CI inventories + RLS docs

**Files:**
- Modify: `scripts/ci/tenant-tables.ts:26-27`, `scripts/ci/tenant-scope-allowlist.ts` (~1630 and ~1711 regions), `docs/security/rls-inventory.md:33`

- [ ] **Step 1: Remove the tables from the tenant audit**

In `scripts/ci/tenant-tables.ts` delete lines 26–27:
```typescript
  'sms_sender_opt_outs',
  'sms_sender_opt_out_events',
```

In `scripts/ci/tenant-scope-allowlist.ts`: delete EVERY allowlist object whose `table` is `sms_sender_opt_outs` or `sms_sender_opt_out_events` (the three `src/app/api/admin/channels/sms/*` entries, plus all `worker/jobs/account-offboarding/purge-stages.ts` SMS entries — search `rg -n "sms_sender_opt_out" scripts/ci/` and remove each whole `{ ... },` object).

In `docs/security/rls-inventory.md`: remove the rows/sections for the two sms tables (line ~33 area); note in the doc that migration 061 dropped them.

- [ ] **Step 2: Run the audits**

Run: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
Expected: PASS (no orphaned allowlist warnings, no missing-table failures).

- [ ] **Step 3: Commit**

```bash
git add scripts/ci docs/security/rls-inventory.md
git commit --no-verify -m "chore(ci): drop SMS tables from tenant-scope and RLS inventories"
```

---

### Task 10: Env, reference docs, legal copy

**Files:**
- Modify: `.env.example:199-223`, `.claude/reference/env-vars.md`, `.claude/reference/migrations-log.md`, `docs/directory.md`, `docs/plans/adding-communication-channels.md`, `docs/eservices-variables.md`, `docs/runbooks/deployment-guide.md`, `docs/security/vendor-risk-register.md`, `docs/known-issues.md`, `docs/sass_ready/21-mobile.md`, `docs/sass_ready/26-financial-operations.md`, `docs/security/access-checklist.md`, `docs/launch-ready-part2.md`, `src/lib/legal/content.ts:33`

- [ ] **Step 1: .env.example**

Delete the whole `# --- SMS channel (Phase 1) ---` block (lines 199–223) EXCEPT keep `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` — move those two into the WhatsApp section with the comment `# Twilio credentials (shared by the WhatsApp channel).` Delete: `CHANNELS_SMS_ENABLED`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_VERIFY_SERVICE_SID`, `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS`, `SMS_DAILY_LIMIT_CENTS_GLOBAL`.

- [ ] **Step 2: Legal copy (user-facing — flag in PR description)**

In `src/lib/legal/content.ts` line 33:
```typescript
// OLD
['Twilio', 'SMS and WhatsApp', 'Phone numbers, message content, delivery metadata'],
// NEW
['Twilio', 'WhatsApp', 'Phone numbers, message content, delivery metadata'],
```

- [ ] **Step 3: Reference docs**

- `.claude/reference/env-vars.md`: delete the `### CHANNELS_SMS_ENABLED` section (lines 99–115) and the flag-summary table row (line ~375 `| CHANNELS_SMS_ENABLED | Off | 10DLC registration |`). In the WhatsApp section, change `TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (shared with SMS if both enabled)` → `TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN`.
- `.claude/reference/migrations-log.md`: update head to **061** / next to **062**; append the 061 entry following the log's existing entry format (what it does: archive sms enrollments, whatsapp-only handle index, one_mobile rebuild without sms, drop both opt-out tables; deploy staging-first).
- `docs/directory.md`: delete the rows for `channels/sms/*` routes, `SmsEnrollmentWidget.tsx`, `sms-body.ts`, `channels/sms-channel.ts`, `sms-tracker.ts`, `sms-budget.ts`, `twilio/twilio.ts`; update the `ChannelsClient.tsx` row (`ComingSoonChannelRow` for WhatsApp only), the `ComingSoonChannelRow.tsx` row (WhatsApp only), the `dispatch.ts` row (drop "and the SMS cost reserve/refund flow"), and the `twilio/twilio-intent.ts` row (`used by WhatsApp ingress`).
- `docs/plans/adding-communication-channels.md`, `docs/eservices-variables.md`, `docs/runbooks/deployment-guide.md` (~line 132), `docs/security/vendor-risk-register.md` (~line 17), `docs/known-issues.md` (~line 42), `docs/sass_ready/21-mobile.md` (~line 16), `docs/sass_ready/26-financial-operations.md` (~line 40), `docs/security/access-checklist.md` (~line 15), `docs/launch-ready-part2.md` (~line 88): in each, find SMS mentions (`rg -in '\bsms\b' <file>`) and either delete the SMS-specific lines or rewrite to WhatsApp/Telegram-only phrasing. Twilio mentions that are about WhatsApp stay; pure-SMS rows (10DLC, Messaging Service, Verify Service, SMS budgets) go.

- [ ] **Step 4: Commit**

```bash
git add .env.example .claude/reference docs src/lib/legal
git commit --no-verify -m "docs(sms-removal): purge SMS from env, reference docs, and legal copy"
```

---

### Task 11: Final sweep + full local gate

**Files:** none new — fixes anything the sweep finds.

- [ ] **Step 1: Classified sweep**

Run: `rg -in '\bsms\b' src/ worker/ scripts/ e2e/ docs/ .claude/reference/ --glob '!docs/superpowers/**' | rg -v 'sms_sender_opt_out'` and `rg -in 'twilio' src/ worker/ docs/ .claude/reference/ --glob '!docs/superpowers/**'`.

Classify EVERY hit as one of:
1. `kept: WhatsApp/shared Twilio` (twilio-verify/intent/delivery-status/whatsapp files, TWILIO_ACCOUNT_SID/AUTH_TOKEN docs, legal Twilio row)
2. `remove/update: SMS-specific` → fix it now
3. `historical: dated spec/plan` (`docs/superpowers/**` is already excluded; anything else claiming to be historical must be a dated document)

Also verify: `rg -n "CHANNELS_SMS_ENABLED|TWILIO_MESSAGING_SERVICE_SID|TWILIO_VERIFY_SERVICE_SID|SMS_DAILY_LIMIT" src/ worker/ scripts/ .env.example` returns ZERO hits.

- [ ] **Step 2: Full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy && pnpm build`
Expected: ALL PASS. (If lint misbehaves due to worktree nesting, note it and rely on CI — do not skip the rest.)

- [ ] **Step 3: Commit any sweep fixes**

```bash
git add -A && git commit --no-verify -m "chore(sms-removal): final sweep fixes"
```
(Skip if the sweep found nothing.)

---

### Task 12: Pre-flight prod gate, PR, staging, promotion

**Process steps — needs prod/staging Supabase access and GitHub. STOP at each gate.**

- [ ] **Step 1: Pre-flight gate #1 (prod), BEFORE opening the PR**

Run against the **production** Supabase project (psql or Supabase MCP). ALL counts must be 0:

```sql
SELECT 'enrollments' AS what, COUNT(*) FROM channel_enrollments WHERE channel = 'sms'
UNION ALL SELECT 'opt_outs', COUNT(*) FROM sms_sender_opt_outs
UNION ALL SELECT 'opt_out_events', COUNT(*) FROM sms_sender_opt_out_events
UNION ALL SELECT 'approval_links', COUNT(*) FROM approval_links WHERE channel = 'sms'
UNION ALL SELECT 'deliveries', COUNT(*) FROM notification_deliveries WHERE channel = 'sms'
UNION ALL SELECT 'inbound_sms_events', COUNT(*) FROM inbound_events WHERE source = 'twilio' AND event_type = 'inbound_sms'
UNION ALL SELECT 'twilio_status_events_sms', COUNT(*) FROM inbound_events
  WHERE source = 'twilio' AND event_type LIKE 'status:%'
    AND COALESCE(payload->>'From', '') NOT LIKE 'whatsapp:%'
    AND COALESCE(payload->>'To', '') NOT LIKE 'whatsapp:%'
UNION ALL SELECT 'pending_sms_outbox', COUNT(*) FROM job_outbox
  WHERE topic = 'send_notification' AND status IN ('pending', 'dispatched')
    AND payload::text ILIKE '%"sms"%';
```

Run the same against **staging** for awareness (nonzero staging test data is OK — record it). **Any nonzero in PROD → STOP. Export the data, report to owner, do not merge.** Paste the prod output into the PR description.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin worktree-remove-sms-channel
gh pr create --title "feat: remove SMS notification channel entirely" --body "<summary; spec + plan links; prod pre-flight output; ops follow-up checklist: delete CHANNELS_SMS_ENABLED, TWILIO_MESSAGING_SERVICE_SID, TWILIO_VERIFY_SERVICE_SID, SMS_DAILY_LIMIT_* from Railway staging+prod after deploy; retire Twilio Messaging/Verify Services; NOTE: user-facing legal copy changed (src/lib/legal/content.ts)>"
```
Wait for all 4 CI checks green. CI is the authoritative gate (worktree-local lint is advisory).

- [ ] **Step 3: Staging ride**

Merge/push the branch to `staging` (per repo convention for migration-bearing changes). Apply migration 061 to the **staging** Supabase project. Verify: staging worker boots clean (no SMS startup assertion, no SMS routes), `/settings/channels` renders without SMS, WhatsApp/Telegram/email resolution works, `\d channel_enrollments` shows `idx_channel_enrollments_whatsapp_handle` and the rebuilt `one_mobile_per_scope`, and the two sms tables are gone.

- [ ] **Step 4: Pre-flight gate #2 + promote**

Re-run the Step 1 prod query — still all 0 (paste output in the PR). Merge the PR into `main`. Apply migration 061 to the **production** Supabase project. Then fast-forward `staging` onto `main` (`git merge --ff-only main`).

- [ ] **Step 5: Ops follow-up (manual, after prod deploy)**

Delete from Railway (staging + prod): `CHANNELS_SMS_ENABLED`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_VERIFY_SERVICE_SID`, `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS`, `SMS_DAILY_LIMIT_CENTS_GLOBAL` (keep `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` — WhatsApp). Retire the Twilio Messaging Service + Verify Service in the Twilio console if nothing else uses them. Confirm worker reboots clean after env removal.
