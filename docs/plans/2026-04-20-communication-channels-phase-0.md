# Communication Channels — Phase 0: Dispatcher Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `NotificationWorker` from a hard-coded email sender into a pluggable dispatcher that reads per-business channel enrollments and sends through a `NotificationChannel` interface. No customer-visible behavior changes — email still works for every existing business.

**Architecture:** Introduce `channel_enrollments` table (one row per business-channel pair) + `NotificationChannel` interface (one implementation per transport, email only for now). Dispatcher loops over verified enrollments, per-channel idempotency check + send + delivery recording, channel failures isolated (one bad channel never aborts siblings). `NotificationFailoverPoller` stale branch switches from re-sending to admin-alerting.

**Tech Stack:** TypeScript 5 strict, Postgres 15 (Supabase) with Postgres.js, Vitest for unit tests, existing BullMQ + outbox pattern.

**Context:**

- Spec: `docs/adding-communication-channels.md` §1, §2, §3.1, §3.5
- This is plan **1 of 5** for the communication-channels feature. Phases 1–4 (SMS, Telegram, WhatsApp, owner dashboard) each depend on this refactor.
- Next migration number is **021** (per `.claude/CLAUDE.md` migration inventory).
- Project-specific invariants in `.claude/CLAUDE.md` (Architecture invariants, Key patterns, Lab notes) are binding. In particular: `jsonb()` helper from `src/lib/db/server.ts` for JSONB writes, Node.js native `crypto`, transactional outbox pattern, subscription guard in customer-facing workers.

---

## File Structure

**Create:**

- `supabase/migrations/021_channel_enrollments.sql` — new table + backfill
- `src/lib/notifications/channels/types.ts` — `NotificationChannel` interface, `SendApprovalParams`, `ChannelId` type
- `src/lib/notifications/channels/email-channel.ts` — wraps existing `sendApprovalEmail`
- `src/lib/notifications/channels/index.ts` — `getChannel(id)` factory + re-exports
- `src/lib/notifications/enrollments.ts` — `getVerifiedEnrollments(businessId)` query helper
- `src/lib/notifications/channels/__tests__/email-channel.test.ts`
- `src/lib/notifications/__tests__/enrollments.test.ts`
- `src/lib/approval/__tests__/create-link.test.ts` — new tests for channel-aware helper

**Modify:**

- `src/lib/approval/create-link.ts` — accept `channel` param, channel-scoped revoke, return `approvalLinkId`
- `worker/jobs/NotificationWorker.ts` — refactor into dispatcher loop, calls `createApprovalLink`
- `worker/jobs/NotificationFailoverPoller.ts` — stale branch: alert admin instead of re-sending; query gates on `sent_at`
- `worker/jobs/EngagementAlertWorker.ts` — pass `channel: 'email'` to helper
- `worker/jobs/OnboardingDripWorker.ts` — pass `channel: 'email'` to helper
- `worker/__tests__/NotificationWorker.test.ts` — update for dispatcher, add multi-channel tests
- `worker/__tests__/NotificationFailoverPoller.test.ts` — update stale-branch expectations
- `worker/__tests__/EngagementAlertWorker.test.ts` — mock signature
- `worker/__tests__/OnboardingDripWorker.test.ts` — mock signature
- `src/app/api/settings/route.ts` — remove `notificationPreference` write path
- `src/app/api/settings/__tests__/route.test.ts` — drop obsolete assertion
- `src/app/api/dashboard/route.ts` — remove `notificationPreference` from `DashboardSettings/response`
- `src/app/api/admin/businesses/route.ts` — drop `notification_preference` from INSERT
- `src/app/admin/runbook/page.tsx` — update runbook text

**Preserve (no change needed):**

- `src/lib/notifications/email.ts` — template builders + `sendApprovalEmail` stay as-is; `EmailChannel` calls them

Additional `Modify` entries (also listed in the task detail sections below):

- `src/lib/notifications/delivery.ts` — widen `channel` param type to `ChannelId` (Task 2 Step 2)
- `src/lib/shared/worker-types.ts` — narrow `SendNotificationPayload.failover.reason` to `'all_deliveries_failed'` only (Task 7 Step 4)
- `worker/index.ts` — update `shouldRunFailoverPoller()` to drop the obsolete `RESEND_WEBHOOK_SECRET` gate (Task 7.5)

---

## Task 1: Write migration 021 (channel_enrollments table + backfill email rows)

**Files:**

- Create: `supabase/migrations/021_channel_enrollments.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/021_channel_enrollments.sql
--
-- channel_enrollments: one row per (business, channel) capturing the owner's
-- notification handle per channel plus its lifecycle (pending_verification ->
-- verified -> disabled -> unsubscribed). Backfills one auto-verified email
-- row per existing business from businesses.owner_email.
--
-- IDs are app-generated UUIDv7 per repo convention (migration 002 dropped
-- DB-side UUID defaults on every other table). No DEFAULT on id. The backfill
-- INSERT below uses gen_random_uuid() one-off — acceptable for a historical
-- data migration since production runtime writes are what must obey the
-- convention; these rows will never be inserted again.
--
-- verification_token is stored as SHA-256 hash. Raw token is returned ONCE
-- to admin UI for QR/deep-link generation, never persisted. Same pattern as
-- approval_links.token_hash.
--
-- See docs/adding-communication-channels.md §2 for the full data-model rationale.

CREATE TABLE IF NOT EXISTS channel_enrollments (
  id                              UUID PRIMARY KEY,
  business_id                     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel                         TEXT NOT NULL,
    -- Accepted values: 'email' | 'sms' | 'telegram' | 'whatsapp'
    -- No CHECK constraint on channel; enforced at app layer (mirrors responses.status convention).
  handle                          TEXT,
    -- Email address, E.164 phone, or telegram chat_id. NULL during
    -- 'pending_verification' for Telegram/WhatsApp (handle only becomes
    -- known when the owner taps the deep link and /start <token> arrives).
    -- CHECK below enforces: handle IS NOT NULL whenever status = 'verified'.
  status                          TEXT NOT NULL DEFAULT 'pending_verification',
    -- Accepted: 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed'
  verified_at                     TIMESTAMPTZ,
  disabled_at                     TIMESTAMPTZ,
  unsubscribed_at                 TIMESTAMPTZ,
  unsubscribed_reason             TEXT,
  verification_token_hash         TEXT,
  verification_token_expires_at   TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, channel),
  -- Guardrail: a verified enrollment MUST have a handle (otherwise the
  -- dispatcher has no recipient). pending_verification / disabled /
  -- unsubscribed rows may have NULL handles transiently.
  CHECK (status <> 'verified' OR handle IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_channel_enrollments_business
  ON channel_enrollments(business_id);

CREATE INDEX IF NOT EXISTS idx_channel_enrollments_verify
  ON channel_enrollments(verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;

-- Backfill: every existing business with an email gets an auto-verified email
-- enrollment. verified_at = created_at treats them as already-verified (no
-- re-verification of live customers). gen_random_uuid() is fine for this
-- one-off historical insert; runtime code uses app-generated UUIDv7.
INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
SELECT gen_random_uuid(), id, 'email', owner_email, 'verified', created_at
FROM businesses
WHERE owner_email IS NOT NULL
ON CONFLICT (business_id, channel) DO NOTHING;

-- Deprecation marker. Legacy column stays for one release cycle so any
-- stray read doesn't crash. Drop in migration 022.
COMMENT ON COLUMN businesses.notification_preference IS
  'DEPRECATED: replaced by channel_enrollments. Do not read from this column; will be dropped in migration 022 once all call sites are migrated.';

-- RLS for owner-scoped reads (future owner dashboard).
ALTER TABLE channel_enrollments ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Apply the migration**

Apply via your preferred method — Supabase MCP (`mcp__supabase__apply_migration`), Supabase CLI (`supabase db push`), or the Supabase dashboard SQL editor. The Supabase project ref is in `.env.local` (`SUPABASE_URL`).

- [ ] **Step 3: Verify the table + backfill landed correctly**

Run this query against the DB:

```sql
SELECT
  (SELECT COUNT(*) FROM businesses WHERE owner_email IS NOT NULL) AS businesses_with_email,
  (SELECT COUNT(*) FROM channel_enrollments WHERE channel = 'email' AND status = 'verified') AS enrolled_emails,
  (SELECT COUNT(*) FROM channel_enrollments) AS total_enrollments;
```

Expected: `businesses_with_email == enrolled_emails == total_enrollments`. If they don't match, investigate BEFORE moving on — the rest of the plan assumes every business has an email enrollment row.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/021_channel_enrollments.sql
git commit -m "feat(channels): add channel_enrollments table + backfill email rows

Phase 0 of communication channels refactor. One row per (business, channel)
with per-channel lifecycle. Backfills every existing business with an
auto-verified email enrollment.

See docs/adding-communication-channels.md §2."
```

---

## Task 2: Define the `NotificationChannel` interface + types

**Files:**

- Create: `src/lib/notifications/channels/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/lib/notifications/channels/types.ts
//
// Pluggable transport interface for approval notifications. Mirrors the
// ReviewSource pattern in src/lib/reviews/. Each implementation wraps exactly
// one provider (Resend, Twilio, Telegram Bot API, etc.) and produces a
// deterministic external_message_id for delivery tracking.
//
// See docs/adding-communication-channels.md §1 for rationale.

export type ChannelId = "email" | "sms" | "telegram" | "whatsapp";

export interface SendApprovalParams {
  /** Per-enrollment recipient: email address, E.164 phone, or telegram chat_id. */
  handle: string;
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string;
  responsePreview: string;
  /**
   * Always provided. Link-based channels use this as the message body CTA.
   * Inline-capable channels use it as the "Edit" URL button target.
   * Contains the raw approval token in the URL path — legitimate for URLs
   * (matches existing email flow), but MUST NOT appear in inline-button
   * callback payloads.
   */
  approvalUrl: string;
  /**
   * UUIDv7 of the approval_links row. Used by inline-capable channels
   * (Telegram, WhatsApp) as the button callback payload. Non-secret
   * (74-bit random entropy, not cryptographically sensitive). Safe to
   * persist in inbound_events.payload. See spec §3.2.
   *
   * Supersedes the original plan's `rawToken` field, which would have
   * leaked raw approval tokens into inbound_events via webhook bodies —
   * violating the "approval tokens NEVER stored raw" invariant.
   */
  approvalLinkId: string;
}

export interface SendApprovalResult {
  /** Provider-assigned message ID. Stored in notification_deliveries.external_message_id. */
  externalMessageId: string;
}

export interface NotificationChannel {
  readonly id: ChannelId;
  /** True if the channel supports inline buttons for approve/regenerate. */
  readonly supportsInlineActions: boolean;
  /** True if owner must initiate contact before we can send (Telegram, WhatsApp). */
  readonly requiresOptInHandshake: boolean;
  sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult>;
}
```

- [ ] **Step 2: Widen `recordNotificationDelivery`'s channel type**

The existing `src/lib/notifications/delivery.ts` signature is `channel: 'email' | 'sms'`. The dispatcher in Task 6 will pass `ChannelId` (`'email' | 'sms' | 'telegram' | 'whatsapp'`), which won't compile against the narrower type. Widen it now so Task 6 compiles cleanly even though Phase 0 only exercises `'email'`.

Edit `src/lib/notifications/delivery.ts`:

