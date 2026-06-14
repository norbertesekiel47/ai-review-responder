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

beforeEach(() => {
  sqlResult.rows = [];
  sqlCalls.length = 0;
});

describe('conversational seam (Codex R1 #10 — auth boundary, no unauthenticated surface)', () => {
  it('isAuthorizedConversationalSender is TRUE for a verified enrollment on a servable account', async () => {
    sqlResult.rows = [{ id: 'ce-1' }];
    expect(await isAuthorizedConversationalSender('telegram', '12345')).toBe(true);
    const q = sqlCalls.join(' ');
    expect(q).toContain('channel_enrollments');
    expect(q).toContain("status = 'verified'");
    expect(q).toContain('archived_at IS NULL');
    expect(q).toContain("subscription_status IN ('active', 'past_due')");
  });

  it('isAuthorizedConversationalSender is FALSE for an unknown sender (no DB hit on empty handle)', async () => {
    expect(await isAuthorizedConversationalSender('whatsapp', '')).toBe(false);
    expect(sqlCalls).toHaveLength(0);
  });

  it('isAuthorizedConversationalSender is FALSE when no enrollment row matches', async () => {
    sqlResult.rows = [];
    expect(await isAuthorizedConversationalSender('telegram', '999')).toBe(false);
  });

  it('handleConversationalMessage NO-OPs (no throw, no reply) for an authorized sender', async () => {
    sqlResult.rows = [{ id: 'ce-1' }];
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
