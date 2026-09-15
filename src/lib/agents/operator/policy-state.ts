// The Owner Operator's database reads for one auto-approval policy target
// (Run C T5): the target's dials, its **Version token**, the 30-day review
// cohort its consequence line walks, and the retained-veto count Apply writes
// into a Receipt.
//
// Two consumers: the turn worker, which prepares a policy Proposal from a
// snapshot, and Apply, which recomputes the counts under its account lock.
// `consequence.ts` stays pure. This module owns only the reads and the mapping
// into `simulateRule`.
//
// ONE STATEMENT PER READ. A snapshot's dials, the `updated_at::text` stamps of
// its token, its review cohort and its window come from ONE SELECT. A caller
// therefore cannot stamp values from one policy version with a token from
// another. The bundle crosses the driver as one JSONB object, read through the
// agents surface's existing parse site (`parseJsonbObject`), then narrowed.
//
// NO ROW LOCKS in the snapshot. Apply locks the account row before it calls
// this, and nothing here locks a business, review or response after that lock.
// The retained-veto count takes `FOR SHARE OF aal` on immutable audit rows and
// nothing else.
//
// TIME IS THE SERVER'S. Every instant is `statement_timestamp()` or a stored
// column, formatted as UTC text with microseconds. Nothing becomes a JS Date,
// which would drop the microseconds (CLAUDE.md timestamptz gotcha) and break
// the lexical order `simulateRule` sorts by.
//
// ORIGIN IS NEVER INFERRED. A review counts only when its initial
// `review_ingested` marker(s) on its own `review_handler` run all say `live`.
// Connection dates, later generation lanes and external replies are not
// evidence. A missing marker (pre-T5.0 rows, or a marker pruned by the 180-day
// run-spine retention) is `unknown` and is reported, never counted.
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import type { AGENT_RUN_KINDS, AgentStepKey, RecordStepInput, StartRunInput } from '@/lib/agents/run-spine';
import { AUDIT_ACTION_AUTO_APPROVED_BY_POLICY } from '@/lib/approval/audit';
import { DEFAULT_VETO_WINDOW_MINUTES, resolveDailyCap } from '@/lib/auto-approval/policy';
import {
  APPROVAL_METHOD,
  POLICY_ACTION_POSTING,
  POLICY_PERSONA_REPLY,
  isAutoApprovalThreshold,
  isVetoWindowMinutes,
} from '@/lib/auto-approval/types';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import type { INGESTION_ORIGIN as WriterIngestionOrigin } from '@/lib/reviews/process-review';
import type { ALL_RESPONSE_STATUSES } from '@/lib/shared/response-status';
import type { PolicyScopeState, PolicyTarget } from './catalog';
import {
  simulateRule,
  type ConsequenceDials,
  type ConsequenceResult,
  type ConsequenceReview,
} from './consequence';
import { parseJsonbObject, parsePolicyState, type PolicyState } from './schema';
import {
  computeAutoApprovalVersionToken,
  type AutoApprovalVersionToken,
  type PolicyRowVersion,
} from './version-token';

type SqlExecutor = Sql | TransactionSql;

type PolicyScopeInput = { accountId: string; locationId: string | null };

export interface PolicySnapshot {
  accountId: string;
  locationId: string | null;
  target: PolicyTarget;
  state: PolicyScopeState;
  versionToken: AutoApprovalVersionToken;
  /** The targeted location is archived. Its state is still read; its cohort is empty. */
  targetArchived: boolean;
  /** The target's effective suspension: account default suspended OR the winning row suspended. */
  policySuspended: boolean;
  /** Active scoped locations, each with its EFFECTIVE state. `rowExists` = its own override row exists. */
  locations: readonly { id: string; state: PolicyState }[];
  /** Confirmed-live, deduplicated reviews only. Every row has `imported: false`. */
  reviews: readonly ConsequenceReview[];
  windowStart: string;
  windowEnd: string;
  asOf: string;
  source: 'reviews_received_30d';
  excludedImported: number;
  excludedUnknown: number;
}

