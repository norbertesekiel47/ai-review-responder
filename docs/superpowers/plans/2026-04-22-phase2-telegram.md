# Phase 2 — Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Telegram notification channel for RepWorth — owners get approval requests as Telegram messages with inline Approve/Regenerate buttons (Edit stays as a URL button). Admin-onboarding only. Flag-gated off at merge; flipped on after a real-bot walkthrough.

**Architecture:** New `TelegramChannel` plugs into the existing `NotificationChannel` dispatcher. New `worker/ingress/telegram.ts` handles `/start <token>` enrollment and `callback_query` button taps with Model A ack ordering (ack after cheap validation, before the approval transaction). Four typed link-state errors let the ingress classify permanent failures vs transient. Zero migrations — migration 021 already accommodates telegram handles.

**Tech Stack:** Node.js 20, TypeScript 5 strict, Next.js 14 App Router (admin pages), Fastify (worker), Postgres.js, Vitest. Direct `fetch` to `api.telegram.org` (no SDK). New dependency: `qrcode` for server-side QR data URL rendering.

**Spec reference:** `docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md` — this plan executes that spec. When in doubt, the spec wins.

**Branch:** `feat/channels-telegram` (already created from `main`).

---

## File Structure

| Path | Role |
|------|------|
| `src/lib/approval/errors.ts` | **MODIFY** — add 4 new typed `*LinkError` / `ChannelMismatchError` classes |
| `src/lib/approval/service.ts` | **MODIFY** — add exported `approveViaCallback` + `regenerateViaCallback`, reusing module-private helpers |
| `worker/ingress/shared.ts` | **CREATE** — `claimInboundEvent(source, dedupKey, eventType, payload)` extracted from twilio.ts |
| `worker/ingress/twilio.ts` | **MODIFY** — import claimInboundEvent from shared, remove local copy |
| `src/lib/notifications/channels/telegram-env.ts` | **CREATE** — `assertChannelsTelegramEnv()` for worker startup |
| `src/lib/notifications/channels/telegram-body.ts` | **CREATE** — pure `formatApprovalTelegram(params)` returning `{ text, inline_keyboard }` |
| `src/lib/notifications/channels/telegram-client.ts` | **CREATE** — fetch wrapper + 4 typed error classes (`TelegramRecipientBlockedError`, `TelegramChatNotFoundError`, `TelegramRateLimitError`, `TelegramApiError`) |
| `src/lib/notifications/channels/telegram-channel.ts` | **CREATE** — `TelegramChannel implements NotificationChannel` |
| `src/lib/notifications/channels/index.ts` | **MODIFY** — register `TelegramChannel` in factory with flag gate |
| `worker/ingress/telegram-verify.ts` | **CREATE** — `verifyTelegramSecret(header)` constant-time compare |
| `worker/ingress/telegram.ts` | **CREATE** — Fastify handler: `/start <token>` enrollment + `callback_query` with Model A ack ordering |
| `worker/startup-assert.ts` | **MODIFY** — export `assertChannelsTelegramEnv()` alongside SMS |
| `worker/index.ts` | **MODIFY** — register `POST /ingress/telegram` + call new env assertion |
| `worker/jobs/NotificationWorker.ts` | **MODIFY** — add telegram flag-skip + `TelegramRecipientBlockedError`/`TelegramChatNotFoundError` enrollment-flip branch |
| `src/app/api/admin/channels/telegram/_shared.ts` | **CREATE** — `isTelegramEnabled`, `flagOff` (404), `assertTelegramEnvReady` (503) — mirrors SMS shared |
| `src/app/api/admin/channels/telegram/start/route.ts` | **CREATE** — POST — upsert enrollment per state machine, return `{ deepLink, qrDataUrl, expiresAt }` |
| `src/app/api/admin/channels/telegram/cancel/route.ts` | **CREATE** — POST — clear hash + expiry on pending row |
| `src/app/api/admin/channels/telegram/disable/route.ts` | **CREATE** — POST — flip verified → disabled |
| `src/app/api/admin/businesses/[id]/route.ts` | **MODIFY** — add `telegramEnabled: process.env.CHANNELS_TELEGRAM_ENABLED === 'true'` to response |
| `src/components/admin/TelegramEnrollmentWidget.tsx` | **CREATE** — 5-state UI: idle / generating / awaiting_scan / verified / expired |
| `src/app/admin/businesses/[id]/page.tsx` | **MODIFY** — mount widget in Channels section alongside SMS |
| `.env.example` | **MODIFY** — add 3 telegram env vars |
| `.claude/CLAUDE.md` | **MODIFY** — status update to "Phase 2 Telegram code-complete, flag-gated" |
| `package.json` / `pnpm-lock.yaml` | **MODIFY** — add `qrcode` dependency |

---

## Task 1: Add typed link-state error classes

**Files:**
- Modify: `src/lib/approval/errors.ts`
- Test: `src/lib/approval/__tests__/errors.test.ts` (CREATE)

- [ ] **Step 1: Write failing tests**

Create `src/lib/approval/__tests__/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from '../errors';

describe('link-state typed errors', () => {
  it('ConsumedLinkError has correct name and message', () => {
    const err = new ConsumedLinkError();
    expect(err.name).toBe('ConsumedLinkError');
    expect(err.message).toMatch(/already been used/i);
    expect(err).toBeInstanceOf(Error);
  });

  it('RevokedLinkError has correct name and message', () => {
    const err = new RevokedLinkError();
    expect(err.name).toBe('RevokedLinkError');
    expect(err.message).toMatch(/revoked/i);
    expect(err).toBeInstanceOf(Error);
  });

  it('ExpiredLinkError has correct name and message', () => {
    const err = new ExpiredLinkError();
    expect(err.name).toBe('ExpiredLinkError');
    expect(err.message).toMatch(/expired/i);
    expect(err).toBeInstanceOf(Error);
  });

  it('ChannelMismatchError carries expected and actual channel', () => {
    const err = new ChannelMismatchError('telegram', 'sms');
    expect(err.name).toBe('ChannelMismatchError');
    expect(err.expectedChannel).toBe('telegram');
    expect(err.actualChannel).toBe('sms');
    expect(err.message).toContain('telegram');
    expect(err.message).toContain('sms');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/approval/__tests__/errors.test.ts`
Expected: FAIL — "ConsumedLinkError is not exported from '../errors'"

- [ ] **Step 3: Add the error classes**

Append to `src/lib/approval/errors.ts`:

```ts
export class ConsumedLinkError extends Error {
  constructor() {
    super('This approval link has already been used');
    this.name = 'ConsumedLinkError';
  }
}

export class RevokedLinkError extends Error {
  constructor() {
    super('This approval link has been revoked');
    this.name = 'RevokedLinkError';
  }
}

export class ExpiredLinkError extends Error {
  constructor() {
    super('This approval link has expired');
    this.name = 'ExpiredLinkError';
  }
}

export class ChannelMismatchError extends Error {
  constructor(
    public readonly expectedChannel: string,
    public readonly actualChannel: string,
  ) {
    super(`Approval link channel mismatch — expected ${expectedChannel}, got ${actualChannel}`);
    this.name = 'ChannelMismatchError';
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test src/lib/approval/__tests__/errors.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/approval/errors.ts src/lib/approval/__tests__/errors.test.ts
git commit -m "feat(approval): add link-state typed errors for channel callbacks"
```

---

## Task 2: Extract claimInboundEvent into a shared ingress helper

**Files:**
- Create: `worker/ingress/shared.ts`
- Modify: `worker/ingress/twilio.ts` (drop local copy; import from shared)
- Test: `worker/ingress/__tests__/shared.test.ts` (CREATE)

- [ ] **Step 1: Write the failing test**

Create `worker/ingress/__tests__/shared.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
type Row = Record<string, unknown>;

const mockSql = (async (...args: unknown[]) => {
  void args;
  const next = sqlQueue.shift();
  if (Array.isArray(next)) return next as Row[];
  const arr: Row[] & { count?: number } = [];
  arr.count = typeof next === 'number' ? next : 0;
  return arr;
}) as unknown as {
  (...args: unknown[]): Promise<unknown>;
};

vi.mock('../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

import { claimInboundEvent } from '../shared';

describe('claimInboundEvent', () => {
  beforeEach(() => {
    sqlQueue.length = 0;
  });

  it('returns "claimed" when INSERT lands (count > 0)', async () => {
    sqlQueue.push(1); // INSERT count
    const result = await claimInboundEvent('telegram', 'tg:123', 'callback_query', { a: 1 });
    expect(result).toBe('claimed');
  });

  it('returns "claimed" when reclaim UPDATE matches a stale row', async () => {
    sqlQueue.push(0); // INSERT conflict
    sqlQueue.push([{ id: 'row-1' }]); // reclaim UPDATE returns row
    const result = await claimInboundEvent('telegram', 'tg:456', 'callback_query', {});
    expect(result).toBe('claimed');
  });

  it('returns "duplicate" when both INSERT and reclaim miss', async () => {
    sqlQueue.push(0); // INSERT conflict
    sqlQueue.push([]); // reclaim UPDATE matches nothing
    const result = await claimInboundEvent('telegram', 'tg:789', 'callback_query', {});
    expect(result).toBe('duplicate');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test worker/ingress/__tests__/shared.test.ts`
Expected: FAIL — "Cannot find module '../shared'"

- [ ] **Step 3: Create the shared helper**

Create `worker/ingress/shared.ts`:

```ts
// worker/ingress/shared.ts
//
// Shared ingress primitives used across webhook handlers (Twilio, Telegram, etc.).
// claimInboundEvent dedup pattern originated in worker/ingress/twilio.ts and was
// extracted here when Telegram was added — see docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md §2.

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';

/**
 * Claim an inbound webhook event for exactly-once processing.
 *
 * Returns:
 *   'claimed'   — caller owns processing; proceed with business logic.
 *   'duplicate' — another worker/request already handled this event; return 200 no-op.
 *
 * Reclaim semantics: a row stuck in status='received' for > 2min, or status='failed',
 * is reclaimable — covers worker crashes + transient retry windows.
 */
export async function claimInboundEvent(
  source: string,
  dedupKey: string,
  eventType: string,
  payload: unknown,
): Promise<'claimed' | 'duplicate'> {
  const inserted = await sql`
    INSERT INTO inbound_events (id, source, external_event_key, event_type, payload, status)
    VALUES (${uuidv7()}, ${source}, ${dedupKey}, ${eventType}, ${jsonb(payload)}, 'received')
    ON CONFLICT (external_event_key) DO NOTHING
  ` as unknown as { count: number };

  if (inserted.count !== 0) return 'claimed';

  const reclaimed = await sql<{ id: string }[]>`
    UPDATE inbound_events
    SET received_at = NOW(), status = 'received', error_message = NULL
    WHERE external_event_key = ${dedupKey}
      AND (status = 'failed' OR (status = 'received' AND received_at < NOW() - INTERVAL '2 minutes'))
    RETURNING id
  `;
  return reclaimed.length > 0 ? 'claimed' : 'duplicate';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test worker/ingress/__tests__/shared.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Refactor twilio.ts to use the shared helper**

In `worker/ingress/twilio.ts`:

1. Remove the local `claimInboundEvent` function (lines ~25–57 — the export and its doc comment).
2. Add the import at the top of the file alongside other worker imports:

```ts
import { claimInboundEvent } from './shared';
```

3. The two call sites (`handleTwilioStatusCallback`, `handleTwilioInbound`) already call `claimInboundEvent(dedupKey, eventType, payload)` — update both to pass `'twilio'` as the first argument:

```ts
// BEFORE
const claim = await claimInboundEvent(dedupKey, eventType, payload);
// AFTER
const claim = await claimInboundEvent('twilio', dedupKey, eventType, payload);
```

- [ ] **Step 6: Run the Twilio ingress tests to confirm no regression**

Run: `pnpm test worker/ingress/__tests__/`
Expected: PASS (all existing Twilio tests still pass — pure refactor).

- [ ] **Step 7: Commit**

```bash
git add worker/ingress/shared.ts worker/ingress/twilio.ts worker/ingress/__tests__/shared.test.ts
git commit -m "refactor(ingress): extract claimInboundEvent to shared helper with source param"
```

---

## Task 3: Add Telegram env assertion

**Files:**
- Modify: `worker/startup-assert.ts`
- Test: `worker/__tests__/startup-assertion.test.ts` (MODIFY — add describe block)

- [ ] **Step 1: Write failing tests**

Append to `worker/__tests__/startup-assertion.test.ts`:

```ts
import { assertChannelsTelegramEnv } from '../startup-assert';