```typescript
import { v7 as uuidv7 } from "uuid";
import { sql } from "@/lib/db/server";
import type { ChannelId } from "@/lib/notifications/channels/types";

export async function recordNotificationDelivery(params: {
  businessId: string;
  responseId?: string | null;
  channel: ChannelId; // widened from 'email' | 'sms'
  recipient: string;
  template: string;
  externalMessageId: string;
}): Promise<void> {
  await sql`
    INSERT INTO notification_deliveries (id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
    VALUES (
      ${uuidv7()}, ${params.businessId}, ${params.responseId ?? null}, ${params.channel},
      ${params.recipient}, ${params.template}, NOW(), ${params.externalMessageId}
    )
  `;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit`
Expected: no errors related to the new file or the delivery.ts change. (Any unrelated pre-existing errors can be ignored.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/notifications/channels/types.ts src/lib/notifications/delivery.ts
git commit -m "feat(channels): add NotificationChannel types + widen delivery helper channel type"
```

---

## Task 3: Implement `EmailChannel` wrapping existing Resend send (TDD)

**Files:**

- Create: `src/lib/notifications/channels/email-channel.ts`
- Create: `src/lib/notifications/channels/__tests__/email-channel.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/notifications/channels/__tests__/email-channel.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSendApprovalEmail } = vi.hoisted(() => ({
  mockSendApprovalEmail: vi.fn(),
}));

vi.mock("../../email", () => ({
  sendApprovalEmail: mockSendApprovalEmail,
}));

import { EmailChannel } from "../email-channel";

describe("EmailChannel", () => {
  beforeEach(() => {
    mockSendApprovalEmail.mockReset();
    process.env.RESEND_FROM_EMAIL = "RepWorth <notifications@example.com>";
  });

  it("exposes the expected capabilities", () => {
    const ch = new EmailChannel();
    expect(ch.id).toBe("email");
    expect(ch.supportsInlineActions).toBe(false);
    expect(ch.requiresOptInHandshake).toBe(false);
  });

  it("forwards approval params to sendApprovalEmail and returns the messageId", async () => {
    mockSendApprovalEmail.mockResolvedValueOnce({
      messageId: "resend-msg-123",
    });
    const ch = new EmailChannel();

    const result = await ch.sendApprovalRequest({
      handle: "owner@example.com",
      businessName: "Gjelina",
      reviewerName: "Jane",
      starRating: 4,
      reviewText: "Great food",
      reviewDate: "2026-04-01",
      responsePreview: "Thank you Jane!",
      approvalUrl: "https://repworth.example.com/approve/tok-abc",
      approvalLinkId: "019d9f0e-566b-730d-8097-fd67a51559d9",
    });

    expect(result).toEqual({ externalMessageId: "resend-msg-123" });
    expect(mockSendApprovalEmail).toHaveBeenCalledTimes(1);
    expect(mockSendApprovalEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      from: "RepWorth <notifications@example.com>",
      businessName: "Gjelina",
      reviewerName: "Jane",
      starRating: 4,
      reviewText: "Great food",
      reviewDate: "2026-04-01",
      responsePreview: "Thank you Jane!",
      approvalUrl: "https://repworth.example.com/approve/tok-abc",
    });
  });

  it("throws when RESEND_FROM_EMAIL is not set", async () => {
    delete process.env.RESEND_FROM_EMAIL;
    const ch = new EmailChannel();

    await expect(
      ch.sendApprovalRequest({
        handle: "x@y.com",
        businessName: "b",
        reviewerName: "r",
        starRating: 3,
        reviewText: null,
        reviewDate: "2026-04-01",
        responsePreview: "p",
        approvalUrl: "u",
        approvalLinkId: "id-1",
      }),
    ).rejects.toThrow(/RESEND_FROM_EMAIL/);
  });

  it("propagates the underlying Resend error on failure", async () => {
    mockSendApprovalEmail.mockRejectedValueOnce(new Error("Resend 5xx"));
    const ch = new EmailChannel();

    await expect(
      ch.sendApprovalRequest({
        handle: "x@y.com",
        businessName: "b",
        reviewerName: "r",
        starRating: 3,
        reviewText: null,
        reviewDate: "2026-04-01",
        responsePreview: "p",
        approvalUrl: "u",
        approvalLinkId: "id-1",
      }),
    ).rejects.toThrow(/Resend 5xx/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/notifications/channels/__tests__/email-channel.test.ts`
Expected: FAIL — "Cannot find module '../email-channel'" or similar.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/lib/notifications/channels/email-channel.ts
//
// EmailChannel wraps the existing sendApprovalEmail(). All Resend-specific
// logic (template builders, categories, tags) stays in src/lib/notifications/email.ts;
// this class just adapts that call to the NotificationChannel interface.

import { sendApprovalEmail } from "../email";
import type {
  NotificationChannel,
  SendApprovalParams,
  SendApprovalResult,
} from "./types";

export class EmailChannel implements NotificationChannel {
  readonly id = "email" as const;
  readonly supportsInlineActions = false;
  readonly requiresOptInHandshake = false;

  async sendApprovalRequest(
    p: SendApprovalParams,
  ): Promise<SendApprovalResult> {
    const from = process.env.RESEND_FROM_EMAIL;
    if (!from) {
      throw new Error("RESEND_FROM_EMAIL not configured");
    }

    const { messageId } = await sendApprovalEmail({
      to: p.handle,
      from,
      businessName: p.businessName,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      reviewDate: p.reviewDate,
      responsePreview: p.responsePreview,
      approvalUrl: p.approvalUrl,
    });

    return { externalMessageId: messageId };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/notifications/channels/__tests__/email-channel.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/channels/email-channel.ts src/lib/notifications/channels/__tests__/email-channel.test.ts
git commit -m "feat(channels): implement EmailChannel wrapping existing Resend send"
```

---

## Task 4: Channel factory `getChannel(id)` (TDD)

**Files:**

- Create: `src/lib/notifications/channels/index.ts`

- [ ] **Step 1: Add a factory test to the existing email-channel test file**

Append to `src/lib/notifications/channels/__tests__/email-channel.test.ts`:

```typescript
import { getChannel } from "../index";
import type { ChannelId } from "../types";

describe("getChannel factory", () => {
  it('returns an EmailChannel for id "email"', () => {
    const ch = getChannel("email");
    expect(ch.id).toBe("email");
    expect(ch).toBeInstanceOf(EmailChannel);
  });

  it("throws for an unknown channel id", () => {
    expect(() => getChannel("discord" as ChannelId)).toThrow(
      /unknown channel/i,
    );
  });

  it("throws for a not-yet-implemented channel (sms, telegram, whatsapp)", () => {
    for (const id of ["sms", "telegram", "whatsapp"] as const) {
      expect(() => getChannel(id)).toThrow(/not yet implemented/i);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/notifications/channels/__tests__/email-channel.test.ts`
Expected: FAIL — "Cannot find module '../index'".

- [ ] **Step 3: Implement the factory**

```typescript
// src/lib/notifications/channels/index.ts
//
// Channel factory. Each channel implementation is imported lazily-safe
// (top-level imports are fine; the classes themselves don't call provider
// SDKs at construction time). Subsequent phases add SMS / Telegram / WhatsApp
// cases here.

import { EmailChannel } from "./email-channel";
import type { NotificationChannel, ChannelId } from "./types";

export { EmailChannel } from "./email-channel";
export type {
  NotificationChannel,
  ChannelId,
  SendApprovalParams,
  SendApprovalResult,
} from "./types";

const NOT_YET_IMPLEMENTED: ReadonlySet<ChannelId> = new Set([
  "sms",
  "telegram",
  "whatsapp",
]);

export function getChannel(id: ChannelId): NotificationChannel {
  if (id === "email") return new EmailChannel();
  if (NOT_YET_IMPLEMENTED.has(id)) {
    throw new Error(
      `Channel "${id}" not yet implemented — scheduled for a later phase`,
    );
  }
  throw new Error(`Unknown channel "${id}"`);
}
```

- [ ] **Step 4: Run tests — factory tests pass**

Run: `pnpm vitest run src/lib/notifications/channels/__tests__/email-channel.test.ts`
Expected: PASS — all 7 tests green (4 EmailChannel + 3 factory).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/channels/index.ts src/lib/notifications/channels/__tests__/email-channel.test.ts
git commit -m "feat(channels): add getChannel factory with not-yet-implemented guards for sms/telegram/whatsapp"
```

---

## Task 5: Enrollment query helper `getVerifiedEnrollments(businessId)` (TDD)

**Files:**

- Create: `src/lib/notifications/enrollments.ts`
- Create: `src/lib/notifications/__tests__/enrollments.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/notifications/__tests__/enrollments.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });
  return { sqlReturnQueue, mockSql };
});

vi.mock("../../db/server", () => ({
  sql: mockSql,
}));

import { getVerifiedEnrollments } from "../enrollments";

describe("getVerifiedEnrollments", () => {
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    mockSql.mockClear();
  });

  it("returns verified, non-unsubscribed enrollments for the business", async () => {
    sqlReturnQueue.push([
      { channel: "email", handle: "owner@example.com" },
      { channel: "sms", handle: "+15551234567" },
    ]);

    const result = await getVerifiedEnrollments("biz-1");

    expect(result).toEqual([
      { channel: "email", handle: "owner@example.com" },
      { channel: "sms", handle: "+15551234567" },
    ]);
    expect(mockSql).toHaveBeenCalledTimes(1);

    // Sanity-check the query shape — should filter on status='verified' and unsubscribed_at IS NULL.
    const [template] = mockSql.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const queryText = template.join("?");
    expect(queryText).toMatch(/channel_enrollments/);
    expect(queryText).toMatch(/status = 'verified'/);
    expect(queryText).toMatch(/unsubscribed_at IS NULL/);
  });

  it("returns an empty array when no enrollments match", async () => {
    sqlReturnQueue.push([]);
    const result = await getVerifiedEnrollments("biz-with-no-channels");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/notifications/__tests__/enrollments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```typescript
// src/lib/notifications/enrollments.ts
//
// Query helpers for channel_enrollments.

import { sql } from "../db/server";
import type { ChannelId } from "./channels/types";

export interface VerifiedEnrollment {
  channel: ChannelId;
  handle: string;
}

/**
 * Returns all channels the business is currently enrolled on and can receive
 * approval notifications through. Excludes disabled and unsubscribed rows.
 * Order is stable (by created_at ASC) so the dispatcher processes channels
 * in enrollment order — useful for deterministic test + log output.
 */
export async function getVerifiedEnrollments(
  businessId: string,
): Promise<VerifiedEnrollment[]> {
  const rows = await sql<VerifiedEnrollment[]>`
    SELECT channel, handle
    FROM channel_enrollments
    WHERE business_id = ${businessId}
      AND status = 'verified'
      AND unsubscribed_at IS NULL
    ORDER BY created_at ASC
  `;
  return rows;
}
```

- [ ] **Step 4: Run tests — all pass**

Run: `pnpm vitest run src/lib/notifications/__tests__/enrollments.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/enrollments.ts src/lib/notifications/__tests__/enrollments.test.ts
git commit -m "feat(channels): add getVerifiedEnrollments query helper"
```

---

## Task 5.5: Refactor `createApprovalLink` to be channel-aware (TDD)

**Why:** The existing helper at `src/lib/approval/create-link.ts` hardcodes `channel = 'email'` on line 50 and its revoke logic operates on all open links for a response regardless of channel. The dispatcher in Task 6 needs to create one approval_link per channel, so the helper has to accept `channel` and scope both the "orphaned delivery" probe and the revoke statement to the caller's channel — otherwise creating an SMS link would silently revoke the still-valid email link.

Other callers (`EngagementAlertWorker:158`, `OnboardingDripWorker:276`) are email-only nudges and must keep email semantics unchanged — they will pass `channel: 'email'` explicitly once the helper signature changes.

**Files:**

- Modify: `src/lib/approval/create-link.ts`
- Modify: `worker/jobs/EngagementAlertWorker.ts` (update call site)
- Modify: `worker/jobs/OnboardingDripWorker.ts` (update call site)
- Modify: `worker/__tests__/EngagementAlertWorker.test.ts` (mock signature)
- Modify: `worker/__tests__/OnboardingDripWorker.test.ts` (mock signature)
- Create: `src/lib/approval/__tests__/create-link.test.ts` (new — channel-scoped behavior)

- [ ] **Step 1: Write the failing test (channel scoping)**

Create `src/lib/approval/__tests__/create-link.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sqlReturnQueue, mockSql, mockTx, updateCalls, insertCalls } =
  vi.hoisted(() => {
    const sqlReturnQueue: unknown[] = [];
    const updateCalls: string[] = [];
    const insertCalls: Array<Record<string, unknown>> = [];
    const mockTx: any = vi.fn(
      (template: TemplateStringsArray, ...values: unknown[]) => {
        const queryText = template.join("?");
        if (queryText.match(/UPDATE approval_links/i)) {
          updateCalls.push(queryText);
        }
        if (queryText.match(/INSERT INTO approval_links/i)) {
          insertCalls.push({ queryText, values });
        }
        return Promise.resolve([]);
      },
    );
    const mockSql: any = vi.fn((_t: TemplateStringsArray, ..._v: unknown[]) =>
      Promise.resolve(sqlReturnQueue.shift() ?? []),
    );
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
    return { sqlReturnQueue, mockSql, mockTx, updateCalls, insertCalls };
  });

vi.mock("@/lib/db/server", () => ({ sql: mockSql }));
vi.mock("uuid", () => ({ v7: () => "uuid-v7-fixture" }));

import { createApprovalLink } from "../create-link";

describe("createApprovalLink — channel-aware", () => {
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    updateCalls.length = 0;
    insertCalls.length = 0;
    mockSql.mockClear();
    mockSql.begin.mockClear();  // clear sql.begin call history between tests
    mockTx.mockClear();
  });

  it("inserts approval_links row with the provided channel", async () => {
    // orphaned_only check → no prior delivery → revoke fires (no-op anyway)
    sqlReturnQueue.push([]);

    const { rawToken, tokenHash, approvalLinkId } = await createApprovalLink({
      responseId: "resp-1",
      businessId: "biz-1",
      channel: "sms",
    });

    expect(rawToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenHash).toHaveLength(64); // sha256 hex
    expect(approvalLinkId).toBe("uuid-v7-fixture");
    expect(insertCalls).toHaveLength(1);
    const insertQuery = insertCalls[0]!.queryText as string;
    expect(insertQuery).toMatch(/INSERT INTO approval_links/);
    // Channel is passed as a parameter, not hardcoded.
    expect(insertCalls[0]!.values).toContain("sms");
  });

  it("orphaned_only revokes ONLY same-channel non-consumed links", async () => {
    // Delivery check for SMS → empty (no prior SMS delivery) → revoke fires
    sqlReturnQueue.push([]);

    await createApprovalLink({
      responseId: "resp-1",
      businessId: "biz-1",
      channel: "sms",
      revokeMode: "orphaned_only",
    });

    expect(updateCalls).toHaveLength(1);
    // Revoke query must filter by channel — prevents cross-channel revoke.
    expect(updateCalls[0]).toMatch(/channel\s*=/i);
  });

  it("orphaned_only does NOT revoke when a prior same-channel delivery exists", async () => {
    sqlReturnQueue.push([{ id: "prior-delivery-id" }]); // prior delivery → skip revoke

    await createApprovalLink({
      responseId: "resp-1",
      businessId: "biz-1",
      channel: "email",
      revokeMode: "orphaned_only",
    });

    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(1);
  });

  it("always-mode revokes same-channel links unconditionally", async () => {
    // No delivery check is made in 'always' mode — no sql returns needed.
    await createApprovalLink({
      responseId: "resp-1",
      businessId: "biz-1",
      channel: "email",
      revokeMode: "always",
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatch(/channel\s*=/i);
  });
});
```

- [ ] **Step 2: Run the test — fails (helper doesn't accept channel yet)**

Run: `pnpm vitest run src/lib/approval/__tests__/create-link.test.ts`
Expected: FAIL — `channel` not a property on params, or test assertion about `values` containing `'sms'` fails because the impl hardcodes `'email'`.

- [ ] **Step 3: Rewrite the helper**

Replace `src/lib/approval/create-link.ts` entirely with:

```typescript
import { randomUUID, createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { sql } from "@/lib/db/server";
import type { ChannelId } from "@/lib/notifications/channels/types";

/**
 * Creates a fresh approval link for a response on a specific channel.
 *
 * Revoke behavior (scoped to the caller's channel — prevents cross-channel
 * accidents when the dispatcher creates one link per enrolled channel):
 *   'orphaned_only' (default): revoke existing same-channel open links ONLY
 *     if no prior same-channel delivery exists (orphaned from worker crash).
 *   'always': revoke all same-channel open links unconditionally (used by
 *     owner-nudge emails which want a fresh email link each time).
 *
 * Returns the raw token + hash + approval_links row ID. Caller must use the
 * rawToken immediately in a URL and never persist it. approvalLinkId is safe
 * to persist (non-sensitive).
 */
export async function createApprovalLink(params: {
  responseId: string;
  businessId: string;
  channel: ChannelId;
  /** 'orphaned_only' (default): only revoke if no same-channel delivery exists.
   *  'always': revoke all same-channel open links regardless. */
  revokeMode?: "orphaned_only" | "always";
}): Promise<{ rawToken: string; tokenHash: string; approvalLinkId: string }> {
  const { responseId, businessId, channel } = params;
  const rawToken = randomUUID();
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const approvalLinkId = uuidv7();
  const revokeMode = params.revokeMode ?? "orphaned_only";

  let shouldRevoke = revokeMode === "always";
  if (!shouldRevoke && revokeMode === "orphaned_only") {
    const [existingDelivery] = await sql<{ id: string }[]>`
      SELECT id FROM notification_deliveries
      WHERE response_id = ${responseId}
        AND channel = ${channel}
        AND template = 'approval_request'
        AND sent_at IS NOT NULL
      LIMIT 1
    `;
    shouldRevoke = !existingDelivery;
  }

  await sql.begin(async (tx) => {
    if (shouldRevoke) {
      await tx`
        UPDATE approval_links SET revoked_at = NOW()
        WHERE response_id = ${responseId}
          AND channel = ${channel}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > NOW()
      `;
    }

    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
      VALUES (
        ${approvalLinkId}, ${responseId}, ${businessId}, ${tokenHash}, ${channel},
        NOW() + INTERVAL '48 hours'
      )
    `;
  });

  return { rawToken, tokenHash, approvalLinkId };
}
```

- [ ] **Step 4: Update email-only callers to pass `channel: 'email'` explicitly — AND update the matching `toHaveBeenCalledWith` assertions**

In `worker/jobs/EngagementAlertWorker.ts` near line 158, find the `await createApprovalLink({ ... })` call and add `channel: 'email',` to the params object.

In `worker/jobs/OnboardingDripWorker.ts` near line 276, same change.

**Test fixture updates (MUST also be done, or the existing tests will fail with "expected / received" diffs):**

`worker/__tests__/EngagementAlertWorker.test.ts` lines 166 and 167 currently read:
```ts
expect(mockCreateApprovalLink).toHaveBeenCalledWith({ responseId: 'resp-1', businessId: 'biz-1', revokeMode: 'orphaned_only' });
expect(mockCreateApprovalLink).toHaveBeenCalledWith({ responseId: 'resp-2', businessId: 'biz-1', revokeMode: 'orphaned_only' });
```
Change both to include `channel: 'email'`:
```ts
expect(mockCreateApprovalLink).toHaveBeenCalledWith({ responseId: 'resp-1', businessId: 'biz-1', channel: 'email', revokeMode: 'orphaned_only' });
expect(mockCreateApprovalLink).toHaveBeenCalledWith({ responseId: 'resp-2', businessId: 'biz-1', channel: 'email', revokeMode: 'orphaned_only' });
```

`worker/__tests__/OnboardingDripWorker.test.ts` — search for every `toHaveBeenCalledWith` call against `mockCreateApprovalLink` (approximately lines 257–266) and add `channel: 'email'` to each expected object. Typically there are 2–3 such assertions in that file.

Optional (not required for tests to pass since `vi.fn()` is loosely typed): extend `mockCreateApprovalLink.mockResolvedValue(...)` return shape from `{ rawToken, tokenHash }` to `{ rawToken, tokenHash, approvalLinkId: 'id-fixture' }`. Both workers only use `rawToken`, so leaving `approvalLinkId` off is safe — but adding it keeps the mock aligned with the helper's real return type.

- [ ] **Step 5: Run all tests — green**

Run: `pnpm vitest run src/lib/approval/__tests__/ worker/__tests__/EngagementAlertWorker.test.ts worker/__tests__/OnboardingDripWorker.test.ts`
Expected: PASS — new tests green, existing worker tests still green after the minor mock signature update.

- [ ] **Step 6: Commit**

```bash
git add src/lib/approval/create-link.ts src/lib/approval/__tests__/create-link.test.ts worker/jobs/EngagementAlertWorker.ts worker/jobs/OnboardingDripWorker.ts worker/__tests__/EngagementAlertWorker.test.ts worker/__tests__/OnboardingDripWorker.test.ts
git commit -m "refactor(approval): createApprovalLink accepts channel, scopes revoke logic

Prerequisite for the multi-channel dispatcher. Email-only callers
(EngagementAlertWorker, OnboardingDripWorker) pass channel: 'email'
explicitly — behavior unchanged. Revoke logic now filters by channel so
creating an SMS link cannot accidentally revoke a valid email link.

Returns approvalLinkId (UUIDv7 row ID) for use as inline-button callback
payload in Phase 2/3 — replaces the spec's original rawToken-in-payload
design that would have leaked raw tokens to inbound_events."
```

---

## Task 6: Refactor `NotificationWorker` into dispatcher (TDD, biggest task)

This is the core behavioral change. The existing test suite must continue to pass (email-only behavior preserved for current customers), and new tests cover multi-channel dispatch.

**Files:**

- Modify: `worker/jobs/NotificationWorker.ts`
- Modify: `worker/__tests__/NotificationWorker.test.ts`

- [ ] **Step 1: Update existing test mocks to include the enrollments helper**

At the top of `worker/__tests__/NotificationWorker.test.ts`, ADD the following mock alongside the existing `vi.mock` calls (after the `vi.mock('../../src/lib/notifications/email', ...)` block):

```typescript
const { mockGetVerifiedEnrollments, mockGetChannel, mockChannelSend } =
  vi.hoisted(() => ({
    mockGetVerifiedEnrollments: vi.fn(),
    mockGetChannel: vi.fn(),
    mockChannelSend: vi.fn(),
  }));

vi.mock("../../src/lib/notifications/enrollments", () => ({
  getVerifiedEnrollments: mockGetVerifiedEnrollments,
}));

vi.mock("../../src/lib/notifications/channels", () => ({
  getChannel: mockGetChannel,
}));
```

- [ ] **Step 2: Add a helper at the top of the test file for channel stubbing**

Add below `function makeJob()`:

```typescript
function stubEmailChannel(messageId = "resend-msg-123") {
  mockChannelSend.mockResolvedValue({ externalMessageId: messageId });
  mockGetChannel.mockImplementation((id: string) => {
    if (id === "email") {
      return {
        id: "email",
        supportsInlineActions: false,
        requiresOptInHandshake: false,
        sendApprovalRequest: mockChannelSend,
      };
    }
    throw new Error(`channel ${id} not stubbed`);
  });
}

function beforeEachSetup() {
  sqlReturnQueue.length = 0;
  mockSql.mockClear();
  mockTx.mockClear();
  mockMarkOutboxCompleted.mockReset();
  mockMarkOutboxFailed.mockReset();
  mockSendApprovalEmail.mockReset().mockResolvedValue({ messageId: "msg-123" });
  mockGetVerifiedEnrollments.mockReset();
  mockGetChannel.mockReset();
  mockChannelSend.mockReset();
  process.env.RESEND_FROM_EMAIL = "RepWorth <notifications@example.com>";
  process.env.NEXT_PUBLIC_APP_URL = "https://repworth.example.com";
}
```

And replace every existing `beforeEach(() => { ... })` in the file with `beforeEach(beforeEachSetup)`.

- [ ] **Step 3: Update each pre-existing test's SQL return queue to account for enrollments lookup**

The existing test pattern stages SQL return values for: (1) response row, (2) business row, (3) idempotency check, (4) approval link insert. Under the dispatcher, step (3) and (4) now happen **inside the per-channel loop**, and a new enrollments lookup replaces the old `business.notification_preference` path.

For every existing test that currently stages `[responseRow], [businessRow], [existingDeliveryRow], ...`, change the setup to:

```typescript
// At the top of the test, stub the email channel:
stubEmailChannel();
mockGetVerifiedEnrollments.mockResolvedValue([
  { channel: "email", handle: "owner@example.com" },
]);

// Then stage SQL returns for the per-channel loop:
//   1. response row
//   2. business row
//   3. per-channel idempotency check (existing delivery lookup)
//   4. approval_link INSERT returns (empty array — we don't read it back)
//   5. recordNotificationDelivery INSERT (empty)
sqlReturnQueue.push(
  [responseRow],  // 1. response + review SELECT
  [businessRow],  // 2. business SELECT
  [],             // 3. per-channel idempotency SELECT — no prior delivery → proceed
  [],             // 4. createApprovalLink's orphaned_only delivery-check SELECT
  [],             // 5. recordNotificationDelivery INSERT
);
// NOTE: createApprovalLink's sql.begin (UPDATE revoke + INSERT approval_link) goes
// through mockTx, which bypasses sqlReturnQueue entirely. Do NOT add entries for
// those calls — they're not consumed from the queue.
```

Update each of the existing tests (`first send`, `skips on cancelled`, `skips on bounced`, `failover: completes when delivered_at exists`, `failover: re-sends when sent_at but no delivered_at`) to match this new SQL-return ordering. The existing tests remain as ESSENTIAL regression coverage for the email-only path.

- [ ] **Step 4: Add new multi-channel tests to the same file**

Append to `worker/__tests__/NotificationWorker.test.ts`:

```typescript
describe("NotificationWorker — dispatcher (multi-channel)", () => {
  beforeEach(beforeEachSetup);

  it("sends on every verified enrollment sequentially", async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: "email", handle: "owner@example.com" },
      { channel: "sms", handle: "+15551234567" },
    ]);

    // Stub email + SMS channels (SMS stub is inline here for the test; real impl in Phase 1).
    const smsSend = vi
      .fn()
      .mockResolvedValue({ externalMessageId: "twi-msg-1" });
    mockChannelSend.mockResolvedValue({ externalMessageId: "resend-msg-1" });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === "email")
        return {
          id: "email",
          supportsInlineActions: false,
          requiresOptInHandshake: false,
          sendApprovalRequest: mockChannelSend,
        };
      if (id === "sms")
        return {
          id: "sms",
          supportsInlineActions: false,
          requiresOptInHandshake: false,
          sendApprovalRequest: smsSend,
        };
      throw new Error(`unexpected channel ${id}`);
    });

    // SQL return queue: response, business,
    //   per-channel × 2: [idempotency check], [approval_link insert], [delivery insert]
    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],
      [],
      [], // email loop iteration
      [],
      [],
      [], // sms loop iteration
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).toHaveBeenCalledTimes(1); // email
    expect(smsSend).toHaveBeenCalledTimes(1); // sms
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it("throws (for BullMQ retry) when ALL attempted channels fail", async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: "email", handle: "owner@example.com" },
    ]);
    mockChannelSend.mockRejectedValue(new Error("Resend 500"));
    mockGetChannel.mockImplementation((id: string) => {
      if (id === "email")
        return {
          id: "email",
          supportsInlineActions: false,
          requiresOptInHandshake: false,
          sendApprovalRequest: mockChannelSend,
        };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [], // idempotency check — proceed
      [], // approval_link insert
      [], // failed_at insert (catch branch)
    );

    await expect(handleSendNotification(makeJob())).rejects.toThrow(
      /All 1 channel send/,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it("continues to other channels when one channel send throws", async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: "email", handle: "owner@example.com" },
      { channel: "sms", handle: "+15551234567" },
    ]);

    const smsSend = vi.fn().mockRejectedValue(new Error("Twilio 500"));
    mockChannelSend.mockResolvedValue({ externalMessageId: "resend-msg-1" });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === "email")
        return {
          id: "email",
          supportsInlineActions: false,
          requiresOptInHandshake: false,
          sendApprovalRequest: mockChannelSend,
        };
      if (id === "sms")
        return {
          id: "sms",
          supportsInlineActions: false,
          requiresOptInHandshake: false,
          sendApprovalRequest: smsSend,
        };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [],
      [],
      [], // email iteration (succeeds)
      [],
      [],
      [], // sms iteration (fails — failed_at write)
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).toHaveBeenCalledTimes(1);
    expect(smsSend).toHaveBeenCalledTimes(1);
    // Outbox completes even though one channel failed — failover poller handles all-fail case
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it("skips channel when a prior successful delivery already exists (per-channel idempotency)", async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: "email", handle: "owner@example.com" },
    ]);
    stubEmailChannel();

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow()],
      [{ id: "delivery-already-exists" }], // idempotency check HITS
      // no approval_link insert, no delivery insert
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it("skips email channel when owner_email_bounced is true, but still sends on other channels", async () => {
    mockGetVerifiedEnrollments.mockResolvedValue([
      { channel: "email", handle: "owner@example.com" },
      { channel: "sms", handle: "+15551234567" },
    ]);

    const smsSend = vi
      .fn()
      .mockResolvedValue({ externalMessageId: "twi-msg-1" });
    mockChannelSend.mockResolvedValue({ externalMessageId: "resend-msg-1" });
    mockGetChannel.mockImplementation((id: string) => {
      if (id === "email")
        return {
          id: "email",
          supportsInlineActions: false,
          requiresOptInHandshake: false,
          sendApprovalRequest: mockChannelSend,
        };
      if (id === "sms")
        return {
          id: "sms",
          supportsInlineActions: false,
          requiresOptInHandshake: false,
          sendApprovalRequest: smsSend,
        };
      throw new Error(`unexpected channel ${id}`);
    });

    sqlReturnQueue.push(
      [mockResponseRow()],
      [mockBusinessRow({ owner_email_bounced: true })],
      // email is skipped — no idempotency check, no insert, no delivery
      [],
      [],
      [], // sms iteration
    );

    await handleSendNotification(makeJob());

    expect(mockChannelSend).not.toHaveBeenCalled(); // email skipped due to bounce
    expect(smsSend).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });
});
```

Note: `mockBusinessRow` must accept an optional override (if it doesn't already — check the existing helper in the file and extend). Add `owner_email_bounced: false` as the default.

- [ ] **Step 5: Run tests — all fail (intentionally, pre-refactor)**

Run: `pnpm vitest run worker/__tests__/NotificationWorker.test.ts`
Expected: multiple FAILs — existing tests fail because the new mocks aren't used by the worker yet, new tests fail because dispatcher logic doesn't exist.

- [ ] **Step 6: Refactor `worker/jobs/NotificationWorker.ts` into the dispatcher**

Replace the body of `handleSendNotification` entirely. The file should now read:

```typescript
// worker/jobs/NotificationWorker.ts
//
// Dispatcher for approval notifications. Loads per-business channel enrollments
// and sends through a NotificationChannel interface. Channel-level failures are
// isolated (one bad channel does not abort the rest). The failover poller
// handles the all-deliveries-failed case separately.
//
// See docs/adding-communication-channels.md §3.1 for the full flow.