export type PolicyConsequence = ConsequenceResult &
  Pick<PolicySnapshot, 'windowStart' | 'windowEnd' | 'asOf' | 'source' | 'excludedImported' | 'excludedUnknown'>;

// The run-spine vocabulary this read matches, pinned to the writer's own types
// so a rename there fails typecheck here.
const REVIEW_RUN_KIND = 'review_handler' satisfies (typeof AGENT_RUN_KINDS)[number];
const REVIEW_SUBJECT_TYPE = 'review' satisfies Extract<StartRunInput, { kind: 'review_handler' }>['subjectType'];
const INITIAL_MARKER_STEP = 'review_ingested' satisfies AgentStepKey;
const COMPLETED_STEP = 'completed' satisfies NonNullable<RecordStepInput['status']>;

/** Match the ingestion writer without loading its pipeline into the read path. */
const INGESTION_ORIGIN = {
  LIVE: 'live', IMPORTED: 'imported', UNKNOWN: 'unknown',
} as const satisfies typeof WriterIngestionOrigin;

const APPROVED_RESPONSE_STATUS = 'approved' satisfies (typeof ALL_RESPONSE_STATUSES)[number];

/** Canonical UTC text with microseconds. Lexical order is instant order. */
const UTC_TEXT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const UtcTextSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

const StoredPolicyRowSchema = z.object({
  id: z.uuid(),
  threshold: z.number().int().nullable(),
  veto_window_minutes: z.number().int(),
  daily_auto_post_cap: z.number().int().nullable(),
  suspended: z.boolean(),
  /** `updated_at::text` VERBATIM — the token's opaque stamp. */
  updated_at: z.string().min(1),
}).strict();
type StoredPolicyRow = z.infer<typeof StoredPolicyRowSchema>;

const SnapshotBundleSchema = z.object({
  account_exists: z.boolean(),
  window_start: UtcTextSchema,
  window_end: UtcTextSchema,
  target: z.object({ id: z.uuid(), archived: z.boolean() }).strict().nullable(),
  account_default: StoredPolicyRowSchema.nullable(),
  location_rows: z.array(StoredPolicyRowSchema.extend({ location_id: z.uuid() }).strict()),
  scoped_business_ids: z.array(z.uuid()),
  review_rows: z.array(z.object({
    business_id: z.uuid(),
    review_id: z.uuid(),
    stars: z.number().int().min(1).max(5).nullable(),
    detected_at: UtcTextSchema,
    day_key: UtcTextSchema,
    origin: z.enum([INGESTION_ORIGIN.LIVE, INGESTION_ORIGIN.IMPORTED, INGESTION_ORIGIN.UNKNOWN]),
  }).strict()),
}).strict();
type SnapshotBundle = z.infer<typeof SnapshotBundleSchema>;

/**
 * One target's policy snapshot, or `null` when the account does not exist or
 * the targeted location is missing or belongs to another account.
 *
 * Scope: the account scope reads every ACTIVE business; the location scope
 * reads exactly that business, and reads its policy row even when it is
 * archived (a contraction still needs the before state). Reviews are the
 * non-deleted rows with `detected_at` in `[windowEnd - 30 days, windowEnd)`,
 * bucketed with the publisher's UTC day expression.
 */