describe('assertChannelsTelegramEnv', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.MOCK_EXTERNAL_APIS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is a no-op when flag is off', () => {
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });

  it('is a no-op when MOCK_EXTERNAL_APIS=true even with flag on', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });

  it('throws with all missing vars when flag is on and env is empty', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    expect(() => assertChannelsTelegramEnv()).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => assertChannelsTelegramEnv()).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('passes when flag is on and all required vars are set', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-at-least-32-bytes-long-XXXXXXXXXXXXX';
    expect(() => assertChannelsTelegramEnv()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test worker/__tests__/startup-assertion.test.ts`
Expected: FAIL — "assertChannelsTelegramEnv is not exported"

- [ ] **Step 3: Add the assertion function**

Append to `worker/startup-assert.ts`:

```ts
/**
 * Boot-time assertion. When CHANNELS_TELEGRAM_ENABLED=true, verifies all required
 * Telegram env vars are set. Fail fast at startup rather than on first webhook.
 * No-op when the flag is off or MOCK_EXTERNAL_APIS=true.
 */
export function assertChannelsTelegramEnv(): void {
  if (process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(`CHANNELS_TELEGRAM_ENABLED=true but missing required env vars: ${missing.join(', ')}`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test worker/__tests__/startup-assertion.test.ts`
Expected: PASS (all tests, including the 4 new Telegram ones)

- [ ] **Step 5: Commit**

```bash
git add worker/startup-assert.ts worker/__tests__/startup-assertion.test.ts
git commit -m "feat(channels): add Telegram env assertion for worker startup"
```

---

## Task 4: Telegram body formatter (pure function)

**Files:**
- Create: `src/lib/notifications/channels/telegram-body.ts`
- Test: `src/lib/notifications/channels/__tests__/telegram-body.test.ts` (CREATE)

- [ ] **Step 1: Write failing tests**

Create `src/lib/notifications/channels/__tests__/telegram-body.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatApprovalTelegram } from '../telegram-body';

function sample(overrides: Partial<Parameters<typeof formatApprovalTelegram>[0]> = {}) {
  return {
    businessName: 'Acme Auto',
    reviewerName: 'Jane Doe',
    starRating: 3,
    reviewText: 'Service was okay.',
    reviewDate: '2026-04-15',
    responsePreview: 'Thanks for your feedback, Jane.',
    approvalUrl: 'https://app.repworth.net/approve/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    approvalLinkId: '01932b55-5555-7f60-9abc-abcdefabcdef',
    ...overrides,
  };
}

describe('formatApprovalTelegram', () => {
  it('returns text containing business name, star rating, and reviewer', () => {
    const { text } = formatApprovalTelegram(sample());
    expect(text).toContain('Acme Auto');
    expect(text).toContain('Jane Doe');
    expect(text).toContain('⭐3');
  });

  it('HTML-escapes special chars in reviewer name and business name', () => {
    const { text } = formatApprovalTelegram(
      sample({ reviewerName: 'Tom & Jerry <>', businessName: 'A & B' }),
    );
    expect(text).toContain('Tom &amp; Jerry &lt;&gt;');
    expect(text).toContain('A &amp; B');
    expect(text).not.toContain('<>');
  });

  it('handles null reviewText gracefully', () => {
    const { text } = formatApprovalTelegram(sample({ reviewText: null }));
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('truncates long reviewText to under 400 chars with ellipsis', () => {
    const long = 'x'.repeat(800);
    const { text } = formatApprovalTelegram(sample({ reviewText: long }));
    // The embedded block should be truncated — confirm it contains ellipsis
    // and the number of x's in text is well under 800.
    const xCount = (text.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThan(500);
    expect(text).toMatch(/…|\.\.\./);
  });

  it('inline_keyboard has exactly 3 buttons in 2 rows: approve/regenerate then edit URL', () => {
    const { inline_keyboard } = formatApprovalTelegram(sample());
    expect(inline_keyboard).toHaveLength(2);
    expect(inline_keyboard[0]).toHaveLength(2);
    expect(inline_keyboard[1]).toHaveLength(1);
    expect(inline_keyboard[0][0]).toMatchObject({ callback_data: expect.stringMatching(/^a:/) });
    expect(inline_keyboard[0][1]).toMatchObject({ callback_data: expect.stringMatching(/^r:/) });
    expect(inline_keyboard[1][0]).toMatchObject({ url: expect.stringContaining('/approve/') });
  });

  it('callback_data is within Telegram 64-byte limit', () => {
    const { inline_keyboard } = formatApprovalTelegram(sample());
    const approveData = inline_keyboard[0][0].callback_data!;
    const regenData = inline_keyboard[0][1].callback_data!;
    expect(Buffer.byteLength(approveData, 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(regenData, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('callback_data embeds the approvalLinkId', () => {
    const id = '01932b55-5555-7f60-9abc-abcdefabcdef';
    const { inline_keyboard } = formatApprovalTelegram(sample({ approvalLinkId: id }));
    expect(inline_keyboard[0][0].callback_data).toBe(`a:${id}`);
    expect(inline_keyboard[0][1].callback_data).toBe(`r:${id}`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/notifications/channels/__tests__/telegram-body.test.ts`
Expected: FAIL — "Cannot find module '../telegram-body'"

- [ ] **Step 3: Implement the formatter**

Create `src/lib/notifications/channels/telegram-body.ts`:

```ts
// src/lib/notifications/channels/telegram-body.ts
//
// Pure formatter for Telegram approval messages. No side effects — unit-testable
// without a network. HTML parse mode is used, so every dynamic field is escaped.

export interface TelegramApprovalParams {
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string;
  responsePreview: string;
  approvalUrl: string;
  approvalLinkId: string;
}

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface FormattedApprovalMessage {
  text: string;
  inline_keyboard: TelegramInlineButton[][];
}

const MAX_EMBED = 400;

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  return raw.slice(0, max - 1) + '…';
}

export function formatApprovalTelegram(p: TelegramApprovalParams): FormattedApprovalMessage {
  const business = escapeHtml(p.businessName);
  const reviewer = escapeHtml(p.reviewerName);
  const reviewBody = p.reviewText ? escapeHtml(truncate(p.reviewText, MAX_EMBED)) : '(no review text)';
  const preview = escapeHtml(truncate(p.responsePreview, MAX_EMBED));

  const text = [
    `<b>New ⭐${p.starRating} review — ${business}</b>`,
    `From: ${reviewer} · ${p.reviewDate}`,
    `—`,
    `"${reviewBody}"`,
    `—`,
    `<b>Draft reply:</b>`,
    preview,
  ].join('\n');

  const inline_keyboard: TelegramInlineButton[][] = [
    [
      { text: '✅ Approve', callback_data: `a:${p.approvalLinkId}` },
      { text: '🔄 Regenerate', callback_data: `r:${p.approvalLinkId}` },
    ],
    [{ text: '✏️ Edit / view full', url: p.approvalUrl }],
  ];

  return { text, inline_keyboard };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/lib/notifications/channels/__tests__/telegram-body.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/channels/telegram-body.ts src/lib/notifications/channels/__tests__/telegram-body.test.ts
git commit -m "feat(channels): telegram body formatter with HTML escape + inline keyboard"
```

---

## Task 5: Telegram Bot API client + error classification

**Files:**
- Create: `src/lib/notifications/channels/telegram-client.ts`
- Test: `src/lib/notifications/channels/__tests__/telegram-client.test.ts` (CREATE)

- [ ] **Step 1: Write failing tests**

Create `src/lib/notifications/channels/__tests__/telegram-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TelegramClient,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
  TelegramRateLimitError,
  TelegramApiError,
} from '../telegram-client';

describe('TelegramClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });

  it('sendMessage calls correct URL with token and returns message_id on success', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 123 } } }),
        { status: 200 }),
    );
    const client = new TelegramClient();
    const result = await client.sendMessage({ chat_id: '123', text: 'hi' });
    expect(result.message_id).toBe(42);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('maps 403 bot_blocked to TelegramRecipientBlockedError', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
        { status: 403 }),
    );
    const client = new TelegramClient();
    await expect(client.sendMessage({ chat_id: '1', text: 'x' })).rejects.toBeInstanceOf(TelegramRecipientBlockedError);
  });

  it('maps 400 chat not found to TelegramChatNotFoundError', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
        { status: 400 }),
    );
    const client = new TelegramClient();
    await expect(client.sendMessage({ chat_id: '1', text: 'x' })).rejects.toBeInstanceOf(TelegramChatNotFoundError);
  });

  it('maps 429 with retry_after to TelegramRateLimitError', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 30 } }),
        { status: 429 }),
    );
    const client = new TelegramClient();
    try {
      await client.sendMessage({ chat_id: '1', text: 'x' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramRateLimitError);
      expect((err as TelegramRateLimitError).retryAfterSeconds).toBe(30);
    }
  });

  it('maps other errors to TelegramApiError with description', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 500, description: 'Internal server error' }),
        { status: 500 }),
    );
    const client = new TelegramClient();
    await expect(client.sendMessage({ chat_id: '1', text: 'x' })).rejects.toThrow(/Internal server error/);
  });

  it('editMessageReplyMarkup posts with empty keyboard correctly', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    const client = new TelegramClient();
    await client.editMessageReplyMarkup({ chat_id: '1', message_id: 99, reply_markup: { inline_keyboard: [] } });
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.reply_markup.inline_keyboard).toEqual([]);
  });

  it('answerCallbackQuery accepts optional text', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    const client = new TelegramClient();
    await client.answerCallbackQuery({ callback_query_id: 'cb1', text: 'Approving…' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.callback_query_id).toBe('cb1');
    expect(body.text).toBe('Approving…');
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `pnpm test src/lib/notifications/channels/__tests__/telegram-client.test.ts`
Expected: FAIL — "Cannot find module '../telegram-client'"

- [ ] **Step 3: Implement client + error classes**

Create `src/lib/notifications/channels/telegram-client.ts`:

```ts
// src/lib/notifications/channels/telegram-client.ts
//
// Thin fetch wrapper over the Telegram Bot API. Only the 4 methods we use.
// Typed error classes let callers (TelegramChannel, the ingress handler) do
// pattern matching without parsing Telegram's description strings twice.

export class TelegramRecipientBlockedError extends Error {
  constructor() { super('telegram_recipient_blocked'); this.name = 'TelegramRecipientBlockedError'; }
}

export class TelegramChatNotFoundError extends Error {
  constructor() { super('telegram_chat_not_found'); this.name = 'TelegramChatNotFoundError'; }
}

export class TelegramRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`telegram_rate_limited retry_after=${retryAfterSeconds}`);
    this.name = 'TelegramRateLimitError';
  }
}

export class TelegramApiError extends Error {
  constructor(public readonly errorCode: number, public readonly description: string) {
    super(`telegram_api_error code=${errorCode}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface SendMessageParams {
  chat_id: string;
  text: string;
  reply_markup?: unknown;
  parse_mode?: 'HTML' | 'Markdown';
  disable_web_page_preview?: boolean;
}

interface SendMessageResult {
  message_id: number;
  chat: { id: number };
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(botToken: string = process.env.TELEGRAM_BOT_TOKEN ?? '') {
    if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await res.json()) as TelegramResponse<T>;
    if (payload.ok && payload.result !== undefined) return payload.result;
    const code = payload.error_code ?? res.status;
    const desc = payload.description ?? 'unknown telegram error';
    if (code === 403 && /blocked/i.test(desc)) throw new TelegramRecipientBlockedError();
    if (code === 400 && /chat not found/i.test(desc)) throw new TelegramChatNotFoundError();
    if (code === 429) {
      const retry = payload.parameters?.retry_after ?? 1;
      throw new TelegramRateLimitError(retry);
    }
    throw new TelegramApiError(code, desc);
  }

  async sendMessage(p: SendMessageParams): Promise<SendMessageResult> {
    return this.call<SendMessageResult>('sendMessage', {
      chat_id: p.chat_id,
      text: p.text,
      parse_mode: p.parse_mode ?? 'HTML',
      disable_web_page_preview: p.disable_web_page_preview ?? true,
      reply_markup: p.reply_markup,
    });
  }

  async editMessageText(p: { chat_id: string; message_id: number; text: string }): Promise<boolean> {
    return this.call<boolean>('editMessageText', {
      chat_id: p.chat_id,
      message_id: p.message_id,
      text: p.text,
      parse_mode: 'HTML',
    });
  }

  async editMessageReplyMarkup(p: { chat_id: string; message_id: number; reply_markup: { inline_keyboard: unknown[][] } }): Promise<boolean> {
    return this.call<boolean>('editMessageReplyMarkup', {
      chat_id: p.chat_id,
      message_id: p.message_id,
      reply_markup: p.reply_markup,
    });
  }

  async answerCallbackQuery(p: { callback_query_id: string; text?: string }): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: p.callback_query_id,
      text: p.text,
    });
  }
}
```

- [ ] **Step 4: Run tests — pass**

Run: `pnpm test src/lib/notifications/channels/__tests__/telegram-client.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/channels/telegram-client.ts src/lib/notifications/channels/__tests__/telegram-client.test.ts
git commit -m "feat(channels): Telegram Bot API client with typed error classification"
```

---

## Task 6: TelegramChannel (implements NotificationChannel)

**Files:**
- Create: `src/lib/notifications/channels/telegram-channel.ts`
- Modify: `src/lib/notifications/channels/index.ts` (factory registration)
- Test: `src/lib/notifications/channels/__tests__/telegram-channel.test.ts` (CREATE)
- Test: `src/lib/notifications/channels/__tests__/factory.test.ts` (MODIFY — add telegram cases)

- [ ] **Step 1: Write failing tests**

Create `src/lib/notifications/channels/__tests__/telegram-channel.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendMessage } = vi.hoisted(() => ({ mockSendMessage: vi.fn() }));

