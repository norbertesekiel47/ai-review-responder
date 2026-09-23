import type postgres from 'postgres';
import {
  PAST_DUE_EXTENSION_TIMESTAMP_PATTERN,
  PAST_DUE_GRACE_DAYS,
} from './past-due-recovery';
import { SubscriptionStatus } from './subscription-status';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

/**
 * SQL counterpart of checkSubscription(..., workerType: 'publisher') for
 * bounded global candidate scans. Alias contract: the accounts table is `a`.
 * The CASE guards casts so malformed optional extension JSON fails closed
 * instead of aborting the whole fleet-health/sweep query. It is PostgreSQL
 * 15-compatible: fixed-width UTC timestamps are calendar-validated with
 * exception-free integer arithmetic, then compared lexicographically to the
 * same fixed-width UTC representation of NOW(). No timestamp cast is needed.
 */
export function publisherSubscriptionEligibleSql(exec: SqlExecutor) {
  return exec`(
    a.subscription_status IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.TRIALING})
    OR (
      a.subscription_status = ${SubscriptionStatus.PAST_DUE}
      AND a.past_due_at IS NOT NULL
      AND (
        a.past_due_at > NOW() - make_interval(days => ${PAST_DUE_GRACE_DAYS})
        OR CASE
          WHEN jsonb_typeof(a.flags->'past_due_extension') = 'object'
          THEN CASE
            WHEN jsonb_typeof(a.flags->'past_due_extension'->'days') = 'number'
            THEN CASE
              WHEN (a.flags->'past_due_extension'->>'days')::numeric > 0
                AND (a.flags->'past_due_extension'->>'days')::numeric <= 30
                AND jsonb_typeof(a.flags->'past_due_extension'->'expires_at') = 'string'
              THEN CASE
                WHEN (a.flags->'past_due_extension'->>'expires_at')
                  ~ ${PAST_DUE_EXTENSION_TIMESTAMP_PATTERN}
                THEN CASE
                  WHEN substring(a.flags->'past_due_extension'->>'expires_at' FROM 9 FOR 2)::int
                    <= CASE substring(a.flags->'past_due_extension'->>'expires_at' FROM 6 FOR 2)::int
                      WHEN 2 THEN CASE
                        WHEN (
                          substring(a.flags->'past_due_extension'->>'expires_at' FROM 1 FOR 4)::int % 400 = 0
                          OR (
                            substring(a.flags->'past_due_extension'->>'expires_at' FROM 1 FOR 4)::int % 4 = 0
                            AND substring(a.flags->'past_due_extension'->>'expires_at' FROM 1 FOR 4)::int % 100 <> 0
                          )
                        ) THEN 29 ELSE 28
                      END
                      WHEN 4 THEN 30
                      WHEN 6 THEN 30
                      WHEN 9 THEN 30
                      WHEN 11 THEN 30
                      ELSE 31
                    END
                  THEN (a.flags->'past_due_extension'->>'expires_at')
                    > to_char(
                      NOW() AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                    )
                  ELSE FALSE
                END
                ELSE FALSE
              END
              ELSE FALSE
            END
            ELSE FALSE
          END
          ELSE FALSE
        END
      )
    )
  )`;
}
