import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlResult, sqlCalls } = vi.hoisted(() => ({
  sqlResult: { rows: [] as unknown[] },
  sqlCalls: [] as string[],
}));
vi.mock('../../../src/lib/db/server', () => ({
  sql: async (strings: TemplateStringsArray) => {
    sqlCalls.push(strings.join('?'));
    return sqlResult.rows;
  },
}));

import {
  handleConversationalMessage,
  isAuthorizedConversationalSender,
} from '../conversational-seam';

const DAY_MS = 24 * 60 * 60 * 1000;
function accountRow(over: Record<string, unknown> = {}) {
  return { subscription_status: 'active', past_due_at: null, flags: {}, ...over };
}

beforeEach(() => {
  sqlResult.rows = [];
  sqlCalls.length = 0;
});

describe('conversational seam (Codex R1 #10 — auth boundary, no unauthenticated surface)', () => {
  it('TRUE for a verified enrollment on an active account; query is verified + non-archived, keyed by handle', async () => {
    sqlResult.rows = [accountRow({ subscription_status: 'active' })];
    expect(await isAuthorizedConversationalSender('telegram', '12345')).toBe(true);
    const q = sqlCalls.join(' ');
    expect(q).toContain('channel_enrollments');
    expect(q).toContain("status = 'verified'");
    expect(q).toContain('archived_at IS NULL');
    expect(q).toContain('ce.handle =');
  });

  it('FALSE for an unknown sender (no DB hit on empty handle)', async () => {
    expect(await isAuthorizedConversationalSender('whatsapp', '')).toBe(false);
    expect(sqlCalls).toHaveLength(0);
  });

  it('FALSE when no enrollment row matches', async () => {
    sqlResult.rows = [];
    expect(await isAuthorizedConversationalSender('telegram', '999')).toBe(false);
  });

  // Codex review P2: past_due must honor the shared guard's 7-day grace, not
  // authorize every past_due account.
  it('TRUE for past_due WITHIN the 7-day grace window', async () => {
    sqlResult.rows = [accountRow({ subscription_status: 'past_due', past_due_at: new Date(Date.now() - 1 * DAY_MS) })];
    expect(await isAuthorizedConversationalSender('telegram', '12345')).toBe(true);
  });

  it('FALSE for past_due BEYOND the 7-day grace window', async () => {
    sqlResult.rows = [accountRow({ subscription_status: 'past_due', past_due_at: new Date(Date.now() - 8 * DAY_MS) })];
    expect(await isAuthorizedConversationalSender('telegram', '12345')).toBe(false);
  });

  it('FALSE for a cancelled account', async () => {
    sqlResult.rows = [accountRow({ subscription_status: 'cancelled' })];
    expect(await isAuthorizedConversationalSender('telegram', '12345')).toBe(false);
  });

  it('handleConversationalMessage NO-OPs (no throw, no reply) for an authorized sender', async () => {
    sqlResult.rows = [accountRow({ subscription_status: 'active' })];
    await expect(
      handleConversationalMessage({ channel: 'telegram', senderHandle: '12345' }),
    ).resolves.toBeUndefined();
  });

  it('handleConversationalMessage NO-OPs for an unauthorized sender', async () => {
    sqlResult.rows = [];
    await expect(
      handleConversationalMessage({ channel: 'whatsapp', senderHandle: '+15550000009' }),
    ).resolves.toBeUndefined();
  });
});