export async function readPolicySnapshot(
  db: SqlExecutor,
  input: PolicyScopeInput,
): Promise<PolicySnapshot | null> {
  const [row] = await db<{ bundle: unknown }[]>`
    WITH clock AS (
      SELECT statement_timestamp() AS window_end
    )
    SELECT jsonb_build_object(
      'account_exists', EXISTS (
        SELECT 1 FROM accounts a WHERE a.id = ${input.accountId}::uuid
      ),
      'window_start', to_char((c.window_end - interval '30 days') AT TIME ZONE 'UTC', ${UTC_TEXT_FORMAT}),
      'window_end', to_char(c.window_end AT TIME ZONE 'UTC', ${UTC_TEXT_FORMAT}),
      'target', (
        SELECT jsonb_build_object('id', tb.id, 'archived', tb.archived_at IS NOT NULL)
        FROM businesses tb
        WHERE tb.account_id = ${input.accountId}::uuid
          AND tb.id = ${input.locationId}::uuid
      ),
      'account_default', (
        SELECT jsonb_build_object(
          'id', p.id,
          'threshold', p.auto_approve_min_star,
          'veto_window_minutes', p.veto_window_minutes,
          'daily_auto_post_cap', p.daily_auto_post_cap,
          'suspended', p.suspended_at IS NOT NULL,
          'updated_at', p.updated_at::text
        )
        FROM auto_approval_policies p
        WHERE p.account_id = ${input.accountId}::uuid
          AND p.location_id IS NULL
          AND p.persona = ${POLICY_PERSONA_REPLY}
          AND p.action_class = ${POLICY_ACTION_POSTING}
      ),
      'location_rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'location_id', p.location_id,
          'id', p.id,
          'threshold', p.auto_approve_min_star,
          'veto_window_minutes', p.veto_window_minutes,
          'daily_auto_post_cap', p.daily_auto_post_cap,
          'suspended', p.suspended_at IS NOT NULL,
          'updated_at', p.updated_at::text
        ) ORDER BY p.location_id)
        FROM auto_approval_policies p
        JOIN businesses pb
          ON pb.id = p.location_id
         AND pb.account_id = ${input.accountId}::uuid
        WHERE p.account_id = ${input.accountId}::uuid
          AND p.location_id IS NOT NULL
          AND p.persona = ${POLICY_PERSONA_REPLY}
          AND p.action_class = ${POLICY_ACTION_POSTING}
          AND (
            (${input.locationId}::uuid IS NULL AND pb.archived_at IS NULL)
            OR pb.id = ${input.locationId}::uuid
          )
      ), '[]'::jsonb),
      'scoped_business_ids', COALESCE((
        SELECT jsonb_agg(sb.id ORDER BY sb.id)
        FROM businesses sb
        WHERE sb.account_id = ${input.accountId}::uuid
          AND sb.archived_at IS NULL
          AND (${input.locationId}::uuid IS NULL OR sb.id = ${input.locationId}::uuid)
      ), '[]'::jsonb),
      'review_rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'business_id', r.business_id,
          'review_id', r.id,
          'stars', r.star_rating,
          'detected_at', to_char(r.detected_at AT TIME ZONE 'UTC', ${UTC_TEXT_FORMAT}),
          'day_key', to_char(
            (date_trunc('day', r.detected_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
            ${UTC_TEXT_FORMAT}
          ),
          'origin', m.origin
        ) ORDER BY r.detected_at, r.id)
        FROM reviews r
        JOIN businesses rb
          ON rb.id = r.business_id
         AND rb.account_id = ${input.accountId}::uuid
        CROSS JOIN LATERAL (
          -- One row per review, however many markers it has: extra step rows
          -- can never multiply a review. Live only when EVERY initial marker
          -- is a completed, string-valued 'live'; imported only when every one
          -- is 'imported'; anything else — none, unrecognized, contradictory —
          -- is unknown.
          SELECT CASE
            WHEN COUNT(*) = 0 THEN ${INGESTION_ORIGIN.UNKNOWN}::text
            WHEN bool_and(marker.origin = ${INGESTION_ORIGIN.LIVE}::text) THEN ${INGESTION_ORIGIN.LIVE}::text
            WHEN bool_and(marker.origin = ${INGESTION_ORIGIN.IMPORTED}::text) THEN ${INGESTION_ORIGIN.IMPORTED}::text
            ELSE ${INGESTION_ORIGIN.UNKNOWN}::text
          END AS origin
          FROM (
            SELECT CASE
              WHEN s.status = ${COMPLETED_STEP}::text
               AND jsonb_typeof(s.detail -> 'ingestion_origin') = 'string'
               AND s.detail ->> 'ingestion_origin' IN (${INGESTION_ORIGIN.LIVE}::text, ${INGESTION_ORIGIN.IMPORTED}::text)
              THEN s.detail ->> 'ingestion_origin'
              ELSE ${INGESTION_ORIGIN.UNKNOWN}::text
            END AS origin
            FROM agent_runs ar
            JOIN agent_run_steps s ON s.agent_run_id = ar.id
            WHERE ar.account_id = ${input.accountId}::uuid
              AND ar.business_id = r.business_id
              AND ar.kind = ${REVIEW_RUN_KIND}::text
              AND ar.subject_type = ${REVIEW_SUBJECT_TYPE}::text
              AND ar.subject_id = r.id::text
              AND s.step_key = ${INITIAL_MARKER_STEP}::text
          ) marker
        ) m
        WHERE rb.archived_at IS NULL
          AND (${input.locationId}::uuid IS NULL OR rb.id = ${input.locationId}::uuid)
          AND r.status IS DISTINCT FROM ${REVIEW_STATUS.DELETED}
          AND r.detected_at >= c.window_end - interval '30 days'
          AND r.detected_at < c.window_end
      ), '[]'::jsonb)
    ) AS bundle
    FROM clock c
  `;
  if (!row) {
    throw new Error('agents/operator: the policy snapshot statement returned no row');
  }
  const parsed = SnapshotBundleSchema.safeParse(parseJsonbObject(row.bundle, 'policy_state.snapshot_bundle'));
  if (!parsed.success) {
    throw new Error('agents/operator: the policy snapshot bundle holds a shape this reader does not produce');
  }
  return mapSnapshot(input, parsed.data);
}

