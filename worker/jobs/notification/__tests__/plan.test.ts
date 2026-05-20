import { describe, expect, it } from 'vitest';
import {
  buildNotificationDispatchPlan,
  orderNotificationDispatchEnrollments,
} from '../plan';

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

describe('orderNotificationDispatchEnrollments', () => {
  it('orders enrollments by notification plan without dropping duplicates', () => {
    const enrollments = [
      { channel: 'whatsapp' as const, handle: 'wa-1' },
      { channel: 'sms' as const, handle: 'sms-1' },
      { channel: 'email' as const, handle: 'email-1' },
      { channel: 'telegram' as const, handle: 'telegram-1' },
      { channel: 'sms' as const, handle: 'sms-2' },
    ];

    expect(orderNotificationDispatchEnrollments(enrollments)).toEqual([
      { channel: 'email', handle: 'email-1' },
      { channel: 'sms', handle: 'sms-1' },
      { channel: 'sms', handle: 'sms-2' },
      { channel: 'telegram', handle: 'telegram-1' },
      { channel: 'whatsapp', handle: 'wa-1' },
    ]);
  });
});
