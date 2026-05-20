import { describe, expect, it } from 'vitest';
import { buildNotificationDispatchPlan } from '../plan';

describe('buildNotificationDispatchPlan', () => {
  it('returns enabled channels in deterministic order', () => {
    expect(
      buildNotificationDispatchPlan({
        email: { enabled: true },
        sms: { enabled: true },
        telegram: { enabled: false },
        whatsapp: { enabled: true },
      }),
    ).toEqual(['email', 'sms', 'whatsapp']);
  });

  it('returns an empty plan when every channel is disabled', () => {
    expect(
      buildNotificationDispatchPlan({
        email: { enabled: false },
        sms: { enabled: false },
        telegram: { enabled: false },
        whatsapp: { enabled: false },
      }),
    ).toEqual([]);
  });
});
