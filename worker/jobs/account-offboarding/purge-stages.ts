import type postgres from 'postgres';
import { jsonb, sql, supabaseServer } from '../../../src/lib/db/server';
import { verifyAccountOffboardingPurge } from '../../../src/lib/account-offboarding/purge-verification';
import {
  extractConcreteAdminProviderDispositions,
  hasConcreteAdminProviderDisposition,
  unresolvedApplicableTeardownProviders,
} from '../../../src/lib/account-offboarding/provider-disposition';
import { enqueueOffboardingPurged } from '../../../src/lib/account-offboarding/analytics';
import { enqueueAccountOffboardingEmail } from '../../../src/lib/account-offboarding/outbox';
import {
  deleteByBusiness,
  impersonationSessionScrubScopeRecord,
  isSupabaseAuthNotFound,
  jobOutboxScrubScopeRecord,
  safeSupabaseError,
} from './purge-helpers';

export interface AccountOffboardingPurgeRow {
  id: string;
  account_id: string;
  mode: 'delete_data';
  status: 'purge_scheduled' | 'purged' | 'failed';
  terminal_at: Date | string | null;
  teardown_completed_at: Date | string | null;
  purge_started_at: Date | string | null;
  purge_cancelled_at: Date | string | null;
  auth_user_id: string | null;
  recipient_email: string | null;
  provider_dispositions: unknown;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  location_ids: string[] | null;
  stripe_step: string | null;
  zernio_accounts_step: string | null;
  zernio_profiles_step: string | null;
  location_archival_step: string | null;
}

interface AuthRevalidationRow {
  can_delete: boolean;
  already_detached: boolean;
}

class StaleOutboxAttemptError extends Error {
  constructor() {
    super('account_offboarding_purge_stale_outbox_attempt');
    this.name = 'StaleOutboxAttemptError';
  }
}

export function isStaleOutboxAttemptError(err: unknown): boolean {
  return err instanceof StaleOutboxAttemptError;
}

export async function loadPurgeOffboarding(
  accountOffboardingId: string,
  accountId: string,
): Promise<AccountOffboardingPurgeRow | null> {
  const [row] = await sql<AccountOffboardingPurgeRow[]>`
    SELECT id, account_id, mode, status, terminal_at, teardown_completed_at,
           purge_started_at, purge_cancelled_at, auth_user_id,
           recipient_email, provider_dispositions, stripe_customer_id,
           stripe_subscription_id, zernio_account_ids, zernio_profile_ids,
           location_ids, stripe_step, zernio_accounts_step, zernio_profiles_step,
           location_archival_step
    FROM account_offboardings
    WHERE id = ${accountOffboardingId}::uuid
      AND account_id = ${accountId}::uuid
  `;
  return row ?? null;
}

export function validatePurgeableOffboarding(
  row: AccountOffboardingPurgeRow,
): string | null {
  if (row.mode !== 'delete_data') return 'account_offboarding_mode_not_delete_data';
  if (row.status !== 'purge_scheduled') {
    return `account_offboarding_status_not_purgeable:${row.status}`;
  }
  if (row.terminal_at !== null) return 'account_offboarding_already_terminal';
  if (row.purge_cancelled_at !== null) return 'account_offboarding_purge_cancelled';
  if (row.purge_started_at === null) return 'account_offboarding_purge_not_started';
  if (row.teardown_completed_at === null) {
    // Teardown did not complete normally — this row reached purge_scheduled via an
    // admin force-transition. Re-assert the same invariant that gate enforces, as
    // defense-in-depth before the irreversible purge: there must be a concrete
    // disposition, AND it (plus any others) must cover EVERY applicable provider
    // resource the teardown left unresolved. Otherwise a purge would destroy the
    // local pointers to a live provider resource that was never torn down.
    if (!hasConcreteAdminProviderDisposition(row.provider_dispositions)) {
      return 'account_offboarding_teardown_incomplete';
    }
    const unresolved = unresolvedApplicableTeardownProviders(
      row,
      extractConcreteAdminProviderDispositions(row.provider_dispositions),
    );
    if (unresolved.length > 0) {
      return 'account_offboarding_teardown_incomplete';
    }
  }
  return null;
}