import { v7 as uuidv7 } from "uuid";
import type { Job } from "bullmq";
import { sql } from "../../src/lib/db/server";
import { checkSubscription } from "../../src/lib/shared/subscription-guard";
import {
  markOutboxCompleted,
  markOutboxFailed,
} from "../../src/lib/shared/outbox";
import { recordNotificationDelivery } from "../../src/lib/notifications/delivery";
import { getVerifiedEnrollments } from "../../src/lib/notifications/enrollments";
import { getChannel } from "../../src/lib/notifications/channels";
import type { ChannelId } from "../../src/lib/notifications/channels/types";
import { createApprovalLink } from "../../src/lib/approval/create-link";
import type { SendNotificationPayload } from "../../src/lib/shared/worker-types";
import { createWorkerLogger } from "../../src/lib/shared/logger";

export async function handleSendNotification(
  job: Job<SendNotificationPayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    "[NotificationWorker]",
    job.data.correlation_id,
  );
  const { response_id, business_id } = job.data;
  const outboxId =
    (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── 1. Load response + guard ────────────────────────────────────────
  const [responseRow] = await sql<
    {
      id: string;
      response_text: string;
      status: string;
      resp_business_id: string;
      review_id: string;
      reviewer_name: string;
      star_rating: number;
      review_text: string | null;
      review_date: string;
    }[]
  >`
    SELECT resp.id, resp.response_text, resp.status,
           resp.business_id AS resp_business_id, resp.review_id,
           r.reviewer_name, r.star_rating, r.review_text, r.review_date
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.id = ${response_id}
  `;

  if (!responseRow) {
    logger.warn(`Response ${response_id} not found`);
    await markOutboxFailed(outboxId, "response_not_found");
    return;
  }
  if (responseRow.resp_business_id !== business_id) {
    logger.error(
      `Response ${response_id} belongs to business ${responseRow.resp_business_id}, not ${business_id}`,
    );
    await markOutboxFailed(outboxId, "business_id_mismatch");
    return;
  }
  if (responseRow.status !== "pending_approval") {
    logger.warn(
      `Response ${response_id} is ${responseRow.status}, not pending_approval — skipping`,
    );
    await markOutboxCompleted(outboxId);
    return;
  }

  const [business] = await sql<
    {
      name: string;
      owner_email_bounced: boolean;
      subscription_status: string;
      updated_at: Date;
    }[]
  >`
    SELECT name, owner_email_bounced, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;
  if (!business) {
    logger.warn(`Business ${business_id} not found`);
    await markOutboxFailed(outboxId, "business_not_found");
    return;
  }

  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    "notification",
  );
  if (!subCheck.allowed) {
    logger.log(`Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 2. Load enrolled channels ───────────────────────────────────────
  const enrollments = await getVerifiedEnrollments(business_id);
  if (enrollments.length === 0) {
    logger.warn(
      `Business ${business_id} has no verified channel enrollments — skipping`,
    );
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 3. Failover mode vs normal mode ─────────────────────────────────
  const isFailover = !!(job.data as SendNotificationPayload).failover;

  // ── 4. Per-channel dispatch loop ────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error(
      "NEXT_PUBLIC_APP_URL not set — cannot construct approval URLs",
    );
    await markOutboxFailed(outboxId, "NEXT_PUBLIC_APP_URL not configured");
    return;
  }

  // Track attempted vs succeeded so we preserve BullMQ retry behavior when ALL
  // channels fail (e.g., Resend outage in Phase 0 email-only era). If we
  // silently completed the outbox on total failure, approvals would stall
  // until the failover poller catches up hours later.
  let attempted = 0;
  let succeeded = 0;

  for (const enrollment of enrollments) {
    const channelId: ChannelId = enrollment.channel;

    // 4a. Email-specific: skip when owner's address has hard-bounced.
    //     (Moved here from the old pre-loop check. Other channels have their
    //     own per-channel opt-out via channel_enrollments.unsubscribed_at.)
    if (channelId === "email" && business.owner_email_bounced) {
      logger.log(
        `Email channel skipped for business ${business_id}: owner_email_bounced`,
      );
      continue;
    }

    // 4b. Per-channel idempotency.
    //     In normal mode: skip if any row with sent_at exists (email already went out).
    //     In failover mode: skip only if a delivered_at row exists (email CONFIRMED delivered).
    const idempotencyClause = isFailover
      ? sql`AND delivered_at IS NOT NULL`
      : sql`AND sent_at IS NOT NULL AND failed_at IS NULL`;
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM notification_deliveries
      WHERE response_id = ${response_id}
        AND channel = ${channelId}
        AND template = 'approval_request'
        ${idempotencyClause}
      LIMIT 1
    `;
    if (existing) {
      logger.log(
        `${channelId} channel already has a prior delivery for response ${response_id}, skipping`,
      );
      continue;
    }

    // 4c. Create approval link via the channel-aware helper (handles
    //     raw token, hash, UUIDv7 id, and same-channel orphan revoke in
    //     one transaction). Raw token returned stays in memory only.
    const { rawToken, approvalLinkId } = await createApprovalLink({
      responseId: response_id,
      businessId: business_id,
      channel: channelId,
    });

    // 4d. Build approval URL and send.
    //     approvalUrl contains the raw token (legitimate — matches existing
    //     email-link flow). approvalLinkId is the non-sensitive row ID
    //     that inline-capable channels use as button callback payload.
    const approvalUrl = `${appUrl}/approve/${rawToken}`;
    attempted++;
    let externalMessageId: string;
    try {
      const result = await getChannel(channelId).sendApprovalRequest({
        handle: enrollment.handle,
        businessName: business.name,
        reviewerName: responseRow.reviewer_name,
        starRating: responseRow.star_rating,
        reviewText: responseRow.review_text,
        reviewDate: responseRow.review_date,
        responsePreview: responseRow.response_text,
        approvalUrl,
        approvalLinkId,
      });
      externalMessageId = result.externalMessageId;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        `${channelId} send failed for response ${response_id}: ${reason}`,
      );
      // Record the failure so failover poller can observe it.
      await sql`
        INSERT INTO notification_deliveries
          (id, business_id, response_id, channel, recipient, template, failed_at, failure_reason)
        VALUES (
          ${uuidv7()}, ${business_id}, ${response_id}, ${channelId},
          ${enrollment.handle}, 'approval_request', NOW(), ${`send_error:${reason}`}
        )
      `;
      continue; // next channel — one failure does not abort the rest
    }

    // 4e. Record successful delivery.
    await recordNotificationDelivery({
      businessId: business_id,
      responseId: response_id,
      channel: channelId,
      recipient: enrollment.handle,
      template: "approval_request",
      externalMessageId,
    });
    succeeded++;
    logger.log(
      `${channelId} approval notification sent for response ${response_id} (business ${business_id})`,
    );
  }

  // ── 5. Completion or retry ──────────────────────────────────────────
  // If we attempted at least one channel and ALL of them failed, throw so
  // BullMQ retries the whole job. This preserves today's Resend-outage
  // retry behavior and is essential in Phase 0 (email-only) where a single
  // channel failure == total failure. When later phases add more channels,
  // partial success (>=1 succeeded) correctly marks the outbox complete —
  // the failed channel just won't land, and the failover poller's
  // all-failed branch catches total regressions.
  if (attempted > 0 && succeeded === 0) {
    throw new Error(
      `All ${attempted} channel send(s) failed for response ${response_id}. ` +
        `Failed deliveries recorded. BullMQ will retry.`,
    );
  }

  await markOutboxCompleted(outboxId);
}
```

- [ ] **Step 7: Run tests — existing + new all pass**

Run: `pnpm vitest run worker/__tests__/NotificationWorker.test.ts`
Expected: PASS — all existing tests (email-only regression coverage) plus the 4 new multi-channel tests.

- [ ] **Step 8: Commit**

```bash
git add worker/jobs/NotificationWorker.ts worker/__tests__/NotificationWorker.test.ts
git commit -m "refactor(channels): NotificationWorker -> dispatcher over NotificationChannel

Loads channel_enrollments per business and dispatches one send per verified
enrollment. Per-channel idempotency; failures isolated (one bad channel
does not abort others). Email-only behavior preserved for existing
customers (all currently have exactly one email enrollment).

See docs/adding-communication-channels.md §3.1."
```

---

## Task 7: Update `NotificationFailoverPoller` — stale branch alerts admin instead of re-sending (TDD)

This task also narrows `SendNotificationPayload.failover.reason` and updates the worker tests that still reference the removed `'stale_no_delivery'` reason string — otherwise the removed code path remains type-valid and test-valid in the repo.

**Files:**

- Modify: `src/lib/shared/worker-types.ts` — narrow `failover.reason` union
- Modify: `worker/jobs/NotificationFailoverPoller.ts`
- Modify: `worker/__tests__/NotificationFailoverPoller.test.ts`
- Modify: `worker/__tests__/NotificationWorker.test.ts` (two fixtures at lines 207, 223 reference `'stale_no_delivery'`)

- [ ] **Step 1: Write the new stale-branch test**

Append to `worker/__tests__/NotificationFailoverPoller.test.ts` (or add a new describe block if easier):

```typescript
describe("NotificationFailoverPoller — stale branch (multi-channel era)", () => {
  beforeEach(beforeEachSetup);

  it("sends an admin alert and does NOT queue a new send_notification outbox entry", async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = "admin@repworth.example.com";

    // All-failed query → empty (not this branch)
    sqlReturnQueue.push([]);
    // Stale query → one stuck response
    sqlReturnQueue.push([
      {
        response_id: "resp-stuck-1",
        business_id: "biz-1",
        business_name: "Gjelina",
        reviewer_name: "Jane",
        star_rating: 3,
      },
    ]);
    // 24h dedup check → no prior alert
    sqlReturnQueue.push([]);
    // notification_deliveries insert (alert record) → ignored
    sqlReturnQueue.push([]);

    await runFailoverPollerOnce();

    // sendInternalEmail was called once
    expect(mockSendInternalEmail).toHaveBeenCalledTimes(1);
    expect(mockSendInternalEmail.mock.calls[0][0].to).toBe(
      "admin@repworth.example.com",
    );
    expect(mockSendInternalEmail.mock.calls[0][0].subject).toMatch(
      /unresponsive|no response|approval_responsiveness/i,
    );
    // No outbox INSERT happened (search mockSql calls)
    const outboxInserts = mockSql.mock.calls.filter(
      ([template]: [TemplateStringsArray]) =>
        template.join("").includes("INSERT INTO job_outbox"),
    );
    expect(outboxInserts).toHaveLength(0);
  });

  it("dedups within 24h — does not re-alert the same stuck response", async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = "admin@repworth.example.com";

    sqlReturnQueue.push([]); // all-failed branch
    sqlReturnQueue.push([
      {
        // stale branch — same stuck response
        response_id: "resp-stuck-1",
        business_id: "biz-1",
        business_name: "Gjelina",
        reviewer_name: "Jane",
        star_rating: 3,
      },
    ]);
    sqlReturnQueue.push([{ id: "prior-alert-within-24h" }]); // dedup HITS

    await runFailoverPollerOnce();

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });
});
```

**Prerequisite refactor — explicit steps (the `runFailoverPollerOnce` function does not exist yet):**

1. In `worker/jobs/NotificationFailoverPoller.ts`, rename the internal `async function checkFailedNotifications()` (around line 62) to `export async function runFailoverPollerOnce()`. Update its two call sites inside the module (the `setInterval` callback and the initial kick at the top of `startNotificationFailoverPoller`) to use the new name.

2. **Put the new tests in a separate `describe` block that does NOT use `vi.useFakeTimers()`.** The existing `describe('NotificationFailoverPoller', ...)` block uses fake timers (line ~38) — the two cannot coexist in the same `beforeEach`. Append AFTER the existing block:

   ```ts
   describe('NotificationFailoverPoller — stale branch (multi-channel era)', () => {
     beforeEach(() => {
       vi.clearAllMocks();
       sqlReturnQueue.length = 0;
       mockSendInternalEmail.mockReset();
       process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.example.com';
       // NO vi.useFakeTimers() here — this describe calls runFailoverPollerOnce directly
     });

     // ...the two new tests from Task 7 Step 1 go here...
   });
   ```

3. Import `runFailoverPollerOnce` directly at the top of the test file (`import { runFailoverPollerOnce } from '../jobs/NotificationFailoverPoller'`) and call it synchronously inside each new test — no `vi.advanceTimersByTimeAsync`.

The existing tests in the file remain untouched and continue using the timer-based entry point `startNotificationFailoverPoller`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run worker/__tests__/NotificationFailoverPoller.test.ts`
Expected: FAIL — the poller currently queues outbox entries in the stale branch; the admin-alert path doesn't exist yet.

- [ ] **Step 3: Modify `worker/jobs/NotificationFailoverPoller.ts` — rewrite the stale branch**

Find the section starting with the comment `// ── 2. Stale: pending_approval >4h ...` and replace the entire block (including the `for (const row of staleResponses) { ... }` loop) with:

```typescript
// ── 2. Stale: pending_approval >4h, at least one send attempted, no approval ──
//
// Query gates on sent_at (we tried to notify), NOT delivered_at. Telegram
// Bot API has no "delivered to recipient" callback, and SMS/WhatsApp
// delivery webhooks are unreliable in some regions — gating on
// delivered_at would false-alert on every Telegram-enrolled owner.
//
// Multi-channel era: re-sending has already happened across every enrolled
// channel on initial dispatch. If the owner hasn't approved after 4h on
// ANY channel, resending is unlikely to help — escalate to admin instead.
// See docs/adding-communication-channels.md §3.5.
const staleResponses = await sql<
  {
    response_id: string;
    business_id: string;
    business_name: string;
    reviewer_name: string;
    star_rating: number;
  }[]
>`
      SELECT resp.id AS response_id, resp.business_id,
             b.name AS business_name, r.reviewer_name, r.star_rating
      FROM responses resp
      JOIN businesses b ON resp.business_id = b.id
      JOIN reviews r ON resp.review_id = r.id
      WHERE resp.status = 'pending_approval'
        AND resp.created_at < NOW() - INTERVAL '4 hours'
        AND EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id
            AND nd.template = 'approval_request'
            AND nd.sent_at IS NOT NULL       -- we tried to notify
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'send_notification'
            AND jo.aggregate_id = resp.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
    `;

const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
let alertedCount = 0;
for (const row of staleResponses) {
  if (!adminEmail) {
    console.warn(
      `${LOG_PREFIX} Stuck response ${row.response_id} detected but ADMIN_NOTIFICATION_EMAIL not set — no alert sent`,
    );
    continue;
  }

  // 24h dedup — one alert per stuck response per day.
  const [recentAlert] = await sql<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${row.response_id}
          AND template = 'approval_responsiveness_alert'
          AND recipient = ${adminEmail}
          AND created_at > NOW() - INTERVAL '24 hours'
      `;
  if (recentAlert) continue;

  try {
    const { messageId } = await sendInternalEmail({
      to: adminEmail,
      subject: `Approval stuck: ${row.business_name} — no response in 4+ hours`,
      bodyHtml: `<p>A draft response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong> has been waiting for owner approval for more than 4 hours.</p>
            <p>Every enrolled channel was notified successfully; the owner simply hasn't responded. Consider a check-in call.</p>
            <p><em>Response ID: ${row.response_id}</em></p>`,
      category: "internal",
    });
    await recordNotificationDelivery({
      businessId: row.business_id,
      responseId: row.response_id,
      channel: "email",
      recipient: adminEmail,
      template: "approval_responsiveness_alert",
      externalMessageId: messageId,
    });
    alertedCount++;
  } catch (err) {
    console.error(
      `${LOG_PREFIX} Failed to send responsiveness alert for response ${row.response_id}:`,
      err,
    );
  }
}

