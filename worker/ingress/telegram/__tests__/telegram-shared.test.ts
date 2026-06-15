import { describe, it, expect } from 'vitest';
import { redactForAudit, type TelegramUpdate } from '../telegram-shared';

describe('redactForAudit (Codex R1 #9 — no raw user text in inbound_events)', () => {
  it('redacts an ARBITRARY free-text message body (not just /start)', () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        from: { id: 42 },
        chat: { id: 42, type: 'private' },
        text: 'hey can you change my reply to be funnier',
      },
    };
    const out = redactForAudit(update);
    const msg = out.message as { text?: unknown; from?: unknown; chat?: unknown };
    expect(msg.text).toBe('[redacted]');
    // Numeric ids + chat type survive (enrollment-relevant, non-PII).
    expect(msg.from).toEqual({ id: 42 });
    expect(msg.chat).toEqual({ id: 42, type: 'private' });
  });

  it('still redacts a /start token body', () => {
    const update: TelegramUpdate = {
      update_id: 2,
      message: { from: { id: 7 }, chat: { id: 7 }, text: '/start SECRET-TOKEN' },
    };
    const out = redactForAudit(update);
    expect((out.message as { text?: unknown }).text).toBe('[redacted]');
  });

  it('strips callback data + extra PII fields (regression guard for the existing behavior)', () => {
    const update = {
      update_id: 3,
      callback_query: {
        id: 'cb1',
        from: { id: 9, username: 'jane', first_name: 'Jane' },
        data: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
      },
    } as unknown as TelegramUpdate;
    const out = redactForAudit(update);
    const cb = out.callback_query as { data?: unknown; from?: unknown };
    expect(cb.data).toBe('[redacted]');
    expect(cb.from).toEqual({ id: 9 });
  });
});