export async function runAuthBindingPurgeStage(
  row: AccountOffboardingPurgeRow,
): Promise<void> {
  if (!row.auth_user_id?.trim()) return;

  const authUserId = row.auth_user_id;
  const resolution = await revalidateAuthBinding(row, authUserId);
  if (resolution === 'already_detached') return;

  const result = await supabaseServer.auth.admin.deleteUser(authUserId);
  if (result.error && !isSupabaseAuthNotFound(result.error)) {
    throw new Error(`supabase_delete_user_failed:${safeSupabaseError(result.error)}`);
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE users
      SET auth_id = NULL,
          updated_at = NOW()
      WHERE account_id = ${row.account_id}::uuid
        AND auth_id = ${authUserId}
    `;
  });
}

async function revalidateAuthBinding(
  row: AccountOffboardingPurgeRow,
  authUserId: string,
): Promise<'delete_required' | 'already_detached'> {
  const [match] = await sql.begin(async (tx) => tx<AuthRevalidationRow[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM users u
        WHERE u.auth_id = ${authUserId}
          AND u.account_id = ${row.account_id}::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM users future_binding
            WHERE future_binding.auth_id = ${authUserId}
              AND future_binding.account_id <> ${row.account_id}::uuid
          )
      ) AS can_delete,
      NOT EXISTS (
        SELECT 1
        FROM users u
        WHERE u.account_id = ${row.account_id}::uuid
          AND u.auth_id IS NOT NULL
      ) AS already_detached
  `);

  if (match?.can_delete) return 'delete_required';
  if (match?.already_detached) return 'already_detached';

  throw new Error('account_offboarding_auth_revalidation_failed');
}

export async function runDependentReferencePurgeStage(row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin); they execute
    // serially on a single connection and cannot be parallelized.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await tx`
      DELETE FROM account_offboarding_tokens t
      USING account_offboardings ao
      WHERE t.account_offboarding_id = ao.id
        AND ao.id = ${row.id}::uuid
        AND ao.account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE approval_audit_log
      SET response_id = NULL,
          token_hash = NULL,
          device_cookie_hash = NULL,
          ip_address = NULL,
          metadata = '{}'::jsonb,
          actor_user_id = NULL,
          response_text_at_approval = NULL
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM notification_deliveries nd
      WHERE nd.account_id = ${row.account_id}::uuid
         OR nd.business_id IN (
           SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid
         )
    `;
    await tx`
      UPDATE api_costs
      SET account_id = NULL,
          business_id = NULL,
          response_id = NULL,
          endpoint = 'scrubbed:' || id::text,
          moderation_categories = NULL,
          flag_reason = NULL,
          output_excerpt = NULL
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE api_costs ac
      SET account_id = NULL,
          business_id = NULL,
          response_id = NULL,
          endpoint = 'scrubbed:' || ac.id::text,
          moderation_categories = NULL,
          flag_reason = NULL,
          output_excerpt = NULL
      FROM businesses b
      WHERE ac.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE review_exceptions re
      SET review_id = NULL,
          response_id = NULL,
          payload = '{}'::jsonb
      FROM businesses b
      WHERE re.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
  });
}