if (alertedCount > 0) {
  console.log(
    `${LOG_PREFIX} Sent ${alertedCount} responsiveness alerts (${staleResponses.length} stuck candidates)`,
  );
}
```

- [ ] **Step 4: Narrow `SendNotificationPayload.failover.reason` and fix worker tests**

Edit `src/lib/shared/worker-types.ts` line 32:

```typescript
  /** Present only when re-queued by the NotificationFailoverPoller. */
  failover?: {
    reason: 'all_deliveries_failed';
    // 'stale_no_delivery' was removed in Phase 0 — the poller alerts admin
    // directly instead of re-dispatching. See docs/adding-communication-channels.md §3.5.
  };
```

Update `worker/__tests__/NotificationWorker.test.ts` — locate the two fixtures that do `(job.data as any).failover = { reason: 'stale_no_delivery' as const }` (approximate lines 207 and 223). Change both to `{ reason: 'all_deliveries_failed' as const }`. The test bodies remain valid — they were exercising the failover idempotency logic, which still applies to the `all_deliveries_failed` reason.

- [ ] **Step 5: Clean up dead code in `NotificationWorker.ts`**

In `worker/jobs/NotificationWorker.ts`, find the line `const isFailover = !!(job.data as SendNotificationPayload).failover;` and change it to:

```typescript
// Failover mode is now only entered via the all_deliveries_failed branch.
// The stale_no_delivery branch was removed in Phase 0 — the poller alerts
// admin directly instead of re-dispatching. See docs/adding-communication-channels.md §3.5.
const isFailover = !!(job.data as SendNotificationPayload).failover;
```

- [ ] **Step 6: Run the tests — poller + worker both green**

Run: `pnpm vitest run worker/__tests__/NotificationFailoverPoller.test.ts worker/__tests__/NotificationWorker.test.ts`
Expected: PASS — all tests green including the two new stale-branch tests. TypeScript also accepts the narrowed union.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/worker-types.ts worker/jobs/NotificationFailoverPoller.ts worker/jobs/NotificationWorker.ts worker/__tests__/NotificationFailoverPoller.test.ts worker/__tests__/NotificationWorker.test.ts
git commit -m "refactor(channels): failover poller stale branch -> admin alert (not re-dispatch)

In multi-channel mode, every channel has already been tried on initial
dispatch. 4h+ with no approval on ANY channel means owner is unresponsive —
escalate to sales partner via admin alert with 24h dedup, rather than
re-sending and adding noise.

See docs/adding-communication-channels.md §3.5."
```

