import type postgres from 'postgres';
import {
  PURGE_VERIFICATION_TABLES,
  type AccountOffboardingDisposition,
  type PurgeVerificationMode,
} from './table-disposition';

export interface VerifyAccountOffboardingPurgeInput {
  accountId: string;
  offboardingId: string;
  currentOutboxId?: string | null;
  authUserId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  zernioAccountIds?: string[] | null;
  zernioProfileIds?: string[] | null;
}

export interface PurgeVerificationIssue {
  table: string;
  disposition: AccountOffboardingDisposition;
  purgeVerification: PurgeVerificationMode;
  violationCount: number;
  reason: string;
}

export interface PurgeVerificationResult {
  ok: boolean;
  issues: PurgeVerificationIssue[];
}

type VerificationRow = { violation_count: number | string | bigint };
type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export const PURGE_VERIFICATION_SQL_TABLES = Object.freeze(
  PURGE_VERIFICATION_TABLES.map((entry) => entry.table),
);

export async function verifyAccountOffboardingPurge(
  input: VerifyAccountOffboardingPurgeInput,
  exec: SqlExecutor,
): Promise<PurgeVerificationResult> {
  const issues: PurgeVerificationIssue[] = [];

  for (const entry of PURGE_VERIFICATION_TABLES) {
    // sequential account-scoped verification queries (parallel fan-out would contend on the same account's rows/locks)
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const violationCount = await countViolations(entry.table, input, exec);
    if (violationCount > 0) {
      issues.push({
        table: entry.table,
        disposition: entry.disposition,
        purgeVerification: entry.purgeVerification,
        violationCount,
        reason: entry.reason,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

async function countViolations(
  table: string,
  input: VerifyAccountOffboardingPurgeInput,
  exec: SqlExecutor,
): Promise<number> {
  const rows = await verificationQuery(table, input, exec);
  return Number(rows[0]?.violation_count ?? 0);
}

// Exported for the fail-closed guard test: a table added to the disposition
// inventory but missing a verification branch must throw, never silently pass.
export function verificationQuery(
  table: string,
  input: VerifyAccountOffboardingPurgeInput,
  exec: SqlExecutor,
): Promise<VerificationRow[]> {
  const {
    accountId,
    offboardingId,
    currentOutboxId,
    authUserId,
    stripeCustomerId,
    stripeSubscriptionId,
    zernioAccountIds,
    zernioProfileIds,
  } = input;

  switch (table) {
    case 'accounts':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM accounts
        WHERE id = ${accountId}::uuid
          AND (
            display_name <> 'Deleted account'
            OR stripe_customer_id IS NOT NULL
            OR stripe_subscription_id IS NOT NULL
            OR flags <> '{}'::jsonb
          )
      `;

    case 'businesses':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM businesses b
        WHERE b.id IN (SELECT id FROM account_businesses)
          AND (
            b.name <> 'Deleted location'
            OR b.owner_name <> 'Deleted owner'
            OR b.owner_email NOT LIKE ('deleted-' || b.id::text || '@repworth.invalid')
            OR b.owner_phone IS NOT NULL
            OR b.google_place_id IS NOT NULL
            OR b.google_maps_url IS NOT NULL
            OR b.products_services IS NOT NULL
            OR b.staff_names IS NOT NULL
            OR b.highlight_facts IS NOT NULL
            OR b.avoid_facts IS NOT NULL
            OR b.sample_responses IS NOT NULL
            OR b.google_place_address IS NOT NULL
            OR b.google_place_lat IS NOT NULL
            OR b.google_place_lng IS NOT NULL
            OR b.ranking_search_location IS NOT NULL
            OR b.website IS NOT NULL
            OR b.display_label IS NOT NULL
            OR b.tracked_keywords <> '[]'::jsonb
          )
      `;

    case 'users':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM users
        WHERE account_id = ${accountId}::uuid
          AND (
            auth_id IS NOT NULL
            OR name <> 'Deleted user'
            OR email NOT LIKE ('deleted-' || id::text || '@repworth.invalid')
            OR phone IS NOT NULL
          )
      `;

    case 'reviews':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM reviews
        WHERE business_id IN (SELECT id FROM account_businesses)
      `;

    case 'responses':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM responses
        WHERE business_id IN (SELECT id FROM account_businesses)
      `;

    case 'approval_links':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM approval_links
        WHERE business_id IN (SELECT id FROM account_businesses)
      `;

    case 'approval_audit_log':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM approval_audit_log
        WHERE account_id = ${accountId}::uuid
          AND (
            response_id IS NOT NULL
            OR token_hash IS NOT NULL
            OR device_cookie_hash IS NOT NULL
            OR ip_address IS NOT NULL
            OR metadata <> '{}'::jsonb
            OR actor_user_id IS NOT NULL
            OR response_text_at_approval IS NOT NULL
          )
      `;

    case 'account_audit_log':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM account_audit_log
        WHERE account_id = ${accountId}::uuid
          AND (
            actor_user_id IS NOT NULL
            OR location_id IS NOT NULL
            OR payload <> '{}'::jsonb
            OR entity_id IS NOT NULL
            OR ip IS NOT NULL
            OR user_agent IS NOT NULL
            OR request_id IS NOT NULL
          )
      `;

    case 'notification_deliveries':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM notification_deliveries
        WHERE (account_id = ${accountId}::uuid OR business_id IN (SELECT id FROM account_businesses))
      `;

    case 'channel_enrollments':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM channel_enrollments
        WHERE account_id = ${accountId}::uuid
           OR business_id IN (SELECT id FROM account_businesses)
           OR location_id IN (SELECT id FROM account_businesses)
      `;

    case 'zernio_connections':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM zernio_connections
        WHERE business_id IN (SELECT id FROM account_businesses)
      `;

    case 'zernio_finalize_incidents':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM zernio_finalize_incidents
        WHERE business_id IN (SELECT id FROM account_businesses)
          AND (
            zernio_profile_id NOT LIKE 'scrubbed:%'
            OR flow_id NOT LIKE 'scrubbed:%'
            OR zernio_account_id IS NOT NULL
            OR zernio_location_id IS NOT NULL
            OR resolution_notes IS NOT NULL
          )
      `;

    case 'zernio_backfill_runs':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM zernio_backfill_runs
        WHERE business_id IN (SELECT id FROM account_businesses)
          AND (
            zernio_account_id NOT LIKE 'scrubbed:%'
            OR zernio_location_id NOT LIKE 'scrubbed:%'
          )
      `;

    case 'weekly_summaries':
      return absentByBusiness('weekly_summaries', accountId, exec);
    case 'monthly_impact_emails':
      return absentByBusiness('monthly_impact_emails', accountId, exec);
    case 'ranking_snapshots':
      return absentByBusiness('ranking_snapshots', accountId, exec);
    case 'onboarding_drip_log':
      return absentByBusiness('onboarding_drip_log', accountId, exec);
    case 'onboarding_demos':
      return absentByBusiness('onboarding_demos', accountId, exec);
    case 'satisfaction_responses':
      return absentByBusiness('satisfaction_responses', accountId, exec);
    case 'google_connections':
      return absentByBusiness('google_connections', accountId, exec);

    case 'review_exceptions':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM review_exceptions
        WHERE business_id IN (SELECT id FROM account_businesses)
          AND (
            review_id IS NOT NULL
            OR response_id IS NOT NULL
            OR payload <> '{}'::jsonb
          )
      `;

    case 'auto_approval_policies':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM auto_approval_policies
        WHERE account_id = ${accountId}::uuid
      `;

    case 'api_costs':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM api_costs
        WHERE (
            account_id = ${accountId}::uuid
            OR business_id IN (SELECT id FROM account_businesses)
            OR endpoint LIKE 'scrubbed:%'
          )
          AND (
            account_id IS NOT NULL
            OR business_id IS NOT NULL
            OR response_id IS NOT NULL
            OR endpoint NOT LIKE 'scrubbed:%'
            OR output_excerpt IS NOT NULL
            OR flag_reason IS NOT NULL
            OR moderation_categories IS NOT NULL
          )
      `;

    case 'api_costs_daily_rollups':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM api_costs_daily_rollups
        WHERE business_id IN (SELECT id FROM account_businesses)
      `;

    case 'analytics_events':
      return exec<VerificationRow[]>`
        WITH scoped_events AS (
          SELECT id
          FROM analytics_events
          WHERE account_id = ${accountId}::uuid
             OR business_id IN (SELECT id FROM businesses WHERE account_id = ${accountId}::uuid)
             OR user_id IN (SELECT id FROM users WHERE account_id = ${accountId}::uuid)
             -- Mirror the FK-independent scrub pass so a residual raw-UUID
             -- distinct_id with no FK and no 'scrubbed:' prefix stays in scope and
             -- fails verification closed if the scrub ever regresses.
             OR distinct_id IN (${accountId}, ${`account:${accountId}`})
             OR event_key LIKE 'scrubbed:%'
             OR distinct_id LIKE 'scrubbed:%'
        )
        SELECT COUNT(*) AS violation_count
        FROM analytics_events
        WHERE id IN (SELECT id FROM scoped_events)
          AND (
            account_id IS NOT NULL
            OR business_id IS NOT NULL
            OR user_id IS NOT NULL
            OR properties <> '{}'::jsonb
            OR anonymous_id IS NOT NULL
            OR last_error IS NOT NULL
            OR distinct_id NOT LIKE 'scrubbed:%'
          )
      `;

    case 'inbound_events':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id::text AS id FROM businesses WHERE account_id = ${accountId}::uuid
        ),
        offboarding_scope AS (
          SELECT id::text AS identifier FROM account_businesses
          UNION ALL SELECT ${accountId}::text
          UNION ALL SELECT ${offboardingId}::text
          UNION ALL SELECT ${authUserId ?? null}::text
          UNION ALL SELECT ${stripeCustomerId ?? null}::text
          UNION ALL SELECT ${stripeSubscriptionId ?? null}::text
          UNION ALL SELECT UNNEST(${zernioAccountIds ?? []}::text[])
          UNION ALL SELECT UNNEST(${zernioProfileIds ?? []}::text[])
        )
        SELECT COUNT(*) AS violation_count
        FROM inbound_events
        WHERE EXISTS (
          SELECT 1
          FROM offboarding_scope s
          WHERE s.identifier IS NOT NULL
            AND length(btrim(s.identifier)) > 0
            AND (
              payload::text LIKE ('%' || s.identifier || '%')
              OR aggregate_key LIKE ('%' || s.identifier || '%')
              OR error_message LIKE ('%' || s.identifier || '%')
            )
        )
      `;

    case 'job_outbox':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id::text AS id FROM businesses WHERE account_id = ${accountId}::uuid
        ),
        offboarding_scope AS (
          SELECT id::text AS identifier FROM account_businesses
          UNION ALL SELECT ${accountId}::text
          UNION ALL SELECT ${offboardingId}::text
          UNION ALL SELECT ${authUserId ?? null}::text
          UNION ALL SELECT ${stripeCustomerId ?? null}::text
          UNION ALL SELECT ${stripeSubscriptionId ?? null}::text
          UNION ALL SELECT UNNEST(${zernioAccountIds ?? []}::text[])
          UNION ALL SELECT UNNEST(${zernioProfileIds ?? []}::text[])
        ),
        job_outbox_scrub_scope AS (
          SELECT scope.value->>'job_outbox_id' AS job_outbox_id
          FROM account_offboardings ao
          CROSS JOIN LATERAL jsonb_array_elements(ao.provider_dispositions) AS scope(value)
          WHERE ao.id = ${offboardingId}::uuid
            AND ao.account_id = ${accountId}::uuid
            AND scope.value->>'type' = 'job_outbox_scrub_scope'
        )
        SELECT COUNT(*) AS violation_count
        FROM job_outbox
        WHERE (
          ${currentOutboxId ?? null}::uuid IS NULL
          OR id <> ${currentOutboxId ?? null}::uuid
        )
          AND (
            EXISTS (
              SELECT 1
              FROM offboarding_scope s
              WHERE s.identifier IS NOT NULL
                AND length(btrim(s.identifier)) > 0
                AND (
                  payload::text LIKE ('%' || s.identifier || '%')
                  OR aggregate_id::text = s.identifier
                  OR last_error LIKE ('%' || s.identifier || '%')
                )
            )
            OR (
              EXISTS (
                SELECT 1
                FROM job_outbox_scrub_scope scope
                WHERE job_outbox.id::text = scope.job_outbox_id
              )
              AND (
                aggregate_id IS NOT NULL
                OR payload <> '{}'::jsonb
                OR last_error IS NOT NULL
                OR status NOT IN ('completed', 'failed')
              )
            )
          )
      `;

    case 'flagged_responses':
      return exec<VerificationRow[]>`
        WITH account_businesses AS (
          SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
        )
        SELECT COUNT(*) AS violation_count
        FROM flagged_responses
        WHERE account_id = ${accountId}::uuid
           OR business_id IN (SELECT id FROM account_businesses)
      `;

    case 'impersonation_sessions':
      return exec<VerificationRow[]>`
        WITH impersonation_scrub_scope AS (
          SELECT scope.value->>'impersonation_session_id' AS impersonation_session_id
          FROM account_offboardings ao
          CROSS JOIN LATERAL jsonb_array_elements(ao.provider_dispositions) AS scope(value)
          WHERE ao.id = ${offboardingId}::uuid
            AND ao.account_id = ${accountId}::uuid
            AND scope.value->>'type' = 'impersonation_session_scrub_scope'
        )
        SELECT COUNT(*) AS violation_count
        FROM impersonation_sessions s
        WHERE (
          account_id = ${accountId}::uuid
          OR impersonated_user_id IN (
            SELECT id FROM users WHERE account_id = ${accountId}::uuid
          )
          OR EXISTS (
            SELECT 1
            FROM impersonation_scrub_scope scope
            WHERE s.id::text = scope.impersonation_session_id
          )
        )
          AND (
            account_id IS NOT NULL
            OR impersonated_user_id IS NOT NULL
            OR
            ticket_id NOT LIKE 'scrubbed:%'
            OR reason <> 'account purged'
            OR ended_at IS NULL
          )
      `;

    case 'prospect_demos':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM prospect_demos
        WHERE created_by IN (SELECT id FROM users WHERE account_id = ${accountId}::uuid)
      `;

    case 'account_offboardings':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM account_offboardings
        WHERE id = ${offboardingId}::uuid
          AND account_id = ${accountId}::uuid
          AND (
            recipient_email IS NOT NULL
            OR stripe_customer_id IS NOT NULL
            OR stripe_subscription_id IS NOT NULL
            OR zernio_account_ids IS NOT NULL
            OR zernio_profile_ids IS NOT NULL
            OR auth_user_id IS NOT NULL
            OR last_error IS NOT NULL
          )
      `;

    case 'account_offboarding_tokens':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM account_offboarding_tokens
        WHERE account_offboarding_id = ${offboardingId}::uuid
      `;

    default:
      throw new Error(`missing_purge_verification_sql:${table}`);
  }
}

// Verification twin of DELETABLE_BY_BUSINESS: count any surviving rows whose business
// belongs to the account. Allowlisted so the dynamic table identifier is never untrusted.
const ABSENT_BY_BUSINESS_TABLES = new Set<string>([
  'weekly_summaries',
  'monthly_impact_emails',
  'ranking_snapshots',
  'onboarding_drip_log',
  'onboarding_demos',
  'satisfaction_responses',
  'google_connections',
]);

export function absentByBusiness(
  tableName: string,
  accountId: string,
  exec: SqlExecutor,
): Promise<VerificationRow[]> {
  if (!ABSENT_BY_BUSINESS_TABLES.has(tableName)) {
    throw new Error(`missing_absent_by_business_sql:${tableName}`);
  }
  return exec<VerificationRow[]>`
    WITH account_businesses AS (
      SELECT id FROM businesses WHERE account_id = ${accountId}::uuid
    )
    SELECT COUNT(*) AS violation_count FROM ${exec(tableName)}
    WHERE business_id IN (SELECT id FROM account_businesses)
  `;
}

