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
        telegram: { enabled: false },
        whatsapp: { enabled: true },
      }),
    ).toEqual(['email', 'whatsapp']);
  });

  it('returns an empty plan when every channel is disabled', () => {
    expect(
      buildNotificationDispatchPlan({
        email: { enabled: false },
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
      { channel: 'telegram' as const, handle: 'tg-2' },
      { channel: 'email' as const, handle: 'email-1' },
      { channel: 'telegram' as const, handle: 'tg-1' },
    ];

    expect(orderNotificationDispatchEnrollments(enrollments)).toEqual([
      { channel: 'email', handle: 'email-1' },
      { channel: 'telegram', handle: 'tg-2' },
      { channel: 'telegram', handle: 'tg-1' },
      { channel: 'whatsapp', handle: 'wa-1' },
    ]);
  });

  it('drops unknown-channel enrollments and does not throw', () => {
    const enrollments = [
      { channel: 'email' as const, handle: 'email-1' },
      { channel: 'sms' as never, handle: 'sms-1' },
      { channel: 'whatsapp' as const, handle: 'wa-1' },
    ];

    expect(() => orderNotificationDispatchEnrollments(enrollments)).not.toThrow();
    expect(orderNotificationDispatchEnrollments(enrollments)).toEqual([
      { channel: 'email', handle: 'email-1' },
      { channel: 'whatsapp', handle: 'wa-1' },
    ]);
  });
});