---

## Task 7.5: Update `worker/index.ts` failover poller gate

The existing gate at `worker/index.ts:70-86` disables the failover poller when `RESEND_WEBHOOK_SECRET` is unset, because the OLD stale-branch logic depended on `notification_deliveries.delivered_at` (which is set only by the Resend delivery webhook). Task 7 changed that gate to `sent_at`, which the dispatcher writes directly — so the Resend webhook secret is no longer a dependency for stale detection.

Keep the `MOCK_EXTERNAL_APIS` and `NOTIFICATION_FAILOVER_DISABLED` gates (they remain correct). Remove the `RESEND_WEBHOOK_SECRET` gate and update the comment.

**Files:**

- Modify: `worker/index.ts`

- [ ] **Step 1: Update the guard block**

Replace the block at `worker/index.ts:70-86` with:

```typescript
// NotificationFailoverPoller gate (Phase 0 update).
//
// Stale detection now gates on notification_deliveries.sent_at (written by
// the dispatcher on every successful send), not delivered_at — so the
// Resend delivery webhook is no longer a prerequisite. The stale branch
// alerts admin directly instead of re-dispatching, so missing delivery
// webhooks no longer cause email re-send spam.
//
// We still short-circuit in mock mode (no real sends happening) and respect
// the explicit NOTIFICATION_FAILOVER_DISABLED escape hatch for local-dev
// ergonomics. RESEND_WEBHOOK_SECRET is no longer consulted here.
//
// See docs/adding-communication-channels.md §3.5.
function shouldRunFailoverPoller(): { run: boolean; reason?: string } {
  if (process.env.NOTIFICATION_FAILOVER_DISABLED === "true") {
    return { run: false, reason: "NOTIFICATION_FAILOVER_DISABLED=true" };
  }
  if (isMockMode()) {
    return { run: false, reason: "MOCK_EXTERNAL_APIS=true (no real sends)" };
  }
  return { run: true };
}
```