export async function runContentPurgeStage(row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin); they execute
    // serially on a single connection and cannot be parallelized.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await tx`
      DELETE FROM flagged_responses
      WHERE account_id = ${row.account_id}::uuid
    `;
    await deleteByBusiness(tx, 'approval_links', row.account_id);
    await deleteByBusiness(tx, 'responses', row.account_id);
    await deleteByBusiness(tx, 'reviews', row.account_id);
    await deleteByBusiness(tx, 'weekly_summaries', row.account_id);
    await deleteByBusiness(tx, 'monthly_impact_emails', row.account_id);
    await deleteByBusiness(tx, 'ranking_snapshots', row.account_id);
    await deleteByBusiness(tx, 'onboarding_drip_log', row.account_id);
    await deleteByBusiness(tx, 'onboarding_demos', row.account_id);
    await deleteByBusiness(tx, 'satisfaction_responses', row.account_id);
    await deleteByBusiness(tx, 'google_connections', row.account_id);
    await tx`
      DELETE FROM prospect_demos
      WHERE created_by IN (
        SELECT id FROM users WHERE account_id = ${row.account_id}::uuid
      )
    `;
  });
}

// Scrubs raw account-linked content out of the schemaless payload columns of
// inbound_events + job_outbox. Because those payloads are unstructured JSON, the
// scope identifiers are matched with a substring LIKE over payload::text rather
// than a structured key lookup. This is an accepted tradeoff: the identifiers are
// UUIDs / Stripe ids / Zernio ids (effectively unique high-entropy strings), so a
// cross-account false-positive scrub is vanishingly unlikely, and the verification
// twin (purge-verification.ts) checks the same scope shape on the read side so the
// purge cannot stamp purged_at while a matching raw identifier survives.
export async function runRawPayloadPurgeStage(
  row: AccountOffboardingPurgeRow,
  currentOutboxId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      WITH account_businesses AS (
        SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid
      ),
      onboarding_demo_scope AS (
        SELECT od.id::text AS identifier
        FROM onboarding_demos od
        JOIN businesses b ON b.id = od.business_id
        WHERE b.account_id = ${row.account_id}::uuid
      ),
      offboarding_scope AS (
        SELECT id::text AS identifier FROM account_businesses
        UNION ALL SELECT identifier FROM onboarding_demo_scope
        UNION ALL SELECT ${row.account_id}::text
        UNION ALL SELECT ${row.id}::text
        UNION ALL SELECT ${row.auth_user_id ?? null}::text
        UNION ALL SELECT ${row.stripe_customer_id ?? null}::text
        UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text
        UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[])
        UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[])
        UNION ALL
        SELECT auth_user_id FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND auth_user_id IS NOT NULL
        UNION ALL
        SELECT stripe_customer_id FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_customer_id IS NOT NULL
        UNION ALL
        SELECT stripe_subscription_id FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_subscription_id IS NOT NULL
        UNION ALL
        SELECT unnest(zernio_account_ids) FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_account_ids IS NOT NULL
        UNION ALL
        SELECT unnest(zernio_profile_ids) FROM account_offboardings
        WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_profile_ids IS NOT NULL
      )
      UPDATE inbound_events
      SET external_event_key = 'scrubbed:' || id::text,
          aggregate_key = NULL,
          payload = '{}'::jsonb,
          error_message = NULL
      WHERE EXISTS (
        SELECT 1 FROM offboarding_scope s
        WHERE s.identifier IS NOT NULL
          AND length(btrim(s.identifier)) > 0
          AND (
            inbound_events.payload::text LIKE ('%' || s.identifier || '%')
            OR inbound_events.aggregate_key LIKE ('%' || s.identifier || '%')
            OR inbound_events.error_message LIKE ('%' || s.identifier || '%')
        )
      )
    `;
    const scopedOutboxRows = await tx<{ id: string }[]>`
      WITH account_businesses AS (
        SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid
      ),
      onboarding_demo_scope AS (
        SELECT od.id::text AS identifier
        FROM onboarding_demos od
        JOIN businesses b ON b.id = od.business_id
        WHERE b.account_id = ${row.account_id}::uuid
      ),
      offboarding_scope AS (
        SELECT id::text AS identifier FROM account_businesses
        UNION ALL SELECT identifier FROM onboarding_demo_scope
        UNION ALL SELECT ${row.account_id}::text
        UNION ALL SELECT ${row.id}::text
        UNION ALL SELECT ${row.auth_user_id ?? null}::text
        UNION ALL SELECT ${row.stripe_customer_id ?? null}::text
        UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text
        UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[])
        UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[])
      )
      SELECT id
      FROM job_outbox
      WHERE EXISTS (
        SELECT 1 FROM offboarding_scope s
        WHERE s.identifier IS NOT NULL
          AND length(btrim(s.identifier)) > 0
          AND (
            job_outbox.payload::text LIKE ('%' || s.identifier || '%')
            OR job_outbox.aggregate_id::text = s.identifier
            OR job_outbox.last_error LIKE ('%' || s.identifier || '%')
          )
      )
        AND job_outbox.id <> ${currentOutboxId}::uuid
    `;

    if (scopedOutboxRows.length > 0) {
      await tx`
        UPDATE account_offboardings
        SET provider_dispositions = provider_dispositions || ${jsonb(scopedOutboxRows.map(jobOutboxScrubScopeRecord))},
            updated_at = NOW()
        WHERE id = ${row.id}::uuid
          AND account_id = ${row.account_id}::uuid
          AND terminal_at IS NULL
      `;
      await tx`
        UPDATE job_outbox
        SET aggregate_id = NULL,
            payload = '{}'::jsonb,
            last_error = NULL,
            status = CASE
              WHEN status IN ('pending', 'dispatching', 'dispatched') THEN 'completed'
              ELSE status
            END,
            completed_at = CASE
              WHEN status IN ('pending', 'dispatching', 'dispatched') THEN COALESCE(completed_at, NOW())
              ELSE completed_at
            END
        WHERE id = ANY(${scopedOutboxRows.map((entry) => entry.id)}::uuid[])
      `;
    }
  });
}