function storedRowState(row: StoredPolicyRow, label: string): PolicyState {
  if (row.threshold !== null && !isAutoApprovalThreshold(row.threshold)) {
    throw new Error(`agents/operator: ${label} ${row.id} holds an out-of-domain threshold`);
  }
  if (!isVetoWindowMinutes(row.veto_window_minutes)) {
    throw new Error(`agents/operator: ${label} ${row.id} holds an out-of-domain veto window`);
  }
  return parsePolicyState({
    domain: 'policy',
    threshold: row.threshold,
    vetoWindowMinutes: row.veto_window_minutes,
    dailyAutoPostCap: row.daily_auto_post_cap,
    effectiveDailyCap: resolveDailyCap({ dailyAutoPostCap: row.daily_auto_post_cap }),
    rowExists: true,
  }, label);
}

/** No account-default row: the column defaults a fresh row would persist. */
function absentAccountDefaultState(): PolicyState {
  return parsePolicyState({
    domain: 'policy',
    threshold: null,
    vetoWindowMinutes: DEFAULT_VETO_WINDOW_MINUTES,
    dailyAutoPostCap: null,
    effectiveDailyCap: resolveDailyCap({ dailyAutoPostCap: null }),
    rowExists: false,
  }, 'auto_approval_policies account default (absent)');
}

function rowVersion(row: StoredPolicyRow | null | undefined): PolicyRowVersion {
  return row ? { id: row.id, updatedAt: row.updated_at } : { id: 'absent' };
}

/** Keep provenance filtering and tenant validation together at the read boundary. */
function snapshotReviews(bundle: SnapshotBundle) {
  const scoped = new Set(bundle.scoped_business_ids);
  const reviews: ConsequenceReview[] = [];
  let excludedImported = 0;
  let excludedUnknown = 0;
  for (const review of bundle.review_rows) {
    if (!scoped.has(review.business_id)) {
      throw new Error('agents/operator: the policy snapshot returned a review outside its scope');
    }
    if (review.origin === INGESTION_ORIGIN.IMPORTED) {
      excludedImported += 1;
      continue;
    }
    if (review.origin !== INGESTION_ORIGIN.LIVE) {
      excludedUnknown += 1;
      continue;
    }
    reviews.push({
      businessId: review.business_id,
      reviewId: review.review_id,
      stars: review.stars,
      detectedAt: review.detected_at,
      dayKey: review.day_key,
      imported: false,
    });
  }
  return { reviews, excludedImported, excludedUnknown };
}

