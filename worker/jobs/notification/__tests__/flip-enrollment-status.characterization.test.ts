// worker/jobs/notification/__tests__/flip-enrollment-status.characterization.test.ts
//
// BYTE-EXACT characterization pins for the enrollment status-flip UPDATE that
// the dispatcher issues after a permanent per-channel send failure
// (flipEnrollmentStatus in dispatch.ts). One pin per variant across the full
// matrix: 4 StatusFlipKind values × {org-default (location_id IS NULL),
// per-location override (location_id = <uuid>)} = 8 pins.
//
// WHY BYTE-EXACT (not fragment matchers): a later change deduped the 8
// near-identical inline UPDATE blocks into one fragment-composed helper. These
// pins lock the produced SQL text + bound-value order character-for-character so
// the dedup is provably behavior-preserving. They MUST stay green both before
// and after that refactor — if any `.text`/`.values` differs, the refactor
// changed behavior.
//
// The channel name and the unsubscribed_reason are SQL LITERALS (present in
// `.text`), never bound params — this is deliberate (invariant relied on by the
// dispatcher's SQL-text assertions) and the pins encode it.
//
// Uses the shared createMockSql() harness because it flattens nested `sql``
// fragments into one recorded `sqlCalls[i].text`/`.values`, exactly matching
// how Postgres.js composes the deduped helper's fragments at runtime.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mockGetChannel } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql(), mockGetChannel: vi.fn() };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('@/lib/notifications/delivery', () => ({
  insertPendingApprovalDelivery: vi.fn(() => Promise.resolve('pending-delivery-1')),
  finalizeDeliverySent: vi.fn(() => Promise.resolve()),
  failDelivery: vi.fn(() => Promise.resolve()),
}));

// Spread the real module so the error classes keep working under instanceof in
// classifyChannelError; only getChannel is stubbed to throw the provider error.
vi.mock('@/lib/notifications/channels', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications/channels')>(
    '@/lib/notifications/channels',
  );
  return { ...actual, getChannel: mockGetChannel };
});

vi.mock('@/lib/approval/create-link', () => ({
  createApprovalLink: vi.fn(() => Promise.resolve({ rawToken: 'raw-tok', approvalLinkId: 'link-1' })),
}));