export async function runAnalyticsPurgeStage(row: AccountOffboardingPurgeRow): Promise<void> {
  // One scrub over a single account-scope predicate: every analytics row owned by this
  // account by FK (account/business/user) OR by a raw account identifier still sitting in
  // `distinct_id` (the FK-independent case the unenforced "raw UUID implies FK" invariant
  // used to miss). This predicate is the write-side twin of the post-purge read-side check
  // in `purge-verification.ts` (`account_id IS NULL ... distinct_id IN`); keep the two in
  // sync — a divergence is what previously let scrubbed-distinct_id rows survive (M1).
  await sql`
    UPDATE analytics_events
    SET event_key = 'scrubbed:' || id::text,
        distinct_id = 'scrubbed:' || id::text,
        anonymous_id = NULL,
        account_id = NULL,
        user_id = NULL,
        business_id = NULL,
        properties = '{}'::jsonb,
        last_error = NULL
    WHERE account_id = ${row.account_id}::uuid
       OR business_id IN (SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid)
       OR user_id IN (SELECT id FROM users WHERE account_id = ${row.account_id}::uuid)
       OR distinct_id IN (${row.account_id}, ${`account:${row.account_id}`})
  `;
}

export async function runProviderIdentifierPurgeStage(row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin); they execute
    // serially on a single connection and cannot be parallelized.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await deleteByBusiness(tx, 'zernio_connections', row.account_id);
    await tx`
      UPDATE zernio_finalize_incidents zfi
      SET zernio_profile_id = 'scrubbed:' || zfi.id::text,
          flow_id = 'scrubbed:' || zfi.id::text,
          zernio_account_id = NULL,
          zernio_location_id = NULL,
          resolution_notes = NULL,
          updated_at = NOW()
      FROM businesses b
      WHERE zfi.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE zernio_backfill_runs zbr
      SET zernio_account_id = 'scrubbed:' || zbr.id::text,
          zernio_location_id = 'scrubbed:' || zbr.id::text,
          updated_at = NOW()
      FROM businesses b
      WHERE zbr.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM channel_enrollments
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM auto_approval_policies
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      DELETE FROM api_costs_daily_rollups acdr
      USING businesses b
      WHERE acdr.business_id = b.id
        AND b.account_id = ${row.account_id}::uuid
    `;
  });
}

export async function runAuditAndCostPayloadPurgeStage(row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    const impersonationSessionIds = await scopedImpersonationSessionIds(tx, row);
    await tx`
      UPDATE account_audit_log
      SET location_id = NULL,
          actor_user_id = NULL,
          payload = '{}'::jsonb,
          entity_id = NULL,
          ip = NULL,
          user_agent = NULL,
          request_id = NULL
      WHERE account_id = ${row.account_id}::uuid
    `;
    if (impersonationSessionIds.length > 0) {
      await tx`
        UPDATE account_offboardings
        SET provider_dispositions = provider_dispositions || ${jsonb(impersonationSessionIds.map(impersonationSessionScrubScopeRecord))},
            updated_at = NOW()
        WHERE id = ${row.id}::uuid
          AND account_id = ${row.account_id}::uuid
          AND terminal_at IS NULL
      `;
      await tx`
        UPDATE impersonation_sessions
        SET ticket_id = 'scrubbed:' || id::text,
            reason = 'account purged',
            account_id = NULL,
            impersonated_user_id = NULL,
            ended_at = COALESCE(ended_at, NOW())
        WHERE id = ANY(${impersonationSessionIds}::uuid[])
      `;
    }
  });
}