function locationSnapshotFields(input: {
  locationId: string;
  accountDefault: PolicyState;
  accountDefaultRow: StoredPolicyRow | null;
  override: StoredPolicyRow | undefined;
  locationState: PolicyState;
  targetArchived: boolean;
  accountSuspended: boolean;
}): Pick<PolicySnapshot, 'locationId' | 'target' | 'state' | 'versionToken' | 'targetArchived' | 'policySuspended'> {
  return {
    locationId: input.locationId,
    target: { scope: 'location', locationId: input.locationId },
    state: { accountDefault: input.accountDefault, location: input.locationState, targetRowSuspended: input.override?.suspended ?? false },
    // BOTH rows, always: a location proposal goes stale when the parent moves.
    versionToken: computeAutoApprovalVersionToken({
      locationRow: rowVersion(input.override),
      accountDefaultRow: rowVersion(input.accountDefaultRow),
    }),
    targetArchived: input.targetArchived,
    policySuspended: input.accountSuspended || (input.override?.suspended ?? false),
  };
}

function mapSnapshot(input: PolicyScopeInput, bundle: SnapshotBundle): PolicySnapshot | null {
  if (!bundle.account_exists) return null;
  const targetRow = bundle.target;
  if (input.locationId !== null && targetRow === null) return null;

  const accountDefaultRow = bundle.account_default;
  const accountDefault = accountDefaultRow === null
    ? absentAccountDefaultState()
    : storedRowState(accountDefaultRow, 'auto_approval_policies account default');
  const overrides = new Map(bundle.location_rows.map((policy) => [policy.location_id, policy]));

  // A location row replaces the WHOLE default — a manual (null) threshold
  // included. There is no per-field fallback to the parent.
  const effectiveFor = (businessId: string): PolicyState => {
    const override = overrides.get(businessId);
    return override === undefined
      ? { ...accountDefault, rowExists: false }
      : storedRowState(override, 'auto_approval_policies location override');
  };

  const locations = bundle.scoped_business_ids.map((id) => ({ id, state: effectiveFor(id) }));

  const accountSuspended = accountDefaultRow?.suspended ?? false;
  const common = {
    accountId: input.accountId,
    locations,
    ...snapshotReviews(bundle),
    windowStart: bundle.window_start,
    windowEnd: bundle.window_end,
    asOf: bundle.window_end,
    source: 'reviews_received_30d' as const,
  };

  if (input.locationId === null || targetRow === null) {
    return {
      ...common,
      locationId: null,
      target: { scope: 'account' },
      state: { accountDefault, location: null, targetRowSuspended: accountSuspended },
      versionToken: computeAutoApprovalVersionToken({ accountDefaultRow: rowVersion(accountDefaultRow) }),
      targetArchived: false,
      policySuspended: accountSuspended,
    };
  }

  const override = overrides.get(input.locationId);
  return {
    ...common,
    ...locationSnapshotFields({
      locationId: input.locationId, accountDefault, accountDefaultRow, override,
      locationState: effectiveFor(input.locationId), targetArchived: targetRow.archived, accountSuspended,
    }),
  };
}

/**
 * The eligible-review consequence of `targetState` over the snapshot's ONE
 * captured cohort. Apply calls this twice — before and after its write — with
 * the same snapshot, so old and new counts never walk different reviews.
 *
 * Account target: a location with its own row keeps its snapshot state; an
 * inheriting location takes `targetState`. Location target: only that
 * location takes `targetState`.
 */