vi.mock('../telegram-client', async () => {
  const actual = await vi.importActual<typeof import('../telegram-client')>('../telegram-client');
  return {
    ...actual,
    TelegramClient: vi.fn(() => ({ sendMessage: mockSendMessage })),
  };
});

import { TelegramChannel } from '../telegram-channel';

function sampleParams() {
  return {
    handle: '123456789',
    businessName: 'Acme',
    reviewerName: 'Jane',
    starRating: 4,
    reviewText: 'Nice',
    reviewDate: '2026-04-15',
    responsePreview: 'Thanks!',
    approvalUrl: 'https://app.repworth.net/approve/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    approvalLinkId: '01932b55-5555-7f60-9abc-abcdefabcdef',
  };
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
  });

  it('exposes the correct NotificationChannel identity flags', () => {
    const ch = new TelegramChannel();
    expect(ch.id).toBe('telegram');
    expect(ch.supportsInlineActions).toBe(true);
    expect(ch.requiresOptInHandshake).toBe(true);
  });

  it('returns externalMessageId formatted as chat_id:message_id', async () => {
    mockSendMessage.mockResolvedValueOnce({ message_id: 77, chat: { id: 123456789 } });
    const result = await new TelegramChannel().sendApprovalRequest(sampleParams());
    expect(result.externalMessageId).toBe('123456789:77');
  });

  it('passes chat_id from handle and includes inline_keyboard in reply_markup', async () => {
    mockSendMessage.mockResolvedValueOnce({ message_id: 1, chat: { id: 1 } });
    await new TelegramChannel().sendApprovalRequest(sampleParams());
    const [[args]] = mockSendMessage.mock.calls;
    expect(args.chat_id).toBe('123456789');
    expect(args.reply_markup.inline_keyboard).toBeDefined();
    expect(args.reply_markup.inline_keyboard[0]).toHaveLength(2);
    expect(args.reply_markup.inline_keyboard[1]).toHaveLength(1);
  });

  it('propagates TelegramRecipientBlockedError from client', async () => {
    const { TelegramRecipientBlockedError } = await import('../telegram-client');
    mockSendMessage.mockRejectedValueOnce(new TelegramRecipientBlockedError());
    await expect(new TelegramChannel().sendApprovalRequest(sampleParams()))
      .rejects.toBeInstanceOf(TelegramRecipientBlockedError);
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `pnpm test src/lib/notifications/channels/__tests__/telegram-channel.test.ts`
Expected: FAIL — "Cannot find module '../telegram-channel'"

- [ ] **Step 3: Implement TelegramChannel**

Create `src/lib/notifications/channels/telegram-channel.ts`:

```ts
// src/lib/notifications/channels/telegram-channel.ts
//
// NotificationChannel implementation for Telegram.
//
// Cross-cutting concerns live in the dispatcher:
//   - Dispatcher classifies TelegramRecipientBlockedError → flip enrollment unsubscribed
//   - Dispatcher classifies TelegramChatNotFoundError → flip enrollment disabled
// This class only owns:
//   - Format the message (telegram-body.ts)
//   - Call Bot API sendMessage (telegram-client.ts)

import { formatApprovalTelegram } from './telegram-body';
import { TelegramClient } from './telegram-client';
import type { NotificationChannel, ChannelId, SendApprovalParams, SendApprovalResult } from './types';

export class TelegramChannel implements NotificationChannel {
  readonly id: ChannelId = 'telegram';
  readonly supportsInlineActions = true;
  readonly requiresOptInHandshake = true;

  async sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult> {
    const { text, inline_keyboard } = formatApprovalTelegram({
      businessName: p.businessName,
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      reviewText: p.reviewText,
      reviewDate: p.reviewDate,
      responsePreview: p.responsePreview,
      approvalUrl: p.approvalUrl,
      approvalLinkId: p.approvalLinkId,
    });
    const client = new TelegramClient();
    const result = await client.sendMessage({
      chat_id: p.handle,
      text,
      reply_markup: { inline_keyboard },
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return { externalMessageId: `${result.chat.id}:${result.message_id}` };
  }
}
```

- [ ] **Step 4: Run TelegramChannel tests — pass**

Run: `pnpm test src/lib/notifications/channels/__tests__/telegram-channel.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Register in factory + add factory tests**

In `src/lib/notifications/channels/index.ts`:

```ts
import type { NotificationChannel, ChannelId } from './types';

export { EmailChannel } from './email-channel';
export { SmsChannel, SmsRecipientUnsubscribedError } from './sms-channel';
export { TelegramChannel } from './telegram-channel';
export {
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
  TelegramRateLimitError,
  TelegramApiError,
} from './telegram-client';
export type { NotificationChannel, ChannelId, SendApprovalParams, SendApprovalResult } from './types';

import { EmailChannel } from './email-channel';
import { SmsChannel } from './sms-channel';
import { TelegramChannel } from './telegram-channel';

const NOT_YET_IMPLEMENTED: ReadonlySet<ChannelId> = new Set(['whatsapp']);

export function getChannel(id: ChannelId): NotificationChannel {
  if (id === 'email') return new EmailChannel();
  if (id === 'sms') {
    if (process.env.CHANNELS_SMS_ENABLED !== 'true') {
      throw new Error('SMS channel disabled by CHANNELS_SMS_ENABLED env flag');
    }
    return new SmsChannel();
  }
  if (id === 'telegram') {
    if (process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') {
      throw new Error('Telegram channel disabled by CHANNELS_TELEGRAM_ENABLED env flag');
    }
    return new TelegramChannel();
  }
  if (NOT_YET_IMPLEMENTED.has(id)) {
    throw new Error(`Channel "${id}" not yet implemented — scheduled for a later phase`);
  }
  throw new Error(`Unknown channel "${id}"`);
}
```

Append to `src/lib/notifications/channels/__tests__/factory.test.ts` (or add a new `describe` block if that file uses one):

```ts
describe('getChannel — telegram', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('returns TelegramChannel when flag on', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    const { getChannel, TelegramChannel } = await import('../index');
    expect(getChannel('telegram')).toBeInstanceOf(TelegramChannel);
  });

  it('throws with clear message when flag off', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'false';
    const { getChannel } = await import('../index');
    expect(() => getChannel('telegram')).toThrow(/CHANNELS_TELEGRAM_ENABLED/);
  });
});
```

- [ ] **Step 6: Run factory tests — pass**

Run: `pnpm test src/lib/notifications/channels/__tests__/factory.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/notifications/channels/telegram-channel.ts src/lib/notifications/channels/index.ts src/lib/notifications/channels/__tests__/
git commit -m "feat(channels): TelegramChannel impl + factory registration with flag gate"
```

---

## Task 7: Approval service callback entry points

**Files:**
- Modify: `src/lib/approval/service.ts`
- Test: `src/lib/approval/__tests__/approve-via-callback.test.ts` (CREATE)

- [ ] **Step 1: Write failing tests**

Create `src/lib/approval/__tests__/approve-via-callback.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tx mocking: push expected row sets into the queue; the mock consumes them in order.
const txQueue: unknown[] = [];
type TxCall = { sql: string; params: unknown[] };
const txCalls: TxCall[] = [];

const mockTx = Object.assign(
  async (strings: TemplateStringsArray, ...params: unknown[]) => {
    txCalls.push({ sql: strings.join('?'), params });
    const next = txQueue.shift();
    return next ?? [];
  },
  { begin: vi.fn() },
) as unknown;

vi.mock('../../db/server', () => ({
  sql: {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
  },
  jsonb: (v: unknown) => v,
}));

vi.mock('../correlation', () => ({
  recoverCorrelationId: vi.fn(async () => 'upstream-corr-id'),
}));

import { approveViaCallback, regenerateViaCallback } from '../service';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from '../errors';

function liveLinkRow(overrides: Partial<Record<string, unknown>> = {}) {
  return [{
    id: 'link-1',
    response_id: 'resp-1',
    business_id: 'biz-1',
    token_hash: 'hash-1',
    channel: 'telegram',
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    revoked_at: null,
    device_cookie_hash: null,
    created_at: new Date(),
    ...overrides,
  }];
}

function pendingResponseRow() {
  return [{ status: 'pending_approval', original_draft_text: 'draft', version: 1, review_id: 'rev-1' }];
}

