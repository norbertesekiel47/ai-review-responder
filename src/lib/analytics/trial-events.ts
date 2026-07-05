// src/lib/analytics/trial-events.ts
//
// Durable, server-side trial lifecycle analytics facts. Enqueued IN the same
// Postgres transaction as the subscription-status projection write (the
// transactional-outbox invariant), so a status flip and its analytics fact
// commit together. Deterministic event keys make replays (BullMQ retry / Stripe
// webhook redelivery) idempotent via ON CONFLICT (event_key) DO NOTHING.
//
// Keying (PLAN.md §0.2 lean-abuse posture): trial_started is keyed by accountId
// alone (one trial-start fact per account; residual multi-account abuse is
// accepted). The conversion/failure/cancellation facts are keyed by
// (accountId, stripeSubscriptionId) so a re-trial on a NEW subscription emits a
// fresh lifecycle fact rather than colliding with the prior trial's.

import type { Sql, TransactionSql } from 'postgres';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';

type SqlExecutor = Sql | TransactionSql;

interface TrialStartInput {
  accountId: string;
  userId?: string | null;
}

interface TrialSubscriptionEventInput {
  accountId: string;
  stripeSubscriptionId: string;
  userId?: string | null;
}

export async function enqueueTrialStarted(
  db: SqlExecutor,
  input: TrialStartInput,
): Promise<void> {
  await enqueueAnalyticsEvent(db, {
    eventName: 'trial_started',
    eventKey: makeAnalyticsEventKey('trial_started', [input.accountId]),
    distinctId: input.accountId,
    accountId: input.accountId,
    userId: input.userId ?? null,
    properties: { status: 'trialing' },
  });
}

export async function enqueueTrialConverted(
  db: SqlExecutor,
  input: TrialSubscriptionEventInput,
): Promise<void> {
  await enqueueAnalyticsEvent(db, {
    eventName: 'trial_converted',
    eventKey: makeAnalyticsEventKey('trial_converted', [input.accountId, input.stripeSubscriptionId]),
    distinctId: input.accountId,
    accountId: input.accountId,
    userId: input.userId ?? null,
    properties: { status: 'active' },
  });
}

export async function enqueueTrialPaymentFailed(
  db: SqlExecutor,
  input: TrialSubscriptionEventInput,
): Promise<void> {
  await enqueueAnalyticsEvent(db, {
    eventName: 'trial_payment_failed',
    eventKey: makeAnalyticsEventKey('trial_payment_failed', [input.accountId, input.stripeSubscriptionId]),
    distinctId: input.accountId,
    accountId: input.accountId,
    userId: input.userId ?? null,
    properties: { status: 'past_due' },
  });
}

export async function enqueueTrialCancelled(
  db: SqlExecutor,
  input: TrialSubscriptionEventInput,
): Promise<void> {
  await enqueueAnalyticsEvent(db, {
    eventName: 'trial_cancelled',
    eventKey: makeAnalyticsEventKey('trial_cancelled', [input.accountId, input.stripeSubscriptionId]),
    distinctId: input.accountId,
    accountId: input.accountId,
    userId: input.userId ?? null,
    properties: { status: 'cancelled' },
  });
}
