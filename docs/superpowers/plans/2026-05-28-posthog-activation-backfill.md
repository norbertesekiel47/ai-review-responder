# PostHog `activation_completed` Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent, dry-run-by-default CLI that backfills historical `activation_completed` events into PostHog, sharing one authoritative activation rule with the live publisher path.

**Architecture:** Extract the activation rule (7-day window + event shape) into one pure builder used by both the live path and the backfill; teach the capture wrapper to carry an optional `timestamp` and dedup `uuid`; key every activation event on `uuid = response_id` so re-runs and live/backfill overlap dedupe in PostHog. The backfill stamps each event at its real `posted_at`.

**Tech Stack:** TypeScript (strict), Vitest, Postgres.js (`sql`), posthog-node@5.35.1, `tsx` CLI, Node `node:util` `parseArgs`.

**Scope note:** The Railway `POSTHOG_API_KEY` + redeploy steps of #83 are an operator/ops gate, **out of scope**. So are the legal/sub-processor edits (drafted on `main`; they land with the prod-key flip). This plan delivers only the optional historical-backfill acceptance criterion.

**Ground truth already verified:**
- posthog-node@5.35.1 `EventMessage` accepts `timestamp?: Date` and `uuid?: string` (`node_modules/.pnpm/posthog-node@5.35.1/.../dist/types.d.ts:32-33`).
- `ci:tenant-scope` only scans `SCANNED_ROOTS = ['src', 'worker']` (`scripts/ci/tenant-scope-audit.ts`). It does **not** scan `scripts/`, and it flags *unused* allowlist entries — so the backfill's cross-account query needs **no** allowlist entry, and adding one would fail the audit. No allowlist task exists in this plan by design.
- Existing live-path test `worker/jobs/publisher/__tests__/activation.test.ts` asserts the exact captured-event object, so Task 3 must update it to include `uuid`.

---

## File Structure

- **Create** `src/lib/analytics/activation-event.ts` — pure `buildActivationCompletedEvent` (the activation rule + event shape; single owner).
- **Create** `src/lib/analytics/__tests__/activation-event.test.ts` — builder unit tests.
- **Modify** `src/lib/analytics/posthog.ts` — add optional `timestamp`/`uuid` to `CaptureAnalyticsEventInput` and forward them.
- **Modify** `src/lib/analytics/__tests__/posthog.test.ts` — assert forwarding + omission.
- **Modify** `worker/jobs/publisher/activation.ts` — use the builder; drop inline calc + `MS_PER_DAY`.
- **Modify** `worker/jobs/publisher/__tests__/activation.test.ts` — expect `uuid` in the captured event.
- **Create** `scripts/posthog-backfill-activations.ts` — the CLI.

---

## Task 1: Extend the capture wrapper with `timestamp` + `uuid`

**Files:**
- Modify: `src/lib/analytics/posthog.ts` (type at lines 7-11; `captureAnalyticsEvent` at lines 36-48)
- Test: `src/lib/analytics/__tests__/posthog.test.ts`

- [ ] **Step 1: Add the failing tests**

Append these two `it(...)` blocks inside the existing `describe('PostHog analytics wrapper', ...)` in `src/lib/analytics/__tests__/posthog.test.ts` (before the closing `});` of the describe):

```typescript
  it('forwards timestamp and uuid to capture when provided', () => {
    vi.stubEnv('POSTHOG_API_KEY', 'ph_test_key');
    const when = new Date('2026-05-03T12:00:00.000Z');

    captureAnalyticsEvent({
      event: 'activation_completed',
      distinctId: 'account_1',
      properties: { account_id: 'account_1' },
      timestamp: when,
      uuid: 'response_1',
    });

    expect(posthogMock.instances[0]?.capture).toHaveBeenCalledWith({
      event: 'activation_completed',
      distinctId: 'account_1',
      properties: { account_id: 'account_1' },
      timestamp: when,
      uuid: 'response_1',
    });
  });

  it('omits timestamp and uuid keys when not provided', () => {
    vi.stubEnv('POSTHOG_API_KEY', 'ph_test_key');

    captureAnalyticsEvent({ event: 'review_published', distinctId: 'business_1' });

    const call = posthogMock.instances[0]?.capture.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty('timestamp');
    expect(call).not.toHaveProperty('uuid');
  });
```