describe('approveViaCallback', () => {
  beforeEach(() => { txQueue.length = 0; txCalls.length = 0; });

  it('happy path: consumes link, revokes siblings, approves response, inserts publish_response + audit', async () => {
    txQueue.push(liveLinkRow());             // SELECT approval_links FOR UPDATE
    txQueue.push(pendingResponseRow());      // lockPendingResponse
    txQueue.push([]);                        // consumeLink UPDATE
    txQueue.push([]);                        // UPDATE responses status=approved
    txQueue.push([]);                        // revokeSiblings UPDATE
    txQueue.push([]);                        // INSERT job_outbox publish_response
    txQueue.push([]);                        // insertAuditLog INSERT
    await approveViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123456789',
      viaChannel: 'telegram',
      audit: { updateId: 999, ipAddress: '1.2.3.4' },
    });
    const auditCall = txCalls.find((c) => c.sql.includes('approval_audit_log'));
    expect(auditCall).toBeDefined();
    const metadata = auditCall!.params.find((p) => p && typeof p === 'object' && 'chat_handle_hash' in (p as object));
    expect(metadata).toMatchObject({
      via_channel: 'telegram',
      update_id: 999,
      correlation_id: 'upstream-corr-id',
    });
    expect((metadata as { chat_handle_hash: string }).chat_handle_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('throws ConsumedLinkError when consumed_at is set', async () => {
    txQueue.push(liveLinkRow({ consumed_at: new Date() }));
    await expect(approveViaCallback({
      approvalLinkId: 'link-1', chatHandle: 'h', viaChannel: 'telegram',
      audit: { updateId: 1, ipAddress: null },
    })).rejects.toBeInstanceOf(ConsumedLinkError);
  });

  it('throws RevokedLinkError when revoked_at is set', async () => {
    txQueue.push(liveLinkRow({ revoked_at: new Date() }));
    await expect(approveViaCallback({
      approvalLinkId: 'link-1', chatHandle: 'h', viaChannel: 'telegram',
      audit: { updateId: 1, ipAddress: null },
    })).rejects.toBeInstanceOf(RevokedLinkError);
  });

  it('throws ExpiredLinkError when expires_at is past', async () => {
    txQueue.push(liveLinkRow({ expires_at: new Date(Date.now() - 60_000) }));
    await expect(approveViaCallback({
      approvalLinkId: 'link-1', chatHandle: 'h', viaChannel: 'telegram',
      audit: { updateId: 1, ipAddress: null },
    })).rejects.toBeInstanceOf(ExpiredLinkError);
  });

  it('throws ChannelMismatchError when link.channel != viaChannel', async () => {
    txQueue.push(liveLinkRow({ channel: 'sms' }));
    await expect(approveViaCallback({
      approvalLinkId: 'link-1', chatHandle: 'h', viaChannel: 'telegram',
      audit: { updateId: 1, ipAddress: null },
    })).rejects.toBeInstanceOf(ChannelMismatchError);
  });
});

describe('regenerateViaCallback', () => {
  beforeEach(() => { txQueue.length = 0; txCalls.length = 0; });

  it('marks response superseded and enqueues generate_response outbox', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push(pendingResponseRow());
    txQueue.push([]); // consumeLink
    txQueue.push([]); // revokeSiblings
    txQueue.push([]); // UPDATE responses superseded
    txQueue.push([]); // INSERT outbox
    txQueue.push([]); // audit
    await regenerateViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123',
      viaChannel: 'telegram',
      audit: { updateId: 7, ipAddress: null },
    });
    const outboxCall = txCalls.find((c) => c.sql.includes('job_outbox') && c.sql.includes('generate_response'));
    expect(outboxCall).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `pnpm test src/lib/approval/__tests__/approve-via-callback.test.ts`
Expected: FAIL — "approveViaCallback is not exported"

- [ ] **Step 3: Implement the two callback methods**

Append to `src/lib/approval/service.ts`:

```ts
// ---------------------------------------------------------------------------
// Inline-callback approval (Telegram / future WhatsApp button taps)
// ---------------------------------------------------------------------------

import { sql } from '@/lib/db/server';
import { recoverCorrelationId } from './correlation';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from './errors';

export interface CallbackAuditContext {
  updateId: number;
  ipAddress: string | null;
}

export interface CallbackApprovalInput {
  approvalLinkId: string;
  chatHandle: string;
  viaChannel: 'telegram' | 'whatsapp';
  audit: CallbackAuditContext;
}

async function lockLinkByIdForCallback(
  tx: TxClient,
  approvalLinkId: string,
  expectedChannel: string,
): Promise<ApprovalLink> {
  const rows = await tx<ApprovalLink[]>`
    SELECT id, response_id, business_id, token_hash, channel, expires_at, consumed_at, revoked_at, device_cookie_hash, created_at
    FROM approval_links
    WHERE id = ${approvalLinkId}
    FOR UPDATE
  `;
  const link = rows[0];
  if (!link) throw new InvalidTokenError();
  if (link.channel !== expectedChannel) throw new ChannelMismatchError(expectedChannel, link.channel);
  if (link.consumed_at !== null) throw new ConsumedLinkError();
  if (link.revoked_at !== null) throw new RevokedLinkError();
  if (new Date(link.expires_at) <= new Date()) throw new ExpiredLinkError();
  return link;
}

function buildCallbackAudit(
  link: ApprovalLink,
  input: CallbackApprovalInput,
  correlationId: string,
): { audit: AuditContext; metadata: Record<string, unknown> } {
  const chatHandleHash = createHash('sha256').update(input.chatHandle).digest('hex');
  return {
    audit: {
      tokenHash: link.token_hash,
      deviceCookieHash: null,
      ipAddress: input.audit.ipAddress,
    },
    metadata: {
      via_channel: input.viaChannel,
      chat_handle_hash: chatHandleHash,
      update_id: input.audit.updateId,
      correlation_id: correlationId,
    },
  };
}

/**
 * Approve via inline-button callback (Telegram / WhatsApp).
 * Authorization is provider-signature + sender-handle bound in the ingress layer.
 * Throws typed link-state errors for caller classification.
 */
export async function approveViaCallback(input: CallbackApprovalInput): Promise<void> {
  await sql.begin(async (tx) => {
    const link = await lockLinkByIdForCallback(tx, input.approvalLinkId, input.viaChannel);
    const response = await lockPendingResponse(tx, link.response_id);
    await consumeLink(tx, link.id);
    await tx`
      UPDATE responses
      SET status = 'approved', approved_at = NOW(), approved_text = response_text
      WHERE id = ${link.response_id}
    `;
    await revokeSiblings(tx, link.response_id, link.id);

    const correlationId = await recoverCorrelationId(tx, {
      reviewId: response.review_id,
      responseId: link.response_id,
    });

    const payload: PublishResponsePayload = {
      response_id: link.response_id,
      business_id: link.business_id,
      correlation_id: correlationId,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (${uuidv7()}, 'publish_response', 'response', ${link.response_id}, ${jsonb(payload)}, 'pending')
    `;

    const { audit, metadata } = buildCallbackAudit(link, input, correlationId);
    await insertAuditLog(tx, link.response_id, link.business_id, `approved_via_${input.viaChannel}`, audit, metadata);
  });
}

/**
 * Regenerate via inline-button callback. Marks current response superseded,
 * enqueues generate_response. A new approval cycle will follow.
 */
