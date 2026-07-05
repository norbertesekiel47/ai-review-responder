import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnqueueAnalyticsEvent } = vi.hoisted(() => ({
  mockEnqueueAnalyticsEvent: vi.fn(),
}));

vi.mock('@/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: mockEnqueueAnalyticsEvent,
}));

import {
  enqueueOffboardingPurged,
  enqueueOffboardingReactivated,
  enqueueOffboardingStarted,
  enqueueOffboardingTeardownCompleted,
} from '../analytics';

const ACCOUNT_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const OFFBOARDING_ID = '00000000-0000-7000-8000-000000000003';

describe('account offboarding analytics', () => {
  beforeEach(() => {
    mockEnqueueAnalyticsEvent.mockReset();
    mockEnqueueAnalyticsEvent.mockResolvedValue(undefined);
  });

  it('enqueues offboarding_started as an account-scoped durable server event', async () => {
    const tx = vi.fn();

    await enqueueOffboardingStarted(tx as never, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      offboardingId: OFFBOARDING_ID,
      mode: 'delete_data',
    });

    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(tx, {
      eventName: 'offboarding_started',
      eventKey: `offboarding_started:${OFFBOARDING_ID}`,
      distinctId: ACCOUNT_ID,
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      properties: {
        mode: 'delete_data',
        status: 'pending',
      },
    });
  });

  it('enqueues reactivation and teardown completion with lifecycle properties only', async () => {
    const tx = vi.fn();

    await enqueueOffboardingReactivated(tx as never, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      offboardingId: OFFBOARDING_ID,
    });
    await enqueueOffboardingTeardownCompleted(tx as never, {
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      mode: 'cancel_only',
      status: 'churned',
    });

    expect(mockEnqueueAnalyticsEvent).toHaveBeenNthCalledWith(1, tx, {
      eventName: 'offboarding_reactivated',
      eventKey: `offboarding_reactivated:${OFFBOARDING_ID}`,
      distinctId: ACCOUNT_ID,
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      properties: {
        mode: 'cancel_only',
        status: 'reactivated',
      },
    });
    expect(mockEnqueueAnalyticsEvent).toHaveBeenNthCalledWith(2, tx, {
      eventName: 'offboarding_teardown_completed',
      eventKey: `offboarding_teardown_completed:${OFFBOARDING_ID}`,
      distinctId: ACCOUNT_ID,
      accountId: ACCOUNT_ID,
      userId: null,
      properties: {
        mode: 'cancel_only',
        status: 'churned',
      },
    });
  });

  it('de-identifies offboarding_purged and does not retain scoped identifiers or properties', async () => {
    const tx = vi.fn();
    const offboardingHash = createHash('sha256').update(OFFBOARDING_ID).digest('hex');

    await enqueueOffboardingPurged(tx as never, {
      offboardingId: OFFBOARDING_ID,
    });

    const [db, eventInput] = mockEnqueueAnalyticsEvent.mock.calls[0]!;
    expect(db).toBe(tx);
    expect(eventInput).toEqual({
      eventName: 'offboarding_purged',
      eventKey: `offboarding_purged:${offboardingHash}`,
      distinctId: `offboarding:${offboardingHash}`,
      properties: {},
    });
    expect(JSON.stringify(eventInput)).not.toContain(OFFBOARDING_ID);
    expect(JSON.stringify(eventInput)).not.toContain(ACCOUNT_ID);
    expect(JSON.stringify(eventInput)).not.toContain(USER_ID);
  });
});