export async function runParentTombstonePurgeStage(row: AccountOffboardingPurgeRow): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin) and tombstone
    // account-scoped rows ending on the shared accounts row; parallel = lock contention/deadlock.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await tx`
      UPDATE users
      SET name = 'Deleted user',
          email = 'deleted-' || id::text || '@repworth.invalid',
          phone = NULL,
          auth_id = NULL,
          updated_at = NOW()
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE businesses
      SET name = 'Deleted location',
          category = NULL,
          google_place_id = NULL,
          google_maps_url = NULL,
          tone = 'professional and friendly',
          products_services = NULL,
          staff_names = NULL,
          highlight_facts = NULL,
          avoid_facts = NULL,
          sample_responses = NULL,
          owner_name = 'Deleted owner',
          owner_email = 'deleted-' || id::text || '@repworth.invalid',
          owner_phone = NULL,
          stripe_customer_id = NULL,
          stripe_subscription_id = NULL,
          tracked_keywords = '[]'::jsonb,
          google_place_address = NULL,
          google_place_lat = NULL,
          google_place_lng = NULL,
          ranking_search_location = NULL,
          website = NULL,
          display_label = NULL,
          archived_at = COALESCE(archived_at, NOW()),
          updated_at = NOW()
      WHERE account_id = ${row.account_id}::uuid
    `;
    await tx`
      UPDATE accounts
      SET display_name = 'Deleted account',
          stripe_customer_id = NULL,
          stripe_subscription_id = NULL,
          flags = '{}'::jsonb,
          updated_at = NOW()
      WHERE id = ${row.account_id}::uuid
    `;
  });
}

export async function finalizePurgeInTransaction(
  row: AccountOffboardingPurgeRow,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql.begin(async (tx) => {
    // Sequential awaits share one Postgres.js transaction connection (sql.begin);
    // they cannot run in parallel and ordering (lock → scrub → verify → finalize) is load-bearing.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await lockCurrentOutboxAttempt(tx, outboxId, outboxAttempt);

    await tx`
      UPDATE job_outbox
      SET aggregate_id = NULL,
          payload = ${jsonb({})},
          last_error = NULL
      WHERE id = ${outboxId}::uuid
    `;

    await scrubLifecycleReceiptInTransaction(tx, row);

    const verification = await verifyAccountOffboardingPurge(
      {
        accountId: row.account_id,
        offboardingId: row.id,
        currentOutboxId: outboxId,
        authUserId: row.auth_user_id,
        stripeCustomerId: row.stripe_customer_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        zernioAccountIds: row.zernio_account_ids,
        zernioProfileIds: row.zernio_profile_ids,
      },
      tx,
    );
    if (!verification.ok) {
      throw new Error(
        `account_offboarding_purge_verification_failed:${verification.issues
          .map((issue) => issue.table)
          .join(',')}`,
      );
    }

    const [updated] = await tx<{ id: string }[]>`
      UPDATE account_offboardings
      SET status = 'purged',
          purged_at = NOW(),
          terminal_at = COALESCE(terminal_at, NOW()),
          failed_step = NULL,
          last_error = NULL,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
        AND status = 'purge_scheduled'
        AND terminal_at IS NULL
        AND recipient_email IS NULL
        AND stripe_customer_id IS NULL
        AND stripe_subscription_id IS NULL
        AND zernio_account_ids IS NULL
        AND zernio_profile_ids IS NULL
        AND auth_user_id IS NULL
      RETURNING id
    `;

    if (!updated) {
      throw new Error('account_offboarding_purge_finalize_precondition_failed');
    }

    await enqueueOffboardingPurged(tx, {
      offboardingId: row.id,
    });

    // Durable purge receipt: enqueue inside the finalize tx so a crash after
    // commit cannot lose it (the prior best-effort post-commit send could). The
    // recipient is carried in the outbox payload because the row's
    // recipient_email is scrubbed in this same transaction; the email worker
    // sends it and scrubs the payload afterwards.
    //
    // ACCEPTED RESIDUAL (M4): this means a single raw owner email lives in
    // job_outbox.payload past the purged_at stamp — sending the final "your data
    // was deleted" notice inherently requires retaining the address until it is
    // sent, and the account row is tombstoned so it cannot be re-derived. The
    // window is bounded by the outbox dispatch + BullMQ retry guarantee, and the
    // email worker scrubs the payload atomically on completion. The verification
    // gate above intentionally does not scan for this (it would never allow the
    // receipt to be sent). The only way it persists is a permanently-undeliverable
    // receipt; the outbox failure surface is the place to detect that.
    const recipient = row.recipient_email?.trim();
    if (recipient) {
      await enqueueAccountOffboardingEmail(tx, {
        accountOffboardingId: row.id,
        accountId: row.account_id,
        emailType: 'purge_receipt',
        recipientEmail: recipient,
        purgedAt: new Date().toISOString(),
      });
    }

    await completeCurrentOutboxAttempt(tx, outboxId, outboxAttempt);
  });
}

async function lockCurrentOutboxAttempt(
  tx: postgres.TransactionSql,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  const [row] = typeof outboxAttempt === 'number' && Number.isFinite(outboxAttempt)
    ? await tx<{ id: string }[]>`
        SELECT id
        FROM job_outbox
        WHERE id = ${outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${outboxAttempt}
        FOR UPDATE
      `
    : await tx<{ id: string }[]>`
        SELECT id
        FROM job_outbox
        WHERE id = ${outboxId}::uuid
          AND status = 'dispatched'
        FOR UPDATE
      `;

  if (!row) {
    throw new StaleOutboxAttemptError();
  }
}

async function scrubLifecycleReceiptInTransaction(
  exec: typeof sql | postgres.TransactionSql,
  row: AccountOffboardingPurgeRow,
): Promise<void> {
  await exec`
    UPDATE account_offboardings
    SET recipient_email = NULL,
        stripe_customer_id = NULL,
        stripe_subscription_id = NULL,
        zernio_account_ids = NULL,
        zernio_profile_ids = NULL,
        auth_user_id = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND terminal_at IS NULL
  `;
}

async function completeCurrentOutboxAttempt(
  tx: postgres.TransactionSql,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  const [row] = typeof outboxAttempt === 'number' && Number.isFinite(outboxAttempt)
    ? await tx<{ id: string }[]>`
        UPDATE job_outbox
        SET status = 'completed',
            completed_at = NOW()
        WHERE id = ${outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${outboxAttempt}
        RETURNING id
      `
    : await tx<{ id: string }[]>`
        UPDATE job_outbox
        SET status = 'completed',
            completed_at = NOW()
        WHERE id = ${outboxId}::uuid
          AND status = 'dispatched'
        RETURNING id
      `;

  if (!row) {
    throw new StaleOutboxAttemptError();
  }
}

export async function markPurgeRetryableFailure(
  row: AccountOffboardingPurgeRow,
  safeMessage: string,
): Promise<void> {
  await sql`
    UPDATE account_offboardings
    SET last_error = ${safeMessage},
        retry_count = retry_count + 1,
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND status = 'purge_scheduled'
      AND terminal_at IS NULL
  `;
}

export async function markPurgeTerminalFailure(
  row: AccountOffboardingPurgeRow,
  safeMessage: string,
): Promise<void> {
  await sql`
    UPDATE account_offboardings
    SET status = 'failed',
        failed_step = 'purge',
        last_error = ${safeMessage},
        retry_count = retry_count + 1,
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND terminal_at IS NULL
  `;
}

async function scopedImpersonationSessionIds(
  tx: postgres.TransactionSql,
  row: AccountOffboardingPurgeRow,
): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    SELECT DISTINCT s.id
    FROM impersonation_sessions s
    WHERE s.account_id = ${row.account_id}::uuid
       OR s.impersonated_user_id IN (
         SELECT id FROM users WHERE account_id = ${row.account_id}::uuid
       )
  `;
  return rows.map((entry) => entry.id);
}