export async function regenerateViaCallback(input: CallbackApprovalInput): Promise<void> {
  await sql.begin(async (tx) => {
    const link = await lockLinkByIdForCallback(tx, input.approvalLinkId, input.viaChannel);
    const response = await lockPendingResponse(tx, link.response_id);
    await consumeLink(tx, link.id);
    await revokeSiblings(tx, link.response_id, link.id);
    await tx`UPDATE responses SET status = 'superseded' WHERE id = ${link.response_id}`;

    const correlationId = await recoverCorrelationId(tx, {
      reviewId: response.review_id,
      responseId: link.response_id,
    });

    const payload: GenerateResponsePayload = {
      review_id: response.review_id,
      business_id: link.business_id,
      version: response.version + 1,
      correlation_id: correlationId,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (${uuidv7()}, 'generate_response', 'review', ${response.review_id}, ${jsonb(payload)}, 'pending')
    `;

    const { audit, metadata } = buildCallbackAudit(link, input, correlationId);
    await insertAuditLog(tx, link.response_id, link.business_id, `regenerated_via_${input.viaChannel}`, audit, metadata);
  });
}
```

Note: the top-of-file imports need to include `ConsumedLinkError`, `RevokedLinkError`, `ExpiredLinkError`, `ChannelMismatchError` from `./errors`. Move the new imports into the existing import block at the top of the file rather than leaving them at the append site.

- [ ] **Step 4: Run callback tests — pass**

Run: `pnpm test src/lib/approval/__tests__/approve-via-callback.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run full approval test suite — no regressions**

Run: `pnpm test src/lib/approval/`
Expected: PASS (all approval tests, including pre-existing ones)

- [ ] **Step 6: Commit**

```bash
git add src/lib/approval/service.ts src/lib/approval/__tests__/approve-via-callback.test.ts
git commit -m "feat(approval): approveViaCallback + regenerateViaCallback for channel callbacks"
```

---

## Task 8: Telegram webhook signature verifier

**Files:**
- Create: `worker/ingress/telegram-verify.ts`
- Test: `worker/ingress/__tests__/telegram-verify.test.ts` (CREATE)

- [ ] **Step 1: Write failing tests**

Create `worker/ingress/__tests__/telegram-verify.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { verifyTelegramSecret } from '../telegram-verify';

describe('verifyTelegramSecret', () => {
  beforeEach(() => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it('returns false when TELEGRAM_WEBHOOK_SECRET is not set', () => {
    expect(verifyTelegramSecret('anything')).toBe(false);
  });

  it('returns false when header is undefined', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-123';
    expect(verifyTelegramSecret(undefined)).toBe(false);
  });

  it('returns true when header matches exactly', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-123';
    expect(verifyTelegramSecret('secret-123')).toBe(true);
  });

  it('returns false when header differs', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-123';
    expect(verifyTelegramSecret('secret-456')).toBe(false);
  });

  it('returns false when lengths differ (no early-exit leak)', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-123';
    expect(verifyTelegramSecret('secret-1234567890')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `pnpm test worker/ingress/__tests__/telegram-verify.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the verifier**

Create `worker/ingress/telegram-verify.ts`:

```ts
// worker/ingress/telegram-verify.ts
//
// Constant-time compare of the X-Telegram-Bot-Api-Secret-Token header against
// TELEGRAM_WEBHOOK_SECRET. Separate module so it's trivially unit-testable
// with fixtures.

import { timingSafeEqual } from 'node:crypto';

export function verifyTelegramSecret(headerValue: string | undefined): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !headerValue) return false;
  const a = Buffer.from(headerValue, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run tests — pass**

Run: `pnpm test worker/ingress/__tests__/telegram-verify.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/ingress/telegram-verify.ts worker/ingress/__tests__/telegram-verify.test.ts
git commit -m "feat(ingress): Telegram webhook secret verifier (constant-time)"
```

---

## Task 9: Telegram ingress handler (enrollment + callback)

**Files:**
- Create: `worker/ingress/telegram.ts`
- Test: `worker/ingress/__tests__/telegram.test.ts` (CREATE)

- [ ] **Step 1: Write failing tests**

Create `worker/ingress/__tests__/telegram.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
const sqlCalls: { sql: string }[] = [];

vi.mock('../../../src/lib/db/server', () => ({
  sql: Object.assign(
    async (strings: TemplateStringsArray) => {
      sqlCalls.push({ sql: strings.join('?') });
      const next = sqlQueue.shift();
      if (Array.isArray(next)) return next;
      const arr: unknown[] & { count?: number } = [];
      arr.count = typeof next === 'number' ? next : 0;
      return arr;
    },
    { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(null) },
  ),
  jsonb: (v: unknown) => v,
}));

const mockClaim = vi.fn();
vi.mock('../shared', () => ({ claimInboundEvent: mockClaim }));

const mockVerify = vi.fn();
vi.mock('../telegram-verify', () => ({ verifyTelegramSecret: mockVerify }));

const mockApprove = vi.fn();
const mockRegenerate = vi.fn();
vi.mock('../../../src/lib/approval/service', () => ({
  approveViaCallback: mockApprove,
  regenerateViaCallback: mockRegenerate,
}));

const mockAck = vi.fn();
const mockSendMsg = vi.fn();
const mockEditText = vi.fn();
const mockEditMarkup = vi.fn();
vi.mock('../../../src/lib/notifications/channels/telegram-client', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/notifications/channels/telegram-client')>(
    '../../../src/lib/notifications/channels/telegram-client',
  );
  return {
    ...actual,
    TelegramClient: vi.fn(() => ({
      answerCallbackQuery: mockAck,
      sendMessage: mockSendMsg,
      editMessageText: mockEditText,
      editMessageReplyMarkup: mockEditMarkup,
    })),
  };
});

import { handleTelegramWebhook } from '../telegram';
import {
  ConsumedLinkError,
  ChannelMismatchError,
  ExpiredLinkError,
  RevokedLinkError,
} from '../../../src/lib/approval/errors';

function mkRequest(body: unknown, secretHeader = 'good-secret') {
  return {
    body,
    headers: { 'x-telegram-bot-api-secret-token': secretHeader },
    ip: '1.2.3.4',
  } as unknown as Parameters<typeof handleTelegramWebhook>[0];
}

function mkReply() {
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    code: vi.fn().mockReturnThis(),
  };
  return reply as unknown as Parameters<typeof handleTelegramWebhook>[1];
}

beforeEach(() => {
  sqlQueue.length = 0; sqlCalls.length = 0;
  mockClaim.mockReset(); mockVerify.mockReset();
  mockApprove.mockReset(); mockRegenerate.mockReset();
  mockAck.mockReset(); mockSendMsg.mockReset();
  mockEditText.mockReset(); mockEditMarkup.mockReset();
  process.env.TELEGRAM_BOT_TOKEN = 'bot-test';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'good-secret';
});

describe('telegram ingress — signature verification', () => {
  it('returns 401 when signature fails', async () => {
    mockVerify.mockReturnValueOnce(false);
    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({ update_id: 1 }, 'bad'), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockAck).not.toHaveBeenCalled();
  });
});

describe('telegram ingress — dedup', () => {
  it('returns 200 without ack when update is a duplicate', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('duplicate');
    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 1,
      callback_query: { id: 'cb1', from: { id: 111 }, data: 'a:xyz', message: { chat: { id: 111 }, message_id: 9 } },
    }), reply);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(mockAck).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
  });
});

describe('telegram ingress — callback_query happy path', () => {
  it('approve flow: ack → approveViaCallback → editMessageText', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    // invariant check: SELECT approval_links + SELECT enrollment
    sqlQueue.push([{ id: 'link-1', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockApprove.mockResolvedValueOnce(undefined);
    sqlQueue.push([]); // mark inbound_events processed

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 2,
      callback_query: { id: 'cb2', from: { id: 111 }, data: 'a:link-1', message: { chat: { id: 111 }, message_id: 55 } },
    }), reply);

    const order = mockAck.mock.invocationCallOrder[0];
    const approveOrder = mockApprove.mock.invocationCallOrder[0];
    const editOrder = mockEditText.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(approveOrder);
    expect(approveOrder).toBeLessThan(editOrder);
    expect(mockAck).toHaveBeenCalledTimes(1);
    expect(mockEditText).toHaveBeenCalledTimes(1);
    expect(mockSendMsg).not.toHaveBeenCalled();
  });

  it('regenerate flow: ack → regenerateViaCallback → editMessageReplyMarkup with empty keyboard', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([{ id: 'link-2', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockRegenerate.mockResolvedValueOnce(undefined);
    sqlQueue.push([]);

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 3,
      callback_query: { id: 'cb3', from: { id: 111 }, data: 'r:link-2', message: { chat: { id: 111 }, message_id: 56 } },
    }), reply);

    expect(mockAck).toHaveBeenCalledTimes(1);
    expect(mockEditMarkup).toHaveBeenCalledWith(expect.objectContaining({
      reply_markup: { inline_keyboard: [] },
    }));
    expect(mockSendMsg).not.toHaveBeenCalled();
  });
});

describe('telegram ingress — permanent link-state failures after ack', () => {
  it.each([
    ['consumed', new ConsumedLinkError()],
    ['revoked', new RevokedLinkError()],
    ['expired', new ExpiredLinkError()],
    ['channel-mismatch', new ChannelMismatchError('telegram', 'sms')],
  ])('%s → ack success, then sendMessage with friendly copy, processed (not failed)', async (_label, err) => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([{ id: 'link-x', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockApprove.mockRejectedValueOnce(err);
    sqlQueue.push([]);

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 10,
      callback_query: { id: 'cb-x', from: { id: 111 }, data: 'a:link-x', message: { chat: { id: 111 }, message_id: 1 } },
    }), reply);

    expect(mockAck).toHaveBeenCalledTimes(1);
    expect(mockSendMsg).toHaveBeenCalledTimes(1);
    expect(mockEditText).not.toHaveBeenCalled();
    expect(mockEditMarkup).not.toHaveBeenCalled();
    const markProcessed = sqlCalls.find((c) => c.sql.includes('processed_at = NOW()'));
    expect(markProcessed).toBeDefined();
  });
});

describe('telegram ingress — unexpected tx failure', () => {
  it('sends fallback sendMessage without approval URL, marks inbound_events failed, returns 503', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([{ id: 'link-z', business_id: 'biz-1', channel: 'telegram', consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    sqlQueue.push([{ handle: '111' }]);
    mockApprove.mockRejectedValueOnce(new Error('DB timeout'));
    sqlQueue.push([]); // mark failed

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 11,
      callback_query: { id: 'cb-z', from: { id: 111 }, data: 'a:link-z', message: { chat: { id: 111 }, message_id: 1 } },
    }), reply);

    expect(mockAck).toHaveBeenCalledTimes(1);
    expect(mockSendMsg).toHaveBeenCalledTimes(1);
    const text = (mockSendMsg.mock.calls[0][0] as { text: string }).text;
    expect(text).not.toMatch(/https?:\/\//); // no URL embedded
    expect(text).toMatch(/Edit/i);
    expect(reply.code).toHaveBeenCalledWith(503);
  });
});

describe('telegram ingress — enrollment (/start)', () => {
  it('verifies token, flips status to verified, sends confirmation', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    // SELECT channel_enrollments by hash
    sqlQueue.push([{ id: 'enrl-1', business_id: 'biz-1' }]);
    sqlQueue.push([]); // UPDATE enrollments
    sqlQueue.push([]); // mark processed

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 20,
      message: { from: { id: 222 }, chat: { id: 222 }, text: '/start RAW-TOKEN-HERE' },
    }), reply);

    expect(mockSendMsg).toHaveBeenCalledTimes(1);
    const sendText = (mockSendMsg.mock.calls[0][0] as { text: string }).text;
    expect(sendText).toMatch(/connected/i);
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('unknown/expired token: sends failure message, no state change', async () => {
    mockVerify.mockReturnValueOnce(true);
    mockClaim.mockResolvedValueOnce('claimed');
    sqlQueue.push([]); // SELECT returns no matching enrollment
    sqlQueue.push([]); // mark processed

    const reply = mkReply();
    await handleTelegramWebhook(mkRequest({
      update_id: 21,
      message: { from: { id: 333 }, chat: { id: 333 }, text: '/start BAD-TOKEN' },
    }), reply);

    expect(mockSendMsg).toHaveBeenCalledTimes(1);
    const text = (mockSendMsg.mock.calls[0][0] as { text: string }).text;
    expect(text).toMatch(/invalid|expired/i);
    expect(reply.code).toHaveBeenCalledWith(200);
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `pnpm test worker/ingress/__tests__/telegram.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the handler**

Create `worker/ingress/telegram.ts`:

```ts
// worker/ingress/telegram.ts
//
// Telegram webhook ingress. Two paths:
//   A. Enrollment — message.text starts with '/start <rawToken>'.
//      Looks up channel_enrollments by SHA-256(token), flips to verified,
//      stores chat_id as handle.
//   B. Callback_query — inline button tap. Model A ack ordering:
//      cheap validation → answerCallbackQuery → approval transaction →
//      editMessage* for visible confirmation. Errors classified as
//      permanent link-state (typed errors → processed, not failed) vs
//      unexpected (→ failed, reclaim retries).
//
// Security invariants enforced on every callback:
//   1. X-Telegram-Bot-Api-Secret-Token matches env
//   2. inbound_events dedup by update_id
//   3. approval_links row live AND channel='telegram'
//   4. callback_query.from.id matches a verified telegram enrollment
//      for the link's business_id

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql, jsonb } from '../../src/lib/db/server';
import { claimInboundEvent } from './shared';
import { verifyTelegramSecret } from './telegram-verify';
import { approveViaCallback, regenerateViaCallback } from '../../src/lib/approval/service';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from '../../src/lib/approval/errors';
import { TelegramClient } from '../../src/lib/notifications/channels/telegram-client';

interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    chat?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

function parseCallbackData(data: string): { action: 'approve' | 'regenerate'; approvalLinkId: string } | null {
  if (data.startsWith('a:')) return { action: 'approve', approvalLinkId: data.slice(2) };
  if (data.startsWith('r:')) return { action: 'regenerate', approvalLinkId: data.slice(2) };
  return null;
}

function redactForAudit(update: TelegramUpdate): TelegramUpdate {
  const clone = JSON.parse(JSON.stringify(update)) as TelegramUpdate;
  if (clone.callback_query) clone.callback_query.data = '[redacted]';
  if (clone.message?.text?.startsWith('/start ')) clone.message.text = '[redacted]';
  return clone;
}

async function markProcessed(dedupKey: string): Promise<void> {
  await sql`
    UPDATE inbound_events
    SET status = 'processed', processed_at = NOW()
    WHERE external_event_key = ${dedupKey}
  `;
}

async function markFailed(dedupKey: string, reason: string): Promise<void> {
  await sql`
    UPDATE inbound_events
    SET status = 'failed', error_message = ${reason}
    WHERE external_event_key = ${dedupKey}
  `;
}

async function handleEnrollment(
  update: TelegramUpdate,
  dedupKey: string,
  client: TelegramClient,
): Promise<void> {
  const message = update.message!;
  const text = message.text ?? '';
  const rawToken = text.slice(7).trim(); // strip '/start '
  const chatId = String(message.from?.id ?? message.chat?.id ?? '');

  if (!rawToken || !chatId) {
    await client.sendMessage({ chat_id: chatId, text: 'This link is invalid or expired. Please request a new one from your RepWorth admin.' });
    await markProcessed(dedupKey);
    return;
  }

  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const rows = await sql<{ id: string; business_id: string }[]>`
    SELECT id, business_id
    FROM channel_enrollments
    WHERE verification_token_hash = ${tokenHash}
      AND channel = 'telegram'
      AND status = 'pending_verification'
      AND verification_token_expires_at > NOW()
    FOR UPDATE
  `;

  if (rows.length === 0) {
    await client.sendMessage({ chat_id: chatId, text: 'This link is invalid or expired. Please request a new one from your RepWorth admin.' });
    await markProcessed(dedupKey);
    return;
  }

  await sql`
    UPDATE channel_enrollments
    SET handle = ${chatId},
        status = 'verified',
        verified_at = NOW(),
        verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE id = ${rows[0].id}
  `;
  await client.sendMessage({
    chat_id: chatId,
    text: "✅ You're connected to RepWorth — we'll ping you here when a review needs approval.",
  });
  await markProcessed(dedupKey);
}

function messageForLinkError(err: Error): string {
  if (err instanceof ConsumedLinkError || err instanceof RevokedLinkError) {
    return 'This reply was just handled on another channel.';
  }
  if (err instanceof ExpiredLinkError) {
    return 'This approval link has expired — a new draft will arrive on the next review.';
  }
  if (err instanceof ChannelMismatchError) {
    return 'This approval is no longer valid.';
  }
  return 'This approval is no longer valid.';
}

async function handleCallback(
  update: TelegramUpdate,
  dedupKey: string,
  client: TelegramClient,
  reply: FastifyReply,
  ipAddress: string,
): Promise<void> {
  const cb = update.callback_query!;
  const chatId = String(cb.message?.chat.id ?? cb.from.id);
  const messageId = cb.message?.message_id ?? 0;

  // Step 3: parse
  const parsed = cb.data ? parseCallbackData(cb.data) : null;
  if (!parsed) {
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'Invalid action' });
    await markProcessed(dedupKey);
    reply.code(200).send({ ok: true });
    return;
  }

  // Step 4: invariants
  const linkRows = await sql<{ id: string; business_id: string; channel: string; consumed_at: Date | null; revoked_at: Date | null; expires_at: Date }[]>`
    SELECT id, business_id, channel, consumed_at, revoked_at, expires_at
    FROM approval_links
    WHERE id = ${parsed.approvalLinkId}
  `;
  const link = linkRows[0];
  const linkLive = !!link
    && link.channel === 'telegram'
    && link.consumed_at === null
    && link.revoked_at === null
    && new Date(link.expires_at) > new Date();

  if (!linkLive) {
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'This approval is no longer valid — it may have been handled on another channel.' });
    await markProcessed(dedupKey);
    reply.code(200).send({ ok: true });
    return;
  }

  const senderId = String(cb.from.id);
  const enrollmentRows = await sql<{ handle: string }[]>`
    SELECT handle FROM channel_enrollments
    WHERE business_id = ${link.business_id}
      AND channel = 'telegram'
      AND status = 'verified'
      AND handle = ${senderId}
  `;
  if (enrollmentRows.length === 0) {
    await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'This approval is no longer valid — it may have been handled on another channel.' });
    await markProcessed(dedupKey);
    reply.code(200).send({ ok: true });
    return;
  }

  // Step 5: ack BOUNDARY — fire with outcome text
  const ackText = parsed.action === 'approve' ? 'Approving…' : 'Regenerating — a new draft will follow shortly';
  await client.answerCallbackQuery({ callback_query_id: cb.id, text: ackText });

  // Step 6: service call
  try {
    if (parsed.action === 'approve') {
      await approveViaCallback({
        approvalLinkId: link.id,
        chatHandle: senderId,
        viaChannel: 'telegram',
        audit: { updateId: update.update_id, ipAddress },
      });
    } else {
      await regenerateViaCallback({
        approvalLinkId: link.id,
        chatHandle: senderId,
        viaChannel: 'telegram',
        audit: { updateId: update.update_id, ipAddress },
      });
    }
  } catch (err) {
    const e = err as Error;
    const isPermanent = e instanceof ConsumedLinkError
      || e instanceof RevokedLinkError
      || e instanceof ExpiredLinkError
      || e instanceof ChannelMismatchError;

    if (isPermanent) {
      await client.sendMessage({ chat_id: chatId, text: messageForLinkError(e) });
      await markProcessed(dedupKey);
      reply.code(200).send({ ok: true });
      return;
    }

    // Unexpected — fallback with no URL embedded; owner uses the Edit button on the original message.
    const fallback = '⚠️ Something went wrong on our end. Please tap the Edit link in the approval message above to finish approval in the browser.';
    await client.sendMessage({ chat_id: chatId, text: fallback });
    await markFailed(dedupKey, e.message);
    reply.code(503).send({ ok: false });
    return;
  }

  // Step 7: visible confirmation
  if (parsed.action === 'approve') {
    await client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: "✅ Response approved — we'll post it shortly.",
    }).catch(() => { /* edit failures are cosmetic; ack already confirmed */ });
  } else {
    await client.editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => { /* cosmetic */ });
  }

  // Step 8: terminal state
  await markProcessed(dedupKey);
  reply.code(200).send({ ok: true });
}

export async function handleTelegramWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Step 1: signature
  const secretHeader = request.headers['x-telegram-bot-api-secret-token'];
  const headerValue = typeof secretHeader === 'string' ? secretHeader : undefined;
  if (!verifyTelegramSecret(headerValue)) {
    reply.code(401).send({ ok: false });
    return;
  }

  const update = request.body as TelegramUpdate;
  if (!update || typeof update.update_id !== 'number') {
    reply.code(400).send({ ok: false });
    return;
  }
  const dedupKey = `tg:${update.update_id}`;
  const eventType = update.callback_query ? 'callback_query' : 'enrollment_start';

  // Step 2: dedup claim with redacted payload
  const claim = await claimInboundEvent('telegram', dedupKey, eventType, redactForAudit(update));
  if (claim === 'duplicate') {
    reply.code(200).send({ ok: true });
    return;
  }

  const client = new TelegramClient();
  const ipAddress = request.ip ?? null;

  try {
    if (update.callback_query) {
      await handleCallback(update, dedupKey, client, reply, ipAddress);
      return;
    }
    if (update.message?.text?.startsWith('/start ')) {
      await handleEnrollment(update, dedupKey, client);
      reply.code(200).send({ ok: true });
      return;
    }
    // Unknown update type — silent 200, mark processed (permanent)
    await markProcessed(dedupKey);
    reply.code(200).send({ ok: true });
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    await markFailed(dedupKey, msg).catch(() => {});
    reply.code(503).send({ ok: false });
  }
}
```

- [ ] **Step 4: Run tests — pass**

Run: `pnpm test worker/ingress/__tests__/telegram.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add worker/ingress/telegram.ts worker/ingress/__tests__/telegram.test.ts
git commit -m "feat(ingress): Telegram webhook — /start enrollment + callback_query Model A ack"
```

---

## Task 10: Wire route + startup assertion in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Register route + env assertion**

In `worker/index.ts`:

1. Add import at top near other ingress handler imports:

```ts
import { handleTelegramWebhook } from './ingress/telegram';
```

2. Update the existing `startup-assert` import block to also bring in the Telegram assertion:

```ts
import { assertChannelsSmsEnv, assertChannelsTelegramEnv } from './startup-assert';
```

3. In the block that calls `assertChannelsSmsEnv()`, add the Telegram one immediately after:

```ts
assertChannelsSmsEnv();
assertChannelsTelegramEnv();
```

4. Register the webhook route next to the Twilio routes:

```ts
// Telegram webhook — /start enrollment + callback_query taps
app.post('/ingress/telegram', { config: { rawBody: true } }, handleTelegramWebhook);
```

- [ ] **Step 2: Run the full worker test suite**

Run: `pnpm test worker/`
Expected: PASS (all existing worker tests + new ingress + startup)

- [ ] **Step 3: Commit**

```bash
git add worker/index.ts
git commit -m "feat(worker): register Telegram webhook route + startup env assertion"
```

---

## Task 11: NotificationWorker — flag skip + blocked/chat-not-found handling

**Files:**
- Modify: `worker/jobs/NotificationWorker.ts`
- Test: `worker/__tests__/NotificationWorker-telegram.test.ts` (CREATE — new file mirroring `worker/__tests__/NotificationWorker-sms.test.ts`)

- [ ] **Step 1: Read the SMS test file as a template**

Open `worker/__tests__/NotificationWorker-sms.test.ts`. Read these sections in full — they are the template to mirror:
- Module mocks (lines 30–100): `vi.mock` for `../../src/lib/notifications/channels`, seeding of `getChannel`, mock SQL queue.
- SMS flag-skip test (line 193, describe "NotificationWorker — SMS flag gate"): exact fixture + assertion shape for the skip case.
- 21610 fan-out tests (line 338, describe "NotificationWorker — SMS sender-wide 21610 handling"): how the test sets up a verified enrollment, stubs the channel's `sendApprovalRequest` to throw, asserts the enrollment row flip + audit row insert.

- [ ] **Step 2: Write failing tests**

Create `worker/__tests__/NotificationWorker-telegram.test.ts` by copying the imports + module mocks block from `NotificationWorker-sms.test.ts` line-for-line, then adding telegram-specific tests. Replace `SmsChannel` with `TelegramChannel`, `SmsRecipientUnsubscribedError` with `TelegramRecipientBlockedError` / `TelegramChatNotFoundError`, and the 21610 audit-row assertions with enrollment-only updates (Telegram has no sender-wide opt-out table — just a simple enrollment flip).

The three tests to add:

```ts
describe('NotificationWorker — Telegram flag gate', () => {
  it('skips telegram enrollment when CHANNELS_TELEGRAM_ENABLED is not "true"; email still sends', async () => {
    // Fixture: verified email + verified telegram enrollments.
    // With flag off, dispatcher must NOT call getChannel('telegram').
    // Assert:
    //   - getChannel was called with 'email'
    //   - getChannel was NOT called with 'telegram'
    //   - no notification_deliveries row is inserted for channel='telegram'
    // Copy the setup shape from the SMS equivalent at line 193.
  });
});

describe('NotificationWorker — Telegram blocked recipient', () => {
  it('on TelegramRecipientBlockedError: flips enrollment to unsubscribed with reason telegram_blocked, records failed delivery, continues to next channel', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    // Fixture: one verified email + one verified telegram enrollment.
    // Stub TelegramChannel.sendApprovalRequest to throw TelegramRecipientBlockedError.
    // EmailChannel.sendApprovalRequest succeeds.
    // Assert:
    //   - channel_enrollments row for telegram is UPDATE'd with
    //       status='unsubscribed', unsubscribed_at=NOW(), unsubscribed_reason='telegram_blocked'
    //   - a notification_deliveries row is written via insertFailedDelivery()
    //     with channel='telegram', failure_reason containing 'telegram_blocked'
    //   - email enrollment still produces a successful delivery row
  });
});

describe('NotificationWorker — Telegram chat not found', () => {
  it('on TelegramChatNotFoundError: flips enrollment to disabled, records failed delivery', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    // Same fixture as above, but stub to throw TelegramChatNotFoundError.
    // Assert:
    //   - telegram enrollment UPDATE'd with status='disabled', disabled_at=NOW()
    //   - notification_deliveries row for telegram marked failed with reason
    //     'telegram_chat_not_found'
    //   - no unsubscribed_at / unsubscribed_reason fields are touched
  });
});
```

The detailed fixture scaffolding (mock SQL queue pushes, `getChannel` mock return values, spies on `insertFailedDelivery`) must match what's already established in `NotificationWorker-sms.test.ts` — copy that exact style rather than improvising. If a helper the SMS tests use isn't applicable to Telegram (e.g., the sender-wide opt-out audit), omit that assertion from the Telegram version.

- [ ] **Step 2: Run the tests — fail**

Run: `pnpm test worker/jobs/__tests__/NotificationWorker.test.ts`
Expected: FAIL

- [ ] **Step 3: Add flag-skip branch**

In `worker/jobs/NotificationWorker.ts`, right after the existing SMS skip at line ~118, insert:

```ts
if (channelId === 'telegram' && process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') {
  logger.log(`Telegram channel disabled by flag — skipping enrollment for business ${business_id}`);
  continue;
}
```

- [ ] **Step 4: Add blocked/chat-not-found branch**

Locate the existing `SmsRecipientUnsubscribedError` handler (line 207 in `worker/jobs/NotificationWorker.ts`). The helper for recording a failed delivery is `insertFailedDelivery` from `../../src/lib/notifications/delivery` — already imported at line 15.

Extend the import at line 17 to pull in the new Telegram errors:

```ts
import {
  getChannel,
  SmsRecipientUnsubscribedError,
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
} from '../../src/lib/notifications/channels';
```

Inside the channel-send `catch (err)` block, AFTER the existing SMS 21610 branch (around line 207–240) and BEFORE the generic failure path, insert:

```ts
if (err instanceof TelegramRecipientBlockedError) {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE channel_enrollments
      SET status = 'unsubscribed',
          unsubscribed_at = NOW(),
          unsubscribed_reason = COALESCE(unsubscribed_reason, 'telegram_blocked'),
          updated_at = NOW()
      WHERE business_id = ${business_id}
        AND channel = 'telegram'
        AND archived_at IS NULL
    `;
  });
  logger.log(`Telegram enrollment flipped to unsubscribed (telegram_blocked) for business ${business_id}`);
  await insertFailedDelivery(business_id, response_id, 'telegram', enrollment.handle, 'telegram_blocked');
  continue;
}
if (err instanceof TelegramChatNotFoundError) {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE channel_enrollments
      SET status = 'disabled',
          disabled_at = COALESCE(disabled_at, NOW()),
          updated_at = NOW()
      WHERE business_id = ${business_id}
        AND channel = 'telegram'
        AND archived_at IS NULL
    `;
  });
  logger.log(`Telegram enrollment flipped to disabled (chat_not_found) for business ${business_id}`);
  await insertFailedDelivery(business_id, response_id, 'telegram', enrollment.handle, 'telegram_chat_not_found');
  continue;
}
```

> `insertFailedDelivery` signature (verified from `src/lib/notifications/delivery.ts:37`) is **positional**: `(businessId, responseId, channel, recipient, failureReason, template?)`. The SMS 21610 branch at `worker/jobs/NotificationWorker.ts:234` is the call-site template. The Telegram branches use the same pattern — no new helpers introduced.

- [ ] **Step 5: Run tests — pass**

Run: `pnpm test worker/jobs/__tests__/NotificationWorker.test.ts`
Expected: PASS (including the new telegram tests)

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/NotificationWorker.ts worker/jobs/__tests__/NotificationWorker.test.ts
git commit -m "feat(worker): NotificationWorker handles Telegram flag + blocked/chat-not-found"
```

---

## Task 12: Admin API shared helper

**Files:**
- Create: `src/app/api/admin/channels/telegram/_shared.ts`
- Test: `src/app/api/admin/channels/telegram/__tests__/_shared.test.ts` (CREATE)

- [ ] **Step 1: Write failing tests**

Create `src/app/api/admin/channels/telegram/__tests__/_shared.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';

describe('admin telegram _shared', () => {
  beforeEach(() => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  it('isTelegramEnabled returns false by default', () => {
    expect(isTelegramEnabled()).toBe(false);
  });

  it('isTelegramEnabled returns true when flag is set', () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    expect(isTelegramEnabled()).toBe(true);
  });

  it('flagOff returns 404', async () => {
    const res = flagOff();
    expect(res.status).toBe(404);
  });

  it('assertTelegramEnvReady returns null in mock mode', () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(assertTelegramEnvReady()).toBeNull();
  });

  it('assertTelegramEnvReady returns 503 when env missing', () => {
    const res = assertTelegramEnvReady();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it('assertTelegramEnvReady returns null when env complete', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    expect(assertTelegramEnvReady()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `pnpm test src/app/api/admin/channels/telegram/__tests__/_shared.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the shared helper**

Create `src/app/api/admin/channels/telegram/_shared.ts`:

```ts
// src/app/api/admin/channels/telegram/_shared.ts
//
// Shared helpers for admin Telegram routes. Mirrors the SMS pattern at
// src/app/api/admin/channels/sms/_shared.ts.

import { NextResponse } from 'next/server';

export function isTelegramEnabled(): boolean {
  return process.env.CHANNELS_TELEGRAM_ENABLED === 'true';
}

export function flagOff(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export function assertTelegramEnvReady(): NextResponse | null {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return null;
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length === 0) return null;
  console.error(`[telegram-admin] CHANNELS_TELEGRAM_ENABLED=true but missing env vars: ${missing.join(', ')}`);
  return NextResponse.json({ ok: false, reason: 'telegram_env_not_ready', missing }, { status: 503 });
}
```

- [ ] **Step 4: Run tests — pass**

Run: `pnpm test src/app/api/admin/channels/telegram/__tests__/_shared.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/channels/telegram/_shared.ts src/app/api/admin/channels/telegram/__tests__/_shared.test.ts
git commit -m "feat(admin): telegram admin shared flag/env helpers (404/503)"
```

---

## Task 13: Admin `start` route (generate QR + deep link)

**Files:**
- Create: `src/app/api/admin/channels/telegram/start/route.ts`
- Test: `src/app/api/admin/channels/telegram/__tests__/start.test.ts` (CREATE)

- [ ] **Step 1: Install the `qrcode` dependency**

Run:
```bash
pnpm add qrcode
pnpm add -D @types/qrcode
```

Verify `package.json` now lists `qrcode` and `@types/qrcode`.

- [ ] **Step 2: Write failing tests**

Create `src/app/api/admin/channels/telegram/__tests__/start.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
vi.mock('@/lib/db/server', () => ({
  sql: async () => {
    const next = sqlQueue.shift();
    return Array.isArray(next) ? next : [];
  },
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn(async () => ({ userId: 'admin-1', role: 'admin' })),
  AuthError: class extends Error {},
}));

import { POST } from '../start/route';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/telegram/start', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  delete process.env.CHANNELS_TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.MOCK_EXTERNAL_APIS = 'true'; // skip env readiness check in unit tests
});

describe('POST /api/admin/channels/telegram/start', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq({ businessId: 'biz-1' }));
    expect(res.status).toBe(404);
  });

  it('returns 503 when flag on but env missing (and not in mock mode)', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    delete process.env.MOCK_EXTERNAL_APIS;
    const res = await POST(mkReq({ businessId: 'biz-1' }));
    expect(res.status).toBe(503);
  });

  it('happy path: inserts pending enrollment and returns deepLink + qrDataUrl + expiresAt', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_USERNAME = 'RepWorthBot';
    sqlQueue.push([{ subscription_status: 'active' }]); // subscription check
    sqlQueue.push([]); // advisory lock
    sqlQueue.push([]); // SELECT existing enrollment (none)
    sqlQueue.push([]); // INSERT enrollment
    const res = await POST(mkReq({ businessId: 'biz-1' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deepLink).toMatch(/^https:\/\/t\.me\/RepWorthBot\?start=/);
    expect(json.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(json.expiresAt).toBeDefined();
  });

  it('returns 409 when enrollment is already verified', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_USERNAME = 'RepWorthBot';
    sqlQueue.push([{ subscription_status: 'active' }]);
    sqlQueue.push([]);
    sqlQueue.push([{ id: 'enrl-1', status: 'verified' }]); // existing verified row
    const res = await POST(mkReq({ businessId: 'biz-1' }));
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 3: Run tests — fail**

Run: `pnpm test src/app/api/admin/channels/telegram/__tests__/start.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement the route**

Create `src/app/api/admin/channels/telegram/start/route.ts`:

```ts
// src/app/api/admin/channels/telegram/start/route.ts
//
// POST /api/admin/channels/telegram/start — admin generates a one-time Telegram
// verification deep link + QR for owner scan.
//
// Handler order: auth → flag → env → subscription → advisory lock → state-machine upsert.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(['admin', 'sales_partner']);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    throw e;
  }

  if (!isTelegramEnabled()) return flagOff();
  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const businessRows = await sql<{ subscription_status: string }[]>`
    SELECT subscription_status FROM businesses WHERE id = ${businessId}
  `;
  if (businessRows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (businessRows[0].subscription_status !== 'active') {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  // Advisory lock to serialize concurrent starts on (business_id, 'telegram')
  const lockKey = createHash('sha256').update(`${businessId}:telegram`).digest().readBigInt64BE(0).toString();
  await sql`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

  const existing = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM channel_enrollments
    WHERE business_id = ${businessId} AND channel = 'telegram' AND archived_at IS NULL
  `;
  if (existing.length > 0 && existing[0].status === 'verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409 });
  }

  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  if (existing.length > 0) {
    // Reset to pending_verification with fresh token (handles pending, disabled, unsubscribed)
    await sql`
      UPDATE channel_enrollments
      SET status = 'pending_verification',
          handle = NULL,
          verification_token_hash = ${tokenHash},
          verification_token_expires_at = ${expiresAt},
          disabled_at = NULL,
          unsubscribed_at = NULL,
          unsubscribed_reason = NULL,
          updated_at = NOW()
      WHERE id = ${existing[0].id}
    `;
  } else {
    await sql`
      INSERT INTO channel_enrollments (id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
      VALUES (${uuidv7()}, ${businessId}, 'telegram', 'pending_verification', ${tokenHash}, ${expiresAt})
    `;
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'RepWorthBot';
  const deepLink = `https://t.me/${botUsername}?start=${rawToken}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json({ deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() });
}
```

- [ ] **Step 5: Run tests — pass**

Run: `pnpm test src/app/api/admin/channels/telegram/__tests__/start.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/channels/telegram/start/route.ts src/app/api/admin/channels/telegram/__tests__/start.test.ts package.json pnpm-lock.yaml
git commit -m "feat(admin): POST /api/admin/channels/telegram/start — QR + deep link"
```

---

## Task 14: Admin `cancel` + `disable` routes

**Files:**
- Create: `src/app/api/admin/channels/telegram/cancel/route.ts`
- Create: `src/app/api/admin/channels/telegram/disable/route.ts`
- Test: `src/app/api/admin/channels/telegram/__tests__/cancel.test.ts` (CREATE)
- Test: `src/app/api/admin/channels/telegram/__tests__/disable.test.ts` (CREATE)

- [ ] **Step 1: Write failing tests for cancel**

Create `src/app/api/admin/channels/telegram/__tests__/cancel.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
vi.mock('@/lib/db/server', () => ({
  sql: async () => { const next = sqlQueue.shift(); return Array.isArray(next) ? next : []; },
  jsonb: (v: unknown) => v,
}));
vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn(async () => ({ userId: 'admin', role: 'admin' })),
  AuthError: class extends Error {},
}));

import { POST } from '../cancel/route';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/telegram/cancel', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => { sqlQueue.length = 0; process.env.MOCK_EXTERNAL_APIS = 'true'; });

describe('POST /api/admin/channels/telegram/cancel', () => {
  it('404 when flag off', async () => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    const res = await POST(mkReq({ businessId: 'b1' }));
    expect(res.status).toBe(404);
  });
  it('clears verification hash + expiry on pending row', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([]); // UPDATE ... WHERE status='pending_verification'
    const res = await POST(mkReq({ businessId: 'b1' }));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Write failing tests for disable**

Create `src/app/api/admin/channels/telegram/__tests__/disable.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
vi.mock('@/lib/db/server', () => ({
  sql: async () => { const next = sqlQueue.shift(); return Array.isArray(next) ? next : []; },
  jsonb: (v: unknown) => v,
}));
vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn(async () => ({ userId: 'admin', role: 'admin' })),
  AuthError: class extends Error {},
}));

import { POST } from '../disable/route';

function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/telegram/disable', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => { sqlQueue.length = 0; process.env.MOCK_EXTERNAL_APIS = 'true'; });

describe('POST /api/admin/channels/telegram/disable', () => {
  it('404 when flag off', async () => {
    delete process.env.CHANNELS_TELEGRAM_ENABLED;
    const res = await POST(mkReq({ businessId: 'b1' }));
    expect(res.status).toBe(404);
  });
  it('flips verified → disabled, returns 200', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([{ id: 'enrl-1' }]); // UPDATE RETURNING
    const res = await POST(mkReq({ businessId: 'b1' }));
    expect(res.status).toBe(200);
  });
  it('returns 404 when no verified row matches', async () => {
    process.env.CHANNELS_TELEGRAM_ENABLED = 'true';
    sqlQueue.push([]); // UPDATE matches nothing
    const res = await POST(mkReq({ businessId: 'b1' }));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run tests — fail**

Run: `pnpm test src/app/api/admin/channels/telegram/__tests__/cancel.test.ts src/app/api/admin/channels/telegram/__tests__/disable.test.ts`
Expected: FAIL — routes not yet defined.

- [ ] **Step 4: Implement cancel route**

Create `src/app/api/admin/channels/telegram/cancel/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try { await requireRole(['admin', 'sales_partner']); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); throw e; }

  if (!isTelegramEnabled()) return flagOff();
  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  await sql`
    UPDATE channel_enrollments
    SET verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'telegram'
      AND status = 'pending_verification'
      AND archived_at IS NULL
  `;
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Implement disable route**

Create `src/app/api/admin/channels/telegram/disable/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try { await requireRole(['admin', 'sales_partner']); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); throw e; }

  if (!isTelegramEnabled()) return flagOff();
  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const updated = await sql<{ id: string }[]>`
    UPDATE channel_enrollments
    SET status = 'disabled', disabled_at = NOW(), updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'telegram'
      AND status = 'verified'
      AND archived_at IS NULL
    RETURNING id
  `;
  if (updated.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6: Run tests — pass**

Run: `pnpm test src/app/api/admin/channels/telegram/__tests__/`
Expected: PASS (all cancel + disable + shared + start tests)

- [ ] **Step 7: Commit**

```bash
git add src/app/api/admin/channels/telegram/cancel/route.ts src/app/api/admin/channels/telegram/disable/route.ts src/app/api/admin/channels/telegram/__tests__/
git commit -m "feat(admin): telegram cancel + disable endpoints"
```

---

## Task 15: Extend business detail API with telegramEnabled

**Files:**
- Modify: `src/app/api/admin/businesses/[id]/route.ts`

- [ ] **Step 1: Find the current `smsEnabled` response field**

Open `src/app/api/admin/businesses/[id]/route.ts` and find the response JSON that includes `smsEnabled` (around line 224). Confirm the shape before editing.

- [ ] **Step 2: Add `telegramEnabled` on the next line**

```ts
smsEnabled: process.env.CHANNELS_SMS_ENABLED === 'true',
telegramEnabled: process.env.CHANNELS_TELEGRAM_ENABLED === 'true',
```

- [ ] **Step 3: Run existing route tests (if any exist)**

Run: `pnpm test src/app/api/admin/businesses/`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/businesses/\[id\]/route.ts
git commit -m "feat(admin): expose telegramEnabled flag on business detail API"
```

---

## Task 16: TelegramEnrollmentWidget (admin UI)

**Files:**
- Create: `src/components/admin/TelegramEnrollmentWidget.tsx`

- [ ] **Step 1: Build the widget**

Create `src/components/admin/TelegramEnrollmentWidget.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';

type ChannelEnrollment = {
  channel: string;
  handle: string | null;
  status: 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed';
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
};

type StartResponse = { deepLink: string; qrDataUrl: string; expiresAt: string };

type WidgetState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'awaiting_scan'; deepLink: string; qrDataUrl: string; expiresAt: string }
  | { kind: 'verified'; maskedHandle: string }
  | { kind: 'disabled' }
  | { kind: 'unsubscribed'; reason: string | null }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

function maskChatId(chatId: string): string {
  if (chatId.length <= 4) return '•••';
  return `••• ${chatId.slice(-4)}`;
}

async function fetchTelegramEnrollment(businessId: string): Promise<ChannelEnrollment | null> {
  const res = await fetch(`/api/admin/businesses/${businessId}/channels`);
  if (!res.ok) return null;
  const data = await res.json() as { enrollments: ChannelEnrollment[] };
  return data.enrollments.find((e) => e.channel === 'telegram') ?? null;
}

export function TelegramEnrollmentWidget({ businessId }: { businessId: string }) {
  const [state, setState] = useState<WidgetState>({ kind: 'idle' });
  const [enrollment, setEnrollment] = useState<ChannelEnrollment | null>(null);

  const refresh = useCallback(async () => {
    const e = await fetchTelegramEnrollment(businessId);
    setEnrollment(e);
    if (!e) { setState({ kind: 'idle' }); return; }
    if (e.status === 'verified') setState({ kind: 'verified', maskedHandle: e.handle ? maskChatId(e.handle) : '•••' });
    else if (e.status === 'disabled') setState({ kind: 'disabled' });
    else if (e.status === 'unsubscribed') setState({ kind: 'unsubscribed', reason: e.unsubscribed_reason });
  }, [businessId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll every 3s while awaiting scan
  useEffect(() => {
    if (state.kind !== 'awaiting_scan') return;
    const interval = setInterval(async () => {
      const e = await fetchTelegramEnrollment(businessId);
      if (e?.status === 'verified') {
        setEnrollment(e);
        setState({ kind: 'verified', maskedHandle: e.handle ? maskChatId(e.handle) : '•••' });
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [state.kind, businessId]);

  // Expire the QR when TTL elapses
  useEffect(() => {
    if (state.kind !== 'awaiting_scan') return;
    const ms = new Date(state.expiresAt).getTime() - Date.now();
    if (ms <= 0) { setState({ kind: 'expired' }); return; }
    const t = setTimeout(() => setState({ kind: 'expired' }), ms);
    return () => clearTimeout(t);
  }, [state.kind === 'awaiting_scan' ? state.expiresAt : null]);

  const onConnect = async () => {
    setState({ kind: 'generating' });
    const res = await fetch('/api/admin/channels/telegram/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId }),
    });
    if (res.status === 409) {
      setState({ kind: 'error', message: 'Telegram is already connected. Disable it first to re-enroll.' });
      return;
    }
    if (!res.ok) {
      setState({ kind: 'error', message: `Server returned ${res.status}` });
      return;
    }
    const data = (await res.json()) as StartResponse;
    setState({ kind: 'awaiting_scan', deepLink: data.deepLink, qrDataUrl: data.qrDataUrl, expiresAt: data.expiresAt });
  };

  const onCancel = async () => {
    await fetch('/api/admin/channels/telegram/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId }),
    });
    await refresh();
  };

  const onDisable = async () => {
    if (!confirm('Disable Telegram notifications for this business?')) return;
    await fetch('/api/admin/channels/telegram/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId }),
    });
    await refresh();
  };

  return (
    <div className="telegram-enrollment-widget border rounded-md p-4 bg-white">
      <h3 className="font-medium mb-2">Telegram</h3>
      {state.kind === 'idle' && (
        <button onClick={onConnect} className="px-3 py-1.5 bg-blue-600 text-white rounded">Connect</button>
      )}
      {state.kind === 'generating' && <p>Generating link…</p>}
      {state.kind === 'awaiting_scan' && (
        <div>
          <p className="text-sm mb-2">Scan the QR with Telegram or share this link. The owner taps Start to verify.</p>
          <img src={state.qrDataUrl} alt="Telegram deep link QR" width={256} height={256} />
          <p className="mt-2"><a href={state.deepLink} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{state.deepLink}</a></p>
          <p className="text-xs text-gray-500 mt-1">Expires {new Date(state.expiresAt).toLocaleTimeString()}</p>
          <button onClick={onCancel} className="mt-3 px-3 py-1 border rounded">Cancel</button>
          <button onClick={refresh} className="mt-3 ml-2 px-3 py-1 border rounded">Refresh status</button>
        </div>
      )}
      {state.kind === 'verified' && (
        <div>
          <p className="text-sm text-green-700">✅ Connected — Telegram chat {state.maskedHandle}</p>
          <button onClick={onDisable} className="mt-2 px-3 py-1 border rounded text-red-600">Disable</button>
        </div>
      )}
      {state.kind === 'disabled' && (
        <div>
          <p className="text-sm text-gray-600">Disabled</p>
          <button onClick={onConnect} className="mt-2 px-3 py-1 border rounded">Reconnect</button>
        </div>
      )}
      {state.kind === 'unsubscribed' && (
        <div>
          <p className="text-sm text-orange-600">Unsubscribed ({state.reason ?? 'unknown'})</p>
          <button onClick={onConnect} className="mt-2 px-3 py-1 border rounded">Re-enroll</button>
        </div>
      )}
      {state.kind === 'expired' && (
        <div>
          <p className="text-sm text-gray-600">Verification link expired.</p>
          <button onClick={onConnect} className="mt-2 px-3 py-1 border rounded">Generate new link</button>
        </div>
      )}
      {state.kind === 'error' && (
        <div>
          <p className="text-sm text-red-600">{state.message}</p>
          <button onClick={() => setState({ kind: 'idle' })} className="mt-2 px-3 py-1 border rounded">Back</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

Per spec §5.3 and §5.5, this widget is verified by the manual real-bot ship gate (admin scans QR → owner taps Start → verified status appears in 3s polling). No unit tests for the widget in Phase 2 — it's integration-tested via the ship-gate walkthrough.

```bash
git add src/components/admin/TelegramEnrollmentWidget.tsx
git commit -m "feat(admin): TelegramEnrollmentWidget — QR + deep link + status polling"
```

---

## Task 17: Mount widget in the admin business-detail page

**Files:**
- Modify: `src/app/admin/businesses/[id]/page.tsx`

- [ ] **Step 1: Locate the existing Channels section**

Open the file and find the JSX that renders the SMS widget, gated on `business.smsEnabled`. That's the insertion point.

- [ ] **Step 2: Add the Telegram widget import + JSX**

At the top of the file (alongside other component imports):

```tsx
import { TelegramEnrollmentWidget } from '@/components/admin/TelegramEnrollmentWidget';
```

Inside the Channels section, directly below the existing SMS widget block:

```tsx
{business.telegramEnabled && business.subscription_status === 'active' && (
  <TelegramEnrollmentWidget businessId={business.id} />
)}
```

- [ ] **Step 3: Run the dev server and manually verify the widget renders**

Run: `pnpm dev`

In another terminal or browser:
- Navigate to `/admin/businesses/<some-active-business-id>`
- Confirm the Telegram widget is NOT visible (flag off).
- Set `CHANNELS_TELEGRAM_ENABLED=true` in `.env.local`, restart dev server.
- Reload — widget should render "Connect" button.
- Click "Connect" — expect either a 503 (env missing) or a QR (if env is set).

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/businesses/\[id\]/page.tsx
git commit -m "feat(admin): mount TelegramEnrollmentWidget in business-detail Channels section"
```

---

## Task 18: Update .env.example + CLAUDE.md + runbook

**Files:**
- Modify: `.env.example`
- Modify: `.claude/CLAUDE.md`
- Modify: `docs/launch-runbook.md` (or the equivalent; confirm the filename)

- [ ] **Step 1: Append Telegram vars to `.env.example`**

At the bottom of the "Channels" section:

```bash
# ─── Channels — Telegram ───────────────────────────────────────────────
# Server-authoritative flag. Admin UI reads via /api/admin/businesses/[id].
# Do NOT prefix with NEXT_PUBLIC_ — the widget reads from server-rendered props.
CHANNELS_TELEGRAM_ENABLED=false

# BotFather token for @RepWorthBot. Format: <bot_id>:<hash>. Rotate via BotFather.
TELEGRAM_BOT_TOKEN=

# Random 32+ byte string. Must match what was passed to setWebhook.
# Rotate by re-running setWebhook with a new value + updating this var.
TELEGRAM_WEBHOOK_SECRET=

# Optional — bot username for deep-link rendering in the admin UI.
# Default: RepWorthBot
TELEGRAM_BOT_USERNAME=RepWorthBot
```

- [ ] **Step 2: Update `.claude/CLAUDE.md` status**

In the "Current status" section, under the "Shipped" list, add Phase 2:

```md
- **Channels Phase 2 — Telegram** — `TelegramChannel`, `/ingress/telegram` (Model A ack), `approveViaCallback`/`regenerateViaCallback`, admin enrollment widget. Code-complete, flag-gated off pending BotFather registration + real-bot walkthrough (2026-04-22).
```

In the "Feature flags / non-obvious env vars" list:

```md
- `CHANNELS_TELEGRAM_ENABLED` — gates factory, dispatcher, admin API routes, widget. Default off. Server-authoritative via business detail API.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` — required when Telegram enabled (worker startup assertion fails otherwise, except in MOCK mode).
- `TELEGRAM_BOT_USERNAME` — optional; default `RepWorthBot`.
```

- [ ] **Step 3: Append setWebhook runbook entry**

Find the launch runbook file (likely `docs/launch-runbook.md` or similar — confirm with `ls docs/*runbook*`). Append:

````md
## Telegram — one-time webhook registration

Registering `@RepWorthBot` (or the configured bot) is a prerequisite before flipping `CHANNELS_TELEGRAM_ENABLED=true`.

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "$(cat <<JSON
{
  "url": "${WORKER_PUBLIC_URL}/ingress/telegram",
  "secret_token": "${TELEGRAM_WEBHOOK_SECRET}",
  "allowed_updates": ["message", "callback_query"],
  "drop_pending_updates": true
}
JSON
)"

# Verify
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Rotate by re-running `setWebhook` with a new `secret_token` and updating the matching env var.
````

- [ ] **Step 4: Commit**

```bash
git add .env.example .claude/CLAUDE.md docs/launch-runbook.md
git commit -m "docs(channels): Phase 2 Telegram env vars + status update + runbook"
```

---

## Task 19: Full-suite regression + build check

**Files:** (no code changes — verification only)

- [ ] **Step 1: Run the full Vitest suite**

Run: `pnpm test`
Expected: ALL green. If any pre-existing test breaks, investigate — the Phase 2 work should not regress anything in Phases 0/1.

- [ ] **Step 2: Type check**

Run: `pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Build check**

Run: `pnpm build`
Expected: success. This catches Next.js App Router path issues and type problems in the new admin routes.

- [ ] **Step 4: Worker build check**

Run: `pnpm worker --help 2>/dev/null || tsx worker/index.ts --help 2>/dev/null || echo 'worker entry is valid'`

Actually start and stop the worker briefly to verify startup assertion works:
```bash
# With flag off (default): should boot clean
pnpm worker &
sleep 3
kill %1 2>/dev/null
```

Expected: worker boots, registers routes, and stays up. No assertion failures with flag off.

- [ ] **Step 5: Commit (no-op expected — this is verification)**

If the previous steps created any accidental file changes (e.g., pnpm lockfile drift), commit them now:

```bash
git status
# if dirty:
git add -A
git commit -m "chore: post-implementation verification"
```

---

## Post-Implementation Ship Gate (manual — NOT part of the plan tasks)

These are performed AFTER all automated checks pass, and are gated on external prereqs:

1. Register `@RepWorthBot` via BotFather, capture the token.
2. Generate a random `TELEGRAM_WEBHOOK_SECRET` (≥ 32 bytes).
3. Deploy the branch to a staging environment with `CHANNELS_TELEGRAM_ENABLED=false`.
4. Run the `setWebhook` curl from the runbook pointing at staging's `WORKER_PUBLIC_URL`.
5. Flip `CHANNELS_TELEGRAM_ENABLED=true` in staging only.
6. Walk through the Phase 2 manual ship-gate from `docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md` §5.5:
   - Admin opens business detail → Connect → scans QR → owner taps Start → admin sees Verified within 3s polling.
   - Trigger an approval notification → owner receives Telegram message → taps Approve → response flips to `approved`.
   - Trigger another → owner taps Regenerate → new draft arrives as new message → buttons on original stripped.
   - Owner blocks the bot → trigger notification → enrollment flips to `unsubscribed` with reason `telegram_blocked`.
7. 24-hour Sentry watch on the pilot business after flag-on.
8. If everything holds, open PR and merge to `main`.