vi.mock('@/lib/notifications/resolve-channels', () => ({
  safeInvalidateChannelCache: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchAll, type DispatchContext } from '../dispatch';
import type { ResolvedChannel } from '@/lib/notifications/resolve-channels';
import {
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
} from '@/lib/notifications/channels';

// ---------------------------------------------------------------------------
// Expected-SQL builder. Independent of production: it assembles the exact
// character layout of the original eight inline UPDATE blocks by simple line
// concatenation (explicit \n per line, literal leading indentation). Verified
// byte-for-byte against the UNMODIFIED code before the dedup, so it is a true
// characterization oracle, not a mirror of the refactor.
// ---------------------------------------------------------------------------
const UNSUBSCRIBE_SET = (reason: string) =>
  "            SET status = 'unsubscribed',\n" +
  '                unsubscribed_at = COALESCE(unsubscribed_at, NOW()),\n' +
  `                unsubscribed_reason = COALESCE(unsubscribed_reason, '${reason}'),\n` +
  '                updated_at = NOW()\n';

const DISABLE_SET =
  "            SET status = 'disabled',\n" +
  '                disabled_at = COALESCE(disabled_at, NOW()),\n' +
  '                updated_at = NOW()\n';

function expectedFlipSql(setBlock: string, channel: string, locationLine: string): string {
  return (
    '\n            UPDATE channel_enrollments\n' +
    setBlock +
    '            WHERE account_id = ?\n' +
    `              AND channel = '${channel}'\n` +
    '              AND handle = ?\n' +
    `              AND ${locationLine}\n` +
    '              AND archived_at IS NULL\n' +
    '          '
  );
}

const IS_NULL = 'location_id IS NULL';
const EQ_UUID = 'location_id = ?::uuid';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const ACCOUNT_ID = 'acct-1';
const OVERRIDE_LOCATION_ID = '0190b0c0-0000-7000-8000-000000000abc';

function ctx(): DispatchContext {
  return {
    responseId: 'resp-1',
    businessId: 'biz-1',
    accountId: ACCOUNT_ID,
    isFailover: false,
    appUrl: 'https://app.repworth.com',
    business: { name: 'Acme', displayLabel: null, owner_email_bounced: false },
    review: {
      reviewerName: 'Jane',
      starRating: 4,
      reviewText: 'Great',
      reviewDate: '2026-04-20',
      responsePreview: 'Thanks',
    },
  };
}

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * Drive one enrollment through dispatchAll so its send fails with `error`,
 * triggering flipEnrollmentStatus. Returns the recorded flip UPDATE call.
 */
async function runFlip(
  channel: 'telegram' | 'whatsapp',
  handle: string,
  locationId: string | null,
  error: Error,
): Promise<{ text: string; values: unknown[] }> {
  resetMockSql();
  sqlReturnQueue.push([]); // existing-delivery SELECT → no prior delivery
  mockGetChannel.mockReturnValue({ sendApprovalRequest: vi.fn().mockRejectedValueOnce(error) });

  const enrollment: ResolvedChannel = { channel, handle, location_id: locationId } as ResolvedChannel;
  await dispatchAll(mockSql as never, ctx(), [enrollment], logger);

  const update = sqlCalls.find((c) => c.text.includes('UPDATE channel_enrollments'));
  expect(update, 'expected exactly one channel_enrollments UPDATE').toBeDefined();
  return update!;
}

beforeEach(() => {
  logger.log.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('flipEnrollmentStatus — byte-exact SQL characterization (8 variants)', () => {
  it('telegram_blocked / org-default (location_id IS NULL)', async () => {
    const u = await runFlip('telegram', '123456789', null, new TelegramRecipientBlockedError());
    expect(u.text).toBe(expectedFlipSql(UNSUBSCRIBE_SET('telegram_blocked'), 'telegram', IS_NULL));
    expect(u.values).toEqual([ACCOUNT_ID, '123456789']);
  });

  it('telegram_blocked / per-location override (location_id = <uuid>)', async () => {
    const u = await runFlip('telegram', '123456789', OVERRIDE_LOCATION_ID, new TelegramRecipientBlockedError());
    expect(u.text).toBe(expectedFlipSql(UNSUBSCRIBE_SET('telegram_blocked'), 'telegram', EQ_UUID));
    expect(u.values).toEqual([ACCOUNT_ID, '123456789', OVERRIDE_LOCATION_ID]);
  });

  it('telegram_chat_not_found / org-default (location_id IS NULL)', async () => {
    const u = await runFlip('telegram', '123456789', null, new TelegramChatNotFoundError());
    expect(u.text).toBe(expectedFlipSql(DISABLE_SET, 'telegram', IS_NULL));
    expect(u.values).toEqual([ACCOUNT_ID, '123456789']);
  });

  it('telegram_chat_not_found / per-location override (location_id = <uuid>)', async () => {
    const u = await runFlip('telegram', '123456789', OVERRIDE_LOCATION_ID, new TelegramChatNotFoundError());
    expect(u.text).toBe(expectedFlipSql(DISABLE_SET, 'telegram', EQ_UUID));
    expect(u.values).toEqual([ACCOUNT_ID, '123456789', OVERRIDE_LOCATION_ID]);
  });

  it('whatsapp_blocked / org-default (location_id IS NULL)', async () => {
    const u = await runFlip('whatsapp', '+15550000001', null, new WhatsAppRecipientBlockedError(63014));
    expect(u.text).toBe(expectedFlipSql(UNSUBSCRIBE_SET('whatsapp_blocked'), 'whatsapp', IS_NULL));
    expect(u.values).toEqual([ACCOUNT_ID, '+15550000001']);
  });

  it('whatsapp_blocked / per-location override (location_id = <uuid>)', async () => {
    const u = await runFlip('whatsapp', '+15550000001', OVERRIDE_LOCATION_ID, new WhatsAppRecipientBlockedError(63014));
    expect(u.text).toBe(expectedFlipSql(UNSUBSCRIBE_SET('whatsapp_blocked'), 'whatsapp', EQ_UUID));
    expect(u.values).toEqual([ACCOUNT_ID, '+15550000001', OVERRIDE_LOCATION_ID]);
  });

  it('whatsapp_invalid_recipient / org-default (location_id IS NULL)', async () => {
    const u = await runFlip('whatsapp', '+15550000001', null, new WhatsAppInvalidRecipientError(63024));
    expect(u.text).toBe(expectedFlipSql(DISABLE_SET, 'whatsapp', IS_NULL));
    expect(u.values).toEqual([ACCOUNT_ID, '+15550000001']);
  });

  it('whatsapp_invalid_recipient / per-location override (location_id = <uuid>)', async () => {
    const u = await runFlip('whatsapp', '+15550000001', OVERRIDE_LOCATION_ID, new WhatsAppInvalidRecipientError(63024));
    expect(u.text).toBe(expectedFlipSql(DISABLE_SET, 'whatsapp', EQ_UUID));
    expect(u.values).toEqual([ACCOUNT_ID, '+15550000001', OVERRIDE_LOCATION_ID]);
  });
});