- [ ] **Step 2: Verify compile + smoke**

Run: `pnpm tsc --noEmit`
Expected: clean.

Start the worker locally: `pnpm worker`. Confirm the log line on startup is either:

- `[NotificationFailover] Starting (interval=7200000ms)` when not in mock mode and the disable flag is unset, OR
- `[NotificationFailover] Skipped — MOCK_EXTERNAL_APIS=true (no real sends)` in mock mode.

No more `RESEND_WEBHOOK_SECRET not set (delivery webhooks cannot be verified)` message.

- [ ] **Step 3: Commit**

```bash
git add worker/index.ts
git commit -m "refactor(channels): drop RESEND_WEBHOOK_SECRET gate from failover poller startup

Stale detection now gates on notification_deliveries.sent_at (written by
the dispatcher directly), not delivered_at (Resend webhook). The stale
branch also no longer re-dispatches — it alerts admin with 24h dedup —
so missing delivery webhooks no longer cause spam.

Keeps MOCK_EXTERNAL_APIS + NOTIFICATION_FAILOVER_DISABLED escape hatches.

See docs/adding-communication-channels.md §3.5."
```

---

## Task 8: Remove every `notification_preference` read/write (enumerated)

Second review pass caught 3 additional sites (UI + shared schema) missed by the initial sweep. After this task, NO TypeScript or JSX references `notification_preference` or `notificationPreference` — the column exists only in `businesses` for migration 022 to drop.

**Files touched:**

_Backend:_

- `src/app/api/settings/route.ts` — owner settings PUT
- `src/app/api/dashboard/route.ts` — owner dashboard GET
- `src/app/api/admin/businesses/route.ts` — admin business INSERT
- `src/app/api/settings/__tests__/route.test.ts` — obsolete test assertion

_Shared + UI (newly added after second review):_

- `src/lib/shared/schemas.ts` — Zod enum used by multiple routes
- `src/app/(authenticated)/settings/page.tsx` — owner settings page channel selector
- `src/app/admin/businesses/new/page.tsx` — admin onboarding form channel dropdown

_Docs:_

- `src/app/admin/runbook/page.tsx` — runbook doc text

### Step 1: `src/app/api/settings/route.ts`

Remove the ability for owners to update the legacy preference string via this endpoint. Channel management moves to Phase 4's owner dashboard (dedicated `/dashboard/settings/channels` page that writes to `channel_enrollments`).

- [ ] Open the file. Around line 24, find the `FIELD_TO_COLUMN` map. Remove the line `notificationPreference: 'notification_preference',`.
- [ ] Search the file for `notificationPreference` in the Zod schema (`UpdateSettingsSchema` around line 15). Remove that field from the schema.
- [ ] **Delete the dead SMS/phone validation branch** at lines 74–90 — the `if (data.notificationPreference === 'sms' || data.notificationPreference === 'both')` block that reads `owner_phone` from the database. After the Zod field is removed, `data.notificationPreference` is always `undefined` so this branch is unreachable. Leaving it is harmless at runtime but creates maintenance debt and a stale DB read.
- [ ] Update the test file at `src/app/api/settings/__tests__/route.test.ts`:
    - **Delete the entire `it('returns 200 for updating notification preferences', …)` test block at lines 112–125** — asserts on the removed `notification_preference = $2` query.
    - **Delete the entire `it('returns 400 for invalid notificationPreference value', …)` test block at lines 149–154** — exercises the removed Zod enum; after schema change the field is silently stripped so the test's premise vanishes.
- [ ] Run: `pnpm vitest run src/app/api/settings/__tests__/route.test.ts`
      Expected: remaining tests PASS.

### Step 2: `src/app/api/dashboard/route.ts`

Remove `notificationPreference` entirely from the dashboard response. The owner dashboard page (`src/app/(authenticated)/dashboard`) does not read this field — verified via `rg -n "notificationPreference" src/app/\(authenticated\)/dashboard` returning zero hits. The settings page selector that DID read it is removed in Step 5. No consumer remains.

- [ ] Around line 99, remove `notification_preference` from the `SELECT` column list on the businesses row.
- [ ] Around line 13, remove `notificationPreference: string;` from the `DashboardSettings` (or equivalent) TypeScript type.
- [ ] Around line 303, remove the `notificationPreference: (business.notification_preference as string) ?? 'email',` line from the response object.
- [ ] Run: `rg -n "notificationPreference" src/app/api/dashboard`
      Expected: zero hits.
- [ ] Run: `pnpm vitest run src/app/api/dashboard/`
      Expected: existing tests PASS (adjust any fixture that still asserts on the removed field).

Dropping the field entirely — rather than computing it from `channel_enrollments` — keeps the Phase 0 acceptance gate ("zero `notification_preference` / `notificationPreference` in TS/TSX") internally consistent. Phase 4's owner dashboard is where channel state re-surfaces to the owner UI via a dedicated endpoint.

### Step 3: `src/app/api/admin/businesses/route.ts`

Admin onboarding POST inserts a business with `notification_preference` in the column list. Remove from INSERT; Task 9 below adds the `channel_enrollments` insert in the same transaction.

- [ ] Around line 198, remove `notification_preference,` from the column list in `INSERT INTO businesses ( ... )`.
- [ ] Around line 218 (or wherever the value placeholders align), remove `${data.notificationPreference},` from the VALUES clause.
- [ ] Search the same file for Zod schema / type definitions that require `notificationPreference` on the request body. Remove the field from the request schema — the onboarding form UI may still post it, but the backend will now ignore it silently (safe — it was always `'email'` anyway).
- [ ] Run: `pnpm vitest run src/app/api/admin/businesses/`
      Expected: existing subdirectory tests (prefill, keywords, ranking) all pass — none of them assert on the POST handler's INSERT column list, so dropping `notification_preference` doesn't affect them. There is no existing test for the POST handler itself; Task 9 Step 3 creates it.

### Step 4: `src/lib/shared/schemas.ts`

Line 49: `notificationPreference: z.enum(['email', 'sms', 'both']).default('email'),` lives inside a shared Zod schema used by multiple routes. Remove the field.

- [ ] Open the file, find line 49, remove the `notificationPreference: z.enum(...).default('email'),` line entirely.
- [ ] If any consumer of this schema destructures `notificationPreference`, TypeScript will flag them in the next compile. Update those call sites to stop reading the field (or they are among the routes already handled in Steps 1–3).

### Step 5: `src/app/(authenticated)/settings/page.tsx`

Owner settings page has a channel selector UI (radio group bound to `notificationPreference`). Remove the UI control — channel management moves to Phase 4's dedicated `/dashboard/settings/channels` page.

- [ ] Open the file. Find line 11 `notificationPreference: string;` in the form-state type and remove that property.
- [ ] Find lines 23 and 41 that read/write `notificationPreference` from/to the form state — remove these lines.
- [ ] Find lines 136, 242, 244, 245 — these gate or render the channel selector UI. Delete the entire radio-group block (look for `name="notificationPreference"` and remove its surrounding `<fieldset>`/`<label>`/`<input>` elements).
- [ ] Remove the phone-field conditional on line 136 (`showPhone = ... 'sms' || ... 'both'`) — without the selector, the owner_phone field either always shows or never shows. Leave it visible but optional for now (Phase 1 SMS enrollment will bind the phone properly).

### Step 6: `src/app/admin/businesses/new/page.tsx`

Admin onboarding form has a dropdown for notificationPreference. Remove it — primary-channel choice moves to the mobile-channel verification widgets added in Phases 1–3.

- [ ] Open the file. Find line 25 `notificationPreference: z.enum(['email', 'sms', 'both']),` in the form schema — remove it.
- [ ] Find line 109 `notificationPreference: 'email',` in the form default values — remove it.
- [ ] Find lines 415–417 that render the `<select>` element — delete the whole control and its surrounding label/error wrapper.

### Step 7: `src/app/admin/runbook/page.tsx`

Line 74 references `notification_preference` in an opt-out description.

- [ ] Open the file. Find `'Owner controls opt-outs on /settings. Check weekly_summary_enabled, monthly_impact_enabled, notification_preference columns.'`.
- [ ] Replace with: `'Owner controls opt-outs on /settings. Check weekly_summary_enabled, monthly_impact_enabled, channel_enrollments.status/unsubscribed_at columns.'`.

### Step 8: Verify no reads remain (both casings)

- [ ] Run: `rg -n "notification_preference|notificationPreference" src worker`
      Expected: zero hits in application code. The ONLY acceptable remaining reference is `COMMENT ON COLUMN businesses.notification_preference ...` in the migration file itself.

### Step 9: Run full test suite

- [ ] Run: `pnpm vitest run`
      Expected: all tests green. Frontend type errors (settings page, onboarding form) may surface — fix by removing the now-unused props/fields from test fixtures.

### Step 10: Commit

```bash
git add src/app/api/settings/route.ts src/app/api/settings/__tests__/route.test.ts src/app/api/dashboard/route.ts src/app/api/admin/businesses/route.ts src/app/admin/runbook/page.tsx src/lib/shared/schemas.ts 'src/app/(authenticated)/settings/page.tsx' src/app/admin/businesses/new/page.tsx
git commit -m "refactor(channels): drop all notification_preference reads/writes (backend + UI + shared schema)

Eight call sites surgically updated:
- settings PUT: field removed from writable columns + Zod
- dashboard GET: notificationPreference removed from response
- admin businesses POST: column dropped from INSERT (Task 9 adds enrollment insert)
- shared schemas.ts: Zod enum removed
- owner settings page: channel selector UI removed (moves to Phase 4 dashboard)
- admin onboarding form: notification dropdown removed
- runbook doc: text updated
- settings test: assertion removed

Column stays on businesses table for migration 022 to drop after one
release cycle. Zero production read paths remain in TS/TSX code.

See docs/adding-communication-channels.md §2."
```

---

## Task 9: Add email enrollment insert to existing business-creation transaction

The admin business-creation handler lives at `src/app/api/admin/businesses/route.ts` (there is NO separate `/new/route.ts` — the Next.js route segment handles POST directly). The file already wraps its INSERT in `sql.begin(...)` (verify via grep), so this task ADDS a second INSERT inside that existing transaction — it does NOT add a new transaction boundary.

**Files:**

- Modify: `src/app/api/admin/businesses/route.ts`
- Modify (tests): `src/app/api/admin/businesses/__tests__/route.test.ts` (or similar path — grep to locate the existing test file)

- [ ] **Step 1: Locate the existing transaction**

Run: `rg -n "INSERT INTO businesses|sql.begin" src/app/api/admin/businesses/route.ts`
Expected: find the existing `sql.begin(async (tx) => { ... })` block wrapping an `INSERT INTO businesses` (around line 183 per external review).

- [ ] **Step 2: Add the enrollment insert inside the existing transaction**

Immediately after the existing `INSERT INTO businesses (...)` statement inside the `sql.begin` callback, add the enrollment insert. The route pre-generates `businessId` via `uuidv7()` at the top of the handler (around line 169 in the current file) — that same variable is already the `id` column value on the business insert, so reuse it directly rather than re-reading with `RETURNING`:

```typescript
import { v7 as uuidv7 } from "uuid"; // if not already imported at top of file

// ... inside the existing sql.begin(async (tx) => { ... }) block ...

const enrollmentId = uuidv7();
await tx`
  INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
  VALUES (${enrollmentId}, ${businessId}, 'email', ${data.ownerEmail}, 'verified', NOW())
  ON CONFLICT (business_id, channel) DO NOTHING
`;
```

The `id` column is REQUIRED — migration 021 defines `id UUID PRIMARY KEY` with no default, matching the repo's app-generates-UUIDv7 convention (migration 002). Omitting `id` would raise a NOT NULL violation on every new business.

- [ ] **Step 3: CREATE the admin businesses POST test file (does not exist yet)**

There is NO existing test for the admin business-creation POST handler at `src/app/api/admin/businesses/route.ts` (verified via `Glob src/app/api/admin/businesses/__tests__/*.test.ts` → no files). Create `src/app/api/admin/businesses/__tests__/route.test.ts` fresh, mirroring `src/app/api/feedback/__tests__/route.test.ts` for the hoisted-mock scaffolding — specifically its `sqlProxy` + `txProxy` pair that supports `sql.begin(async (tx) => tx\`...\`)`. The `prefill` test does NOT mock `sql` at all (prefill route doesn't query Postgres directly) and cannot scaffold this POST test.

Minimum coverage for Phase 0:

```typescript
// After hoisted-mock scaffolding:
import { POST } from '../route';

describe('POST /api/admin/businesses — channel enrollment insert', () => {
  beforeEach(() => { /* reset mocks */ });

  it('inserts business + email enrollment inside a single sql.begin transaction', async () => {
    mockRequireRole.mockResolvedValue({ role: 'admin' });
    mockTx.mockResolvedValue([]);

    const req = new NextRequest('http://localhost/api/admin/businesses', {
      method: 'POST',
      body: JSON.stringify({
        /* minimum valid OnboardBusinessSchema payload — look at the Zod
           schema in src/lib/shared/schemas.ts for required fields */
        name: 'Test Biz', category: 'restaurant',
        ownerName: 'Owner', ownerEmail: 'owner@example.com',
        subscriptionTier: 'founding', tone: 'warm_casual',
        googlePlaceId: 'ChIJxxx',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBeLessThan(400);

    const businessInsert = mockTx.mock.calls.find(([t]: [TemplateStringsArray]) =>
      Array.isArray(t) && t.join('').includes('INSERT INTO businesses'),
    );
    const enrollmentInsert = mockTx.mock.calls.find(([t]: [TemplateStringsArray]) =>
      Array.isArray(t) && t.join('').includes('INSERT INTO channel_enrollments'),
    );
    expect(businessInsert).toBeDefined();
    expect(enrollmentInsert).toBeDefined();
    // Both writes happen via the same mockTx → same sql.begin transaction.
  });
});
```

If creating a full POST test feels heavy (the schema validation path is large), an acceptable minimum is to rely entirely on the Task 11 canary for verification and skip Step 3 here — in which case add a one-line note to the acceptance checklist: "No unit test for POST → enrollment insert; covered by Task 11 canary."

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/app/api/admin/businesses/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/businesses/route.ts src/app/api/admin/businesses/__tests__/route.test.ts
git commit -m "feat(channels): onboarding writes verified email enrollment in same txn as business INSERT

Inserted inside the existing sql.begin transaction — single commit, no
dual-write risk. Uses app-generated UUIDv7 for the enrollment id per
repo convention (migration 002 dropped all DB-side UUID defaults).

Replaces the dropped notification_preference write. Email enrollment is
auto-verified (no handshake needed for addresses already on file;
bounces are caught post-send by existing Resend webhook logic)."
```

---

## Task 9.5: Keep email enrollment in sync when admin edits `owner_email`

The admin PATCH route at `src/app/api/admin/businesses/[id]/route.ts` updates `businesses.owner_email` in place when the admin edits the profile. Without this task, the `channel_enrollments` row keeps the OLD email as its `handle`, so future approval notifications continue landing in the previous inbox. Source-of-truth drift.

**Files:**

- Modify: `src/app/api/admin/businesses/[id]/route.ts`
- Modify: existing admin test for this route

- [ ] **Step 1: Understand the existing PATCH pattern**

The current PATCH handler (lines ~270-330) builds a **dynamic UPDATE string** from the `FIELD_TO_COLUMN` map and runs `sql.unsafe(query, values)` at line 319. It checks `result.count === 0` at line 321 to return a 404 when the business ID is unknown. We MUST preserve both behaviors:

1. Keep using `sql.unsafe(...)` (tagged-template dynamic SET isn't how this route works).
2. Keep the 404-on-missing-row guard.
3. Only perform the enrollment upsert AFTER we know the business row was actually updated.

- [ ] **Step 2: Wrap in `sql.begin` and add the enrollment upsert**

Refactor the body of the `try` block to use `sql.begin`, calling `tx.unsafe(...)` instead of `sql.unsafe(...)` so both writes share one transaction. Preserve the 404 check by throwing a sentinel error inside the transaction and catching it after. Pattern:

```typescript
// Import at top of file if not already present:
import { v7 as uuidv7 } from "uuid";

class BusinessNotFoundError extends Error {}

try {
  await sql.begin(async (tx) => {
    const result = await tx.unsafe(query, values);
    if (result.count === 0) {
      throw new BusinessNotFoundError();
    }

    if (data.ownerEmail !== undefined) {
      // Upsert: if the email enrollment row was previously disabled/
      // unsubscribed, a fresh owner_email edit is an explicit admin action
      // to re-enable the channel — refresh to verified state in the same
      // transaction as the business UPDATE.
      await tx`
        INSERT INTO channel_enrollments
          (id, business_id, channel, handle, status, verified_at)
        VALUES
          (${uuidv7()}, ${businessId}, 'email', ${data.ownerEmail}, 'verified', NOW())
        ON CONFLICT (business_id, channel) DO UPDATE SET
          handle              = EXCLUDED.handle,
          status              = 'verified',
          verified_at         = NOW(),
          disabled_at         = NULL,
          unsubscribed_at     = NULL,
          unsubscribed_reason = NULL,
          updated_at          = NOW()
      `;
    }
  });

  return NextResponse.json({ success: true });
} catch (error) {
  if (error instanceof BusinessNotFoundError) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }
  // Duplicate email constraint (users.email or channel_enrollments UNIQUE) —
  // match the POST route's 409 semantics at src/app/api/admin/businesses/route.ts:281-287.
  // MUST come before the generic 500 fallback.
  const pgError = error as { code?: string };
  if (pgError.code === "23505") {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }
  console.error("[api/admin/businesses/[id] PATCH] Failed:", error);
  return NextResponse.json(
    { error: "Failed to update business" },
    { status: 500 },
  );
}
```

The sentinel-error pattern is the only clean way to abort `sql.begin` from inside the callback while still distinguishing "nothing to update, 404" from "transaction failed, 500". Postgres.js rolls back the transaction when the callback throws.

- [ ] **Step 3: CREATE the admin PATCH test file (does not exist yet)**

There is NO existing test at `src/app/api/admin/businesses/[id]/__tests__/route.test.ts` (verified via Glob — the only `[id]`-scoped tests are for `keywords` and `ranking` sub-routes). Create it fresh, mirroring `src/app/api/feedback/__tests__/route.test.ts` for the hoisted-mock scaffolding — specifically its `sqlProxy` + `txProxy` pair that supports both direct `sql\`...\`` calls AND `sql.begin(async (tx) => tx\`...\`)`. The `keywords` test uses a simpler Proxy without `sql.begin` and does not fit this route's needs.

Create `src/app/api/admin/businesses/[id]/__tests__/route.test.ts` with three tests covering the Task 9.5 behavior:

```typescript
// After the hoisted-mock scaffolding:
import { PATCH } from '../route';

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/admin/businesses/biz-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('PATCH /api/admin/businesses/[id] — ownerEmail enrollment sync', () => {
  beforeEach(() => { /* reset mocks */ });

  it('PATCH with ownerEmail upserts channel_enrollments inside same txn', async () => {
    mockRequireRole.mockResolvedValue({ role: 'admin' });
    // First tx call: UPDATE businesses returns result.count = 1
    mockTx.mockImplementationOnce(() => Promise.resolve({ count: 1 }))
          .mockImplementationOnce(() => Promise.resolve([]));

    const res = await PATCH(
      makePatchRequest({ ownerEmail: 'new@example.com' }),
      paramsFor('biz-1'),
    );
    expect(res.status).toBe(200);

    const enrollmentCall = mockTx.mock.calls.find(([template]: [TemplateStringsArray]) =>
      Array.isArray(template) && template.join('').includes('INSERT INTO channel_enrollments'),
    );
    expect(enrollmentCall).toBeDefined();
  });

  it('PATCH without ownerEmail does NOT touch channel_enrollments', async () => {
    mockRequireRole.mockResolvedValue({ role: 'admin' });
    mockTx.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makePatchRequest({ tone: 'formal' }),
      paramsFor('biz-1'),
    );
    expect(res.status).toBe(200);

    const enrollmentCall = mockTx.mock.calls.find(([template]: [TemplateStringsArray]) =>
      Array.isArray(template) && template.join('').includes('INSERT INTO channel_enrollments'),
    );
    expect(enrollmentCall).toBeUndefined();
  });

  it('PATCH on unknown id returns 404 and rolls back (no enrollment upsert)', async () => {
    mockRequireRole.mockResolvedValue({ role: 'admin' });
    mockTx.mockResolvedValue({ count: 0 });

    const res = await PATCH(
      makePatchRequest({ ownerEmail: 'new@example.com' }),
      paramsFor('missing'),
    );
    expect(res.status).toBe(404);
    const enrollmentCall = mockTx.mock.calls.find(([template]: [TemplateStringsArray]) =>
      Array.isArray(template) && template.join('').includes('INSERT INTO channel_enrollments'),
    );
    expect(enrollmentCall).toBeUndefined();
  });
});
```

The 404 test is critical — it verifies the `BusinessNotFoundError` sentinel pattern preserves the existing "no business update = no enrollment change, transaction rolled back" behavior.

- [ ] **Step 4: Smoke-verify `tx.unsafe` behavior (first-use in repo)**

No existing code in this repo calls `tx.unsafe(query, values)` inside `sql.begin` — only top-level `sql.unsafe(...)`. Before committing, verify that Postgres.js's transaction client exposes `unsafe` with the same semantics (returns `{ count }` on UPDATE). Run a throwaway manual smoke:

1. Start the dev DB + worker.
2. `curl -X PATCH http://localhost:3000/api/admin/businesses/<existing-id>` with `{ "tone": "formal" }` (no ownerEmail — just the business UPDATE path).
   Expected: 200. Confirms `tx.unsafe(...)` returns a result with `count === 1`.
3. `curl -X PATCH http://localhost:3000/api/admin/businesses/00000000-0000-0000-0000-000000000000` with `{ "tone": "formal" }`.
   Expected: 404. Confirms the `BusinessNotFoundError` sentinel correctly aborts the transaction.
4. `curl -X PATCH http://localhost:3000/api/admin/businesses/<existing-id>` with `{ "ownerEmail": "test+sync@example.com" }`.
   Expected: 200. Then query DB: `SELECT handle, status, verified_at FROM channel_enrollments WHERE business_id = '<id>' AND channel = 'email'`. Expected: `handle = 'test+sync@example.com'`, `status = 'verified'`, `verified_at` updated to `NOW()`.
5. `curl -X PATCH http://localhost:3000/api/admin/businesses/<existing-id>` with `{ "ownerEmail": "<owner-email-already-owned-by-another-business>" }`.
   Expected: **409** with `"Email already in use"`. Confirms the `23505` handling works inside `sql.begin` and the transaction rolled back (query `channel_enrollments` for the original business — handle should be unchanged from before this curl).

If `tx.unsafe` behaves differently than `sql.unsafe` (returns void, throws, etc.), STOP — report back before continuing. A fallback is to restructure as two separate transactions, but only if necessary.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/app/api/admin/businesses/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/businesses/\[id\]/route.ts src/app/api/admin/businesses/\[id\]/__tests__/route.test.ts
git commit -m "feat(channels): admin owner_email edits keep channel_enrollments in sync

PATCH on businesses upserts the email enrollment row inside the same
transaction, refreshing status to 'verified' and clearing any prior
disabled/unsubscribed flags. Prevents source-of-truth drift between
owner_email and channel_enrollments.handle.

