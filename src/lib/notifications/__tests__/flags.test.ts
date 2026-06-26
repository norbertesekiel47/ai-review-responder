import { afterEach, describe, expect, it } from 'vitest';
import { notificationFailoverDisabled } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('notificationFailoverDisabled', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase TRUE', 'TRUE'],
    ['mixed case True', 'True'],
    ['numeric 1', '1'],
    ['padded true', ' true '],
  ])('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env.NOTIFICATION_FAILOVER_DISABLED;
    else process.env.NOTIFICATION_FAILOVER_DISABLED = value;
    expect(notificationFailoverDisabled()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env.NOTIFICATION_FAILOVER_DISABLED = 'true';
    expect(notificationFailoverDisabled()).toBe(true);
  });
});
