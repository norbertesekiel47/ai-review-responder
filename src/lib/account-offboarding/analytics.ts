import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import type { AccountOffboardingMode } from './types';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

interface OffboardingLifecycleEventInput {
  accountId: string;
  actorUserId?: string | null;
  offboardingId: string;
}

export async function enqueueOffboardingStarted(
  db: SqlExecutor,
  input: OffboardingLifecycleEventInput & { mode: AccountOffboardingMode },
): Promise<void> {
  await enqueueAnalyticsEvent(db, {
    eventName: 'offboarding_started',
    eventKey: makeAnalyticsEventKey('offboarding_started', [input.offboardingId]),
    distinctId: input.accountId,
    accountId: input.accountId,
    userId: input.actorUserId ?? null,
    properties: {
      mode: input.mode,
      status: 'pending',
    },
  });
}

export async function enqueueOffboardingReactivated(
  db: SqlExecutor,
  input: OffboardingLifecycleEventInput,
): Promise<void> {
  await enqueueAnalyticsEvent(db, {
    eventName: 'offboarding_reactivated',
    eventKey: makeAnalyticsEventKey('offboarding_reactivated', [input.offboardingId]),
    distinctId: input.accountId,
    accountId: input.accountId,
    userId: input.actorUserId ?? null,
    properties: {
      mode: 'cancel_only',
      status: 'reactivated',
    },
  });
}

export async function enqueueOffboardingTeardownCompleted(
  db: SqlExecutor,
  input: OffboardingLifecycleEventInput & {
    mode: AccountOffboardingMode;
    status: 'churned' | 'purge_scheduled';
  },
): Promise<void> {
  await enqueueAnalyticsEvent(db, {
    eventName: 'offboarding_teardown_completed',
    eventKey: makeAnalyticsEventKey('offboarding_teardown_completed', [input.offboardingId]),
    distinctId: input.accountId,
    accountId: input.accountId,
    userId: input.actorUserId ?? null,
    properties: {
      mode: input.mode,
      status: input.status,
    },
  });
}

export async function enqueueOffboardingPurged(
  db: SqlExecutor,
  input: { offboardingId: string },
): Promise<void> {
  const offboardingHash = createHash('sha256').update(input.offboardingId).digest('hex');
  await enqueueAnalyticsEvent(db, {
    eventName: 'offboarding_purged',
    eventKey: makeAnalyticsEventKey('offboarding_purged', [offboardingHash]),
    distinctId: `offboarding:${offboardingHash}`,
    properties: {},
  });
}