See docs/adding-communication-channels.md §4.1."
```

---

## Task 10: Admin UI — "Channels" section on business detail page

**Files:**

- Modify: `src/app/admin/businesses/[id]/page.tsx` (or equivalent)
- Create: `src/app/api/admin/businesses/[id]/channels/route.ts`

- [ ] **Step 1: Create the read API**

```typescript
// src/app/api/admin/businesses/[id]/channels/route.ts
//
// Uses the existing auth helper at src/lib/db/auth.ts — `requireRole(request, ...roles)`
// throws AuthError on unauthenticated (401) or non-matching role (403).
// Mirrors the auth + dynamic-route pattern in src/app/api/admin/businesses/[id]/route.ts:74
// (Next.js 15: params is a Promise that must be awaited).
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db/server";
import { requireRole, AuthError } from "@/lib/db/auth";

// Admin/customer data — never cache. Matches the pattern in the existing
// admin business detail API at src/app/api/admin/businesses/[id]/route.ts:7.
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: businessId } = await params;

  try {
    await requireRole(request, "admin", "sales_partner");
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await sql<
    {
      channel: string;
      handle: string | null; // nullable: Telegram/WhatsApp pending_verification rows have no handle yet
      status: string;
      verified_at: Date | null;
      disabled_at: Date | null;
      unsubscribed_at: Date | null;
      unsubscribed_reason: string | null;
      last_activity_at: Date | null; // COALESCE(delivered, sent): works for all channels,
      // including Telegram (no delivery webhook) + SMS/WA
      // where delivery callbacks may be missing or delayed.
    }[]
  >`
    SELECT
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      -- Per-row COALESCE (delivered OR sent), THEN aggregate MAX. Doing it
      -- the other way (COALESCE(MAX(delivered), MAX(sent))) would return
      -- the older delivered timestamp when a newer row has only sent_at.
      (SELECT MAX(COALESCE(nd.delivered_at, nd.sent_at))
         FROM notification_deliveries nd
         WHERE nd.business_id = e.business_id
           AND nd.channel = e.channel) AS last_activity_at
    FROM channel_enrollments e
    WHERE e.business_id = ${businessId}
    ORDER BY e.created_at ASC
  `;

  // Mask handles for display (phone/chat_id → partial).
  const masked = rows.map((r) => ({
    ...r,
    handle: maskHandle(r.channel, r.handle),
  }));

  return NextResponse.json({ enrollments: masked });
}

function maskHandle(channel: string, handle: string | null): string {
  if (handle === null) return "(pending verification)";
  if (channel === "email") return handle;
  if (channel === "sms" || channel === "whatsapp") {
    if (handle.length <= 4) return handle;
    return (
      handle.slice(0, 3) + "•".repeat(handle.length - 7) + handle.slice(-4)
    );
  }
  if (channel === "telegram") return "(telegram chat)";
  return handle;
}
```

- [ ] **Step 2: Wire a second useQuery into the admin detail page for enrollments**

The existing `src/app/admin/businesses/[id]/page.tsx:637` already runs one `useQuery<DetailData>` against `/api/admin/businesses/${businessId}`. Add a second, independent query for the new `/channels` endpoint so we don't need to change the existing detail API shape:

```tsx
// Near the existing useQuery in BusinessDetailPage():
const { data: channelsData } = useQuery<{
  enrollments: ChannelEnrollmentRow[];
}>({
  queryKey: ["admin-business-channels", businessId],
  queryFn: async () => {
    const res = await fetch(`/api/admin/businesses/${businessId}/channels`);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(
        (json as { error?: string }).error ?? `HTTP ${res.status}`,
      );
    }
    return res.json() as Promise<{ enrollments: ChannelEnrollmentRow[] }>;
  },
});

const enrollments = channelsData?.enrollments ?? [];
```

Define the `ChannelEnrollmentRow` type near the top of the file:

```tsx
interface ChannelEnrollmentRow {
  channel: "email" | "sms" | "telegram" | "whatsapp";
  handle: string; // server returns masked or "(pending verification)"
  // for NULL-handle rows, so always non-null after maskHandle
  status: "pending_verification" | "verified" | "disabled" | "unsubscribed";
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  last_activity_at: string | null; // COALESCE(delivered_at, sent_at) — last time we
  // either confirmed delivery or attempted a send
}
```

- [ ] **Step 3: Render the section**

Add a new JSX block in the existing detail-page layout (pick a location consistent with the other cards — e.g., alongside the business profile section). Each row: channel name, masked handle, status badge (color-coded), last activity timestamp (latest confirmed delivery or attempted send), unsubscribe reason if present. Include a "Disable" button per row (wired to a PATCH route in a later task — for Phase 0 render it disabled with `title="Manual disable in Phase 1"`).

```tsx
<section className="...card-styles-matching-other-sections...">
  <h2 className="text-lg font-semibold mb-3">Channels</h2>
  {enrollments.length === 0 ? (
    <p className="text-sm text-gray-500">
      No channel enrollments — business cannot receive approval notifications.
    </p>
  ) : (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th className="text-left">Channel</th>
          <th className="text-left">Handle</th>
          <th className="text-left">Status</th>
          <th className="text-left">Last activity</th>
        </tr>
      </thead>
      <tbody>
        {enrollments.map((e) => (
          <tr key={e.channel}>
            <td>{e.channel}</td>
            <td className="font-mono">{e.handle}</td>
            <td>
              <StatusBadge status={e.status} />
            </td>
            <td>
              {e.last_activity_at
                ? new Date(e.last_activity_at).toLocaleString()
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</section>
```

`StatusBadge` can be a trivial local component (colored span by status) or reuse any existing badge utility in the page.

- [ ] **Step 4: Manual smoke — load the admin page for a test business**

Start the dev server (`pnpm dev`) and the worker (`pnpm worker`). Visit `/admin/businesses/<id>` for a real test business. Verify the Channels section renders with one "email" row showing "verified" status.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/businesses/\[id\]/channels/route.ts src/app/admin/businesses/\[id\]/page.tsx
git commit -m "feat(channels): admin business detail — Channels section

Read-only view of every enrollment with masked handles and last-delivered
timestamp. Disable button stubbed for Phase 1."
```

---

## Task 11: End-to-end canary — send an approval email through the new dispatcher against a real test business

**Files:**

- No code changes — this is a verification task.

- [ ] **Step 1: Ensure a test business exists with a verified email enrollment**

Query Supabase (via MCP or dashboard):

```sql
SELECT b.id, b.name, b.owner_email, b.owner_email_bounced, e.status AS email_enrollment_status
FROM businesses b
LEFT JOIN channel_enrollments e ON e.business_id = b.id AND e.channel = 'email'
WHERE b.subscription_status = 'active'
  AND b.owner_email_bounced = false
LIMIT 5;
```

Pick one. If `email_enrollment_status` is NULL the backfill missed it — investigate before proceeding.

- [ ] **Step 2: Generate a pending_approval response for that business**

Either wait for a natural sync cycle, or manually trigger one. `ReviewSyncWorker` reads `business_id`, `google_place_id`, and `correlation_id` from `job.data` (`worker/jobs/ReviewSyncWorker.ts:19`), so the outbox payload must include all three. An empty `{}` payload fails the worker's destructuring.

```sql
-- Substitute actual values from Step 1's query for <business-id>, <place-id>.
-- The worker also reads correlation_id for structured logging; a fresh UUID
-- is fine for a manual canary.
INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
VALUES (
  gen_random_uuid(),
  'sync_reviews',
  'business',
  '<business-id>',
  jsonb_build_object(
    'business_id',      '<business-id>',
    'google_place_id',  '<place-id>',
    'correlation_id',   gen_random_uuid()::text
  ),
  'pending'
);
```

- [ ] **Step 3: Watch the worker log**

The OutboxPoller picks up the sync, ReviewSyncWorker fetches reviews, ResponseGeneratorWorker produces a response, OutboxPoller then dispatches the `send_notification` outbox entry. Expected log line at completion:

```
[NotificationWorker] [<corr-id>] email approval notification sent for response <resp-id> (business <business-id>)
```

- [ ] **Step 4: Verify delivery row in DB**

```sql
SELECT channel, recipient, template, sent_at, external_message_id, failed_at
FROM notification_deliveries
WHERE response_id = '<resp-id>'
ORDER BY sent_at DESC;
```

Expected: one row with `channel='email'`, `template='approval_request'`, `sent_at` populated, `failed_at NULL`, `external_message_id` from Resend.

- [ ] **Step 5: Open the approval link from the received email and approve**

Verifies the downstream flow (approval page, ApprovalService, outbox entry creation for publish) still works end-to-end after the refactor.

- [ ] **Step 6: Commit the canary success as a note**

Not a code commit — add a line under `docs/adding-communication-channels.md` > Phase 0 acceptance:

```
- [x] Canary passed 2026-04-20: email sent + approval flow end-to-end for business <name>
```

Commit:

```bash
git add docs/adding-communication-channels.md
git commit -m "docs(channels): Phase 0 canary verified end-to-end"
```

---

## Acceptance criteria for Phase 0 (gate to Phase 1)

- [ ] `supabase/migrations/021_channel_enrollments.sql` applied; backfill row count matches `businesses WHERE owner_email IS NOT NULL`.
- [ ] `pnpm vitest run` — full test suite green.
- [ ] `rg` shows zero `notification_preference` AND zero `notificationPreference` references in `src` and `worker` (run: `rg -n "notification_preference|notificationPreference" src worker`). Only acceptable remaining reference is the `COMMENT ON COLUMN` line inside the migration file.
- [ ] `NotificationFailoverPoller` stale branch sends admin alert; no `send_notification` outbox entries queued from the stale path.
- [ ] One canary test business has received + approved a real email through the new dispatcher.
- [ ] `/admin/businesses/[id]` "Channels" section renders.
- [ ] No regression in Sentry error rate over the 48h after deploy.

---

## Self-review checklist (for the plan author)

**1. Spec coverage:**

- §1 architecture → Tasks 2, 3, 4
- §2 data model (UUIDv7 convention, hashed verification_token) → Task 1
- §3.1 send path → Tasks 5.5, 6
- §3.2 (inline callback path) uses `approvalLinkId` not raw token → Task 3 (types), Task 5.5 (helper returns it), Task 6 (dispatcher passes it through)
- §3.5 failover poller change (sent_at gate) → Task 7
- Legacy column deprecation → Tasks 1 + 8
- Onboarding rewrite → Task 9
- Admin visibility → Task 10
- Canary → Task 11

§3.2 inline callback INGRESS (signature verify, sender-handle binding, `ApprovalService.approveViaCallback`, payload redaction) lands in Phases 1-3 with the per-channel ingress handlers. Phase 0 provides the interface contract (`approvalLinkId` in button payloads instead of raw tokens) so later phases can't accidentally regress the invariant.

§3.3 (Edit URL button), §3.4 (multi-channel race) are covered conceptually by the dispatcher's per-channel approval_links insert (Task 5.5 + 6); actual inline callback code lands in Phases 1-3.

§4 (enrollment flows for mobile channels) is Phase 1-3 work. The email auto-enrollment in Task 9 is the only §4 piece that lands here.

**2. Placeholder scan:** no TBD / TODO / "add error handling" / "similar to Task N" anywhere. Task 8 enumerates the exact call sites (8 files across backend routes, shared Zod schema, owner settings UI, admin onboarding UI, and the runbook doc) with per-file refactor instructions. ✓

**3. Type consistency:** `ChannelId`, `NotificationChannel`, `SendApprovalParams` (with `approvalLinkId`, NOT `rawToken`), `VerifiedEnrollment`, `getVerifiedEnrollments`, `getChannel`, `createApprovalLink({ channel, revokeMode })` returning `{ rawToken, tokenHash, approvalLinkId }` — used consistently across Tasks 2–6. ✓

**4. Security invariants preserved:**

- Raw approval tokens never appear in inline button payloads (Task 3: `approvalLinkId` field; Task 6: dispatcher passes UUIDv7 row ID).
- Raw verification tokens never persisted (Task 1: `verification_token_hash` column).
- UUIDv7 convention honored (Task 1: no `DEFAULT gen_random_uuid()` on id column).
- Multi-channel revoke logic is channel-scoped (Task 5.5: `createApprovalLink` filters revoke on channel). ✓

**5. Commit hygiene:** one commit per task, meaningful message, no bundled refactor. ✓
