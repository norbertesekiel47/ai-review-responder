import type { Sql } from 'postgres';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import type { failOnboardingDemoTerminal } from './terminal';

/**
 * Inverted subscription guard for the onboarding demo: if the owner paid
 * between /start and now, the demo is no longer relevant. Marks it failed with
 * `subscription_state_changed` so /onboarding/demo can render a graceful
 * notice — NOT `completeDemo` with empty arrays, which would lock the owner
 * out via the partial-unique-on-completed index.
 *
 * Returns true when it handled the job and the caller must return.
 *
 * `failTerminal` is injected rather than imported so the package's single test
 * file can drive this guard while its own `failOnboardingDemoTerminal` describe
 * block keeps testing the real implementation.
 */
export async function guardOnboardingDemoSubscription(input: {
  sql: Sql;
  demoId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: { warn(message: string): void; error(message: string): void };
  releaseReservation: () => Promise<void>;
  failTerminal: typeof failOnboardingDemoTerminal;
}): Promise<boolean> {
  const [biz] = await input.sql<{ subscription_status: string }[]>`
    SELECT a.subscription_status
    FROM onboarding_demos od
    JOIN businesses b ON b.id = od.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE od.id = ${input.demoId}
  `;

  // A MISSING row is not a changed subscription. The demo may have been
  // deleted, or its business/account gone; claimDemo reports `not_found` a
  // moment later and the job completes cleanly. Only an existing row with a
  // non-pending status fires the guard.
  if (!biz || biz.subscription_status === SubscriptionStatus.PENDING_PAYMENT) {
    return false;
  }

  input.logger.warn(
    `Demo ${input.demoId} account status=${biz.subscription_status}, marking failed`,
  );
  try {
    await input.failTerminal({
      sql: input.sql,
      demoId: input.demoId,
      outboxId: input.outboxId,
      // Forwarding this is load-bearing: failDemo adds `AND attempts = $n` only
      // when it is a number, and that predicate is what stops a stale worker
      // from failing a newer dispatch.
      outboxAttempt: input.outboxAttempt,
      error: new Error('subscription_state_changed'),
      failureKind: 'subscription_state_changed',
      logger: input.logger,
    });
  } finally {
    // Release before the re-throw propagates: failTerminal re-throws when the
    // failure record itself cannot be written, and the 20¢ reserve must not
    // leak on that path.
    await input.releaseReservation();
  }
  return true;
}