- [ ] **Step 2: Run the tests to verify the first fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm vitest run src/lib/analytics/__tests__/posthog.test.ts`
Expected: FAIL — "forwards timestamp and uuid" fails because `capture` is currently called without `timestamp`/`uuid`. ("omits" passes already.)

- [ ] **Step 3: Extend the type**

In `src/lib/analytics/posthog.ts`, replace the `CaptureAnalyticsEventInput` type (lines 7-11):

```typescript
export type CaptureAnalyticsEventInput = {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  /** Historical event time. Omit for live events (PostHog defaults to now). */
  timestamp?: Date;
  /** Deterministic dedup id. PostHog dedupes events that share a uuid. */
  uuid?: string;
};
```

- [ ] **Step 4: Forward the new fields**

In `src/lib/analytics/posthog.ts`, replace the `posthog.capture({...})` call inside `captureAnalyticsEvent` (lines 42-46) with the conditional-spread form so existing callers' payload shape is unchanged when the fields are absent:

```typescript
  posthog.capture({
    event: input.event,
    distinctId: input.distinctId,
    properties: input.properties,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    ...(input.uuid ? { uuid: input.uuid } : {}),
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm vitest run src/lib/analytics/__tests__/posthog.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && \
git add src/lib/analytics/posthog.ts src/lib/analytics/__tests__/posthog.test.ts && \
git commit -m "feat(analytics): support optional timestamp/uuid on captureAnalyticsEvent

Lets callers stamp historical events and set a deterministic dedup id.
Backward-compatible: absent fields are omitted from the capture payload.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Shared activation-event builder

**Files:**
- Create: `src/lib/analytics/activation-event.ts`
- Test: `src/lib/analytics/__tests__/activation-event.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/analytics/__tests__/activation-event.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildActivationCompletedEvent } from '../activation-event';

const BASE = {
  accountId: 'acct_1',
  accountCreatedAt: new Date('2026-05-01T00:00:00.000Z'),
  responseId: 'resp_1',
  businessId: 'biz_1',
  reviewId: 'rev_1',
  postedAt: new Date('2026-05-03T12:00:00.000Z'),
};

describe('buildActivationCompletedEvent', () => {
  it('builds the event for an activation within the 7-day window', () => {
    expect(buildActivationCompletedEvent(BASE)).toEqual({
      event: 'activation_completed',
      distinctId: 'acct_1',
      uuid: 'resp_1',
      properties: {
        account_id: 'acct_1',
        business_id: 'biz_1',
        response_id: 'resp_1',
        review_id: 'rev_1',
        days_to_activation: 2.5,
      },
    });
  });

  it('treats exactly 7.0 days as eligible (inclusive upper bound)', () => {
    const event = buildActivationCompletedEvent({
      ...BASE,
      postedAt: new Date('2026-05-08T00:00:00.000Z'),
    });
    expect(event?.properties?.days_to_activation).toBe(7);
  });

  it('returns null just past 7 days', () => {
    expect(
      buildActivationCompletedEvent({
        ...BASE,
        postedAt: new Date('2026-05-08T00:00:01.000Z'),
      }),
    ).toBeNull();
  });

  it('returns null when posted_at precedes account creation', () => {
    expect(
      buildActivationCompletedEvent({
        ...BASE,
        postedAt: new Date('2026-04-30T23:59:59.000Z'),
      }),
    ).toBeNull();
  });

  it('returns null for unparseable dates (non-finite)', () => {
    expect(buildActivationCompletedEvent({ ...BASE, postedAt: 'not-a-date' })).toBeNull();
  });

  it('rounds days_to_activation to 4 decimal places', () => {
    // created +2d12h43s => 216043s / 86400 = 2.50049768... => 2.5005
    const event = buildActivationCompletedEvent({
      ...BASE,
      postedAt: new Date('2026-05-03T12:00:43.000Z'),
    });
    expect(event?.properties?.days_to_activation).toBe(2.5005);
  });

  it('accepts ISO-string timestamps as well as Date objects', () => {
    const event = buildActivationCompletedEvent({
      ...BASE,
      accountCreatedAt: '2026-05-01T00:00:00.000Z',
      postedAt: '2026-05-03T12:00:00.000Z',
    });
    expect(event?.properties?.days_to_activation).toBe(2.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm vitest run src/lib/analytics/__tests__/activation-event.test.ts`
Expected: FAIL — cannot resolve `../activation-event` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/analytics/activation-event.ts`:

```typescript
import type { CaptureAnalyticsEventInput } from './posthog';

const MS_PER_DAY = 86_400_000;

export interface ActivationCompletedInput {
  accountId: string;
  accountCreatedAt: Date | string;
  responseId: string;
  businessId: string;
  reviewId: string;
  postedAt: Date | string;
}

/**
 * Builds the `activation_completed` event for an account's first posted
 * response, or returns null when the activation falls outside the 0-7 day
 * window. Single authoritative owner of the activation rule and event shape —
 * both the live publisher path and the historical backfill call it, so they
 * cannot drift.
 *
 * The caller must guarantee `responseId` is the account's first posted
 * response; "is-first" is decided in SQL, not here. `uuid = responseId` makes
 * the event idempotent across re-emits, backfill re-runs, and live/backfill
 * overlap (PostHog dedupes on uuid).
 */
export function buildActivationCompletedEvent(
  input: ActivationCompletedInput,
): CaptureAnalyticsEventInput | null {
  const postedAtMs = new Date(input.postedAt).getTime();
  const accountCreatedAtMs = new Date(input.accountCreatedAt).getTime();
  const daysToActivation = (postedAtMs - accountCreatedAtMs) / MS_PER_DAY;

  if (!Number.isFinite(daysToActivation) || daysToActivation < 0 || daysToActivation > 7) {
    return null;
  }

  return {
    event: 'activation_completed',
    distinctId: input.accountId,
    uuid: input.responseId,
    properties: {
      account_id: input.accountId,
      business_id: input.businessId,
      response_id: input.responseId,
      review_id: input.reviewId,
      days_to_activation: Number(daysToActivation.toFixed(4)),
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm vitest run src/lib/analytics/__tests__/activation-event.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && \
git add src/lib/analytics/activation-event.ts src/lib/analytics/__tests__/activation-event.test.ts && \
git commit -m "feat(analytics): extract buildActivationCompletedEvent rule

Single authoritative owner of the activation_completed 7-day window, event
shape, and uuid=response_id dedup key. Consumed by the live path and backfill.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Refactor the live path to use the builder

**Files:**
- Modify: `worker/jobs/publisher/activation.ts` (remove `MS_PER_DAY` at line 4; replace lines 91-109)
- Modify: `worker/jobs/publisher/__tests__/activation.test.ts` (the first assertion)

- [ ] **Step 1: Update the existing test to expect `uuid`**

In `worker/jobs/publisher/__tests__/activation.test.ts`, in the test `'captures activation_completed for the first posted response within 7 days'`, change the `toHaveBeenCalledWith` object to include `uuid` (insert the `uuid` line right after `distinctId`):

```typescript
    expect(mockCaptureAnalyticsEvent).toHaveBeenCalledWith({
      event: 'activation_completed',
      distinctId: '00000000-0000-0000-0000-000000000004',
      uuid: INPUT.responseId,
      properties: {
        account_id: '00000000-0000-0000-0000-000000000004',
        business_id: INPUT.businessId,
        response_id: INPUT.responseId,
        review_id: INPUT.reviewId,
        days_to_activation: 2.5,
      },
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm vitest run worker/jobs/publisher/__tests__/activation.test.ts`
Expected: FAIL — current code captures without `uuid`, so the updated assertion mismatches.

- [ ] **Step 3: Add the builder import**

In `worker/jobs/publisher/activation.ts`, add this import directly below the existing import on line 1 (`import { captureAnalyticsEvent } from '../../../src/lib/analytics/posthog';`):

```typescript
import { buildActivationCompletedEvent } from '../../../src/lib/analytics/activation-event';
```

- [ ] **Step 4: Remove the now-unused `MS_PER_DAY`**

In `worker/jobs/publisher/activation.ts`, delete line 4:

```typescript
const MS_PER_DAY = 86_400_000;
```

- [ ] **Step 5: Replace the inline calc + capture block**

In `worker/jobs/publisher/activation.ts`, replace this block (current lines 91-109):

```typescript
    const postedAtMs = new Date(row.posted_at).getTime();
    const accountCreatedAtMs = new Date(row.account_created_at).getTime();
    const daysToActivation = (postedAtMs - accountCreatedAtMs) / MS_PER_DAY;

    if (!Number.isFinite(daysToActivation) || daysToActivation < 0 || daysToActivation > 7) {
      return;
    }

    captureAnalyticsEvent({
      event: 'activation_completed',
      distinctId: row.account_id,
      properties: {
        account_id: row.account_id,
        business_id: row.business_id,
        response_id: row.response_id,
        review_id: row.review_id,
        days_to_activation: Number(daysToActivation.toFixed(4)),
      },
    });
```

with:

```typescript
    const event = buildActivationCompletedEvent({
      accountId: row.account_id,
      accountCreatedAt: row.account_created_at,
      responseId: row.response_id,
      businessId: row.business_id,
      reviewId: row.review_id,
      postedAt: row.posted_at,
    });
    if (!event) {
      return;
    }

    captureAnalyticsEvent(event);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm vitest run worker/jobs/publisher/__tests__/activation.test.ts`
Expected: PASS — the real builder (not mocked) now produces the event including `uuid`, and the skip/mismatch/no-row cases are unchanged.

- [ ] **Step 7: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && \
git add worker/jobs/publisher/activation.ts worker/jobs/publisher/__tests__/activation.test.ts && \
git commit -m "refactor(publisher): live activation path uses shared builder

Replaces the inline 7-day calc with buildActivationCompletedEvent; the live
event now also carries uuid=response_id for dedup. No behavior change beyond
the added dedup id.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Backfill CLI script

**Files:**
- Create: `scripts/posthog-backfill-activations.ts`

- [ ] **Step 1: Write the script**

Create `scripts/posthog-backfill-activations.ts`:

```typescript
// scripts/posthog-backfill-activations.ts
//
// One-off CLI to backfill historical `activation_completed` events into
// PostHog for accounts that activated before the live capture path started
// emitting (live emits only for accounts created within ~8 days AND only once
// POSTHOG_API_KEY exists in prod).
//
// Each event is stamped at its real `posted_at` and keyed on
// uuid = response_id, so the backfill is idempotent: re-runs and any overlap
// with the live path dedupe in PostHog.
//
// Cross-account by design (operator tool, like src/lib/admin/margin-service.ts).
// Lives in scripts/, which the tenant-scope audit does not scan.
//
// Usage:
//   # Dry run (default): report what WOULD be sent, send nothing.
//   pnpm tsx scripts/posthog-backfill-activations.ts
//   pnpm tsx scripts/posthog-backfill-activations.ts --before 2026-05-28T00:00:00Z
//
//   # Execute: actually send. Requires POSTHOG_API_KEY (and POSTHOG_HOST if EU).
//   pnpm tsx scripts/posthog-backfill-activations.ts --execute --before 2026-05-28T00:00:00Z
//
// Flags:
//   --execute            Actually send events. Default off (dry run).
//   --before <iso>       Only activations with posted_at < cutoff. Default: now.
//                        Set this to roughly when POSTHOG_API_KEY went live to
//                        avoid overlapping the going-forward live path.
//   --limit <n>          Cap candidates processed (accounts). Optional.
//   --account <uuid>     Restrict to a single account. Optional.
//
// Requires: DATABASE_URL (Postgres.js). --execute additionally requires
// POSTHOG_API_KEY.

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { sql } from '../src/lib/db/server';
import { buildActivationCompletedEvent } from '../src/lib/analytics/activation-event';
import {
  captureAnalyticsEvent,
  isAnalyticsConfigured,
  shutdownAnalytics,
} from '../src/lib/analytics/posthog';

interface CandidateRow {
  account_id: string;
  account_created_at: Date | string;
  response_id: string;
  business_id: string;
  review_id: string;
  posted_at: Date | string;
}

function parseCutoff(before: string | undefined): Date {
  if (before === undefined) {
    return new Date();
  }
  const cutoff = new Date(before);
  if (Number.isNaN(cutoff.getTime())) {
    console.error(`Invalid --before value: "${before}". Use an ISO timestamp, e.g. 2026-05-28T00:00:00Z.`);
    process.exit(1);
  }
  return cutoff;
}

function parseLimit(limit: string | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`Invalid --limit value: "${limit}". Use a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      before: { type: 'string' },
      limit: { type: 'string' },
      account: { type: 'string' },
    },
  });

  const execute = values.execute === true;
  const cutoff = parseCutoff(values.before);
  const limit = parseLimit(values.limit);
  const accountId = values.account;

  // No silent success: refuse to --execute when nothing could possibly send.
  if (execute && !isAnalyticsConfigured()) {
    console.error('Refusing to --execute: POSTHOG_API_KEY is unset, so every capture would be a no-op.');
    console.error('Set POSTHOG_API_KEY (and POSTHOG_HOST if EU) before running with --execute.');
    process.exit(1);
  }

  console.log(
    `[posthog-backfill] mode=${execute ? 'EXECUTE' : 'DRY-RUN'} cutoff=${cutoff.toISOString()}` +
      `${limit ? ` limit=${limit}` : ''}${accountId ? ` account=${accountId}` : ''}`,
  );

  const accountFilter = accountId ? sql`AND a.id = ${accountId}::uuid` : sql``;
  const limitClause = limit ? sql`LIMIT ${limit}` : sql``;

  const rows = await sql<CandidateRow[]>`
    SELECT DISTINCT ON (a.id)
      a.id          AS account_id,
      a.created_at  AS account_created_at,
      r.id          AS response_id,
      r.business_id AS business_id,
      r.review_id   AS review_id,
      r.posted_at   AS posted_at
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE r.status = 'posted'
      AND r.posted_at IS NOT NULL
      AND r.posted_at < ${cutoff}
      ${accountFilter}
    ORDER BY a.id, r.posted_at ASC, r.id ASC
    ${limitClause}
  `;

  let eligible = 0;
  let skipped = 0;
  let sent = 0;
  let failed = 0;
  const samples: string[] = [];

  for (const row of rows) {
    const event = buildActivationCompletedEvent({
      accountId: row.account_id,
      accountCreatedAt: row.account_created_at,
      responseId: row.response_id,
      businessId: row.business_id,
      reviewId: row.review_id,
      postedAt: row.posted_at,
    });

    if (!event) {
      skipped++;
      continue;
    }
    eligible++;
    if (samples.length < 10) {
      samples.push(
        `account=${row.account_id} response=${row.response_id} days=${event.properties?.days_to_activation}`,
      );
    }

    if (!execute) {
      continue;
    }

    try {
      const ok = captureAnalyticsEvent({ ...event, timestamp: new Date(row.posted_at) });
      if (ok) {
        sent++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(
        `[posthog-backfill] capture failed for response=${row.response_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (execute) {
    // posthog-node batches in memory; flush before the process exits.
    await shutdownAnalytics();
  }

  console.log(
    `[posthog-backfill] candidates=${rows.length} eligible=${eligible} skipped=${skipped}` +
      `${execute ? ` sent=${sent} failed=${failed}` : ''}`,
  );
  if (samples.length > 0) {
    console.log(`[posthog-backfill] sample (first ${samples.length}):`);
    for (const line of samples) {
      console.log(`  ${line}`);
    }
  }
  if (!execute) {
    console.log(`[posthog-backfill] dry run — nothing sent. Re-run with --execute to send ${eligible} event(s).`);
  }

  // Postgres.js connections persist; force exit so the script terminates.
  process.exit(0);
}

main().catch((err) => {
  console.error('[posthog-backfill] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script typechecks**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm typecheck`
Expected: PASS (no errors). This confirms the Postgres.js fragment composition, `parseArgs` options, and the posthog-node `timestamp`/`uuid` fields all typecheck.

- [ ] **Step 3: No-DB smoke — invalid `--before` exits before any DB call**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm tsx scripts/posthog-backfill-activations.ts --before not-a-date; echo "exit=$?"`
Expected: prints `Invalid --before value: "not-a-date"...` and `exit=1`. (Argument validation runs before the DB query, so this needs no DATABASE_URL.)

- [ ] **Step 4: No-DB smoke — `--execute` without a key is refused**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && POSTHOG_API_KEY= pnpm tsx scripts/posthog-backfill-activations.ts --execute; echo "exit=$?"`
Expected: prints `Refusing to --execute: POSTHOG_API_KEY is unset...` and `exit=1`. (The guard runs before the DB query.)

> Note: a full dry run against a real DB (`pnpm tsx scripts/posthog-backfill-activations.ts`) requires `DATABASE_URL` and is an operator step, not part of CI. The script's logic is covered by the Task 2 builder tests; the script is thin orchestration (entry point) over the tested builder + tested wrapper + a single SQL read.

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && \
git add scripts/posthog-backfill-activations.ts && \
git commit -m "feat(scripts): add posthog-backfill-activations CLI (#83)

Dry-run-by-default, idempotent backfill of historical activation_completed
events. Stamps timestamp=posted_at, uuid=response_id; refuses --execute without
POSTHOG_API_KEY; bounds overlap with the live path via --before.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm lint`
Expected: PASS, 0 errors/warnings.

- [ ] **Step 2: Typecheck**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Full test suite**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm test`
Expected: PASS. Pay attention to `src/lib/analytics/__tests__/posthog.test.ts`, `src/lib/analytics/__tests__/activation-event.test.ts`, and `worker/jobs/publisher/__tests__/activation.test.ts`.

- [ ] **Step 4: Tenant-scope audit**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && pnpm ci:tenant-scope`
Expected: `tenant-scope-audit: passed`. (The backfill SQL is in `scripts/`, which is not scanned; the live-path edit changed no SQL.)

- [ ] **Step 5: Confirm clean tree + summary**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-issue83 && git status --short && git log --oneline origin/main..HEAD`
Expected: clean working tree; commit log shows the spec + 4 implementation commits.

---

## Self-Review

**Spec coverage:**
- Component 1 (`activation-event.ts`) → Task 2. ✓
- Component 2 (`posthog.ts` timestamp/uuid) → Task 1. ✓
- Component 3 (live-path refactor) → Task 3. ✓
- Component 4 (backfill script: flags, query, dry-run/execute, flush, idempotent) → Task 4. ✓
- Component 5 (builder tests + posthog forwarding test) → Tasks 1 & 2. ✓
- Cross-cutting: tenant-scope — corrected; `scripts/` is unscanned, **no** allowlist task (would fail as unused). ✓
- Verification gate → Task 5. ✓

**Placeholder scan:** none — every code/edit step shows full content and exact commands.

**Type consistency:** `buildActivationCompletedEvent` returns `CaptureAnalyticsEventInput | null` (Task 2) which the live path (Task 3) and script (Task 4) consume directly; `ActivationCompletedInput` field names (`accountId`/`accountCreatedAt`/`responseId`/`businessId`/`reviewId`/`postedAt`) are used identically in Tasks 2, 3, and 4; `timestamp`/`uuid` field names match the wrapper (Task 1) and posthog-node `EventMessage`. ✓