export function consequenceForPolicy(snapshot: PolicySnapshot, targetState: PolicyState): PolicyConsequence {
  const dials: Record<string, ConsequenceDials> = {};
  for (const location of snapshot.locations) {
    const keepsOwnState = snapshot.target.scope === 'account'
      ? location.state.rowExists
      : location.id !== snapshot.target.locationId;
    const state = keepsOwnState ? location.state : targetState;
    dials[location.id] = { threshold: state.threshold, dailyCap: state.dailyAutoPostCap };
  }
  return {
    ...simulateRule(snapshot.reviews, dials),
    windowStart: snapshot.windowStart,
    windowEnd: snapshot.windowEnd,
    asOf: snapshot.asOf,
    source: snapshot.source,
    excludedImported: snapshot.excludedImported,
    excludedUnknown: snapshot.excludedUnknown,
  };
}

/**
 * How many approved auto-policy drafts in scope retain a previously granted
 * veto window. This includes drafts still awaiting publication after that
 * window elapsed. A dial change never rewrites a grant.
 *
 * The caller holds the account row lock (then the proposal). ONE statement;
 * the only lock is `FOR SHARE OF aal` on the latest immutable grant row per
 * response. No business, review or response lock. `asOf` is the statement's
 * own clock: an actual count at that instant, not a promise that no publisher
 * or veto transition happens before commit.
 *
 * Account scope counts only active locations with NO Reply/posting location
 * row — a manual row is an override too. A missing or invalid latest grant
 * window is an invariant failure, exactly as the publisher treats it.
 */
export async function readRetainedVetoCount(
  tx: TransactionSql,
  input: PolicyScopeInput,
): Promise<{ count: number; asOf: string }> {
  const [row] = await tx<{ count: number; missing_grants: number; as_of: string }[]>`
    SELECT
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE latest_grant.veto_window_minutes IS NULL)::int AS missing_grants,
      to_char(statement_timestamp() AT TIME ZONE 'UTC', ${UTC_TEXT_FORMAT}) AS as_of
    FROM responses resp
    JOIN businesses b
      ON b.id = resp.business_id
     AND b.account_id = ${input.accountId}::uuid
    JOIN reviews r
      ON r.id = resp.review_id
     AND r.business_id = b.id
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN jsonb_typeof(aal.metadata -> 'veto_window_minutes') = 'number'
         AND (aal.metadata ->> 'veto_window_minutes') ~ '^[1-9][0-9]*$'
        THEN (aal.metadata ->> 'veto_window_minutes')::int
      END AS veto_window_minutes
      FROM approval_audit_log aal
      WHERE aal.account_id = ${input.accountId}::uuid
        AND aal.business_id = resp.business_id
        AND aal.response_id = resp.id
        AND aal.action = ${AUDIT_ACTION_AUTO_APPROVED_BY_POLICY}
      ORDER BY aal.created_at DESC, aal.id DESC
      LIMIT 1
      FOR SHARE OF aal
    ) latest_grant ON TRUE
    WHERE b.archived_at IS NULL
      AND resp.status = ${APPROVED_RESPONSE_STATUS}
      AND resp.approval_method = ${APPROVAL_METHOD.AUTO_POLICY}
      AND (
        (
          ${input.locationId}::uuid IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM auto_approval_policies p
            WHERE p.account_id = ${input.accountId}::uuid
              AND p.location_id = b.id
              AND p.persona = ${POLICY_PERSONA_REPLY}
              AND p.action_class = ${POLICY_ACTION_POSTING}
          )
        )
        OR b.id = ${input.locationId}::uuid
      )
  `;
  if (!row) {
    throw new Error('agents/operator: the retained-veto statement returned no row');
  }
  if (row.missing_grants > 0) {
    throw new Error(
      `Invariant violation: ${row.missing_grants} auto_policy approved response(s) in scope have no latest ` +
        'auto_approved_by_policy audit row with a valid veto_window_minutes',
    );
  }
  return { count: row.count, asOf: row.as_of };
}
