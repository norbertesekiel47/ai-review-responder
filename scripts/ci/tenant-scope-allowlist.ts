/**
 * Why each allowlist entry is exempt from tenant scoping. The audit asserts
 * per-category path invariants (see CATEGORY_PATH_RULES) so a mislabeled
 * entry cannot quietly claim a justification its location contradicts.
 */
export type TenantScopeAllowlistCategory =
  /** Caller already established owner scope; the account/business id IS the tenant boundary for this statement. */
  | 'tenant-root-lookup'
  /** Admin-only route or service behind requireRole(admin); cross-tenant by design. */
  | 'admin-after-require-role'
  /** Opaque token/approval lookup that must resolve rows before tenant scope is knowable. */
  | 'pre-auth-token'
  /** Webhook/OAuth ingress resolving tenant rows from signed provider identifiers. */
  | 'provider-ingress'
  /** Scheduler/poller intentionally scanning tenant rows globally before enqueueing scoped work. */
  | 'background-global-scan'
  /** Worker following a durable job payload or scheduler-selected id; tenant context fixed upstream. */
  | 'worker-job-scoped'
  /** Auth/onboarding flow scoping through Supabase auth_id to users. */
  | 'supabase-auth-id'
  /** Intentionally cross-account platform aggregate (margin service, Spec 26). */
  | 'platform-cross-account';

export interface TenantScopeAllowlistEntry {
  file: string;
  table: string;
  sqlSnippet: string;
  category: TenantScopeAllowlistCategory;
  reason: string;
}

/**
 * Exact-match growth gate: the audit fails whenever the entry count differs
 * from this baseline, in EITHER direction. Adding or removing an allowlist
 * entry therefore always requires an explicit, reviewable baseline bump in
 * the same PR — silent growth (and shrink-then-regrow masking) both fail CI.
 */
// 420 → 418 → 414 (#677), a SHRINK in both steps — six fewer tenant-scope
// suppressions in the tree:
//   420 → 418: two entries describing the `needs_backfill` SELECT this ticket
//     removes from `finalize-tx.ts`.
//   418 → 414: the four entries describing `maybeEnqueueBackfillResume`'s
//     resume SELECT (`worker/ingress/stripe/shared.ts`). Round-1 O3 replaced
//     its copied payload/enqueue block with the shared `enqueueInitialImport`
//     and narrowed what remains to an eligibility check that binds
//     `zc.business_id`, `b.account_id` and `a.id` in TOP-LEVEL predicates — so
//     the audit can see the scope and needs no suppression at all. The
//     `zernio_backfill_runs` entry went with the `NOT EXISTS` completed-run
//     subquery, which now lives (scoped to `run_reason = 'initial'`) in
//     `enqueueInitialImport`.
//   414 → 412 (#678), also a SHRINK. The Reviews list rewrote every
//     `load-replies.ts` query, and this allowlist keys on exact SQL text, so
//     all EIGHT of that file's entries were orphaned by construction — none of
//     them avoidable by writing better SQL. Replaced by six:
//       - three for `load-replies.ts`: the LEFT-JOIN + four-LATERAL main query
//         and the two `EXISTS` / `NOT EXISTS` group counts. The new AVG query
//         needs NO entry — it no longer joins `responses`, so
//         `r.business_id = ${locationId}` scopes it outright.
//       - three for the new Generate door
//         (`api/dashboard/reviews/[reviewId]/generate/route.ts`), the same
//         shape `past-replies/draft/route.ts` already carries: the route proves
//         ownership via `businesses.account_id` BEFORE opening the tx, so the
//         in-tx reads key on `review_id` alone.
//     `draft-status/route.ts` needs none — it binds `resp.business_id`.
export const ALLOWLIST_BASELINE = 409;

interface CategoryPathRule {
  allowedPrefixes: readonly string[];
  /** Individually reviewed files outside the standard prefixes. */
  allowedFiles?: readonly string[];
}

/**
 * Cheap structural invariants per category, enforced by the audit. Categories
 * without an entry here have no path-shaped invariant (their justification
 * lives in request/job context, not file location).
 */
export const CATEGORY_PATH_RULES: Partial<
  Record<TenantScopeAllowlistCategory, CategoryPathRule>
> = {
  'admin-after-require-role': {
    allowedPrefixes: ['src/app/api/admin/', 'src/app/admin/', 'src/lib/admin/'],
    // Admin-only mutation helper invoked from the admin offboarding route
    // after requireRole(admin); lives with its domain, not under src/lib/admin.
    allowedFiles: [
      'src/lib/account-offboarding/provider-disposition.ts',
      // Deep read module invoked only after the admin autonomy route's
      // requireAdminWithAal2 gate; keeps cross-account aggregation out of the
      // composition root while remaining explicitly injected and testable.
      'src/lib/auto-approval/suspension.ts',
      // The Task 10 admin recovery list calls governor's bounded batch-rate
      // seam after requireAdminWithAal2. The scheduler's ordinary one-account
      // calls remain tenant-scoped and need no cross-account exemption.
      'src/lib/auto-approval/governor.ts',
    ],
  },
  'platform-cross-account': {
    allowedPrefixes: ['src/lib/admin/'],
  },
  'background-global-scan': {
    allowedPrefixes: ['worker/'],
    // Domain scans invoked by registered pollers/schedulers. Keeping them in
    // src/lib preserves explicit Sql injection and testability; governor.ts's
    // separate Task 10 admin batch-rate statements use the admin category.
    allowedFiles: [
      'src/lib/responses/judge-store.ts',
      'src/lib/responses/judge-health.ts',
      'src/lib/auto-approval/governor.ts',
    ],
  },
  'provider-ingress': {
    // src/app/api/zernio/ is the ADR 0001 OAuth-handshake carve-out.
    allowedPrefixes: ['worker/ingress/', 'src/app/api/zernio/'],
  },
};

// ── Shared snippets ─────────────────────────────────────────────────────────
// One query that the audit attributes to multiple tables needs one entry per
// table, but the snippet text itself must stay byte-identical to the source —
// so each multi-entry query is hoisted here once instead of being copy-pasted
// per entry.

const MONTHLY_IMPACT_CANDIDATES_SQL =
  "INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status) SELECT gen_random_uuid(), ${QUEUE_NAMES.SEND_MONTHLY_IMPACT}, 'business', b.id, jsonb_build_object( 'business_id', b.id, 'month_start_date', ${monthStartDate}::text, 'correlation_id', gen_random_uuid() ), 'pending' FROM businesses b JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'past_due', 'trialing') AND b.archived_at IS NULL AND a.monthly_impact_enabled = TRUE AND NOT EXISTS ( SELECT 1 FROM monthly_impact_emails mie WHERE mie.business_id = b.id AND mie.month_start_date = ${monthStartDate}::date AND mie.sent_at IS NOT NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_MONTHLY_IMPACT} AND jo.aggregate_id = b.id AND jo.status IN ('pending', 'dispatching', 'dispatched') AND jo.payload->>'month_start_date' = ${monthStartDate} ) ON CONFLICT DO NOTHING";

const ONBOARDING_DRIP_CANDIDATES_SQL =
  "SELECT b.id AS business_id, d.drip_type FROM businesses b JOIN accounts a ON a.id = b.account_id CROSS JOIN (VALUES ('day_1', 1), ('day_7', 7), ('day_30', 30)) AS d(drip_type, days) WHERE a.subscription_status IN ('active', 'trialing') AND b.subscription_activated_at IS NOT NULL AND b.subscription_activated_at <= NOW() - (d.days || ' days')::interval AND NOT EXISTS ( SELECT 1 FROM onboarding_drip_log dl WHERE dl.business_id = b.id AND dl.drip_type = d.drip_type AND dl.sent_at IS NOT NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.ONBOARDING_DRIP} AND jo.aggregate_id = b.id AND jo.status <> 'failed' AND jo.payload->>'drip_type' = d.drip_type )";

const WEEKLY_SUMMARY_CANDIDATES_SQL =
  "INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status) SELECT gen_random_uuid(), ${QUEUE_NAMES.WEEKLY_SUMMARY}, 'business', b.id, jsonb_build_object( 'business_id', b.id, 'week_start_date', ${weekStartDate}::text, 'correlation_id', gen_random_uuid() ), 'pending' FROM businesses b JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'past_due', 'trialing') AND b.archived_at IS NULL AND a.weekly_summary_enabled = TRUE AND NOT EXISTS ( SELECT 1 FROM weekly_summaries ws WHERE ws.business_id = b.id AND ws.week_start_date = ${weekStartDate}::date AND ws.sent_at IS NOT NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.WEEKLY_SUMMARY} AND jo.aggregate_id = b.id AND jo.status IN ('pending', 'dispatching', 'dispatched') AND jo.payload->>'week_start_date' = ${weekStartDate} ) ON CONFLICT DO NOTHING";

const RANKING_TRACKING_CANDIDATES_SQL =
  "INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status) SELECT gen_random_uuid(), ${QUEUE_NAMES.TRACK_RANKING}, 'business', b.id, jsonb_build_object( 'business_id', b.id, 'google_place_id', b.google_place_id, 'run_date', ${runDate}::text, 'correlation_id', gen_random_uuid() ), 'pending' FROM businesses b JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status = 'active' AND b.place_id_verified = TRUE AND b.google_place_id IS NOT NULL AND b.tracked_keywords <> '[]'::jsonb AND ( (b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL) OR b.ranking_search_location IS NOT NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.TRACK_RANKING} AND jo.aggregate_id = b.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ON CONFLICT DO NOTHING";

const DASHBOARD_SETTINGS_SELECT_SQL =
  "SELECT b.name, b.created_at, b.initial_review_count, b.initial_responded_count, b.baseline_captured_at, b.tone, b.products_services, b.avoid_facts, b.sample_responses, b.owner_phone, b.owner_email, a.weekly_summary_enabled, a.monthly_impact_enabled, b.category, b.google_place_id FROM businesses b JOIN accounts a ON a.id = b.account_id WHERE b.id = ${businessId} LIMIT 1";

const HEALTH_ZERO_DELIVERY_SQL =
  "SELECT COUNT(*)::int AS count FROM job_outbox jo JOIN responses r ON r.id = (jo.payload->>'response_id')::uuid JOIN businesses b ON b.id = r.business_id WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.status = 'completed' AND COALESCE(jo.completed_at, jo.dispatched_at, jo.available_at) > NOW() - make_interval(secs => ${cfg.zeroDeliveryWindowS}) AND r.status = 'pending_approval' AND b.archived_at IS NULL AND jo.completion_reason IS DISTINCT FROM ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE} AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = r.id )";

// F1 owner-unreachable durable signal. HealthAlertPoller.checkOwnerUnreachable
// counts pending_approval drafts on live businesses whose LATEST completed
// send_notification recorded completion_reason='owner_unreachable' and never got
// an approval_request delivery. Read-only cross-tenant health probe.
const HEALTH_OWNER_UNREACHABLE_SQL =
  "SELECT COUNT(*)::int AS count FROM responses r JOIN businesses b ON b.id = r.business_id WHERE r.status = 'pending_approval' AND b.archived_at IS NULL AND r.created_at < NOW() - make_interval(secs => ${cfg.ownerUnreachableAgeS}) AND ( SELECT jo.completion_reason FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = r.id AND jo.status = 'completed' ORDER BY jo.created_at DESC LIMIT 1 ) = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE} AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = r.id AND nd.template = 'approval_request' )";

// F1 owner-unreachable failover. NotificationFailoverPoller.processOwnerUnreachable
// candidate scan: pending_approval drafts aged past the 4h floor whose latest
// completed send_notification was owner_unreachable and that never got an
// approval_request delivery. Global poller scan before per-row locked re-check.
const FAILOVER_OWNER_UNREACHABLE_CANDIDATES_SQL =
  "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND b.archived_at IS NULL AND resp.created_at < NOW() - make_interval(secs => ${ageFloorSeconds}) AND ( SELECT jo.completion_reason FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status = 'completed' ORDER BY jo.created_at DESC LIMIT 1 ) = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE} AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}";

// F1 owner-unreachable failover. NotificationFailoverPoller.processOwnerUnreachable
// advisory-locked re-check inside sql.begin: confirms still-unreachable and whether
// a send_notification is already in flight before enqueueing a retry.
const FAILOVER_OWNER_UNREACHABLE_RECHECK_SQL =
  "SELECT EXISTS ( SELECT 1 FROM responses resp JOIN businesses b ON b.id = resp.business_id WHERE resp.id = ${row.response_id} AND resp.status = 'pending_approval' AND b.archived_at IS NULL AND resp.created_at < NOW() - make_interval(secs => ${ageFloorSeconds}) AND ( SELECT jo.completion_reason FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status = 'completed' ORDER BY jo.created_at DESC LIMIT 1 ) = ${OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE} AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' ) ) AS unreachable, EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = ${row.response_id} AND jo.status IN ('pending', 'dispatching', 'dispatched') ) AS in_flight";

const HEALTH_FAILED_INBOUND_EVENTS_SQL =
  "SELECT source, event_type, COUNT(*)::int AS count FROM inbound_events WHERE status = 'failed' AND received_at > NOW() - make_interval(secs => ${cfg.failedWindowS}) GROUP BY source, event_type";

// D15c stalled send-batch probe. HealthAlertPoller.checkStalledSendBatches counts
// solicitation_send_batch parent runs still 'running' past their 11-day threshold
// (one day beyond the ≤10-day construction bound). Read-only cross-tenant probe.
const HEALTH_STALLED_SEND_BATCHES_SQL =
  "SELECT COUNT(*)::int AS count, (ARRAY_AGG(id::text ORDER BY started_at))[1] AS oldest_run_id, MAX(EXTRACT(EPOCH FROM (NOW() - started_at))::int) AS oldest_age_s FROM agent_runs WHERE kind = ${SEND_BATCH_RUN_KIND} AND status = 'running' AND started_at < NOW() - make_interval(secs => ${STALLED_SEND_BATCH_THRESHOLD_S})";

const JUDGE_SWEEP_CANDIDATES_SQL =
  "SELECT r.id AS response_id, r.business_id, b.account_id FROM responses r JOIN businesses b ON b.id = r.business_id JOIN accounts a ON a.id = b.account_id WHERE r.status = 'posted' AND r.approval_method = 'auto_policy' AND r.posted_at >= NOW() - make_interval(hours => ${options.lookbackHours}) AND ${publisherSubscriptionEligibleSql(sql)} AND NOT EXISTS ( SELECT 1 FROM judge_verdicts jv WHERE jv.response_id = r.id ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.JUDGE_VERDICT} AND jo.aggregate_id = r.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY r.posted_at ASC, r.id ASC LIMIT ${options.limit}";

const JUDGE_HEALTH_STALENESS_SQL =
  "SELECT EXISTS ( SELECT 1 FROM responses r JOIN businesses b ON b.id = r.business_id JOIN accounts a ON a.id = b.account_id WHERE r.status = 'posted' AND r.approval_method = 'auto_policy' AND r.posted_at >= NOW() - make_interval(hours => ${JUDGE_LOOKBACK_HOURS}) AND r.posted_at < NOW() - make_interval(mins => ${JUDGE_STALENESS_LIMIT_MINUTES}) AND ${publisherSubscriptionEligibleSql(sql)} AND NOT EXISTS ( SELECT 1 FROM judge_verdicts jv WHERE jv.response_id = r.id ) AND EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.JUDGE_VERDICT} AND jo.aggregate_id = r.id AND jo.created_at < NOW() - make_interval(mins => ${JUDGE_STALENESS_LIMIT_MINUTES}) ) ) AS has_stale_unjudged";

const JUDGE_HEALTH_ERROR_DENSITY_SQL =
  "SELECT COUNT(*)::int AS total_count, COUNT(*) FILTER ( WHERE verdict = 'error' AND NOT COALESCE(reasons @> ${sql.json([JUDGE_ERROR_REASON_BUDGET_EXCEEDED])}, false) )::int AS error_count FROM judge_verdicts WHERE created_at >= NOW() - make_interval(mins => ${JUDGE_STALENESS_LIMIT_MINUTES})";

const GOVERNOR_CANDIDATES_SQL =
  "SELECT armed.account_id, GREATEST( NOW() - make_interval(days => ${GOVERNOR_WINDOW_DAYS}), COALESCE(MAX(aal.created_at), '-infinity'::timestamptz) ) AS window_start FROM auto_approval_policies armed LEFT JOIN account_audit_log aal ON aal.account_id = armed.account_id AND aal.event_type = 'autonomy_unsuspended' WHERE armed.auto_approve_min_star IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM auto_approval_policies account_default WHERE account_default.account_id = armed.account_id AND account_default.location_id IS NULL AND account_default.persona = 'reply' AND account_default.action_class = 'posting' AND account_default.suspended_at IS NOT NULL ) GROUP BY armed.account_id ORDER BY CASE WHEN COALESCE(armed.account_id > ${afterAccountId}::uuid, TRUE) THEN 0 ELSE 1 END, armed.account_id LIMIT ${limit}";

const GOVERNOR_BATCH_OUTCOMES_SQL =
  "SELECT scope.account_id, COALESCE(SUM(outcome.unit_count) FILTER ( WHERE outcome.outcome_kind = ${'reply_edited_by_owner'} ), 0)::int AS edited_count, COALESCE(SUM(outcome.unit_count) FILTER ( WHERE outcome.outcome_kind = ${'reply_approved_no_edit'} ), 0)::int AS approved_count, COALESCE(SUM(outcome.unit_count) FILTER ( WHERE outcome.outcome_kind = ${'reply_vetoed_by_owner'} ), 0)::int AS vetoed_count, COALESCE(SUM(outcome.unit_count) FILTER ( WHERE outcome.outcome_kind = ${'reply_auto_posted'} ), 0)::int AS auto_posted_count FROM unnest(${accountIds}::uuid[], ${windowStarts}::timestamptz[]) AS scope(account_id, window_start) LEFT JOIN agent_outcomes outcome ON outcome.account_id = scope.account_id AND outcome.occurred_at >= scope.window_start AND outcome.outcome_kind IN ( ${'reply_edited_by_owner'}, ${'reply_approved_no_edit'}, ${'reply_vetoed_by_owner'}, ${'reply_auto_posted'} ) GROUP BY scope.account_id ORDER BY scope.account_id";

const GOVERNOR_BATCH_VERDICTS_SQL =
  "SELECT scope.account_id, COUNT(*) FILTER (WHERE verdict.verdict = 'pass')::int AS pass_count, COUNT(*) FILTER (WHERE verdict.verdict = 'warn')::int AS warn_count, COUNT(*) FILTER (WHERE verdict.verdict = 'flag')::int AS flag_count FROM unnest(${accountIds}::uuid[], ${windowStarts}::timestamptz[]) AS scope(account_id, window_start) LEFT JOIN judge_verdicts verdict ON verdict.account_id = scope.account_id AND verdict.created_at >= scope.window_start AND verdict.verdict IN ('pass', 'warn', 'flag') GROUP BY scope.account_id ORDER BY scope.account_id";

const SUSPENDED_POLICIES_SQL =
  "SELECT policy.id AS policy_id, policy.account_id, account.display_name AS account_name, policy.location_id, COALESCE(NULLIF(location.display_label, ''), location.name) AS location_name, policy.suspended_reason, policy.suspended_at, GREATEST( NOW() - make_interval(days => ${GOVERNOR_WINDOW_DAYS}), COALESCE(MAX(unsuspend_audit.created_at), '-infinity'::timestamptz) ) AS window_start, (array_agg(suspend_audit.payload->>'trigger' ORDER BY suspend_audit.created_at DESC, suspend_audit.id DESC))[1] AS audit_trigger FROM auto_approval_policies policy JOIN accounts account ON account.id = policy.account_id LEFT JOIN businesses location ON location.id = policy.location_id AND location.account_id = policy.account_id LEFT JOIN account_audit_log unsuspend_audit ON unsuspend_audit.account_id = policy.account_id AND unsuspend_audit.event_type = 'autonomy_unsuspended' LEFT JOIN account_audit_log suspend_audit ON suspend_audit.account_id = policy.account_id AND suspend_audit.event_type = 'autonomy_suspended' WHERE policy.suspended_at IS NOT NULL GROUP BY policy.id, policy.account_id, account.display_name, policy.location_id, location.display_label, location.name, policy.suspended_reason, policy.suspended_at ORDER BY policy.suspended_at DESC, policy.id LIMIT 100";

const SUSPENSION_FLAG_EVIDENCE_SQL =
  "WITH ranked_flags AS ( SELECT verdict.id, verdict.account_id, verdict.business_id, verdict.review_id, verdict.response_id, ARRAY( SELECT jsonb_array_elements_text( CASE WHEN jsonb_typeof(verdict.reasons) = 'array' THEN verdict.reasons ELSE '[]'::jsonb END ) ) AS reason_categories, verdict.created_at, ROW_NUMBER() OVER ( PARTITION BY verdict.account_id ORDER BY verdict.created_at DESC, verdict.id DESC ) AS flag_rank FROM judge_verdicts verdict WHERE verdict.account_id = ANY(${accountIds}::uuid[]) AND verdict.verdict = 'flag' ) SELECT id, account_id, business_id, review_id, response_id, reason_categories, created_at FROM ranked_flags WHERE flag_rank <= 5 ORDER BY account_id, created_at DESC, id DESC";

// #546 Competitor Delta lane. One statement on purpose: RankingTrackingWorker
// replaces the pack wholesale and overwrites search_location on a same-day
// re-run, so sequential reads can observe a pack that does not match the dates
// just read (READ COMMITTED makes a wrapping transaction no help). Every leg is
// bound to ${businessId}; two of the three predicates sit inside CTE bodies.
const NAMED_RIVAL_LANE_SQL =
  "WITH ctx AS ( SELECT ${primaryTrackedKeywordSql(db)} AS keyword, CASE WHEN b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL THEN b.google_place_lat::text || ',' || b.google_place_lng::text ELSE b.ranking_search_location END AS search_location, b.rival_place_id, b.rival_title_snapshot FROM businesses b WHERE b.id = ${businessId} ), dates AS ( SELECT rs.snapshot_date FROM ranking_snapshots rs, ctx WHERE rs.business_id = ${businessId} AND rs.keyword = ctx.keyword AND rs.search_location = ctx.search_location ORDER BY rs.snapshot_date DESC LIMIT 2 ) SELECT ctx.keyword, ctx.search_location, ctx.rival_place_id, ctx.rival_title_snapshot, d.snapshot_date::text AS window_date, cs.snapshot_date::text AS snapshot_date, cs.rank_position, cs.place_id, cs.title, cs.review_count, cs.is_self FROM ctx LEFT JOIN dates d ON true LEFT JOIN competitor_snapshots cs ON cs.business_id = ${businessId} AND cs.keyword = ctx.keyword AND cs.search_location IS NOT DISTINCT FROM ctx.search_location AND cs.snapshot_date = d.snapshot_date ORDER BY d.snapshot_date DESC, cs.rank_position ASC NULLS LAST, cs.place_id ASC NULLS LAST";

// #645 §7.3 admin servicing lookup. One statement the audit attributes to two
// tables (solicitation_suppressions + the accounts display-name join), so it is
// hoisted here once rather than copy-pasted into both entries.
const ADMIN_SUPPRESSION_LOOKUP_SQL =
  "SELECT s.id, s.channel, s.normalized_handle, s.scope, s.source, s.account_id, a.display_name AS account_name, s.created_by_user_id, s.note, s.suppressed_at::text FROM solicitation_suppressions s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.channel = 'email' AND s.normalized_handle = ${handle} ORDER BY (s.scope = 'global') DESC, s.suppressed_at ASC";

export const tenantScopeAllowlist: TenantScopeAllowlistEntry[] = [
  {
    file: "src/app/(authenticated)/settings/locations/page.tsx",
    table: "accounts",
    sqlSnippet: "SELECT subscription_tier, subscription_status FROM accounts WHERE id = ${access.accountId}::uuid LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/app/(public)/approve/[token]/page.tsx",
    table: "approval_links",
    sqlSnippet: "SELECT response_id, business_id, expires_at, consumed_at, revoked_at FROM approval_links WHERE token_hash = ${tokenHash}",
    category: 'pre-auth-token',
    reason: "Opaque approval token or callback lookup must resolve the approval row before tenant scope is known.",
  },
  {
    file: "src/app/api/admin/businesses/[id]/keywords/route.ts",
    table: "businesses",
    sqlSnippet: "UPDATE businesses SET tracked_keywords = ${jsonb(parsed.keywords)}, updated_at = NOW() WHERE id = ${businessId} RETURNING id",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/businesses-list-service.ts",
    table: "businesses",
    sqlSnippet: "SELECT COUNT(*)::int AS total FROM businesses",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/flagged-service.ts",
    table: "responses",
    sqlSnippet: "SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id, fr.source, fr.reason, fr.severity, fr.status, fr.created_at, r.response_text, r.version, rev.reviewer_name, rev.star_rating, b.name AS business_name FROM flagged_responses fr JOIN responses r ON r.id = fr.response_id JOIN reviews rev ON rev.id = fr.review_id JOIN businesses b ON b.id = fr.business_id WHERE fr.status = 'open' ORDER BY fr.created_at DESC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cross-tenant read of the open flagged-response queue (deny-all RLS table joined to its parent rows); gated by requireRole('admin') and proxy /api/admin protection.",
  },
  {
    file: "src/lib/admin/flagged-service.ts",
    table: "reviews",
    sqlSnippet: "SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id, fr.source, fr.reason, fr.severity, fr.status, fr.created_at, r.response_text, r.version, rev.reviewer_name, rev.star_rating, b.name AS business_name FROM flagged_responses fr JOIN responses r ON r.id = fr.response_id JOIN reviews rev ON rev.id = fr.review_id JOIN businesses b ON b.id = fr.business_id WHERE fr.status = 'open' ORDER BY fr.created_at DESC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cross-tenant read of the open flagged-response queue (deny-all RLS table joined to its parent rows); gated by requireRole('admin') and proxy /api/admin protection.",
  },
  {
    file: "src/lib/admin/flagged-service.ts",
    table: "businesses",
    sqlSnippet: "SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id, fr.source, fr.reason, fr.severity, fr.status, fr.created_at, r.response_text, r.version, rev.reviewer_name, rev.star_rating, b.name AS business_name FROM flagged_responses fr JOIN responses r ON r.id = fr.response_id JOIN reviews rev ON rev.id = fr.review_id JOIN businesses b ON b.id = fr.business_id WHERE fr.status = 'open' ORDER BY fr.created_at DESC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cross-tenant read of the open flagged-response queue (deny-all RLS table joined to its parent rows); gated by requireRole('admin') and proxy /api/admin protection.",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "api_costs",
    sqlSnippet: "SELECT COALESCE(SUM(cost_usd), 0)::float AS total FROM api_costs WHERE created_at >= CURRENT_DATE",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT COUNT(*)::int AS count FROM notification_deliveries WHERE failed_at IS NOT NULL AND failed_at >= NOW() - INTERVAL '24 hours'",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '24 hours')::int AS sent_24h, COUNT(*) FILTER (WHERE delivered_at IS NOT NULL AND sent_at >= NOW() - INTERVAL '24 hours')::int AS delivered_24h, COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS bounces_7d, COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:hard:%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS hard_bounces_7d, COUNT(*) FILTER (WHERE failure_reason = 'complained' AND failed_at >= NOW() - INTERVAL '7 days')::int AS complaints_7d FROM notification_deliveries",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "businesses",
    sqlSnippet: "SELECT COUNT(*)::int AS total FROM businesses",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/app/api/approve/[token]/route.ts",
    table: "approval_links",
    sqlSnippet: "SELECT id, response_id, business_id, expires_at, consumed_at, revoked_at FROM approval_links WHERE token_hash = ${tokenHash}",
    category: 'pre-auth-token',
    reason: "Opaque approval token or callback lookup must resolve the approval row before tenant scope is known.",
  },
  {
    file: "src/app/api/billing/checkout/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.id, a.subscription_status, u.email AS owner_email, (SELECT b.onboarded_by FROM businesses b WHERE b.account_id = ${accountId}::uuid AND b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL LIMIT 1) AS onboarded_by FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/app/api/billing/checkout/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT a.id, a.subscription_status, u.email AS owner_email, (SELECT b.onboarded_by FROM businesses b WHERE b.account_id = ${accountId}::uuid AND b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL LIMIT 1) AS onboarded_by FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "onboarded_by subquery is tenant-scoped: b.account_id = a.id where a.id = ${accountId} (the owner-verified tenant root).",
  },
  {
    file: "src/app/api/billing/portal/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT id, subscription_status, stripe_customer_id FROM accounts WHERE id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/accounts/tier-change.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT a.owner_user_id, a.price_variant, a.stripe_subscription_id, a.subscription_status, a.subscription_tier, a.locations_overage_price_cents, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM accounts a LEFT JOIN LATERAL ( SELECT active.* FROM account_offboardings active WHERE active.account_id = a.id AND active.terminal_at IS NULL ORDER BY active.created_at DESC LIMIT 1 ) ao ON TRUE WHERE a.id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "The tier-change transaction first locks the owner-resolved account id, then projects only that account's latest active offboarding row through a correlated lateral join; the scanner intentionally strips the correlated subquery predicate.",
  },
  {
    file: "src/app/api/dashboard/past-replies/draft-status/route.ts",
    table: "responses",
    sqlSnippet: "SELECT id, status, response_text, business_id FROM responses WHERE review_id = ${outbox.aggregate_id} AND status IN ('pending_approval', 'approved', 'edited') ORDER BY version DESC LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Draft-status route verifies the owner-resolved location against the outbox payload before reading this response row, then rechecks response.business_id.",
  },
  {
    file: "src/app/api/dashboard/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT cancelled_at, subscription_activated_at FROM accounts WHERE id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/payments/plan-activation.ts",
    table: "businesses",
    sqlSnippet: "SELECT account_id, onboarded_by FROM businesses WHERE id = ${businessId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses business/location id as the lookup key after owner scope has been established.",
  },
  {
    file: "src/app/api/settings/voice/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT id, name, display_label, tone, products_services, avoid_facts, sample_responses, is_primary FROM businesses WHERE id = ANY(${locationIds}::uuid[]) AND archived_at IS NULL ORDER BY is_primary DESC, created_at ASC",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses business/location id as the lookup key after owner scope has been established.",
  },
  {
    file: "src/lib/accounts/quota.ts",
    table: "accounts",
    sqlSnippet: "SELECT subscription_tier, locations_included, locations_paid, locations_overage_price_cents, base_price_cents FROM accounts WHERE id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/accounts/quota.ts",
    table: "accounts",
    sqlSnippet: "SELECT id, subscription_tier, subscription_status, locations_included, locations_paid FROM accounts WHERE id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/accounts/repo.ts",
    table: "accounts",
    sqlSnippet: "SELECT id, owner_user_id, display_name, subscription_tier, subscription_status, stripe_customer_id, stripe_subscription_id, trial_ends_at, subscription_activated_at, locations_included, locations_paid, locations_overage_price_cents, base_price_cents, flags, created_at, updated_at FROM accounts WHERE id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/accounts/repo.ts",
    table: "accounts",
    sqlSnippet: "SELECT owner_user_id FROM accounts WHERE id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/accounts/repo.ts",
    table: "accounts",
    sqlSnippet: "SELECT u.id, u.name, u.email FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id = ${accountId}::uuid LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/accounts/tier-change.ts",
    table: "businesses",
    sqlSnippet: "SELECT COUNT(*) AS count FROM businesses WHERE account_id = ${accountId}::uuid AND archived_at IS NULL",
    category: 'tenant-root-lookup',
    reason: "The active-location count is constrained by the owner-resolved account id while the shared billing locks hold the tier-change plan boundary.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs",
    sqlSnippet: "SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count FROM api_costs WHERE ${optionalAccountPrefix(sql, accountId)}${dateFilter(sql, days)} GROUP BY provider ORDER BY total_usd DESC",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report; account_id/date predicates are composed from shared sql fragments (optionalAccountPrefix/dateFilter) after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "accounts",
    sqlSnippet: "WITH combined AS ( SELECT business_id, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count, SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd FROM api_costs WHERE ${optionalAccountPrefixCte(sql, accountId)}${dateFilter(sql, days)} AND business_id IS NOT NULL GROUP BY business_id UNION ALL SELECT business_id, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count, 0::float AS today_usd FROM api_costs_daily_rollups WHERE ${rollupBoundary(sql, days)} AND business_id IS NOT NULL${ accountId ? sql` AND ${businessIdInAccount(sql, accountId)}` : sql`` } GROUP BY business_id ), business_totals AS ( SELECT business_id, SUM(total_usd)::float AS total_usd, SUM(call_count)::float AS call_count, SUM(today_usd)::float AS today_usd FROM combined GROUP BY business_id ) SELECT bt.business_id, b.name, a.subscription_tier, bt.total_usd, bt.call_count, bt.today_usd FROM business_totals bt JOIN businesses b ON b.id = bt.business_id JOIN accounts a ON a.id = b.account_id ORDER BY bt.total_usd DESC, bt.business_id ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report byBusiness rollup CTE; account_id/rollup-boundary predicates are composed from shared sql fragments after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "businesses",
    sqlSnippet: "WITH combined AS ( SELECT business_id, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count, SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd FROM api_costs WHERE ${optionalAccountPrefixCte(sql, accountId)}${dateFilter(sql, days)} AND business_id IS NOT NULL GROUP BY business_id UNION ALL SELECT business_id, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count, 0::float AS today_usd FROM api_costs_daily_rollups WHERE ${rollupBoundary(sql, days)} AND business_id IS NOT NULL${ accountId ? sql` AND ${businessIdInAccount(sql, accountId)}` : sql`` } GROUP BY business_id ), business_totals AS ( SELECT business_id, SUM(total_usd)::float AS total_usd, SUM(call_count)::float AS call_count, SUM(today_usd)::float AS today_usd FROM combined GROUP BY business_id ) SELECT bt.business_id, b.name, a.subscription_tier, bt.total_usd, bt.call_count, bt.today_usd FROM business_totals bt JOIN businesses b ON b.id = bt.business_id JOIN accounts a ON a.id = b.account_id ORDER BY bt.total_usd DESC, bt.business_id ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report byBusiness rollup CTE; account_id/rollup-boundary predicates are composed from shared sql fragments after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs",
    sqlSnippet: "WITH combined AS ( SELECT business_id, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count, SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd FROM api_costs WHERE ${optionalAccountPrefixCte(sql, accountId)}${dateFilter(sql, days)} AND business_id IS NOT NULL GROUP BY business_id UNION ALL SELECT business_id, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count, 0::float AS today_usd FROM api_costs_daily_rollups WHERE ${rollupBoundary(sql, days)} AND business_id IS NOT NULL${ accountId ? sql` AND ${businessIdInAccount(sql, accountId)}` : sql`` } GROUP BY business_id ), business_totals AS ( SELECT business_id, SUM(total_usd)::float AS total_usd, SUM(call_count)::float AS call_count, SUM(today_usd)::float AS today_usd FROM combined GROUP BY business_id ) SELECT bt.business_id, b.name, a.subscription_tier, bt.total_usd, bt.call_count, bt.today_usd FROM business_totals bt JOIN businesses b ON b.id = bt.business_id JOIN accounts a ON a.id = b.account_id ORDER BY bt.total_usd DESC, bt.business_id ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report byBusiness rollup CTE; account_id/rollup-boundary predicates are composed from shared sql fragments after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs_daily_rollups",
    sqlSnippet: "WITH combined AS ( SELECT business_id, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count, SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd FROM api_costs WHERE ${optionalAccountPrefixCte(sql, accountId)}${dateFilter(sql, days)} AND business_id IS NOT NULL GROUP BY business_id UNION ALL SELECT business_id, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count, 0::float AS today_usd FROM api_costs_daily_rollups WHERE ${rollupBoundary(sql, days)} AND business_id IS NOT NULL${ accountId ? sql` AND ${businessIdInAccount(sql, accountId)}` : sql`` } GROUP BY business_id ), business_totals AS ( SELECT business_id, SUM(total_usd)::float AS total_usd, SUM(call_count)::float AS call_count, SUM(today_usd)::float AS today_usd FROM combined GROUP BY business_id ) SELECT bt.business_id, b.name, a.subscription_tier, bt.total_usd, bt.call_count, bt.today_usd FROM business_totals bt JOIN businesses b ON b.id = bt.business_id JOIN accounts a ON a.id = b.account_id ORDER BY bt.total_usd DESC, bt.business_id ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report byBusiness rollup CTE; account_id/rollup-boundary predicates are composed from shared sql fragments after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "accounts",
    sqlSnippet: "SELECT ac.business_id, b.name, a.subscription_tier, SUM(ac.cost_usd)::float AS total_usd, COUNT(ac.id)::float AS call_count, SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd FROM api_costs ac JOIN businesses b ON b.id = ac.business_id JOIN accounts a ON a.id = b.account_id WHERE ${ accountId ? sql`ac.account_id = ${accountId}::uuid AND ` : sql`` }ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day' GROUP BY ac.business_id, b.name, a.subscription_tier ORDER BY total_usd DESC, ac.business_id ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report byBusiness non-rollup query; the account_id predicate is an inline ternary sql fragment after requireRole(admin), so the literal snippet no longer inlines the predicate text unconditionally.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "businesses",
    sqlSnippet: "SELECT ac.business_id, b.name, a.subscription_tier, SUM(ac.cost_usd)::float AS total_usd, COUNT(ac.id)::float AS call_count, SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd FROM api_costs ac JOIN businesses b ON b.id = ac.business_id JOIN accounts a ON a.id = b.account_id WHERE ${ accountId ? sql`ac.account_id = ${accountId}::uuid AND ` : sql`` }ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day' GROUP BY ac.business_id, b.name, a.subscription_tier ORDER BY total_usd DESC, ac.business_id ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report byBusiness non-rollup query; the account_id predicate is an inline ternary sql fragment after requireRole(admin), so the literal snippet no longer inlines the predicate text unconditionally.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs",
    sqlSnippet: "WITH combined AS ( SELECT business_id FROM api_costs WHERE ${optionalAccountPrefixCte(sql, accountId)}${dateFilter(sql, days)} AND business_id IS NOT NULL GROUP BY business_id UNION SELECT business_id FROM api_costs_daily_rollups WHERE ${optionalRollupAcctPrefix(sql, days, accountId)} AND business_id IS NOT NULL GROUP BY business_id ) SELECT COUNT(*)::int AS total FROM combined",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report businessCount rollup CTE; account_id/rollup-boundary predicates are composed from shared sql fragments after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs_daily_rollups",
    sqlSnippet: "WITH combined AS ( SELECT business_id FROM api_costs WHERE ${optionalAccountPrefixCte(sql, accountId)}${dateFilter(sql, days)} AND business_id IS NOT NULL GROUP BY business_id UNION SELECT business_id FROM api_costs_daily_rollups WHERE ${optionalRollupAcctPrefix(sql, days, accountId)} AND business_id IS NOT NULL GROUP BY business_id ) SELECT COUNT(*)::int AS total FROM combined",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report businessCount rollup CTE; account_id/rollup-boundary predicates are composed from shared sql fragments after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs",
    sqlSnippet: "SELECT COUNT(DISTINCT business_id)::int AS total FROM api_costs WHERE ${optionalAccountPrefix(sql, accountId)}${dateFilter(sql, days)} AND business_id IS NOT NULL",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report; account_id/date predicates are composed from shared sql fragments (optionalAccountPrefix/dateFilter) after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs",
    sqlSnippet: "SELECT DATE(created_at)::text AS day, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count FROM api_costs WHERE ${optionalAccountPrefix(sql, accountId)}${dateFilter(sql, days)} GROUP BY DATE(created_at) ORDER BY day DESC",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report; account_id/date predicates are composed from shared sql fragments (optionalAccountPrefix/dateFilter) after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs",
    sqlSnippet: "SELECT COALESCE(SUM(cost_usd), 0)::float AS total FROM api_costs WHERE ${optionalAccountPrefix(sql, accountId)}created_at >= CURRENT_DATE",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report; the account_id predicate is composed from a shared sql fragment (optionalAccountPrefix) after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs_daily_rollups",
    sqlSnippet: "SELECT provider, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count FROM api_costs_daily_rollups WHERE ${optionalRollupAcctPrefix(sql, days, accountId)} GROUP BY provider",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report rollupProvider query; the account_id/rollup-boundary predicate is composed from a shared sql fragment (optionalRollupAcctPrefix) after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "api_costs_daily_rollups",
    sqlSnippet: "SELECT rollup_date::text AS day, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count FROM api_costs_daily_rollups WHERE ${optionalRollupAcctPrefix(sql, days, accountId)} GROUP BY rollup_date",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report rollupDay query; the account_id/rollup-boundary predicate is composed from a shared sql fragment (optionalRollupAcctPrefix) after requireRole(admin), so the literal snippet no longer inlines the predicate text.",
  },
  {
    file: "src/lib/admin/cost-report-service.ts",
    table: "businesses",
    sqlSnippet: "business_id IN (SELECT id FROM businesses WHERE account_id = ${accountId}::uuid)",
    category: 'admin-after-require-role',
    reason: "Admin-only cost report's businessIdInAccount sql fragment, scanned standalone by the static audit: the SAME literal is nested into several parent queries (all separately allowlisted above) that already resolve account_id to the caller's requireRole(admin)-authorized scope.",
  },
  {
    file: "src/lib/admin/margin-service.ts",
    table: "accounts",
    sqlSnippet: `SELECT a.id, a.display_name, a.subscription_tier, a.subscription_status,
             a.locations_included, a.locations_overage_price_cents, a.base_price_cents,
             COUNT(b.id) FILTER (WHERE b.archived_at IS NULL)::int AS active_locations
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id
      WHERE a.subscription_status IN ('active', 'past_due', 'trialing')
      GROUP BY a.id`,
    category: 'platform-cross-account',
    reason: "Admin-only platform/account margin aggregate (Spec 26); intentionally cross-account with no tenant filter. Gated by requireRole('admin') at the /api/admin/costs route. Mirrors the admin flagged-queue allowlisting.",
  },
  {
    file: "src/lib/admin/margin-service.ts",
    table: "businesses",
    sqlSnippet: `SELECT a.id, a.display_name, a.subscription_tier, a.subscription_status,
             a.locations_included, a.locations_overage_price_cents, a.base_price_cents,
             COUNT(b.id) FILTER (WHERE b.archived_at IS NULL)::int AS active_locations
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id
      WHERE a.subscription_status IN ('active', 'past_due', 'trialing')
      GROUP BY a.id`,
    category: 'platform-cross-account',
    reason: "Admin-only platform/account margin aggregate (Spec 26); intentionally cross-account with no tenant filter. Gated by requireRole('admin') at the /api/admin/costs route. Mirrors the admin flagged-queue allowlisting.",
  },
  {
    file: "src/lib/admin/margin-service.ts",
    table: "api_costs",
    sqlSnippet: `SELECT account_id,
             SUM(cost_usd)::float AS api_cost_usd,
             COUNT(*) FILTER (WHERE provider IN ('openai', 'anthropic'))::int AS generation_count,
             COUNT(*) FILTER (WHERE provider = 'openai')::int AS openai_count,
             COUNT(*) FILTER (WHERE provider = 'anthropic')::int AS anthropic_count,
             COALESCE(SUM(cost_usd) FILTER (WHERE provider IN ('openai', 'anthropic')), 0)::float AS generation_cost_usd,
             COUNT(*) FILTER (WHERE provider IN ('openai', 'anthropic') AND flagged)::int AS flagged_count
      FROM api_costs
      WHERE account_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY account_id`,
    category: 'platform-cross-account',
    reason: "Admin-only platform/account margin aggregate (Spec 26); intentionally cross-account with no tenant filter. Gated by requireRole('admin') at the /api/admin/costs route. Mirrors the admin flagged-queue allowlisting.",
  },
  {
    file: "src/lib/admin/margin-service.ts",
    table: "api_costs",
    sqlSnippet: `SELECT COALESCE(SUM(cost_usd), 0)::float AS total_cost_usd
      FROM api_costs
      WHERE created_at >= NOW() - INTERVAL '30 days'`,
    category: 'platform-cross-account',
    reason: "Admin-only platform/account margin aggregate (Spec 26); intentionally cross-account with no tenant filter. Gated by requireRole('admin') at the /api/admin/costs route. Mirrors the admin flagged-queue allowlisting.",
  },
  {
    file: "src/lib/dashboard/aggregate-service.ts",
    table: "accounts",
    sqlSnippet: "SELECT locations_included, locations_paid FROM accounts WHERE id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/dashboard/service.ts",
    table: "businesses",
    sqlSnippet: DASHBOARD_SETTINGS_SELECT_SQL,
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses business/location id as the lookup key after owner scope has been established.",
  },
  {
    file: "src/lib/dashboard/service.ts",
    table: "accounts",
    sqlSnippet: DASHBOARD_SETTINGS_SELECT_SQL,
    category: 'tenant-root-lookup',
    reason: "Account is joined on the already-scoped business/location id (b.id = ${businessId}) only to read the account-level digest opt-in toggles (migration 063); no cross-account fan-out.",
  },
  // Reputation summary (PR2): windowed metrics folded into the per-location
  // dashboard response. Scoped by business_id; the scanner strips SELECT
  // subqueries so it cannot see the scope inside the rate query's
  // EXISTS(responses) or the trend query's LEFT JOIN(reviews). businessId is
  // IDOR-checked in the dashboard route before the service runs.
  {
    file: "src/lib/dashboard/service.ts",
    table: "responses",
    sqlSnippet: "SELECT COUNT(*) FILTER ( WHERE r.detected_at >= NOW() - make_interval(days => ${windowDays}) )::int AS received_current, COUNT(*) FILTER ( WHERE r.detected_at >= NOW() - make_interval(days => ${windowDays}) AND EXISTS ( SELECT 1 FROM responses resp WHERE resp.review_id = r.id AND resp.business_id = ${businessId} AND resp.status = ANY(${HANDLED}::text[]) ) )::int AS handled_current, COUNT(*) FILTER ( WHERE r.detected_at >= NOW() - make_interval(days => ${priorEndDays}) AND r.detected_at < NOW() - make_interval(days => ${windowDays}) )::int AS received_prior, COUNT(*) FILTER ( WHERE r.detected_at >= NOW() - make_interval(days => ${priorEndDays}) AND r.detected_at < NOW() - make_interval(days => ${windowDays}) AND EXISTS ( SELECT 1 FROM responses resp WHERE resp.review_id = r.id AND resp.business_id = ${businessId} AND resp.status = ANY(${HANDLED}::text[]) AND resp.approved_at IS NOT NULL AND resp.approved_at <= NOW() - make_interval(days => ${windowDays}) ) )::int AS handled_prior FROM reviews r WHERE r.business_id = ${businessId} AND r.status <> ${REVIEW_STATUS.DELETED} AND r.detected_at >= NOW() - make_interval(days => ${priorEndDays})",
    category: 'tenant-root-lookup',
    reason: "Reputation rate metric; responses accessed via correlated EXISTS (resp.review_id = r.id AND resp.business_id = ${businessId}) inside the reviews scan scoped by r.business_id = ${businessId}. businessId is IDOR-checked in the route.",
  },
  {
    file: "src/lib/dashboard/service.ts",
    table: "reviews",
    sqlSnippet: "SELECT gs::date AS week_start, agg.avg_score::float AS avg_score, COALESCE(agg.cnt, 0)::int AS cnt FROM generate_series( DATE_TRUNC('week', NOW() - make_interval(weeks => ${trendSpanWeeks})), DATE_TRUNC('week', NOW()), INTERVAL '1 week' ) gs LEFT JOIN ( SELECT DATE_TRUNC('week', detected_at)::date AS wk, AVG(sentiment_score) AS avg_score, COUNT(*) AS cnt FROM reviews WHERE business_id = ${businessId} AND status <> ${REVIEW_STATUS.DELETED} AND detected_at >= NOW() - make_interval(weeks => ${trendWeeks}) GROUP BY DATE_TRUNC('week', detected_at) ) agg ON agg.wk = gs::date ORDER BY week_start ASC",
    category: 'tenant-root-lookup',
    reason: "Reputation trend metric; reviews accessed inside a LEFT JOIN subquery scoped by business_id = ${businessId}. Scanner strips SELECT subqueries before predicate analysis. businessId is IDOR-checked in the route.",
  },
  {
    file: "src/lib/db/account-guard.ts",
    table: "accounts",
    sqlSnippet: "SELECT subscription_status FROM accounts WHERE id = ${accountId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/escalations/transitions.ts",
    table: "reviews",
    sqlSnippet: "SELECT id FROM reviews WHERE id = ${pre.review_id} FOR UPDATE",
    category: 'tenant-root-lookup',
    reason: "Lock-ordering statement (run-spine contract: review row FOR UPDATE first); tenant scope is established by the account-filtered escalation pre-check in the same function, which supplies the review_id.",
  },
  {
    file: "src/lib/locations/add-location-tx.ts",
    table: "accounts",
    sqlSnippet: "SELECT u.name, u.email FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id = ${accountId}::uuid LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
  },
  {
    file: "src/lib/locations/repo.ts",
    table: "businesses",
    sqlSnippet: "SELECT id, account_id, name, display_label, is_primary, archived_at, google_place_id, google_place_address, created_at FROM businesses WHERE id = ${locationId}::uuid",
    category: 'tenant-root-lookup',
    reason: "Authenticated flow uses business/location id as the lookup key after owner scope has been established.",
  },
  {
    file: "worker/background/pollers/health-alert/checks.ts",
    table: "notification_deliveries",
    sqlSnippet: HEALTH_ZERO_DELIVERY_SQL,
    category: 'background-global-scan',
    reason: "HealthAlertPoller is a read-only platform health probe: it counts completed send_notification outbox rows that produced zero deliveries across all tenants (for responses still pending_approval on a live business) to detect owners who were never notified. Intentionally cross-tenant (beta-launch gate A3).",
  },
  {
    file: "worker/background/pollers/health-alert/checks.ts",
    table: "responses",
    sqlSnippet: HEALTH_ZERO_DELIVERY_SQL,
    category: 'background-global-scan',
    reason: "HealthAlertPoller zero-delivery probe joins responses only to exclude by-design skips (response no longer pending_approval). Read-only platform health probe, intentionally cross-tenant (beta-launch gate A3).",
  },
  {
    file: "worker/background/pollers/health-alert/checks.ts",
    table: "businesses",
    sqlSnippet: HEALTH_ZERO_DELIVERY_SQL,
    category: 'background-global-scan',
    reason: "HealthAlertPoller zero-delivery probe joins businesses only to exclude archived/offboarded locations. Read-only platform health probe, intentionally cross-tenant (beta-launch gate A3).",
  },
  {
    file: "worker/background/pollers/health-alert/checks.ts",
    table: "responses",
    sqlSnippet: HEALTH_OWNER_UNREACHABLE_SQL,
    category: 'background-global-scan',
    reason: "HealthAlertPoller owner-unreachable probe (F1) counts pending_approval drafts whose latest completed send_notification was owner_unreachable and that never got an approval_request delivery. Read-only platform health probe, intentionally cross-tenant.",
  },
  {
    file: "worker/background/pollers/health-alert/checks.ts",
    table: "businesses",
    sqlSnippet: HEALTH_OWNER_UNREACHABLE_SQL,
    category: 'background-global-scan',
    reason: "HealthAlertPoller owner-unreachable probe (F1) joins businesses only to exclude archived/offboarded locations. Read-only platform health probe, intentionally cross-tenant.",
  },
  {
    file: "worker/background/pollers/health-alert/checks.ts",
    table: "notification_deliveries",
    sqlSnippet: HEALTH_OWNER_UNREACHABLE_SQL,
    category: 'background-global-scan',
    reason: "HealthAlertPoller owner-unreachable probe (F1) anti-joins notification_deliveries to confirm no approval_request delivery reached the owner. Read-only platform health probe, intentionally cross-tenant.",
  },
  {
    file: "worker/background/pollers/health-alert/checks.ts",
    table: "inbound_events",
    sqlSnippet: HEALTH_FAILED_INBOUND_EVENTS_SQL,
    category: 'background-global-scan',
    reason: "HealthAlertPoller failed-inbound-events probe: counts inbound_events rows stuck in status='failed' grouped by (source, event_type) to surface webhook processing bugs otherwise masked by provider retries. Read-only platform health probe, intentionally cross-tenant (prod-hardening P7).",
  },
  {
    file: "worker/background/pollers/health-alert/checks.ts",
    table: "agent_runs",
    sqlSnippet: HEALTH_STALLED_SEND_BATCHES_SQL,
    category: 'background-global-scan',
    reason: "HealthAlertPoller stalled-send-batch probe (#624 D15c): counts solicitation_send_batch parent runs still 'running' past the 11-day threshold, one day beyond the batch's ≤10-day construction bound, so an operator sees a drip that never closed. A platform wedge scan is deliberately cross-tenant; the aggregate carries run ids and ages only. Read-only.",
  },
  {
    file: "worker/background/pollers/ArchivalPoller.ts",
    table: "api_costs",
    sqlSnippet: "WITH candidates AS ( SELECT id FROM api_costs WHERE created_at < NOW() - INTERVAL '90 days' ORDER BY created_at, id LIMIT 5000 FOR UPDATE SKIP LOCKED ), deleted AS ( DELETE FROM api_costs WHERE id IN (SELECT id FROM candidates) RETURNING business_id, provider, created_at::date AS cost_date, cost_usd, COALESCE(input_tokens, 0)::bigint AS input_tokens, COALESCE(output_tokens, 0)::bigint AS output_tokens ), aggregated AS ( SELECT business_id, provider, cost_date, SUM(cost_usd) AS total_cost_usd, SUM(input_tokens)::bigint AS total_input_tokens, SUM(output_tokens)::bigint AS total_output_tokens, COUNT(*)::bigint AS call_count FROM deleted GROUP BY business_id, provider, cost_date ), upserted AS ( INSERT INTO api_costs_daily_rollups (id, business_id, provider, rollup_date, total_cost_usd, total_input_tokens, total_output_tokens, call_count) SELECT gen_random_uuid(), business_id, provider, cost_date, total_cost_usd, total_input_tokens, total_output_tokens, call_count FROM aggregated ON CONFLICT ON CONSTRAINT uniq_cost_rollups_business_provider_date DO UPDATE SET total_cost_usd = api_costs_daily_rollups.total_cost_usd + EXCLUDED.total_cost_usd, total_input_tokens = api_costs_daily_rollups.total_input_tokens + EXCLUDED.total_input_tokens, total_output_tokens = api_costs_daily_rollups.total_output_tokens + EXCLUDED.total_output_tokens, call_count = api_costs_daily_rollups.call_count + EXCLUDED.call_count RETURNING id ) SELECT COUNT(*)::text AS count FROM deleted",
    category: 'background-global-scan',
    reason: "Global archival poller performs retention cleanup independent of tenant request scope.",
  },
  {
    file: "worker/background/pollers/ArchivalPoller.ts",
    table: "notification_deliveries",
    sqlSnippet: "WITH candidates AS ( SELECT id FROM notification_deliveries WHERE created_at < NOW() - INTERVAL '90 days' LIMIT 5000 FOR UPDATE SKIP LOCKED ), deleted AS ( DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM candidates) RETURNING id ) SELECT COUNT(*)::text AS count FROM deleted",
    category: 'background-global-scan',
    reason: "Global archival poller performs retention cleanup independent of tenant request scope.",
  },
  {
    file: "worker/background/pollers/ArchivalPoller.ts",
    table: "agent_outcomes",
    sqlSnippet: "WITH candidates AS ( SELECT id FROM agent_outcomes WHERE occurred_at < NOW() - make_interval(days => ${AGENT_SPINE_RETENTION_DAYS}) LIMIT 5000 FOR UPDATE SKIP LOCKED ), deleted AS ( DELETE FROM agent_outcomes WHERE id IN (SELECT id FROM candidates) RETURNING id ) SELECT COUNT(*)::text AS count FROM deleted",
    category: 'background-global-scan',
    reason: "Global archival poller enforces 180-day agent-run spine retention independent of tenant request scope; agent_outcomes has no account/business column.",
  },
  {
    file: "worker/background/pollers/ArchivalPoller.ts",
    table: "solicitation_outreach",
    sqlSnippet: "WITH candidates AS ( SELECT id FROM solicitation_outreach WHERE sent_at < NOW() - make_interval(days => ${BODY_RETENTION_DAYS}) AND body_redacted_at IS NULL ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED ), redacted AS ( UPDATE solicitation_outreach SET rendered_subject = NULL, rendered_body = NULL, interpolation_inputs = '{}'::jsonb, body_redacted_at = NOW() WHERE id IN (SELECT id FROM candidates) RETURNING id ) SELECT COUNT(*)::text AS count FROM redacted",
    category: 'background-global-scan',
    reason: "Global archival poller enforces 90-day outreach body redaction independent of tenant request scope; a retention sweep is deliberately cross-tenant.",
  },
  {
    file: "worker/background/pollers/ArchivalPoller.ts",
    table: "solicitation_outreach",
    sqlSnippet: "WITH candidates AS ( SELECT id FROM solicitation_outreach WHERE rendered_at < NOW() - make_interval(days => ${BODY_RETENTION_DAYS}) AND body_redacted_at IS NULL AND delivery_status IN ('withheld', 'cancelled', 'failed', 'unknown') ORDER BY rendered_at LIMIT 5000 FOR UPDATE SKIP LOCKED ), redacted AS ( UPDATE solicitation_outreach SET rendered_subject = NULL, rendered_body = NULL, interpolation_inputs = '{}'::jsonb, body_redacted_at = NOW() WHERE id IN (SELECT id FROM candidates) RETURNING id ) SELECT COUNT(*)::text AS count FROM redacted",
    category: 'background-global-scan',
    reason: "Global archival poller enforces the same 90-day outreach body redaction for rows that went terminal without ever sending (#636); a retention sweep is deliberately cross-tenant.",
  },
  {
    file: "worker/background/pollers/ArchivalPoller.ts",
    table: "agent_runs",
    sqlSnippet: "WITH candidates AS ( SELECT id FROM agent_runs WHERE ended_at < NOW() - make_interval(days => ${AGENT_SPINE_RETENTION_DAYS}) LIMIT 5000 FOR UPDATE SKIP LOCKED ), deleted AS ( DELETE FROM agent_runs WHERE id IN (SELECT id FROM candidates) RETURNING id ) SELECT COUNT(*)::text AS count FROM deleted",
    category: 'background-global-scan',
    reason: "Global archival poller enforces 180-day agent-run spine retention independent of tenant request scope; agent_runs has no account/business column.",
  },
  {
    file: "worker/background/pollers/CleanupAbandonedSignupsPoller.ts",
    table: "accounts",
    sqlSnippet: "SELECT u.id AS user_id, u.email AS owner_email, u.auth_id FROM users u LEFT JOIN accounts a ON a.owner_user_id = u.id WHERE u.role = 'owner' AND u.auth_id IS NOT NULL AND u.created_at < NOW() - INTERVAL '7 days' AND a.id IS NULL ORDER BY u.created_at ASC, u.id ASC LIMIT ${batchSize}",
    category: 'tenant-root-lookup',
    reason: "Lifecycle cleanup intentionally finds owner users without accounts before deleting abandoned signups.",
  },
  {
    file: "worker/background/pollers/CleanupAbandonedSignupsPoller.ts",
    table: "onboarding_demos",
    sqlSnippet: "DELETE FROM onboarding_demos WHERE generation_status = 'completed' AND completed_at < NOW() - INTERVAL '30 days'",
    category: 'background-global-scan',
    reason: "Lifecycle cleanup intentionally deletes stale completed pre-pay demo rows globally after the retention window.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "responses",
    sqlSnippet: "SELECT jo.payload->>'correlation_id' AS correlation_id FROM responses r JOIN job_outbox jo ON jo.topic = ${QUEUE_NAMES.GENERATE_RESPONSE} AND jo.aggregate_id = r.review_id WHERE r.id = ${responseId} ORDER BY jo.created_at DESC LIMIT 1",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/background/pollers/ZernioRecentReviewPoller.ts",
    table: "reviews",
    sqlSnippet: "UPDATE reviews SET status = ${REVIEW_STATUS.DELETED} WHERE id = ANY(${reviewIds}::uuid[]) AND status <> ${REVIEW_STATUS.DELETED}",
    category: 'background-global-scan',
    reason: "Zernio poller applies source-deletion updates to rows selected from each active connection.",
  },
  {
    file: "worker/background/pollers/ZernioRecentReviewPoller.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET status = 'failed', posting_error = 'review_deleted_at_source', updated_at = NOW() WHERE review_id = ANY(${reviewIds}::uuid[]) AND status = ANY(${[...NON_TERMINAL_STATUSES]}::text[])",
    category: 'background-global-scan',
    reason: "Zernio poller applies source-deletion updates to rows selected from each active connection.",
  },
  {
    file: "worker/ingress/resend.ts",
    table: "notification_deliveries",
    sqlSnippet: "UPDATE notification_deliveries SET delivered_at = NOW() WHERE external_message_id = ${emailId}",
    category: 'provider-ingress',
    reason: "Provider webhook resolves delivery state from provider identifiers before tenant scope is available.",
  },
  {
    file: "worker/ingress/resend.ts",
    table: "notification_deliveries",
    sqlSnippet: "UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = 'complained' WHERE external_message_id = ${emailId}",
    category: 'provider-ingress',
    reason: "Provider webhook resolves delivery state from provider identifiers before tenant scope is available.",
  },
  {
    file: "worker/ingress/resend.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT business_id, template FROM notification_deliveries WHERE external_message_id = ${emailId} LIMIT 1",
    category: 'provider-ingress',
    reason: "Provider webhook resolves delivery state from provider identifiers before tenant scope is available.",
  },
  {
    file: "worker/ingress/resend.ts",
    table: "notification_deliveries",
    sqlSnippet: "UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = ${reason} WHERE external_message_id = ${emailId}",
    category: 'provider-ingress',
    reason: "Provider webhook resolves delivery state from provider identifiers before tenant scope is available.",
  },
  {
    file: "worker/ingress/resend.ts",
    table: "businesses",
    sqlSnippet: "UPDATE businesses SET owner_email_bounced = TRUE, updated_at = NOW() WHERE id = ${delivery.business_id} AND owner_email_bounced IS DISTINCT FROM TRUE RETURNING id",
    category: 'provider-ingress',
    reason: "Provider webhook resolves delivery state from provider identifiers before tenant scope is available.",
  },
  {
    file: "worker/ingress/stripe/checkout-completed.ts",
    table: "accounts",
    sqlSnippet: "SELECT id FROM accounts WHERE id = ${refId}::uuid",
    category: 'provider-ingress',
    reason: "Stripe webhook resolves account or location from signed Stripe metadata before updating billing state.",
  },
  {
    file: "worker/ingress/stripe/checkout-completed.ts",
    table: "businesses",
    sqlSnippet: "SELECT account_id FROM businesses WHERE id = ${refId}::uuid",
    category: 'provider-ingress',
    reason: "Stripe webhook resolves account or location from signed Stripe metadata before updating billing state.",
  },
  {
    file: "worker/ingress/telegram/telegram-callback.ts",
    table: "approval_links",
    sqlSnippet: "SELECT id, business_id, channel, consumed_at, revoked_at, expires_at FROM approval_links WHERE id = ${parsed.approvalLinkId}",
    category: 'pre-auth-token',
    reason: "Opaque approval token or callback lookup must resolve the approval row before tenant scope is known.",
  },
  {
    file: "worker/ingress/twilio/twilio-delivery-status.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT id, delivered_at, failed_at FROM notification_deliveries WHERE external_message_id = ${messageSid} AND channel = ${channel} LIMIT 1",
    category: 'provider-ingress',
    reason: "Provider webhook resolves delivery state from provider identifiers before tenant scope is available.",
  },
  {
    file: "worker/ingress/twilio/twilio-delivery-status.ts",
    table: "notification_deliveries",
    sqlSnippet: "UPDATE notification_deliveries SET delivered_at = NOW() WHERE id = ${row.id} AND channel = ${channel} AND delivered_at IS NULL AND failed_at IS NULL",
    category: 'provider-ingress',
    reason: "Provider webhook resolves delivery state from provider identifiers before tenant scope is available.",
  },
  {
    file: "worker/ingress/twilio/twilio-delivery-status.ts",
    table: "notification_deliveries",
    sqlSnippet: "UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = ${`twilio:${errorCode ?? 'unknown'}`} WHERE id = ${row.id} AND channel = ${channel} AND delivered_at IS NULL AND failed_at IS NULL",
    category: 'provider-ingress',
    reason: "Provider webhook resolves delivery state from provider identifiers before tenant scope is available.",
  },
  {
    file: "worker/ingress/twilio/twilio-whatsapp-inbound.ts",
    table: "approval_links",
    sqlSnippet: "SELECT id, business_id FROM approval_links WHERE id = ${approvalLinkId} AND channel = 'whatsapp' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1",
    category: 'pre-auth-token',
    reason: "Opaque approval token or callback lookup must resolve the approval row before tenant scope is known.",
  },
  {
    file: "worker/jobs/OnboardingDripWorker.ts",
    table: "businesses",
    sqlSnippet: "SELECT u.name FROM users u JOIN businesses b ON b.onboarded_by = u.id WHERE b.id = ${business.id} AND u.role = 'admin' LIMIT 1",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/jobs/OwnerEmailWorker.ts",
    table: "reviews",
    sqlSnippet: "SELECT reviewer_name FROM reviews WHERE id = ${response.review_id}",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/jobs/OwnerEmailWorker.ts",
    table: "notification_deliveries",
    sqlSnippet: "DELETE FROM notification_deliveries WHERE id = ${deliveryId} AND external_message_id IS NULL",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/jobs/OwnerEmailWorker.ts",
    table: "notification_deliveries",
    sqlSnippet: "UPDATE notification_deliveries SET external_message_id = ${messageId}, sent_at = NOW() WHERE id = ${deliveryId}",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/jobs/PlaceIdValidationWorker.ts",
    table: "businesses",
    sqlSnippet: "SELECT id, google_place_id FROM businesses WHERE id = ${businessId}",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/jobs/PlaceIdValidationWorker.ts",
    table: "businesses",
    sqlSnippet: "UPDATE businesses SET google_place_id = ${resolvedPlaceId}, place_id_verified = TRUE WHERE id = ${businessId} AND (google_place_id IS NULL OR google_place_id = ${resolvedPlaceId} OR google_place_id = ${overwritableStoredId}) RETURNING id",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement. The extra place-id predicates are the no-silent-overwrite guard plus the hex-CID self-heal arm, not tenant scoping.",
  },
  {
    file: "worker/jobs/RankingTrackingWorker.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.id, ${primaryTrackedKeywordSql(sql)} AS primary_keyword, b.google_place_id, b.google_place_lat, b.google_place_lng, b.ranking_search_location FROM businesses b WHERE b.id = ${businessId}",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "src/lib/admin/impersonation/session.ts",
    table: "accounts",
    sqlSnippet: "SELECT s.id, s.actor_user_id, s.impersonated_user_id, s.account_id, s.ticket_id, s.reason, s.started_at, s.expires_at, u.email AS impersonated_email, a.display_name AS account_display_name FROM impersonation_sessions s JOIN users u ON u.id = s.impersonated_user_id JOIN accounts a ON a.id = s.account_id WHERE s.id = ${input.sessionId}::uuid AND s.actor_user_id = ${input.actorUserId}::uuid AND s.ended_at IS NULL AND s.expires_at > ${input.now ?? new Date()} LIMIT 1",
    category: 'admin-after-require-role',
    reason: "Admin-only impersonation: account row is read for a validated active session (scoped by session id + actor_user_id), after platform-admin role + AAL2 checks.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "reviews",
    sqlSnippet: "SELECT b.account_id, EXISTS ( SELECT 1 FROM reviews r2 JOIN businesses b2 ON b2.id = r2.business_id WHERE b2.account_id = b.account_id AND r2.id <> ${input.reviewId}::uuid AND r2.detected_at IS NOT NULL LIMIT 1 ) AS earlier_exists FROM businesses b WHERE b.id = ${input.businessId}::uuid LIMIT 1",
    category: 'worker-job-scoped',
    reason: "first_review_ingested activation check is account-scoped (b2.account_id = b.account_id) inside an EXISTS subquery the static scanner cannot see; the business is resolved by id for a durable ingest job.",
  },
  {
    file: "worker/jobs/response-generation/analytics.ts",
    table: "responses",
    sqlSnippet: "SELECT EXISTS ( SELECT 1 FROM responses r2 JOIN businesses b2 ON b2.id = r2.business_id WHERE b2.account_id = ${input.accountId}::uuid AND r2.id <> ${input.responseId}::uuid AND r2.created_at IS NOT NULL LIMIT 1 ) AS earlier_exists, ( SELECT occurred_at FROM analytics_events WHERE event_name = 'email_verified' AND account_id = ${input.accountId}::uuid ORDER BY occurred_at ASC LIMIT 1 ) AS email_verified_at",
    category: 'worker-job-scoped',
    reason: "first_response_drafted activation check is account-scoped (b2.account_id = input.accountId) inside an EXISTS subquery the static scanner cannot see; runs in the response-generation worker for a durable job.",
  },
  {
    file: "worker/jobs/response-generation/analytics.ts",
    table: "businesses",
    sqlSnippet: "SELECT EXISTS ( SELECT 1 FROM responses r2 JOIN businesses b2 ON b2.id = r2.business_id WHERE b2.account_id = ${input.accountId}::uuid AND r2.id <> ${input.responseId}::uuid AND r2.created_at IS NOT NULL LIMIT 1 ) AS earlier_exists, ( SELECT occurred_at FROM analytics_events WHERE event_name = 'email_verified' AND account_id = ${input.accountId}::uuid ORDER BY occurred_at ASC LIMIT 1 ) AS email_verified_at",
    category: 'worker-job-scoped',
    reason: "first_response_drafted activation check is account-scoped (b2.account_id = input.accountId) inside an EXISTS subquery the static scanner cannot see; runs in the response-generation worker for a durable job.",
  },
  {
    file: "worker/jobs/billing/UpdateStripeOverageWorker.ts",
    table: "accounts",
    sqlSnippet: "SELECT id, subscription_tier, subscription_status, price_variant, stripe_subscription_id, locations_included, locations_overage_price_cents FROM accounts WHERE id = ${account_id}::uuid FOR UPDATE",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload account id and reads the account only after the shared billing advisory lock; the scanner cannot establish that job ownership boundary.",
  },
  {
    file: "worker/jobs/notification/context.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.id, resp.response_text, resp.status, resp.business_id AS resp_business_id, resp.review_id, r.reviewer_name, r.star_rating, r.review_text, r.review_date FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.id = ${input.responseId}",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/jobs/notification/context.ts",
    table: "responses",
    sqlSnippet: "SELECT resp.id, resp.response_text, resp.status, resp.business_id AS resp_business_id, resp.review_id, r.reviewer_name, r.star_rating, r.review_text, r.review_date FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.id = ${input.responseId}",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/jobs/notification/dispatch.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT id FROM notification_deliveries WHERE response_id = ${ctx.responseId} AND channel = ${channelId} AND template = 'approval_request' AND delivered_at IS NOT NULL LIMIT 1",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "worker/jobs/notification/dispatch.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT id FROM notification_deliveries WHERE response_id = ${ctx.responseId} AND channel = ${channelId} AND template = 'approval_request' AND failed_at IS NULL LIMIT 1",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement. Claim-before-send dedup: 'failed_at IS NULL' catches both sent rows and in-flight pending claims (closes the crash-after-send double-send window).",
  },
  {
    file: "worker/jobs/publisher/load-context.ts",
    table: "responses",
    sqlSnippet: "SELECT id, review_id, business_id, approved_text, status, approval_method, posting_error FROM responses WHERE id = ${responseId}",
    category: 'background-global-scan',
    reason: "Worker follows a durable job payload or scheduler-selected id; caller establishes tenant context before this statement.",
  },
  {
    file: "src/lib/admin/businesses-list-service.ts",
    table: "accounts",
    sqlSnippet: "SELECT b.id, b.name, b.category, a.subscription_status, b.last_sync_at, COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_count FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded' GROUP BY b.id, b.name, b.category, a.subscription_status, b.last_sync_at ORDER BY b.name ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/businesses-list-service.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.id, b.name, b.category, a.subscription_status, b.last_sync_at, COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_count FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded' GROUP BY b.id, b.name, b.category, a.subscription_status, b.last_sync_at ORDER BY b.name ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/businesses-list-service.ts",
    table: "responses",
    sqlSnippet: "SELECT b.id, b.name, b.category, a.subscription_status, b.last_sync_at, COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_count FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded' GROUP BY b.id, b.name, b.category, a.subscription_status, b.last_sync_at ORDER BY b.name ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/notifications-service.ts",
    table: "businesses",
    sqlSnippet: "SELECT DISTINCT b.id, b.name FROM businesses b JOIN notification_deliveries nd ON nd.business_id = b.id ORDER BY b.name",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/notifications-service.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT DISTINCT b.id, b.name FROM businesses b JOIN notification_deliveries nd ON nd.business_id = b.id ORDER BY b.name",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/notifications-service.ts",
    table: "businesses",
    sqlSnippet: "SELECT nd.id, b.name AS business_name, nd.channel, nd.recipient, nd.template, nd.sent_at, nd.delivered_at, nd.failed_at, nd.failure_reason, nd.created_at FROM notification_deliveries nd JOIN businesses b ON nd.business_id = b.id ${whereClause} ORDER BY nd.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}",
    category: 'admin-after-require-role',
    reason: "Admin-only notifications service intentionally supports global and optionally filtered delivery review after requireRole(admin).",
  },
  {
    file: "src/lib/admin/notifications-service.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT nd.id, b.name AS business_name, nd.channel, nd.recipient, nd.template, nd.sent_at, nd.delivered_at, nd.failed_at, nd.failure_reason, nd.created_at FROM notification_deliveries nd JOIN businesses b ON nd.business_id = b.id ${whereClause} ORDER BY nd.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}",
    category: 'admin-after-require-role',
    reason: "Admin-only notifications service intentionally supports global and optionally filtered delivery review after requireRole(admin).",
  },
  {
    file: "src/lib/admin/notifications-service.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT COUNT(*)::text AS total FROM notification_deliveries nd ${whereClause}",
    category: 'admin-after-require-role',
    reason: "Admin-only notifications service intentionally counts global or filtered delivery rows after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "accounts",
    sqlSnippet: "SELECT b.id, b.name, a.subscription_status, b.last_sync_at, COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count, COUNT(CASE WHEN resp.status = 'awaiting_owner_connect' THEN 1 END)::int AS pending_reconnect_count, COUNT(resp.id) FILTER (WHERE resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS total_responses, COUNT(*) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS completed_responses, ROUND(EXTRACT(EPOCH FROM AVG(resp.approved_at - resp.created_at) FILTER (WHERE resp.approved_at IS NOT NULL AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)) / 3600.0, 1)::float AS avg_response_time_hours, MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded' GROUP BY b.id, b.name, a.subscription_status, b.last_sync_at",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.id, b.name, a.subscription_status, b.last_sync_at, COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count, COUNT(CASE WHEN resp.status = 'awaiting_owner_connect' THEN 1 END)::int AS pending_reconnect_count, COUNT(resp.id) FILTER (WHERE resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS total_responses, COUNT(*) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS completed_responses, ROUND(EXTRACT(EPOCH FROM AVG(resp.approved_at - resp.created_at) FILTER (WHERE resp.approved_at IS NOT NULL AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)) / 3600.0, 1)::float AS avg_response_time_hours, MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded' GROUP BY b.id, b.name, a.subscription_status, b.last_sync_at",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "responses",
    sqlSnippet: "SELECT b.id, b.name, a.subscription_status, b.last_sync_at, COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count, COUNT(CASE WHEN resp.status = 'awaiting_owner_connect' THEN 1 END)::int AS pending_reconnect_count, COUNT(resp.id) FILTER (WHERE resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS total_responses, COUNT(*) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS completed_responses, ROUND(EXTRACT(EPOCH FROM AVG(resp.approved_at - resp.created_at) FILTER (WHERE resp.approved_at IS NOT NULL AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)) / 3600.0, 1)::float AS avg_response_time_hours, MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded' GROUP BY b.id, b.name, a.subscription_status, b.last_sync_at",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "businesses",
    sqlSnippet: "WITH biz AS (SELECT UNNEST(${businessIds}::uuid[]) AS id), notif AS ( SELECT nd.business_id, COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id IN (SELECT id FROM biz) AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 GROUP BY nd.business_id ), resp AS ( SELECT rp.business_id, COUNT(*) FILTER (WHERE rp.status = 'pending_approval')::int AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(rp.approved_at) FILTER (WHERE rp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) )::int AS days_since_approval, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 7)::float AS avg_hours_current, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 35 AND rp.created_at < CURRENT_DATE - 7)::float AS avg_hours_prev FROM responses rp WHERE rp.business_id IN (SELECT id FROM biz) GROUP BY rp.business_id ) SELECT b.id AS business_id, CASE WHEN COALESCE(n.notified_count, 0) >= 3 THEN n.approved_count::float / NULLIF(n.notified_count, 0) ELSE NULL END AS approval_rate, COALESCE(n.notified_count, 0)::int AS notified_count, COALESCE(rp.pending_count, 0)::int AS pending_count, rp.days_since_approval, EXTRACT(DAY FROM CURRENT_TIMESTAMP - bs.created_at)::int AS account_age_days, rp.avg_hours_current, rp.avg_hours_prev FROM biz b JOIN businesses bs ON bs.id = b.id LEFT JOIN notif n ON n.business_id = b.id LEFT JOIN resp rp ON rp.business_id = b.id",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "responses",
    sqlSnippet: "WITH biz AS (SELECT UNNEST(${businessIds}::uuid[]) AS id), notif AS ( SELECT nd.business_id, COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id IN (SELECT id FROM biz) AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 GROUP BY nd.business_id ), resp AS ( SELECT rp.business_id, COUNT(*) FILTER (WHERE rp.status = 'pending_approval')::int AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(rp.approved_at) FILTER (WHERE rp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) )::int AS days_since_approval, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 7)::float AS avg_hours_current, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 35 AND rp.created_at < CURRENT_DATE - 7)::float AS avg_hours_prev FROM responses rp WHERE rp.business_id IN (SELECT id FROM biz) GROUP BY rp.business_id ) SELECT b.id AS business_id, CASE WHEN COALESCE(n.notified_count, 0) >= 3 THEN n.approved_count::float / NULLIF(n.notified_count, 0) ELSE NULL END AS approval_rate, COALESCE(n.notified_count, 0)::int AS notified_count, COALESCE(rp.pending_count, 0)::int AS pending_count, rp.days_since_approval, EXTRACT(DAY FROM CURRENT_TIMESTAMP - bs.created_at)::int AS account_age_days, rp.avg_hours_current, rp.avg_hours_prev FROM biz b JOIN businesses bs ON bs.id = b.id LEFT JOIN notif n ON n.business_id = b.id LEFT JOIN resp rp ON rp.business_id = b.id",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/overview-service.ts",
    table: "notification_deliveries",
    sqlSnippet: "WITH biz AS (SELECT UNNEST(${businessIds}::uuid[]) AS id), notif AS ( SELECT nd.business_id, COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id IN (SELECT id FROM biz) AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 GROUP BY nd.business_id ), resp AS ( SELECT rp.business_id, COUNT(*) FILTER (WHERE rp.status = 'pending_approval')::int AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(rp.approved_at) FILTER (WHERE rp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) )::int AS days_since_approval, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 7)::float AS avg_hours_current, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 35 AND rp.created_at < CURRENT_DATE - 7)::float AS avg_hours_prev FROM responses rp WHERE rp.business_id IN (SELECT id FROM biz) GROUP BY rp.business_id ) SELECT b.id AS business_id, CASE WHEN COALESCE(n.notified_count, 0) >= 3 THEN n.approved_count::float / NULLIF(n.notified_count, 0) ELSE NULL END AS approval_rate, COALESCE(n.notified_count, 0)::int AS notified_count, COALESCE(rp.pending_count, 0)::int AS pending_count, rp.days_since_approval, EXTRACT(DAY FROM CURRENT_TIMESTAMP - bs.created_at)::int AS account_age_days, rp.avg_hours_current, rp.avg_hours_prev FROM biz b JOIN businesses bs ON bs.id = b.id LEFT JOIN notif n ON n.business_id = b.id LEFT JOIN resp rp ON rp.business_id = b.id",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "worker/background/pollers/EngagementMonitorPoller.ts",
    table: "accounts",
    sqlSnippet: "WITH active_biz AS ( SELECT b.id, b.owner_email_bounced FROM businesses b JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'trialing') ), response_metrics AS ( SELECT resp.business_id, MAX(resp.approved_at) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) AS last_approval, COUNT(*) FILTER (WHERE resp.status = 'pending_approval')::int AS pending_count, MIN(resp.created_at) FILTER (WHERE resp.status = 'pending_approval') AS oldest_pending_at FROM responses resp WHERE resp.business_id IN (SELECT id FROM active_biz) GROUP BY resp.business_id ), notif_metrics AS ( SELECT nd.business_id, COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id IN (SELECT id FROM active_biz) AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 GROUP BY nd.business_id ) SELECT ab.id AS business_id, ab.owner_email_bounced, EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.last_approval)::int AS days_since_approval, COALESCE(rm.pending_count, 0) AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.oldest_pending_at)::int AS oldest_pending_age_days, COALESCE(nm.notified_count, 0) AS notified_count, COALESCE(nm.approved_count, 0) AS approved_count FROM active_biz ab LEFT JOIN response_metrics rm ON rm.business_id = ab.id LEFT JOIN notif_metrics nm ON nm.business_id = ab.id",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/EngagementMonitorPoller.ts",
    table: "businesses",
    sqlSnippet: "WITH active_biz AS ( SELECT b.id, b.owner_email_bounced FROM businesses b JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'trialing') ), response_metrics AS ( SELECT resp.business_id, MAX(resp.approved_at) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) AS last_approval, COUNT(*) FILTER (WHERE resp.status = 'pending_approval')::int AS pending_count, MIN(resp.created_at) FILTER (WHERE resp.status = 'pending_approval') AS oldest_pending_at FROM responses resp WHERE resp.business_id IN (SELECT id FROM active_biz) GROUP BY resp.business_id ), notif_metrics AS ( SELECT nd.business_id, COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id IN (SELECT id FROM active_biz) AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 GROUP BY nd.business_id ) SELECT ab.id AS business_id, ab.owner_email_bounced, EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.last_approval)::int AS days_since_approval, COALESCE(rm.pending_count, 0) AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.oldest_pending_at)::int AS oldest_pending_age_days, COALESCE(nm.notified_count, 0) AS notified_count, COALESCE(nm.approved_count, 0) AS approved_count FROM active_biz ab LEFT JOIN response_metrics rm ON rm.business_id = ab.id LEFT JOIN notif_metrics nm ON nm.business_id = ab.id",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/EngagementMonitorPoller.ts",
    table: "responses",
    sqlSnippet: "WITH active_biz AS ( SELECT b.id, b.owner_email_bounced FROM businesses b JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'trialing') ), response_metrics AS ( SELECT resp.business_id, MAX(resp.approved_at) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) AS last_approval, COUNT(*) FILTER (WHERE resp.status = 'pending_approval')::int AS pending_count, MIN(resp.created_at) FILTER (WHERE resp.status = 'pending_approval') AS oldest_pending_at FROM responses resp WHERE resp.business_id IN (SELECT id FROM active_biz) GROUP BY resp.business_id ), notif_metrics AS ( SELECT nd.business_id, COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id IN (SELECT id FROM active_biz) AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 GROUP BY nd.business_id ) SELECT ab.id AS business_id, ab.owner_email_bounced, EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.last_approval)::int AS days_since_approval, COALESCE(rm.pending_count, 0) AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.oldest_pending_at)::int AS oldest_pending_age_days, COALESCE(nm.notified_count, 0) AS notified_count, COALESCE(nm.approved_count, 0) AS approved_count FROM active_biz ab LEFT JOIN response_metrics rm ON rm.business_id = ab.id LEFT JOIN notif_metrics nm ON nm.business_id = ab.id",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/EngagementMonitorPoller.ts",
    table: "notification_deliveries",
    sqlSnippet: "WITH active_biz AS ( SELECT b.id, b.owner_email_bounced FROM businesses b JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'trialing') ), response_metrics AS ( SELECT resp.business_id, MAX(resp.approved_at) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) AS last_approval, COUNT(*) FILTER (WHERE resp.status = 'pending_approval')::int AS pending_count, MIN(resp.created_at) FILTER (WHERE resp.status = 'pending_approval') AS oldest_pending_at FROM responses resp WHERE resp.business_id IN (SELECT id FROM active_biz) GROUP BY resp.business_id ), notif_metrics AS ( SELECT nd.business_id, COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id IN (SELECT id FROM active_biz) AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 GROUP BY nd.business_id ) SELECT ab.id AS business_id, ab.owner_email_bounced, EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.last_approval)::int AS days_since_approval, COALESCE(rm.pending_count, 0) AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.oldest_pending_at)::int AS oldest_pending_age_days, COALESCE(nm.notified_count, 0) AS notified_count, COALESCE(nm.approved_count, 0) AS approved_count FROM active_biz ab LEFT JOIN response_metrics rm ON rm.business_id = ab.id LEFT JOIN notif_metrics nm ON nm.business_id = ab.id",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "businesses",
    sqlSnippet: "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND resp.created_at < NOW() - INTERVAL '4 hours' AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' ) AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' AND nd.failed_at IS NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND resp.created_at < NOW() - INTERVAL '4 hours' AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' ) AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' AND nd.failed_at IS NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "responses",
    sqlSnippet: "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND resp.created_at < NOW() - INTERVAL '4 hours' AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' ) AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' AND nd.failed_at IS NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND resp.created_at < NOW() - INTERVAL '4 hours' AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' ) AND NOT EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' AND nd.failed_at IS NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "businesses",
    sqlSnippet: "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND resp.created_at < NOW() - INTERVAL '4 hours' AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND resp.created_at < NOW() - INTERVAL '4 hours' AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "responses",
    sqlSnippet: "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND resp.created_at < NOW() - INTERVAL '4 hours' AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT resp.id AS response_id, resp.business_id, b.account_id, b.name AS business_name, r.reviewer_name, r.star_rating FROM responses resp JOIN businesses b ON resp.business_id = b.id JOIN reviews r ON resp.review_id = r.id WHERE resp.status = 'pending_approval' AND resp.created_at < NOW() - INTERVAL '4 hours' AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.response_id = resp.id AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL ) AND NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.SEND_NOTIFICATION} AND jo.aggregate_id = resp.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ORDER BY resp.created_at ASC LIMIT ${BATCH_LIMIT}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "responses",
    sqlSnippet: FAILOVER_OWNER_UNREACHABLE_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "NotificationFailoverPoller owner-unreachable candidate scan (F1): globally selects pending_approval drafts whose latest completed send_notification was owner_unreachable before the per-row locked re-check. Intentionally cross-tenant.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "businesses",
    sqlSnippet: FAILOVER_OWNER_UNREACHABLE_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "NotificationFailoverPoller owner-unreachable candidate scan (F1) joins businesses only to exclude archived/offboarded locations and read account_id/name for the admin escalation. Intentionally cross-tenant.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "reviews",
    sqlSnippet: FAILOVER_OWNER_UNREACHABLE_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "NotificationFailoverPoller owner-unreachable candidate scan (F1) joins reviews only to read reviewer_name/star_rating for the admin escalation email. Intentionally cross-tenant.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "notification_deliveries",
    sqlSnippet: FAILOVER_OWNER_UNREACHABLE_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "NotificationFailoverPoller owner-unreachable candidate scan (F1) anti-joins notification_deliveries to confirm no approval_request delivery reached the owner. Intentionally cross-tenant.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "responses",
    sqlSnippet: FAILOVER_OWNER_UNREACHABLE_RECHECK_SQL,
    category: 'background-global-scan',
    reason: "NotificationFailoverPoller owner-unreachable advisory-locked re-check (F1) re-confirms the single response is still pending_approval and owner-unreachable under pg_advisory_xact_lock before enqueueing a retry. Row already selected by the scoped candidate scan.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "businesses",
    sqlSnippet: FAILOVER_OWNER_UNREACHABLE_RECHECK_SQL,
    category: 'background-global-scan',
    reason: "NotificationFailoverPoller owner-unreachable advisory-locked re-check (F1) joins businesses only to re-confirm the location is not archived. Row already selected by the scoped candidate scan.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "notification_deliveries",
    sqlSnippet: FAILOVER_OWNER_UNREACHABLE_RECHECK_SQL,
    category: 'background-global-scan',
    reason: "NotificationFailoverPoller owner-unreachable advisory-locked re-check (F1) anti-joins notification_deliveries to re-confirm no approval_request delivery landed before enqueueing a retry. Row already selected by the scoped candidate scan.",
  },
  {
    file: "worker/background/pollers/StripeLocationsReconcilePoller.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.id, a.subscription_tier, a.subscription_status, a.stripe_customer_id, a.stripe_subscription_id, a.locations_included, a.locations_paid, a.locations_overage_price_cents, a.base_price_cents, a.past_due_at, a.flags, COUNT(b.id) AS active_location_count FROM accounts a LEFT JOIN businesses b ON b.account_id = a.id AND b.archived_at IS NULL WHERE a.subscription_status IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.PAST_DUE}, ${SubscriptionStatus.TRIALING}) AND (${cursor}::uuid IS NULL OR a.id > ${cursor}::uuid) GROUP BY a.id, a.subscription_tier, a.subscription_status, a.stripe_customer_id, a.stripe_subscription_id, a.locations_included, a.locations_paid, a.locations_overage_price_cents, a.base_price_cents, a.past_due_at, a.flags ORDER BY a.id ASC",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/StripeLocationsReconcilePoller.ts",
    table: "businesses",
    sqlSnippet: "SELECT a.id, a.subscription_tier, a.subscription_status, a.stripe_customer_id, a.stripe_subscription_id, a.locations_included, a.locations_paid, a.locations_overage_price_cents, a.base_price_cents, a.past_due_at, a.flags, COUNT(b.id) AS active_location_count FROM accounts a LEFT JOIN businesses b ON b.account_id = a.id AND b.archived_at IS NULL WHERE a.subscription_status IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.PAST_DUE}, ${SubscriptionStatus.TRIALING}) AND (${cursor}::uuid IS NULL OR a.id > ${cursor}::uuid) GROUP BY a.id, a.subscription_tier, a.subscription_status, a.stripe_customer_id, a.stripe_subscription_id, a.locations_included, a.locations_paid, a.locations_overage_price_cents, a.base_price_cents, a.past_due_at, a.flags ORDER BY a.id ASC",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/ZernioRecentReviewPoller.ts",
    table: "accounts",
    sqlSnippet: "SELECT zc.business_id, zc.zernio_account_id, zc.zernio_location_id, zc.connected_at, a.subscription_status, a.past_due_at, a.flags AS account_flags FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id JOIN accounts a ON a.id = b.account_id WHERE zc.status = 'active' AND b.archived_at IS NULL AND (${afterBusinessId}::uuid IS NULL OR zc.business_id > ${afterBusinessId}::uuid) ORDER BY zc.business_id ASC LIMIT ${limit}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/ZernioRecentReviewPoller.ts",
    table: "businesses",
    sqlSnippet: "SELECT zc.business_id, zc.zernio_account_id, zc.zernio_location_id, zc.connected_at, a.subscription_status, a.past_due_at, a.flags AS account_flags FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id JOIN accounts a ON a.id = b.account_id WHERE zc.status = 'active' AND b.archived_at IS NULL AND (${afterBusinessId}::uuid IS NULL OR zc.business_id > ${afterBusinessId}::uuid) ORDER BY zc.business_id ASC LIMIT ${limit}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/ZernioRecentReviewPoller.ts",
    table: "zernio_connections",
    sqlSnippet: "SELECT zc.business_id, zc.zernio_account_id, zc.zernio_location_id, zc.connected_at, a.subscription_status, a.past_due_at, a.flags AS account_flags FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id JOIN accounts a ON a.id = b.account_id WHERE zc.status = 'active' AND b.archived_at IS NULL AND (${afterBusinessId}::uuid IS NULL OR zc.business_id > ${afterBusinessId}::uuid) ORDER BY zc.business_id ASC LIMIT ${limit}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/schedulers/MonthlyImpactScheduler.ts",
    table: "accounts",
    sqlSnippet: MONTHLY_IMPACT_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/schedulers/MonthlyImpactScheduler.ts",
    table: "businesses",
    sqlSnippet: MONTHLY_IMPACT_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/schedulers/OnboardingDripScheduler.ts",
    table: "accounts",
    sqlSnippet: ONBOARDING_DRIP_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/schedulers/OnboardingDripScheduler.ts",
    table: "businesses",
    sqlSnippet: ONBOARDING_DRIP_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/schedulers/RankingTrackingScheduler.ts",
    table: "accounts",
    sqlSnippet: RANKING_TRACKING_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/schedulers/RankingTrackingScheduler.ts",
    table: "businesses",
    sqlSnippet: RANKING_TRACKING_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/schedulers/WeeklySummaryScheduler.ts",
    table: "accounts",
    sqlSnippet: WEEKLY_SUMMARY_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/schedulers/WeeklySummaryScheduler.ts",
    table: "businesses",
    sqlSnippet: WEEKLY_SUMMARY_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  // #678 — the Reviews list. These three replace the four pre-#678 entries for
  // this file (two activation-split COUNTs, the posted-only AVG, the posted-JOIN
  // main query) plus the two for the orphan query F3 deleted. The new AVG needs
  // NO entry: it no longer joins `responses`, so `r.business_id = ${locationId}`
  // scopes it outright — a net shrink in exempted surface, 414 -> 412.
  {
    file: "src/lib/past-replies/load-replies.ts",
    table: "responses",
    sqlSnippet: "SELECT r.id AS review_id, r.review_text, r.review_date, r.review_content_hash, r.external_reply_ingested_at, r.star_rating, r.reviewer_name, resp.id AS response_id, resp.approved_text, resp.approval_method, resp.posted_at, resp.version, fail_sidecar.id AS failed_response_id, fail_sidecar.posting_error AS failed_posting_error, draft.id AS draft_response_id, COALESCE(draft.held, false) AS draft_held, (pending_gen.exists IS NOT NULL) AS generation_in_flight, (orphan_sidecar.id IS NOT NULL AND resp.id IS NULL) AS is_orphan, orphan_sidecar.id AS orphan_failed_response_id, orphan_sidecar.posting_error AS orphan_posting_error, orphan_superseded.approved_text AS superseded_text FROM reviews r LEFT JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted' LEFT JOIN LATERAL ( SELECT id, posting_error FROM responses WHERE review_id = r.id AND status = 'failed' AND posting_error LIKE ${deletePfx} ORDER BY created_at DESC LIMIT 1 ) fail_sidecar ON true LEFT JOIN LATERAL ( SELECT resp2.id, EXISTS ( SELECT 1 FROM flagged_responses f WHERE f.response_id = resp2.id AND f.status = 'open' ) AS held FROM responses resp2 WHERE resp2.review_id = r.id AND resp2.status = ANY(${[...NON_TERMINAL_STATUSES] as string[]}::text[]) ORDER BY resp2.version DESC LIMIT 1 ) draft ON true LEFT JOIN LATERAL ( SELECT 1 AS exists FROM job_outbox WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE} AND aggregate_id = r.id AND status IN ('pending', 'dispatching', 'dispatched') LIMIT 1 ) pending_gen ON true LEFT JOIN LATERAL ( SELECT id, posting_error FROM responses WHERE review_id = r.id AND status = 'failed' AND posting_error LIKE ${postAfterPfx} ORDER BY created_at DESC LIMIT 1 ) orphan_sidecar ON true LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS approved_text FROM responses WHERE review_id = r.id AND status = 'superseded' ORDER BY created_at DESC LIMIT 1 ) orphan_superseded ON true WHERE r.business_id = ${locationId} ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}",
    category: 'tenant-root-lookup',
    reason: "Authenticated Reviews list page uses the owner-selected locationId resolved for the current account before joining or existence-testing response rows.",
  },
  {
    file: "src/lib/past-replies/load-replies.ts",
    table: "responses",
    sqlSnippet: "SELECT COUNT(*)::int AS count FROM reviews r WHERE r.business_id = ${locationId} AND NOT EXISTS ( SELECT 1 FROM responses p WHERE p.review_id = r.id AND p.status = 'posted' )",
    category: 'tenant-root-lookup',
    reason: "Authenticated Reviews list page uses the owner-selected locationId resolved for the current account before joining or existence-testing response rows.",
  },
  {
    file: "src/lib/past-replies/load-replies.ts",
    table: "responses",
    sqlSnippet: "SELECT COUNT(*)::int AS count FROM reviews r WHERE r.business_id = ${locationId} AND EXISTS ( SELECT 1 FROM responses p WHERE p.review_id = r.id AND p.status = 'posted' )",
    category: 'tenant-root-lookup',
    reason: "Authenticated Reviews list page uses the owner-selected locationId resolved for the current account before joining or existence-testing response rows.",
  },
  {
    file: "src/app/api/approve/[token]/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT resp.response_text, resp.version, resp.status, resp.approval_method, resp.auto_post_scheduled_at, r.reviewer_name, r.star_rating, r.review_text, r.review_date, b.name AS business_name, b.display_label, b.account_id, (b.archived_at IS NOT NULL) AS is_archived FROM responses resp JOIN reviews r ON resp.review_id = r.id JOIN businesses b ON resp.business_id = b.id WHERE resp.id = ${link.response_id}",
    category: 'pre-auth-token',
    reason: "Opaque approval token lookup resolves tenant rows before business scope is known.",
  },
  {
    file: "src/app/api/approve/[token]/route.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.response_text, resp.version, resp.status, resp.approval_method, resp.auto_post_scheduled_at, r.reviewer_name, r.star_rating, r.review_text, r.review_date, b.name AS business_name, b.display_label, b.account_id, (b.archived_at IS NOT NULL) AS is_archived FROM responses resp JOIN reviews r ON resp.review_id = r.id JOIN businesses b ON resp.business_id = b.id WHERE resp.id = ${link.response_id}",
    category: 'pre-auth-token',
    reason: "Opaque approval token lookup resolves tenant rows before business scope is known.",
  },
  {
    file: "src/app/api/approve/[token]/route.ts",
    table: "responses",
    sqlSnippet: "SELECT resp.response_text, resp.version, resp.status, resp.approval_method, resp.auto_post_scheduled_at, r.reviewer_name, r.star_rating, r.review_text, r.review_date, b.name AS business_name, b.display_label, b.account_id, (b.archived_at IS NOT NULL) AS is_archived FROM responses resp JOIN reviews r ON resp.review_id = r.id JOIN businesses b ON resp.business_id = b.id WHERE resp.id = ${link.response_id}",
    category: 'pre-auth-token',
    reason: "Opaque approval token lookup resolves tenant rows before business scope is known.",
  },
  {
    file: "src/app/api/auth/signup-status/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.id AS account_id, a.subscription_status, u.role, b.place_id_verified, b.google_maps_url, a.onboarding_wizard_completed_at FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = ${ownerRole} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/auth/signup-status/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT a.id AS account_id, a.subscription_status, u.role, b.place_id_verified, b.google_maps_url, a.onboarding_wizard_completed_at FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = ${ownerRole} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/auth/verify-otp/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT u.id AS user_id, u.role, u.account_id, b.id AS business_id FROM users u JOIN businesses b ON b.account_id = u.account_id AND b.is_primary = TRUE WHERE u.auth_id = ${data.user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/business/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT b.id, a.id AS account_id, a.subscription_status, b.place_id_verified, b.google_maps_url FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/business/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.id, a.id AS account_id, a.subscription_status, b.place_id_verified, b.google_maps_url FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/demo/regenerate/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT u.id AS user_id, b.id AS id, a.subscription_status FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/demo/regenerate/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT u.id AS user_id, b.id AS id, a.subscription_status FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/demo/status/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT u.id AS user_id, b.id AS business_id FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/demo/status/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT u.id AS user_id, b.id AS business_id FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/select-plan/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT b.id, a.id AS account_id, b.owner_email FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${userId} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/select-plan/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.id, a.id AS account_id, b.owner_email FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${userId} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/start/route.ts",
    table: "accounts",
    sqlSnippet: "SELECT b.id, a.id AS account_id, u.id AS user_id, a.subscription_status, b.place_id_verified, b.google_maps_url FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/api/onboarding/start/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.id, a.id AS account_id, u.id AS user_id, a.subscription_status, b.place_id_verified, b.google_maps_url FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} AND u.role = 'owner' LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/onboarding/business/page.tsx",
    table: "accounts",
    sqlSnippet: "SELECT u.role, a.subscription_status, b.place_id_verified, b.google_maps_url, b.category, b.website, b.name FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/onboarding/business/page.tsx",
    table: "businesses",
    sqlSnippet: "SELECT u.role, a.subscription_status, b.place_id_verified, b.google_maps_url, b.category, b.website, b.name FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/onboarding/demo/page.tsx",
    table: "accounts",
    sqlSnippet: "SELECT u.id AS user_id, b.id AS business_id, u.role, a.subscription_status, b.place_id_verified, b.google_maps_url, b.name AS business_name FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/onboarding/demo/page.tsx",
    table: "businesses",
    sqlSnippet: "SELECT u.id AS user_id, b.id AS business_id, u.role, a.subscription_status, b.place_id_verified, b.google_maps_url, b.name AS business_name FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/onboarding/pay/page.tsx",
    table: "accounts",
    sqlSnippet: "SELECT b.id AS business_id, a.price_variant, a.subscription_status, b.place_id_verified, b.google_maps_url FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/onboarding/pay/page.tsx",
    table: "businesses",
    sqlSnippet: "SELECT b.id AS business_id, a.price_variant, a.subscription_status, b.place_id_verified, b.google_maps_url FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/onboarding/start/page.tsx",
    table: "accounts",
    sqlSnippet: "SELECT u.role, a.subscription_status, b.place_id_verified, b.google_maps_url FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/app/onboarding/start/page.tsx",
    table: "businesses",
    sqlSnippet: "SELECT u.role, a.subscription_status, b.place_id_verified, b.google_maps_url FROM users u JOIN accounts a ON a.id = u.account_id JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE WHERE u.auth_id = ${user.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/lib/admin/business-detail/queries.ts",
    table: "responses",
    sqlSnippet: "SELECT r.id, r.reviewer_name, r.star_rating, r.review_text, r.review_date, r.detected_language, r.status AS review_status, r.detected_at, resp.id AS response_id, resp.status AS response_status, resp.response_text, resp.approved_text, resp.approval_method, resp.version FROM reviews r LEFT JOIN LATERAL ( SELECT id, status, response_text, approved_text, approval_method, version FROM responses WHERE review_id = r.id AND status != 'superseded' ORDER BY version DESC LIMIT 1 ) resp ON true WHERE r.business_id = ${businessId} ORDER BY r.detected_at DESC LIMIT 100",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/business-detail/queries.ts",
    table: "reviews",
    sqlSnippet: "SELECT r.id, r.created_at, COALESCE(r.approved_text, r.response_text) AS draft_text, rev.reviewer_name, rev.review_text, rev.star_rating FROM responses r JOIN reviews rev ON rev.id = r.review_id WHERE r.business_id = ${businessId} AND r.status = 'awaiting_owner_connect' ORDER BY r.created_at DESC LIMIT 50",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/approval/http-routes.ts",
    table: "responses",
    sqlSnippet: "SELECT r.id, r.business_id, r.status FROM responses r JOIN reviews rv ON rv.id = r.review_id JOIN businesses b ON b.id = rv.business_id WHERE rv.id = ${reviewId} AND b.account_id = ${owner.accountId}::uuid AND b.archived_at IS NULL AND r.status NOT IN ('superseded', 'failed') ORDER BY r.version DESC LIMIT 1",
    category: 'pre-auth-token',
    reason: "Owner approval route filters the review through owner.accountId and returns only the active response for that scoped review.",
  },
  {
    file: "src/lib/auth/require-owner-access.ts",
    table: "accounts",
    sqlSnippet: "SELECT u.role, u.account_id, a.subscription_status FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.auth_id = ${authUser.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/lib/dashboard/service.ts",
    table: "responses",
    sqlSnippet: "SELECT COUNT(DISTINCT r.id)::int AS count FROM reviews r JOIN responses resp ON resp.review_id = r.id WHERE r.business_id = ${businessId} AND r.status <> ${REVIEW_STATUS.DELETED} AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])",
    category: 'tenant-root-lookup',
    reason: "Dashboard service receives an owner-scoped accountId or businessId and uses it as the tenant boundary for joined data.",
  },
  {
    file: "src/lib/dashboard/service.ts",
    table: "responses",
    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity FROM reviews rev LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = ${businessId} AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = ${businessId} AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE rev.business_id = ${businessId} AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 10",
    category: 'tenant-root-lookup',
    reason: "Dashboard service receives an owner-scoped accountId or businessId and uses it as the tenant boundary for joined data; the NOT EXISTS clause excludes drafts held by an open moderation flag from owner view.",
  },
  {
    file: "src/lib/dashboard/service.ts",
    table: "review_escalations",
    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity FROM reviews rev LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = ${businessId} AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = ${businessId} AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE rev.business_id = ${businessId} AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 10",
    category: 'tenant-root-lookup',
    reason: "Open-escalation badge read (WS3); review_escalations accessed inside a LEFT JOIN LATERAL scoped by e.business_id = ${businessId} (mirrors the resp lateral). Scanner strips SELECT subqueries before predicate analysis. businessId is IDOR-checked in the dashboard route.",
  },
  // Account-wide recent-reviews feed (100-business perf pass, 2026-07-16):
  // one LIMIT 20 query replaces the aggregate view's fetch-10-per-location
  // composition. responses/review_escalations are accessed inside LEFT JOIN
  // LATERAL subqueries correlated on rev.business_id, which the scanner
  // strips before predicate analysis; the tenant boundary is
  // b.account_id = ${accountId} with rev.business_id = b.id. accountId is
  // owner-scoped by requireOwnerWithAccount in the dashboard route.
  {
    file: "src/lib/dashboard/aggregate-service.ts",
    table: "responses",
    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity, b.id AS location_id, b.name AS location_name, b.display_label AS location_display_label FROM reviews rev JOIN businesses b ON b.id = rev.business_id LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = rev.business_id AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = rev.business_id AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE b.account_id = ${accountId}::uuid AND b.archived_at IS NULL AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 20",
    category: 'tenant-root-lookup',
    reason: "Aggregate recent-reviews feed; responses accessed via LEFT JOIN LATERAL correlated on rev.business_id inside a scan bounded by b.account_id = ${accountId}. Scanner strips SELECT subqueries before predicate analysis.",
  },
  {
    file: "src/lib/dashboard/aggregate-service.ts",
    table: "review_escalations",
    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity, b.id AS location_id, b.name AS location_name, b.display_label AS location_display_label FROM reviews rev JOIN businesses b ON b.id = rev.business_id LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = rev.business_id AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = rev.business_id AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE b.account_id = ${accountId}::uuid AND b.archived_at IS NULL AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 20",
    category: 'tenant-root-lookup',
    reason: "Aggregate recent-reviews feed; review_escalations accessed via LEFT JOIN LATERAL correlated on rev.business_id inside a scan bounded by b.account_id = ${accountId}. Scanner strips SELECT subqueries before predicate analysis.",
  },
  {
    file: "src/lib/db/auth.ts",
    table: "businesses",
    sqlSnippet: "SELECT u.id, u.name, u.email, u.role, u.account_id, (SELECT b.id FROM businesses b WHERE b.account_id = u.account_id AND b.is_primary = TRUE AND b.archived_at IS NULL LIMIT 1) AS primary_location_id FROM users u WHERE u.auth_id = ${authUser.id} LIMIT 1",
    category: 'supabase-auth-id',
    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  },
  {
    file: "src/lib/responses/voice-learning.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.original_draft_text, resp.edited_text, r.star_rating FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.business_id = ${businessId} AND resp.status = 'posted' AND resp.edited_text IS NOT NULL ORDER BY resp.posted_at DESC LIMIT 10",
    category: 'worker-job-scoped',
    reason: "Voice-learning query receives a businessId from an owner-scoped request or worker payload before sampling review and response rows.",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "zernio_connections",
    sqlSnippet: "INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status) SELECT gen_random_uuid(), ${QUEUE_NAMES.INGEST_ZERNIO_REVIEW}, 'business', zc.business_id, jsonb_build_object( 'business_id', zc.business_id, 'zernio_account_id', ${parsed.accountId}::text, 'zernio_location_id', zc.zernio_location_id, 'zernio_review_id', ${parsed.reviewId}::text, 'correlation_id', ${eventId}::text ), 'pending' FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id AND b.archived_at IS NULL WHERE zc.zernio_account_id = ${parsed.accountId} AND zc.status = 'active' ${locationFilter} ON CONFLICT (aggregate_id, (payload->>'zernio_review_id')) WHERE topic = 'ingest_zernio_review' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING",
    category: 'provider-ingress',
    reason: "Provider ingress resolves tenant rows from signed provider identifiers before tenant ids are available. ${locationFilter} is the conditional location-scoping fragment (payload location id when present, empty for account-wide fan-out).",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "businesses",
    sqlSnippet: "INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status) SELECT gen_random_uuid(), ${QUEUE_NAMES.INGEST_ZERNIO_REVIEW}, 'business', zc.business_id, jsonb_build_object( 'business_id', zc.business_id, 'zernio_account_id', ${parsed.accountId}::text, 'zernio_location_id', zc.zernio_location_id, 'zernio_review_id', ${parsed.reviewId}::text, 'correlation_id', ${eventId}::text ), 'pending' FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id AND b.archived_at IS NULL WHERE zc.zernio_account_id = ${parsed.accountId} AND zc.status = 'active' ${locationFilter} ON CONFLICT (aggregate_id, (payload->>'zernio_review_id')) WHERE topic = 'ingest_zernio_review' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING",
    category: 'provider-ingress',
    reason: "Provider ingress fan-out excludes archived locations via a businesses join keyed on the connection's business_id; tenant ids are not yet available from the signed webhook.",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "zernio_connections",
    sqlSnippet: "SELECT EXISTS ( SELECT 1 FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id WHERE zc.zernio_account_id = ${parsed.accountId} AND zc.status = 'active' ${locationFilter} AND b.archived_at IS NOT NULL ) AS archived_match, EXISTS ( SELECT 1 FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id WHERE zc.zernio_account_id = ${parsed.accountId} AND zc.status = 'active' ${locationFilter} AND b.archived_at IS NULL ) AS active_match",
    category: 'provider-ingress',
    reason: "Provider ingress disambiguates a 0-row fan-out (in-flight dedup vs archived-only vs genuinely unconnected) from signed provider identifiers before tenant ids are available; dual EXISTS so a dedup for an active business is never mislabeled as an archived skip.",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "businesses",
    sqlSnippet: "SELECT EXISTS ( SELECT 1 FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id WHERE zc.zernio_account_id = ${parsed.accountId} AND zc.status = 'active' ${locationFilter} AND b.archived_at IS NOT NULL ) AS archived_match, EXISTS ( SELECT 1 FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id WHERE zc.zernio_account_id = ${parsed.accountId} AND zc.status = 'active' ${locationFilter} AND b.archived_at IS NULL ) AS active_match",
    category: 'provider-ingress',
    reason: "Provider ingress disambiguates a 0-row fan-out (in-flight dedup vs archived-only vs genuinely unconnected) from signed provider identifiers before tenant ids are available; dual EXISTS so a dedup for an active business is never mislabeled as an archived skip.",
  },
  {
    file: "worker/jobs/AdminExceptionWorker.ts",
    table: "businesses",
    sqlSnippet: "SELECT re.id, re.type, re.status, re.payload, re.review_id, r.reviewer_name, r.star_rating, r.review_text, b.name AS business_name FROM review_exceptions re LEFT JOIN reviews r ON re.review_id = r.id JOIN businesses b ON re.business_id = b.id WHERE re.id = ${review_exception_id}",
    category: 'worker-job-scoped',
    reason: "Admin exception worker resolves tenant rows from the durable review_exception_id aggregate created by the admin exception flow.",
  },
  {
    file: "worker/jobs/AdminExceptionWorker.ts",
    table: "reviews",
    sqlSnippet: "SELECT re.id, re.type, re.status, re.payload, re.review_id, r.reviewer_name, r.star_rating, r.review_text, b.name AS business_name FROM review_exceptions re LEFT JOIN reviews r ON re.review_id = r.id JOIN businesses b ON re.business_id = b.id WHERE re.id = ${review_exception_id}",
    category: 'worker-job-scoped',
    reason: "Admin exception worker resolves tenant rows from the durable review_exception_id aggregate created by the admin exception flow.",
  },
  {
    file: "worker/jobs/AdminExceptionWorker.ts",
    table: "review_exceptions",
    sqlSnippet: "SELECT re.id, re.type, re.status, re.payload, re.review_id, r.reviewer_name, r.star_rating, r.review_text, b.name AS business_name FROM review_exceptions re LEFT JOIN reviews r ON re.review_id = r.id JOIN businesses b ON re.business_id = b.id WHERE re.id = ${review_exception_id}",
    category: 'worker-job-scoped',
    reason: "Admin exception worker resolves tenant rows from the durable review_exception_id aggregate created by the admin exception flow.",
  },
  {
    file: "worker/jobs/EngagementAlertWorker.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.id AS response_id, COALESCE(r.reviewer_name, 'Anonymous') AS reviewer_name, r.star_rating, r.review_text, COUNT(*) OVER ()::int AS total_pending FROM responses resp JOIN reviews r ON r.id = resp.review_id WHERE resp.business_id = ${businessId} AND resp.status = 'pending_approval' ORDER BY resp.created_at ASC LIMIT 10",
    category: 'background-global-scan',
    reason: "Engagement alert worker processes a scheduler-created business aggregate and filters notification/review rows by that businessId.",
  },
  {
    file: "worker/jobs/OnboardingDemoWorker.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.subscription_status FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id JOIN accounts a ON a.id = b.account_id WHERE od.id = ${demoId}",
    category: 'worker-job-scoped',
    reason: "Onboarding demo worker resolves the owning account through the demo row created by the owner-authenticated onboarding flow.",
  },
  {
    file: "worker/jobs/OnboardingDemoWorker.ts",
    table: "businesses",
    sqlSnippet: "SELECT a.subscription_status FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id JOIN accounts a ON a.id = b.account_id WHERE od.id = ${demoId}",
    category: 'worker-job-scoped',
    reason: "Onboarding demo worker resolves the owning account through the demo row created by the owner-authenticated onboarding flow.",
  },
  {
    file: "worker/jobs/OnboardingDemoWorker.ts",
    table: "onboarding_demos",
    sqlSnippet: "SELECT a.subscription_status FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id JOIN accounts a ON a.id = b.account_id WHERE od.id = ${demoId}",
    category: 'worker-job-scoped',
    reason: "Onboarding demo worker follows a durable demo job id created by the owner-authenticated onboarding flow.",
  },
  {
    file: "worker/jobs/OnboardingDripWorker.ts",
    table: "reviews",
    sqlSnippet: "SELECT r.reviewer_name, r.star_rating, r.review_text, resp.approved_text FROM responses resp JOIN reviews r ON r.id = resp.review_id WHERE resp.business_id = ${business.id} AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) AND r.review_text IS NOT NULL AND resp.created_at >= ${activatedAt} AND resp.created_at < ${windowEnd} ORDER BY LENGTH(r.review_text) DESC LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Onboarding drip worker first selects a business/account candidate, then uses that business id for report and reminder evidence queries.",
  },
  {
    file: "worker/jobs/OnboardingDripWorker.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.id AS response_id, r.reviewer_name, r.star_rating FROM responses resp JOIN reviews r ON r.id = resp.review_id WHERE resp.business_id = ${business.id} AND resp.status = 'pending_approval' ORDER BY resp.created_at ASC LIMIT 5",
    category: 'worker-job-scoped',
    reason: "Onboarding drip worker first selects a business/account candidate, then uses that business id for report and reminder evidence queries.",
  },
  {
    file: "src/lib/admin/business-detail/queries.ts",
    table: "responses",
    sqlSnippet: "WITH notif AS ( SELECT COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id = ${businessId} AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 ), resp AS ( SELECT COUNT(*) FILTER (WHERE rp.status = 'pending_approval')::int AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(rp.approved_at) FILTER (WHERE rp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) )::int AS days_since_approval, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 7)::float AS avg_hours_current, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 35 AND rp.created_at < CURRENT_DATE - 7)::float AS avg_hours_prev FROM responses rp WHERE rp.business_id = ${businessId} ) SELECT CASE WHEN COALESCE(n.notified_count, 0) >= 3 THEN n.approved_count::float / NULLIF(n.notified_count, 0) ELSE NULL END AS approval_rate, COALESCE(n.notified_count, 0)::int AS notified_count, COALESCE(r.pending_count, 0)::int AS pending_count, r.days_since_approval, EXTRACT(DAY FROM CURRENT_TIMESTAMP - b.created_at)::int AS account_age_days, r.avg_hours_current, r.avg_hours_prev FROM businesses b CROSS JOIN notif n CROSS JOIN resp r WHERE b.id = ${businessId}",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/business-detail/queries.ts",
    table: "notification_deliveries",
    sqlSnippet: "WITH notif AS ( SELECT COUNT(DISTINCT nd.response_id)::int AS notified_count, COUNT(DISTINCT nd.response_id) FILTER ( WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) )::int AS approved_count FROM notification_deliveries nd JOIN responses r ON r.id = nd.response_id WHERE nd.business_id = ${businessId} AND nd.template = 'approval_request' AND nd.sent_at IS NOT NULL AND nd.sent_at >= CURRENT_DATE - 30 ), resp AS ( SELECT COUNT(*) FILTER (WHERE rp.status = 'pending_approval')::int AS pending_count, EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(rp.approved_at) FILTER (WHERE rp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) )::int AS days_since_approval, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 7)::float AS avg_hours_current, AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0) FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 35 AND rp.created_at < CURRENT_DATE - 7)::float AS avg_hours_prev FROM responses rp WHERE rp.business_id = ${businessId} ) SELECT CASE WHEN COALESCE(n.notified_count, 0) >= 3 THEN n.approved_count::float / NULLIF(n.notified_count, 0) ELSE NULL END AS approval_rate, COALESCE(n.notified_count, 0)::int AS notified_count, COALESCE(r.pending_count, 0)::int AS pending_count, r.days_since_approval, EXTRACT(DAY FROM CURRENT_TIMESTAMP - b.created_at)::int AS account_age_days, r.avg_hours_current, r.avg_hours_prev FROM businesses b CROSS JOIN notif n CROSS JOIN resp r WHERE b.id = ${businessId}",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/dashboard/service.ts",
    table: "reviews",
    sqlSnippet: "SELECT gs::date AS week_start, COALESCE(r.cnt, 0)::int AS count FROM generate_series( DATE_TRUNC('week', NOW() - make_interval(weeks => ${velocitySpanWeeks})), DATE_TRUNC('week', NOW()), INTERVAL '1 week' ) gs LEFT JOIN ( SELECT DATE_TRUNC('week', detected_at)::date AS wk, COUNT(*) AS cnt FROM reviews WHERE business_id = ${businessId} AND detected_at >= NOW() - make_interval(weeks => ${trendWeeks}) AND status <> ${REVIEW_STATUS.DELETED} GROUP BY DATE_TRUNC('week', detected_at) ) r ON r.wk = gs::date ORDER BY week_start ASC",
    category: 'tenant-root-lookup',
    reason: "Dashboard service receives an owner-scoped accountId or businessId and uses it as the tenant boundary for joined data.",
  },
  {
    file: "worker/background/pollers/EngagementMonitorPoller.ts",
    table: "notification_deliveries",
    sqlSnippet: "INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status) SELECT ${uuidv7()}, ${QUEUE_NAMES.ENGAGEMENT_ALERT}, 'business', ${row.business_id}, ${jsonb(payload)}, 'pending' WHERE NOT EXISTS ( SELECT 1 FROM notification_deliveries WHERE business_id = ${row.business_id} AND template = ${rule.type} AND sent_at > NOW() - ${cooldownDays} * INTERVAL '1 day' ) AND NOT EXISTS ( SELECT 1 FROM job_outbox WHERE topic = ${QUEUE_NAMES.ENGAGEMENT_ALERT} AND aggregate_id = ${row.business_id} AND status IN ('pending', 'dispatching', 'dispatched') AND payload->>'alert_type' = ${rule.type} )",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/jobs/DrainOwnerConnectWorker.ts",
    table: "responses",
    sqlSnippet: "WITH stuck AS ( SELECT id, business_id FROM responses WHERE business_id = ${businessId} AND status = 'awaiting_owner_connect' ) INSERT INTO job_outbox ( id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts ) SELECT gen_random_uuid(), ${QUEUE_NAMES.PUBLISH_RESPONSE}, 'response', stuck.id, jsonb_build_object('response_id', stuck.id, 'business_id', stuck.business_id), 0, 5 FROM stuck WHERE NOT EXISTS ( SELECT 1 FROM job_outbox jo WHERE jo.topic = ${QUEUE_NAMES.PUBLISH_RESPONSE} AND jo.aggregate_id = stuck.id AND jo.status IN ('pending', 'dispatching', 'dispatched') ) ON CONFLICT (topic, aggregate_id) WHERE topic = 'publish_response' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING",
    category: 'worker-job-scoped',
    reason: "Drain owner-connect worker processes a business aggregate id and only enqueues publish work for responses with that businessId.",
  },
  {
    file: "src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts",
    table: "responses",
    sqlSnippet: "INSERT INTO responses ( id, review_id, business_id, response_text, approved_text, original_draft_text, edited_text, response_language, version, status, approval_method, approved_at, llm_provider, llm_model, prompt_tokens, completion_tokens ) VALUES ( ${newId}, ${reviewId}, ${failed.business_id}, ${restoredText}, ${restoredText}, ${restoredText}, ${null}, ${superseded.response_language}, (COALESCE((SELECT MAX(version) FROM responses WHERE review_id = ${reviewId} AND business_id = ${failed.business_id}), 0) + 1), 'approved', ${APPROVAL_METHOD.OWNER}, NOW(), ${null}, ${null}, ${null}, ${null} )",
    category: 'tenant-root-lookup',
    reason: "Owner past-replies transaction has already resolved request account/location scope before this row-level lock or mutation.",
  },
  {
    file: "src/app/api/dashboard/past-replies/draft/route.ts",
    table: "responses",
    sqlSnippet: "SELECT id AS response_id, COALESCE(edited_text, approved_text, response_text) AS text, (edited_text IS NOT NULL) AS is_edited, status FROM responses WHERE review_id = ${parsed.data.review_id} AND status = ANY(${statusArraySql(sql, NON_TERMINAL_STATUSES)}) ORDER BY version DESC LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Owner past-replies transaction has already resolved request account/location scope before this row-level lock or mutation.",
  },
  {
    file: "src/app/api/dashboard/past-replies/draft/route.ts",
    table: "responses",
    sqlSnippet: "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM responses WHERE review_id = ${parsed.data.review_id}",
    category: 'tenant-root-lookup',
    reason: "Owner past-replies transaction has already resolved request account/location scope before this row-level lock or mutation.",
  },
  {
    file: "src/app/api/dashboard/past-replies/draft/route.ts",
    table: "responses",
    sqlSnippet: "SELECT approved_text, response_text, response_language FROM responses WHERE review_id = ${parsed.data.review_id} AND status = 'posted'",
    category: 'tenant-root-lookup',
    reason: "Owner past-replies transaction has already resolved request account/location scope before this row-level lock or mutation.",
  },
  {
    file: "src/lib/accounts/tier-snapshot.ts",
    table: "accounts",
    sqlSnippet: "UPDATE accounts SET subscription_tier = ${snapshot.tier}, base_price_cents = ${snapshot.baseCents}, locations_overage_price_cents = ${snapshot.overageCents}, locations_included = ${snapshot.included}, locations_paid = ${input.locationsPaid}, updated_at = NOW() WHERE id = ${input.accountId}::uuid AND ROW( subscription_tier, base_price_cents, locations_overage_price_cents, locations_included, locations_paid ) IS DISTINCT FROM ROW( ${snapshot.tier}::text, ${snapshot.baseCents}::integer, ${snapshot.overageCents}::integer, ${snapshot.included}::integer, ${input.locationsPaid}::integer ) RETURNING id",
    category: 'tenant-root-lookup',
    reason: "The caller supplies the owner/provider-resolved account id and holds the fixed WS8 billing locks before this complete snapshot update.",
  },
  {
    file: "src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts",
    table: "zernio_connections",
    sqlSnippet: "UPDATE zernio_connections SET zernio_profile_id = ${stored.profileId}, zernio_account_id = ${accountId}, zernio_location_id = ${locationId}, status = 'active', connected_at = NOW(), updated_at = NOW() WHERE id = ${existingConnection.id}",
    category: 'provider-ingress',
    reason: "Zernio OAuth finalize uses a server-side stored connect intent with connectionId and stored.businessId as the tenant boundary.",
  },
  // REMOVED by #677, along with its `zernio_backfill_runs` twin further down: the
  // `needs_backfill` SELECT both entries described no longer exists. That
  // predicate asked "has a backfill ever completed?" as a proxy for "should we
  // import?"; the Review import is consent-gated now, so finalize asks whether the
  // owner accepted the Import offer. The replacement statements bind their tenant
  // keys in top-level predicates and need no suppression.
  {
    file: "src/lib/approval/create-link.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT id FROM notification_deliveries WHERE response_id = ${responseId} AND channel = ${channel} AND template IN ('approval_request', 'pending_post_notice') AND sent_at IS NOT NULL LIMIT 1",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/create-link.ts",
    table: "approval_links",
    sqlSnippet: "UPDATE approval_links SET revoked_at = NOW() WHERE response_id = ${responseId} AND channel = ${channel} AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > NOW()",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/http-routes.ts",
    table: "responses",
    sqlSnippet: "SELECT review_id FROM responses WHERE id = ${link.response_id}",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/locks.ts",
    table: "approval_links",
    sqlSnippet: "SELECT id, response_id, business_id, token_hash, channel, expires_at, consumed_at, revoked_at, device_cookie_hash, created_at FROM approval_links WHERE token_hash = ${tokenHash} FOR UPDATE",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/locks.ts",
    table: "approval_links",
    sqlSnippet: "UPDATE approval_links SET consumed_at = NOW() WHERE id = ${linkId}",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/locks.ts",
    table: "responses",
    sqlSnippet: "SELECT status, original_draft_text, response_text, version, review_id, business_id FROM responses WHERE id = ${responseId} FOR UPDATE",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known; the selected business_id immediately drives the in-tx archived-location gate.",
  },
  {
    file: "src/lib/approval/locks.ts",
    table: "approval_links",
    sqlSnippet: "UPDATE approval_links SET revoked_at = NOW() WHERE response_id = ${responseId} AND id != ${excludeLinkId} AND consumed_at IS NULL",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/locks.ts",
    table: "approval_links",
    sqlSnippet: "UPDATE approval_links SET revoked_at = NOW() WHERE response_id = ${responseId} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/locks.ts",
    table: "approval_links",
    sqlSnippet: "SELECT id, response_id, business_id, token_hash, channel, expires_at, consumed_at, revoked_at, device_cookie_hash, created_at FROM approval_links WHERE id = ${approvalLinkId} FOR UPDATE",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/session-mode.ts",
    table: "approval_links",
    sqlSnippet: "SELECT device_cookie_hash, response_id, business_id FROM approval_links WHERE id = ${linkId} FOR UPDATE",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/session-mode.ts",
    table: "approval_links",
    sqlSnippet: "UPDATE approval_links SET device_cookie_hash = ${deviceCookieHash} WHERE id = ${linkId}",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/responses/edit-existing.ts",
    table: "reviews",
    sqlSnippet: "SELECT review_content_hash, review_text FROM reviews WHERE id = ${reviewId}",
    category: 'tenant-root-lookup',
    reason: "Past-replies edit transaction has already passed the account/location permission gate before this review or response concurrency check.",
  },
  {
    file: "src/lib/responses/edit-existing.ts",
    table: "responses",
    sqlSnippet: "SELECT version FROM responses WHERE review_id = ${reviewId} AND status = 'posted'",
    category: 'tenant-root-lookup',
    reason: "Past-replies edit transaction has already passed the account/location permission gate before this review or response concurrency check.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "reviews",
    sqlSnippet: "SELECT id, review_content_hash, status FROM reviews WHERE provider = ${identity.provider} AND provider_review_name = ${identity.providerReviewName} FOR UPDATE",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "reviews",
    sqlSnippet: "UPDATE reviews SET status = ${REVIEW_STATUS.NEW}, detected_at = NOW() WHERE id = ${existing.id}",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET posting_error = ${STALE_AFTER_REVIEW_CHANGED}, updated_at = NOW() WHERE review_id = ${existing.id} AND status = 'failed' AND (posting_error LIKE ${`${DELETE_FAILED_PREFIX}%`} OR posting_error LIKE ${`${POST_AFTER_DELETE_FAILED_PREFIX}%`})",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "reviews",
    sqlSnippet: "UPDATE reviews SET reviewer_name = ${review.reviewerName}, star_rating = ${review.starRating}, review_text = ${review.reviewText}, review_date = ${review.reviewDate}, detected_language = ${review.detectedLanguage}, review_content_hash = ${contentHash}, google_review_name = COALESCE(${identity.googleReviewName}, google_review_name), sentiment_score = ${sentiment.score}, sentiment_label = ${sentiment.label}, sentiment_classified_at = NOW(), sentiment_source = ${sentiment.source}, status = CASE WHEN status = ${REVIEW_STATUS.DELETED} THEN ${REVIEW_STATUS.NEW} ELSE status END, detected_at = CASE WHEN status = ${REVIEW_STATUS.DELETED} THEN NOW() ELSE detected_at END WHERE id = ${existing.id}",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest. Sentiment columns are derived non-tenant metadata (deterministic star classification); google_review_name is provider-derived provenance (migration 070).",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "responses",
    sqlSnippet: "SELECT id, status, version FROM responses WHERE review_id = ${existing.id} AND status NOT IN ('superseded', 'failed') ORDER BY version DESC LIMIT 1 FOR UPDATE",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "responses",
    sqlSnippet: "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM responses WHERE review_id = ${existing.id}",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET status = 'failed', posting_error = 'review_content_changed', updated_at = NOW() WHERE id = ${activeResponse.id}",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET status = 'superseded', posting_error = 'review_content_changed_during_park', updated_at = NOW() WHERE id = ${activeResponse.id}",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest.",
  },
  {
    file: "src/lib/reviews/process-review.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET status = 'superseded', updated_at = NOW() WHERE id = ${activeResponse.id}",
    category: 'worker-job-scoped',
    reason: "Review ingest transaction receives businessId from source connection resolution; provider/review ids here are locked and mutated inside that scoped ingest.",
  },
  {
    file: "src/lib/demos/lifecycle.ts",
    table: "onboarding_demos",
    sqlSnippet: "UPDATE onboarding_demos SET generation_status = 'archived', updated_at = NOW() WHERE id = ${demoId}",
    category: 'worker-job-scoped',
    reason: "Demo lifecycle race-loser recovery follows a durable onboarding demo id created by an owner-authenticated route and only archives that row.",
  },
  {
    file: "worker/background/pollers/CleanupAbandonedSignupsPoller.ts",
    table: "businesses",
    sqlSnippet: "SELECT EXISTS (SELECT 1 FROM businesses WHERE onboarded_by = ${candidate.user_id}::uuid) AS has_onboarded, EXISTS (SELECT 1 FROM prospect_demos WHERE created_by = ${candidate.user_id}::uuid) AS has_prospect_demos",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/CleanupAbandonedSignupsPoller.ts",
    table: "onboarding_demos",
    sqlSnippet: "DELETE FROM onboarding_demos WHERE user_id = ${candidate.user_id}::uuid",
    category: 'worker-job-scoped',
    reason: "Abandoned-signup cleanup deletes demo rows only after revalidating and locking the candidate owner user inside the cleanup transaction.",
  },
  {
    file: "worker/background/pollers/NotificationFailoverPoller.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT id FROM notification_deliveries WHERE response_id = ${responseId} AND template = ${template} AND recipient = ${recipient} AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/ingress/stripe/invoice-paid.ts",
    table: "accounts",
    sqlSnippet: "SELECT id FROM accounts WHERE stripe_customer_id = ${customerId} AND stripe_subscription_id = ${recoverySubscriptionId}",
    category: 'provider-ingress',
    reason: "Provider ingress resolves tenant rows from signed provider identifiers before tenant ids are available.",
  },
  {
    file: "worker/ingress/stripe/invoice-payment-failed.ts",
    table: "accounts",
    sqlSnippet: "SELECT id FROM accounts WHERE stripe_customer_id = ${customerId} AND stripe_subscription_id = ${failedSubscriptionId}",
    category: 'provider-ingress',
    reason: "Provider ingress resolves tenant rows from signed provider identifiers before tenant ids are available. Scoped by (customer, subscription) — a Stripe customer can map to multiple accounts (RECONCILE-F6), so a failure for subscription B must never mark account A past_due.",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "zernio_connections",
    sqlSnippet: "WITH disconnected AS ( UPDATE zernio_connections SET status = 'disconnected', disconnect_reason = 'webhook_event', disconnected_at = NOW(), last_error = ${reason}, last_error_at = NOW(), updated_at = NOW() WHERE zernio_account_id = ${accountId} AND status = 'active' RETURNING business_id ) INSERT INTO job_outbox ( id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts ) SELECT gen_random_uuid(), 'notify_owner_connection_lost', 'business', d.business_id, jsonb_build_object( 'kind', 'connection_lost', 'business_id', d.business_id ), 0, 5 FROM disconnected d",
    category: 'provider-ingress',
    reason: "Provider ingress resolves tenant rows from signed provider identifiers before tenant ids are available.",
  },
  {
    file: "worker/jobs/response-generation/persist.ts",
    table: "api_costs",
    sqlSnippet: "UPDATE api_costs SET response_id = ${responseId} WHERE id = ${result.apiCostId}",
    category: 'worker-job-scoped',
    reason: "Response generator updates the api_costs row returned by the scoped LLM generation attempt for the same response job.",
  },
  {
    file: "worker/jobs/response-generation/persist.ts",
    table: "api_costs",
    sqlSnippet: "UPDATE api_costs SET response_id = ${responseId} WHERE id = ${retryCostId}",
    category: 'worker-job-scoped',
    reason: "Response generator updates the api_costs row returned by the scoped LLM generation attempt for the same response job.",
  },
  {
    file: "worker/jobs/response-generation/persist.ts",
    table: "api_costs",
    sqlSnippet: "UPDATE api_costs SET moderation_score = ${moderation.score}, moderation_categories = ${tx.json(moderation.categories as never)}, flagged = ${moderation.flagged}, flag_reason = ${moderation.reason}, output_excerpt = ${outputExcerpt} WHERE id = ${moderatedCostId}",
    category: 'worker-job-scoped',
    reason: "Response generator records moderation metadata (invariant #4) on the same scoped api_costs row by its own id; moderatedCostId derives from the LLM generation attempt for this response job. Surfaced by the #125 comment-stripping fix, which previously hid this query.",
  },
  {
    file: "worker/jobs/publisher/edit-publish.ts",
    table: "responses",
    sqlSnippet: "SELECT id FROM responses WHERE review_id = ${reviewId} AND status = 'posted' AND id != ${responseId} LIMIT 1 FOR UPDATE",
    category: 'worker-job-scoped',
    reason: "Edit publisher path derives sibling response ids from the same business-scoped publish job before superseding posted rows.",
  },
  {
    file: "worker/jobs/publisher/auto-policy-publish.ts",
    table: "auto_approval_policies",
    sqlSnippet: "SELECT subscription_status, subscription_tier, past_due_at, flags, EXISTS ( SELECT 1 FROM auto_approval_policies p WHERE p.account_id = ${business.account_id}::uuid AND p.suspended_at IS NOT NULL AND (p.location_id IS NULL OR p.location_id = ${input.businessId}::uuid) ) AS autonomy_suspended FROM accounts WHERE id = ${business.account_id}::uuid",
    category: 'worker-job-scoped',
    reason: "Publish-time WS6 suspension recheck rides the entitlement-lane accounts read; the auto_approval_policies EXISTS subquery IS account-scoped (p.account_id = the locked lane's account id param) and location-scoped via the OR override arm — the static analyzer cannot see through the parenthesized OR.",
  },
  {
    file: "worker/jobs/publisher/edit-publish-tx.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET status = 'superseded', updated_at = NOW() WHERE id = ${siblingId} AND status = 'posted' RETURNING 1",
    category: 'worker-job-scoped',
    reason: "Edit publisher in-tx mutation helper (supersedeSibling) supersedes sibling posted rows by id; sibling ids derive from the same business-scoped publish job. Extracted from edit-publish.ts in the publisher modularization.",
  },
  {
    file: "worker/jobs/zernio/zernio-ingest-shared.ts",
    table: "responses",
    sqlSnippet: "SELECT id, status, approved_text FROM responses WHERE review_id = ANY(${reviewIds}::uuid[]) AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')",
    category: 'worker-job-scoped',
    reason: "Zernio ingest worker has already resolved businessId from the active provider connection; review/response ids derive from that scoped batch.",
  },
  {
    file: "worker/jobs/zernio/zernio-ingest-shared.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET status = 'superseded', posting_error = 'already_replied_external', updated_at = NOW() WHERE id = ANY(${supersedeIds}::uuid[]) RETURNING id",
    category: 'worker-job-scoped',
    reason: "Zernio ingest worker has already resolved businessId from the active provider connection; review/response ids derive from that scoped batch.",
  },
  {
    file: "worker/jobs/zernio/zernio-ingest-shared.ts",
    table: "responses",
    sqlSnippet: "INSERT INTO responses ( id, review_id, business_id, response_text, approved_text, original_draft_text, edited_text, response_language, version, status, approved_at, posted_at, llm_provider, llm_model, prompt_tokens, completion_tokens ) VALUES ( gen_random_uuid(), ${reviewId}, ${businessId}, ${replyText}, ${replyText}, ${replyText}, NULL, ${reviewLanguage}, COALESCE((SELECT MAX(version) FROM responses WHERE review_id = ${reviewId}), 0) + 1, 'posted', ${updateTime}::timestamptz, ${updateTime}::timestamptz, NULL, NULL, NULL, NULL ) ON CONFLICT (review_id) WHERE status = 'posted' DO NOTHING RETURNING 1",
    category: 'worker-job-scoped',
    reason: "Zernio ingest worker has already resolved businessId from the active provider connection; review/response ids derive from that scoped batch.",
  },
  {
    file: "src/lib/accounts/tier-snapshot.ts",
    table: "businesses",
    sqlSnippet: "UPDATE businesses SET subscription_tier = ${account.subscription_tier}, updated_at = NOW() WHERE account_id = ${accountId}::uuid AND subscription_tier IS DISTINCT FROM ${account.subscription_tier}::text",
    category: 'tenant-root-lookup',
    reason: "The deprecated tier-only mirror is constrained by the same owner/provider-resolved account id and runs after locking every business row for that account.",
  },
  {
    file: "src/lib/approval/http-routes.ts",
    table: "businesses",
    sqlSnippet: "SELECT r.id, r.business_id, r.status FROM responses r JOIN reviews rv ON rv.id = r.review_id JOIN businesses b ON b.id = rv.business_id WHERE rv.id = ${reviewId} AND b.account_id = ${owner.accountId}::uuid AND b.archived_at IS NULL AND r.status NOT IN ('superseded', 'failed') ORDER BY r.version DESC LIMIT 1",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/approval/http-routes.ts",
    table: "reviews",
    sqlSnippet: "SELECT r.id, r.business_id, r.status FROM responses r JOIN reviews rv ON rv.id = r.review_id JOIN businesses b ON b.id = rv.business_id WHERE rv.id = ${reviewId} AND b.account_id = ${owner.accountId}::uuid AND b.archived_at IS NULL AND r.status NOT IN ('superseded', 'failed') ORDER BY r.version DESC LIMIT 1",
    category: 'pre-auth-token',
    reason: "Approval transaction resolves token/response rows by durable approval identifiers before tenant scope is known.",
  },
  {
    file: "src/lib/dashboard/service.ts",
    table: "ranking_snapshots",
    sqlSnippet: "SELECT keyword, snapshot_date, rank_position FROM ranking_snapshots WHERE business_id = ${businessId} AND rank_position IS NOT NULL AND snapshot_date >= (CURRENT_DATE - INTERVAL '12 months') ORDER BY keyword ASC, snapshot_date ASC",
    category: 'tenant-root-lookup',
    reason: "Dashboard service receives an owner-scoped accountId or businessId and uses it as the tenant boundary for joined data.",
  },
  {
    file: "src/lib/locations/archive-location-tx.ts",
    table: "businesses",
    sqlSnippet: "UPDATE businesses SET archived_at = NULL, updated_at = NOW() WHERE id = ${locationId}::uuid AND account_id = ${accountId}::uuid AND archived_at IS NOT NULL RETURNING id, google_place_id, google_maps_url",
    category: 'tenant-root-lookup',
    reason: "Location helper filters by the accountId/locationId pair supplied by the owner access guard.",
  },
  {
    file: "src/lib/locations/repo.ts",
    table: "businesses",
    sqlSnippet: "SELECT id, account_id, name, display_label, is_primary, archived_at, google_place_id, google_place_address, created_at FROM businesses WHERE account_id = ${accountId}::uuid AND archived_at IS NOT NULL ORDER BY archived_at DESC",
    category: 'tenant-root-lookup',
    reason: "Location helper filters by the accountId/locationId pair supplied by the owner access guard.",
  },
  {
    file: "src/lib/responses/voice-learning.ts",
    table: "responses",
    sqlSnippet: "SELECT resp.original_draft_text, resp.edited_text, r.star_rating FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.business_id = ${businessId} AND resp.status = 'posted' AND resp.edited_text IS NOT NULL ORDER BY resp.posted_at DESC LIMIT 10",
    category: 'worker-job-scoped',
    reason: "Voice-learning query receives a businessId from an owner-scoped request or worker payload before sampling review and response rows.",
  },
  {
    file: "worker/jobs/EngagementAlertWorker.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT id FROM notification_deliveries WHERE business_id = ${businessId} AND template = 'owner_nudge' AND sent_at IS NOT NULL AND sent_at > NOW() - INTERVAL '3 days' LIMIT 1",
    category: 'background-global-scan',
    reason: "Engagement alert worker processes a scheduler-created business aggregate and filters notification/review rows by that businessId.",
  },
  {
    file: "worker/jobs/EngagementAlertWorker.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT id FROM notification_deliveries WHERE business_id = ${businessId} AND template = ${weekTag} AND sent_at IS NOT NULL LIMIT 1",
    category: 'background-global-scan',
    reason: "Engagement alert worker processes a scheduler-created business aggregate and filters notification/review rows by that businessId.",
  },
  {
    file: "worker/jobs/OnboardingDripWorker.ts",
    table: "responses",
    sqlSnippet: "SELECT r.reviewer_name, r.star_rating, r.review_text, resp.approved_text FROM responses resp JOIN reviews r ON r.id = resp.review_id WHERE resp.business_id = ${business.id} AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) AND r.review_text IS NOT NULL AND resp.created_at >= ${activatedAt} AND resp.created_at < ${windowEnd} ORDER BY LENGTH(r.review_text) DESC LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Onboarding drip worker first selects a business/account candidate, then uses that business id for report and reminder evidence queries.",
  },
  {
    file: "worker/jobs/OnboardingDripWorker.ts",
    table: "responses",
    sqlSnippet: "SELECT 1 AS exists FROM responses WHERE business_id = ${business.id} AND edited_text IS NOT NULL AND status IN ('edited','posted') AND created_at >= ${activatedAt} AND created_at < ${windowEnd} LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Onboarding drip worker first selects a business/account candidate, then uses that business id for report and reminder evidence queries.",
  },
  {
    file: "worker/jobs/OnboardingDripWorker.ts",
    table: "ranking_snapshots",
    sqlSnippet: "SELECT keyword, rank_position FROM ranking_snapshots WHERE business_id = ${business.id} AND rank_position IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Onboarding drip worker first selects a business/account candidate, then uses that business id for report and reminder evidence queries.",
  },
  {
    file: "worker/jobs/OnboardingDripWorker.ts",
    table: "ranking_snapshots",
    sqlSnippet: "SELECT rank_position FROM ranking_snapshots WHERE business_id = ${business.id} AND keyword = ${latestRanking.keyword} AND rank_position IS NOT NULL ORDER BY snapshot_date ASC LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Onboarding drip worker first selects a business/account candidate, then uses that business id for report and reminder evidence queries.",
  },
  {
    file: "worker/jobs/summary-report-helpers.ts",
    table: "ranking_snapshots",
    sqlSnippet: "SELECT keyword, rank_position FROM ranking_snapshots WHERE business_id = ${businessId} AND rank_position IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Summary/report worker processes a business aggregate id and filters review, response, or ranking rows by that businessId.",
  },
  {
    file: "worker/jobs/summary-report-helpers.ts",
    table: "ranking_snapshots",
    sqlSnippet: "SELECT rank_position FROM ranking_snapshots WHERE business_id = ${businessId} AND keyword = ${latestRanking.keyword} AND rank_position IS NOT NULL ORDER BY snapshot_date ASC LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Summary/report worker processes a business aggregate id and filters review, response, or ranking rows by that businessId.",
  },
  {
    file: "worker/jobs/zernio/zernio-ingest-shared.ts",
    table: "reviews",
    sqlSnippet: "SELECT id, provider FROM reviews WHERE business_id = ${businessId} AND ( (provider = 'zernio' AND provider_review_name = ${providerReviewName}) OR ( provider = 'serpapi_poll' AND reviewer_name = ${targetReviewerName} AND star_rating = ${matchFields.star_rating} AND COALESCE(NULLIF(trim(review_text), ''), '') = ${targetComment} AND ABS(EXTRACT(EPOCH FROM (review_date - to_timestamp(${targetCreatedAtMs} / 1000.0)))) < 86400 ) ) FOR UPDATE",
    category: 'worker-job-scoped',
    reason: "Zernio ingest worker has already resolved businessId from the active provider connection; review/response ids derive from that scoped batch.",
  },
  {
    file: "src/lib/admin/business-channels-service.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT e.channel, e.handle, e.status, e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason, e.verification_token_expires_at AS expires_at, e.location_id, (SELECT MAX(COALESCE(nd.delivered_at, nd.sent_at)) FROM notification_deliveries nd WHERE nd.business_id = ${businessId} AND nd.channel = e.channel) AS last_activity_at FROM channel_enrollments e WHERE e.account_id = ${accountId} AND (e.location_id = ${businessId} OR e.location_id IS NULL) AND e.archived_at IS NULL AND e.channel = ANY(${[...CHANNEL_IDS] as string[]}::text[]) ORDER BY CASE WHEN e.location_id IS NOT NULL THEN 0 ELSE 1 END, e.created_at ASC",
    category: 'admin-after-require-role',
    reason: "Admin-only route (after requireRole(admin)). The notification_deliveries last-activity subquery is scoped to the viewed location (route businessId); the outer channel_enrollments read is account-scoped via e.account_id.",
  },
  {
    file: "worker/background/pollers/EmailChannelReconcilePoller.ts",
    table: "accounts",
    sqlSnippet: "SELECT b.id AS business_id, b.account_id, b.owner_email FROM businesses b JOIN users u ON u.account_id = b.account_id AND u.role = 'owner' JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'trialing') AND u.auth_id IS NOT NULL AND b.owner_email IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM channel_enrollments ce WHERE ce.business_id = b.id AND ce.channel = 'email' ) LIMIT ${batchSize}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/background/pollers/EmailChannelReconcilePoller.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.id AS business_id, b.account_id, b.owner_email FROM businesses b JOIN users u ON u.account_id = b.account_id AND u.role = 'owner' JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'trialing') AND u.auth_id IS NOT NULL AND b.owner_email IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM channel_enrollments ce WHERE ce.business_id = b.id AND ce.channel = 'email' ) LIMIT ${batchSize}",
    category: 'background-global-scan',
    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  },
  {
    file: "worker/jobs/publisher/activation.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.id AS account_id, a.created_at AS account_created_at, r.id AS response_id, r.business_id, r.review_id, r.posted_at, first_post.id AS first_response_id FROM responses r JOIN businesses b ON b.id = r.business_id JOIN accounts a ON a.id = b.account_id JOIN LATERAL ( SELECT r2.id FROM responses r2 JOIN businesses b2 ON b2.id = r2.business_id WHERE b2.account_id = a.id AND r2.status = 'posted' AND r2.posted_at IS NOT NULL ORDER BY r2.posted_at ASC, r2.id ASC LIMIT 1 ) first_post ON TRUE WHERE r.id = ${input.responseId}::uuid AND r.business_id = ${input.businessId}::uuid AND r.status = 'posted' AND r.posted_at IS NOT NULL AND a.created_at >= NOW() - INTERVAL '8 days' LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Publisher activation check starts from the publish job responseId/businessId pair and joins back to the owning account and location.",
  },
  {
    file: "worker/jobs/publisher/activation.ts",
    table: "businesses",
    sqlSnippet: "SELECT a.id AS account_id, a.created_at AS account_created_at, r.id AS response_id, r.business_id, r.review_id, r.posted_at, first_post.id AS first_response_id FROM responses r JOIN businesses b ON b.id = r.business_id JOIN accounts a ON a.id = b.account_id JOIN LATERAL ( SELECT r2.id FROM responses r2 JOIN businesses b2 ON b2.id = r2.business_id WHERE b2.account_id = a.id AND r2.status = 'posted' AND r2.posted_at IS NOT NULL ORDER BY r2.posted_at ASC, r2.id ASC LIMIT 1 ) first_post ON TRUE WHERE r.id = ${input.responseId}::uuid AND r.business_id = ${input.businessId}::uuid AND r.status = 'posted' AND r.posted_at IS NOT NULL AND a.created_at >= NOW() - INTERVAL '8 days' LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Publisher activation check starts from the publish job responseId/businessId pair and joins back to the owning account and location.",
  },
  {
    file: "worker/jobs/publisher/activation.ts",
    table: "responses",
    sqlSnippet: "SELECT a.id AS account_id, a.created_at AS account_created_at, r.id AS response_id, r.business_id, r.review_id, r.posted_at, first_post.id AS first_response_id FROM responses r JOIN businesses b ON b.id = r.business_id JOIN accounts a ON a.id = b.account_id JOIN LATERAL ( SELECT r2.id FROM responses r2 JOIN businesses b2 ON b2.id = r2.business_id WHERE b2.account_id = a.id AND r2.status = 'posted' AND r2.posted_at IS NOT NULL ORDER BY r2.posted_at ASC, r2.id ASC LIMIT 1 ) first_post ON TRUE WHERE r.id = ${input.responseId}::uuid AND r.business_id = ${input.businessId}::uuid AND r.status = 'posted' AND r.posted_at IS NOT NULL AND a.created_at >= NOW() - INTERVAL '8 days' LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Publisher activation check starts from the publish job responseId/businessId pair and joins back to the owning account and location.",
  },
  // REMOVED by #677 — the `zernio_backfill_runs` twin of the entry deleted above.
  // Same deleted `needs_backfill` SELECT; the reasoning is recorded there.
  {
    file: "worker/background/schedulers/MonthlyImpactScheduler.ts",
    table: "monthly_impact_emails",
    sqlSnippet: MONTHLY_IMPACT_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler globally scans active accounts and uses monthly_impact_emails only as an idempotency marker before enqueueing scoped jobs.",
  },
  {
    file: "worker/background/schedulers/OnboardingDripScheduler.ts",
    table: "onboarding_drip_log",
    sqlSnippet: ONBOARDING_DRIP_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler globally scans active accounts and uses onboarding_drip_log only as an idempotency marker before enqueueing scoped jobs.",
  },
  {
    file: "worker/background/schedulers/WeeklySummaryScheduler.ts",
    table: "weekly_summaries",
    sqlSnippet: WEEKLY_SUMMARY_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "Background scheduler globally scans active accounts and uses weekly_summaries only as an idempotency marker before enqueueing scoped jobs.",
  },
  {
    file: "worker/jobs/OnboardingDripWorker.ts",
    table: "onboarding_drip_log",
    sqlSnippet: "UPDATE onboarding_drip_log SET sent_at = NOW() WHERE id = ${claimId}",
    category: 'worker-job-scoped',
    reason: "OnboardingDripWorker updates the drip-log row id claimed earlier in the same business-scoped job flow.",
  },
  {
    file: "worker/jobs/zernio/ZernioBackfillWorker.ts",
    table: "zernio_backfill_runs",
    sqlSnippet: "SELECT id, completed_at FROM zernio_backfill_runs WHERE correlation_id = ${correlationId}::uuid LIMIT 1",
    category: 'worker-job-scoped',
    reason: "ZernioBackfillWorker reads the backfill run by correlation id created for the current business-scoped backfill job.",
  },
  {
    file: "worker/jobs/zernio/ZernioBackfillWorker.ts",
    table: "zernio_backfill_runs",
    sqlSnippet: "UPDATE zernio_backfill_runs SET imported_count = ${importedCount}, skipped_count = ${skippedCount}, oldest_skipped_create_time = ${selection.oldestSkippedCreateTime}, updated_at = NOW() WHERE id = ${run.id}",
    category: 'worker-job-scoped',
    reason: "ZernioBackfillWorker updates the run row id loaded by correlation id for the current business-scoped backfill job.",
  },
  {
    file: "worker/jobs/zernio/ZernioBackfillWorker.ts",
    table: "zernio_backfill_runs",
    sqlSnippet: "UPDATE zernio_backfill_runs SET completed_at = NOW(), updated_at = NOW() WHERE id = ${run.id}",
    category: 'worker-job-scoped',
    reason: "ZernioBackfillWorker marks complete on the run row id loaded by correlation id for the current business-scoped backfill job.",
  },
  {
    file: "worker/background/pollers/EmailChannelReconcilePoller.ts",
    table: "channel_enrollments",
    sqlSnippet: "SELECT b.id AS business_id, b.account_id, b.owner_email FROM businesses b JOIN users u ON u.account_id = b.account_id AND u.role = 'owner' JOIN accounts a ON a.id = b.account_id WHERE a.subscription_status IN ('active', 'trialing') AND u.auth_id IS NOT NULL AND b.owner_email IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM channel_enrollments ce WHERE ce.business_id = b.id AND ce.channel = 'email' ) LIMIT ${batchSize}",
    category: 'tenant-root-lookup',
    reason: "Background reconciliation intentionally scans active owner locations and checks channel_enrollments by the candidate business id before inserting the missing scoped email row.",
  },
  {
    file: "worker/ingress/telegram/telegram-enrollment.ts",
    table: "channel_enrollments",
    sqlSnippet: "SELECT id, business_id, account_id FROM channel_enrollments WHERE verification_token_hash = ${tokenHash} AND channel = 'telegram' AND status = 'pending_verification' AND verification_token_expires_at > NOW() FOR UPDATE",
    category: 'pre-auth-token',
    reason: "Telegram enrollment ingress resolves the pending channel row by one-time verification token before account context is known.",
  },
  {
    file: "worker/ingress/telegram/telegram-enrollment.ts",
    table: "channel_enrollments",
    sqlSnippet: "UPDATE channel_enrollments SET handle = ${chatId}, status = 'verified', verified_at = NOW(), verification_token_hash = NULL, verification_token_expires_at = NULL, updated_at = NOW() WHERE id = ${row.id}",
    category: 'pre-auth-token',
    reason: "Telegram enrollment ingress updates the row id locked by verification token in the same transaction.",
  },
  {
    file: "worker/ingress/twilio/twilio-whatsapp-inbound.ts",
    table: "channel_enrollments",
    sqlSnippet: "UPDATE channel_enrollments SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, NOW()), unsubscribed_reason = COALESCE(unsubscribed_reason, 'whatsapp_stop'), updated_at = NOW() WHERE handle = ${ctx.senderHandle} AND channel = 'whatsapp' AND archived_at IS NULL RETURNING account_id",
    category: 'tenant-root-lookup',
    reason: "WhatsApp STOP handling is intentionally handle-wide for TCPA compliance and returns affected account ids for immediate cache invalidation.",
  },
  {
    file: "worker/ingress/twilio/twilio-whatsapp-inbound.ts",
    table: "channel_enrollments",
    sqlSnippet: "SELECT id, account_id FROM channel_enrollments WHERE verification_token_hash = ${tokenHash} AND channel = 'whatsapp' AND status = 'pending_verification' AND verification_token_expires_at > NOW() AND archived_at IS NULL FOR UPDATE",
    category: 'pre-auth-token',
    reason: "WhatsApp enrollment ingress resolves the pending channel row by one-time verification token before account context is known.",
  },
  {
    file: "worker/ingress/twilio/twilio-whatsapp-inbound.ts",
    table: "channel_enrollments",
    sqlSnippet: "UPDATE channel_enrollments SET handle = ${senderHandle}, status = 'verified', verified_at = NOW(), verification_token_hash = NULL, verification_token_expires_at = NULL, updated_at = NOW() WHERE id = ${row.id} AND archived_at IS NULL",
    category: 'pre-auth-token',
    reason: "WhatsApp enrollment ingress updates the row id locked by verification token in the same transaction.",
  },
  // --- KPI service (src/lib/kpi/service.ts) ---
  // Per-location queries: scoped by `r.business_id = ${businessId}` on the reviews scan.
  // Responses are correlated via EXISTS(review_id = r.id) or JOIN ON r.id = resp.review_id —
  // the static scanner cannot trace the correlated join/subquery back to the business scope.
  // businessId is IDOR-checked in the calling route before this service is invoked.
  {
    file: "src/lib/kpi/service.ts",
    table: "responses",
    sqlSnippet: "SELECT COUNT(*)::int AS received, COUNT(*) FILTER ( WHERE EXISTS ( SELECT 1 FROM responses resp WHERE resp.review_id = r.id AND ${handledStatusFilter(sql, HANDLED)} ) )::int AS handled FROM reviews r WHERE r.business_id = ${businessId} AND ${notDeletedFilter(sql, 'r.')} AND ${detectedAtWindowFilter(sql, 'r.', windowDays)}",
    category: 'tenant-root-lookup',
    reason: "Per-location KPI query; responses accessed via correlated EXISTS (resp.review_id = r.id) inside the reviews scan scoped by r.business_id = ${businessId}. businessId is IDOR-checked in the route. Non-scope SELECT/filter pieces (handledStatusFilter/notDeletedFilter/detectedAtWindowFilter) are shared sql`` fragments (A+ campaign 2d) — none spell a FROM/JOIN of a tenant table.",
  },
  {
    file: "src/lib/kpi/service.ts",
    table: "responses",
    sqlSnippet: "SELECT ${ttrSelectExpr(sql)} FROM responses resp JOIN reviews r ON r.id = resp.review_id WHERE r.business_id = ${businessId} AND ${notDeletedFilter(sql, 'r.')} AND ${ttrHandledWindowFilter(sql, HANDLED, windowDays)}",
    category: 'tenant-root-lookup',
    reason: "Per-location KPI query; responses scoped via JOIN reviews r ON r.id = resp.review_id WHERE r.business_id = ${businessId}. businessId is IDOR-checked in the route. Non-scope SELECT/filter pieces are shared sql`` fragments (A+ campaign 2d) — none spell a FROM/JOIN of a tenant table.",
  },
  {
    file: "src/lib/kpi/service.ts",
    table: "reviews",
    sqlSnippet: "SELECT gs::date AS week_start, agg.avg_score::float AS avg_score, COALESCE(agg.cnt, 0)::int AS cnt FROM generate_series( DATE_TRUNC('week', NOW() - make_interval(weeks => ${trendSpanWeeks})), DATE_TRUNC('week', NOW()), INTERVAL '1 week' ) gs LEFT JOIN ( SELECT DATE_TRUNC('week', detected_at)::date AS wk, AVG(sentiment_score) AS avg_score, COUNT(*) AS cnt FROM reviews WHERE business_id = ${businessId} AND ${notDeletedFilter(sql, '')} AND detected_at >= NOW() - make_interval(weeks => ${trendWeeks}) GROUP BY DATE_TRUNC('week', detected_at) ) agg ON agg.wk = gs::date ORDER BY week_start ASC",
    category: 'tenant-root-lookup',
    reason: "Per-location KPI query; reviews accessed inside a LEFT JOIN subquery scoped by business_id = ${businessId}. Scanner strips SELECT subqueries before predicate analysis. businessId is IDOR-checked in the route. The notDeletedFilter fragment (A+ campaign 2d) sits entirely inside the stripped subquery.",
  },
  // Account-aggregate queries: scoped via JOIN businesses b ON b.id = r.business_id
  // WHERE b.account_id = ${accountId} AND b.archived_at IS NULL (active locations only).
  // The static scanner cannot trace the scope through correlated subqueries / multi-join chains.
  // accountId comes from the authenticated session.
  {
    file: "src/lib/kpi/service.ts",
    table: "responses",
    sqlSnippet: "SELECT COUNT(*)::int AS received, COUNT(*) FILTER ( WHERE EXISTS ( SELECT 1 FROM responses resp WHERE resp.review_id = r.id AND ${handledStatusFilter(sql, HANDLED)} ) )::int AS handled FROM reviews r JOIN businesses b ON b.id = r.business_id WHERE b.account_id = ${accountId} AND b.archived_at IS NULL AND ${notDeletedFilter(sql, 'r.')} AND ${detectedAtWindowFilter(sql, 'r.', windowDays)}",
    category: 'tenant-root-lookup',
    reason: "Account-aggregate KPI; responses accessed via correlated EXISTS (resp.review_id = r.id) inside reviews scoped by JOIN businesses b WHERE b.account_id = ${accountId} AND b.archived_at IS NULL (active locations only). Non-scope SELECT/filter pieces are shared sql`` fragments (A+ campaign 2d) — none spell a FROM/JOIN of a tenant table.",
  },
  {
    file: "src/lib/kpi/service.ts",
    table: "responses",
    sqlSnippet: "SELECT ${ttrSelectExpr(sql)} FROM responses resp JOIN reviews r ON r.id = resp.review_id JOIN businesses b ON b.id = r.business_id WHERE b.account_id = ${accountId} AND b.archived_at IS NULL AND ${notDeletedFilter(sql, 'r.')} AND ${ttrHandledWindowFilter(sql, HANDLED, windowDays)}",
    category: 'tenant-root-lookup',
    reason: "Account-aggregate KPI; scoped via JOIN businesses b WHERE b.account_id = ${accountId} AND b.archived_at IS NULL (active locations only). Non-scope SELECT/filter pieces are shared sql`` fragments (A+ campaign 2d) — none spell a FROM/JOIN of a tenant table.",
  },
  {
    file: "src/lib/kpi/service.ts",
    table: "businesses",
    sqlSnippet: "SELECT gs::date AS week_start, agg.avg_score::float AS avg_score, COALESCE(agg.cnt, 0)::int AS cnt FROM generate_series( DATE_TRUNC('week', NOW() - make_interval(weeks => ${trendSpanWeeks})), DATE_TRUNC('week', NOW()), INTERVAL '1 week' ) gs LEFT JOIN ( SELECT DATE_TRUNC('week', r.detected_at)::date AS wk, AVG(r.sentiment_score) AS avg_score, COUNT(*) AS cnt FROM reviews r JOIN businesses b ON b.id = r.business_id WHERE b.account_id = ${accountId} AND b.archived_at IS NULL AND ${notDeletedFilter(sql, 'r.')} AND r.detected_at >= NOW() - make_interval(weeks => ${trendWeeks}) GROUP BY DATE_TRUNC('week', r.detected_at) ) agg ON agg.wk = gs::date ORDER BY week_start ASC",
    category: 'tenant-root-lookup',
    reason: "Account-aggregate KPI; businesses accessed inside a LEFT JOIN subquery scoped by b.account_id = ${accountId} AND b.archived_at IS NULL. Scanner strips SELECT subqueries before predicate analysis. The notDeletedFilter fragment (A+ campaign 2d) sits entirely inside the stripped subquery.",
  },
  {
    file: "src/lib/kpi/service.ts",
    table: "reviews",
    sqlSnippet: "SELECT gs::date AS week_start, agg.avg_score::float AS avg_score, COALESCE(agg.cnt, 0)::int AS cnt FROM generate_series( DATE_TRUNC('week', NOW() - make_interval(weeks => ${trendSpanWeeks})), DATE_TRUNC('week', NOW()), INTERVAL '1 week' ) gs LEFT JOIN ( SELECT DATE_TRUNC('week', r.detected_at)::date AS wk, AVG(r.sentiment_score) AS avg_score, COUNT(*) AS cnt FROM reviews r JOIN businesses b ON b.id = r.business_id WHERE b.account_id = ${accountId} AND b.archived_at IS NULL AND ${notDeletedFilter(sql, 'r.')} AND r.detected_at >= NOW() - make_interval(weeks => ${trendWeeks}) GROUP BY DATE_TRUNC('week', r.detected_at) ) agg ON agg.wk = gs::date ORDER BY week_start ASC",
    category: 'tenant-root-lookup',
    reason: "Account-aggregate KPI; reviews accessed inside a LEFT JOIN subquery scoped by JOIN businesses b WHERE b.account_id = ${accountId} AND b.archived_at IS NULL. Scanner strips SELECT subqueries before predicate analysis. The notDeletedFilter fragment (A+ campaign 2d) sits entirely inside the stripped subquery.",
  },
  // --- Named rival / Competitor Delta lane (src/lib/competitors/named-rival.ts) ---
  // Every leg of the single lane query IS bound to ${businessId}:
  // `WHERE b.id = ${businessId}` in the ctx CTE, `rs.business_id = ${businessId}`
  // in the dates CTE (further correlated to ctx.keyword / ctx.search_location),
  // and `cs.business_id = ${businessId}` in the outer LEFT JOIN — which is why
  // competitor_snapshots needs no entry. The first two are invisible to the
  // scanner because it strips SELECT subqueries (CTE bodies included) before
  // predicate analysis. Collapsing the lane into one statement is deliberate
  // (torn-read fix, see NAMED_RIVAL_LANE_SQL above) and "latest two snapshot
  // dates" needs a LIMIT, so the subquery cannot be flattened away.
  {
    file: "src/lib/competitors/named-rival.ts",
    table: "businesses",
    sqlSnippet: NAMED_RIVAL_LANE_SQL,
    category: 'tenant-root-lookup',
    reason: "Competitor Delta lane; businesses is read inside the ctx CTE scoped by b.id = ${businessId}. Scanner strips SELECT subqueries before predicate analysis. Today the only caller is the WeeklySummaryWorker composition root, which takes businessId from its durable outbox job payload (tenant context fixed upstream by the weekly-summary scheduler); the owner-scoped settings route that will also call it lands in #546 Task 4 and resolves the location under the session's account_id before passing the id.",
  },
  {
    file: "src/lib/competitors/named-rival.ts",
    table: "ranking_snapshots",
    sqlSnippet: NAMED_RIVAL_LANE_SQL,
    category: 'tenant-root-lookup',
    reason: "Competitor Delta lane; ranking_snapshots is read inside the dates CTE scoped by rs.business_id = ${businessId} and correlated to the same location's ctx.keyword / ctx.search_location. Scanner strips SELECT subqueries before predicate analysis. Today the only caller is the WeeklySummaryWorker composition root, which takes businessId from its durable outbox job payload (tenant context fixed upstream by the weekly-summary scheduler); the owner-scoped settings route that will also call it lands in #546 Task 4 and resolves the location under the session's account_id before passing the id.",
  },
  {
    // force_drain connection lookup — businesses is joined only for account_id;
    // it is not value-bound (b.id = zc.business_id is a join), so the scanner
    // flags it. The route is admin-only (requireRole(admin) + AAL2) and acts
    // cross-tenant by design; zernio_connections itself is scoped by zc.business_id.
    file: "src/app/api/admin/businesses/[id]/zernio-queue/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT zc.status, b.account_id FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id WHERE zc.business_id = ${businessId} ORDER BY zc.created_at DESC LIMIT 1 FOR UPDATE OF zc",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    // dismiss lookup — businesses is joined only for account_id (not value-bound).
    // responses itself is scoped by r.business_id = ${businessId}.
    file: "src/app/api/admin/businesses/[id]/zernio-queue/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT r.id, b.account_id FROM responses r JOIN businesses b ON b.id = r.business_id WHERE r.id = ${responseId} AND r.business_id = ${businessId} AND r.status = 'awaiting_owner_connect' FOR UPDATE OF r",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    // dismiss update — scoped by primary key id (already locked FOR UPDATE in the
    // select above), which the scanner does not treat as tenant scope. Admin-only.
    file: "src/app/api/admin/businesses/[id]/zernio-queue/route.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET status = 'superseded', posting_error = 'admin_dismissed_awaiting_connect', updated_at = NOW() WHERE id = ${responseId} AND status = 'awaiting_owner_connect'",
    category: 'admin-after-require-role',
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/lib/admin/offboardings-service.ts",
    table: "accounts",
    sqlSnippet: "SELECT ao.id, ao.account_id, a.display_name AS account_name, a.subscription_status, ao.mode, ao.status, ao.failed_step, ao.last_error, ao.requested_at, ao.access_ends_at, ao.teardown_started_at, ao.teardown_completed_at, ao.purge_after, ao.purge_started_at, ao.purge_cancelled_at, ao.purged_at, ao.terminal_at, ao.stripe_step, ao.zernio_accounts_step, ao.zernio_profiles_step, ao.location_archival_step, ao.job_terminalization_step, ao.retry_count, ao.provider_dispositions, ( ao.status = 'failed' OR ao.failed_step IS NOT NULL OR ao.last_error IS NOT NULL OR ( ao.status = 'scheduled' AND ao.access_ends_at IS NOT NULL AND ao.access_ends_at <= NOW() AND ao.teardown_started_at IS NULL ) OR ( ao.status = 'purge_scheduled' AND ao.purge_after IS NOT NULL AND ao.purge_after <= NOW() AND ao.purge_started_at IS NULL ) ) AS is_stuck FROM account_offboardings ao JOIN accounts a ON a.id = ao.account_id WHERE ao.terminal_at IS NULL OR ao.status = 'failed' ORDER BY CASE WHEN ao.status = 'failed' THEN 0 WHEN ao.last_error IS NOT NULL THEN 1 ELSE 2 END, ao.requested_at DESC, ao.id ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only owner-offboarding visibility intentionally lists active/failed/stuck account lifecycles cross-tenant after requireRole(admin) + current AAL2.",
  },
  {
    file: "src/lib/admin/offboardings-service.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT ao.id, ao.account_id, a.display_name AS account_name, a.subscription_status, ao.mode, ao.status, ao.failed_step, ao.last_error, ao.requested_at, ao.access_ends_at, ao.teardown_started_at, ao.teardown_completed_at, ao.purge_after, ao.purge_started_at, ao.purge_cancelled_at, ao.purged_at, ao.terminal_at, ao.stripe_step, ao.zernio_accounts_step, ao.zernio_profiles_step, ao.location_archival_step, ao.job_terminalization_step, ao.retry_count, ao.provider_dispositions, ( ao.status = 'failed' OR ao.failed_step IS NOT NULL OR ao.last_error IS NOT NULL OR ( ao.status = 'scheduled' AND ao.access_ends_at IS NOT NULL AND ao.access_ends_at <= NOW() AND ao.teardown_started_at IS NULL ) OR ( ao.status = 'purge_scheduled' AND ao.purge_after IS NOT NULL AND ao.purge_after <= NOW() AND ao.purge_started_at IS NULL ) ) AS is_stuck FROM account_offboardings ao JOIN accounts a ON a.id = ao.account_id WHERE ao.terminal_at IS NULL OR ao.status = 'failed' ORDER BY CASE WHEN ao.status = 'failed' THEN 0 WHEN ao.last_error IS NOT NULL THEN 1 ELSE 2 END, ao.requested_at DESC, ao.id ASC LIMIT ${limit} OFFSET ${offset}",
    category: 'admin-after-require-role',
    reason: "Admin-only owner-offboarding visibility intentionally lists active/failed/stuck lifecycle rows cross-tenant after requireRole(admin) + current AAL2.",
  },
  {
    file: "src/lib/admin/offboardings-service.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT COUNT(*)::int AS total FROM account_offboardings WHERE terminal_at IS NULL OR status = 'failed'",
    category: 'admin-after-require-role',
    reason: "Admin-only owner-offboarding visibility needs a cross-tenant count for active/failed lifecycle pagination after requireRole(admin) + current AAL2.",
  },
  {
    file: "src/lib/account-offboarding/provider-disposition.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT id, account_id, mode, status, failed_step, terminal_at, purge_after, purge_cancelled_at, stripe_subscription_id, zernio_account_ids, zernio_profile_ids, location_ids, stripe_step, zernio_accounts_step, zernio_profiles_step, location_archival_step, provider_dispositions FROM account_offboardings WHERE id = ${input.offboardingId}::uuid FOR UPDATE",
    category: 'admin-after-require-role',
    reason: "Admin-only provider-disposition mutation resolves the offboarding row by route id after same-origin + requireRole(admin) + current AAL2; the following update and audit are scoped by the locked row's account_id. Snapshot step/array columns are read to verify every applicable provider step is success-or-dispositioned before force-transition (H2).",
  },
  {
    file: "src/app/api/zernio/connect/callback/route.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT b.account_id, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b LEFT JOIN account_offboardings ao ON ao.account_id = b.account_id AND ao.terminal_at IS NULL WHERE b.id = ${businessId} ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'provider-ingress',
    reason: "Zernio callback follows a signed connect-state business id, then joins only that business account to the active offboarding gate.",
  },
  {
    file: "src/app/api/zernio/disconnect/route.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT a.id AS account_id, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${businessId} AND b.archived_at IS NULL ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Zernio disconnect follows a route business id, then joins only that business account to the active offboarding gate.",
  },
  {
    file: "src/lib/account-offboarding/confirm.ts",
    table: "account_audit_log",
    sqlSnippet: "SELECT ao.id, ao.mode, ao.status, EXISTS ( SELECT 1 FROM account_audit_log aal WHERE aal.account_id = ${accountId}::uuid AND aal.account_id = ao.account_id AND aal.entity_type = 'account_offboarding' AND aal.entity_id = ao.id::text AND aal.event_type = 'account_offboarding_requested' AND aal.payload->>'idempotency_key_hash' = ${idempotencyKeyHash} ) AS idempotency_key_matches FROM account_offboardings ao WHERE ao.account_id = ${accountId}::uuid AND ao.terminal_at IS NULL ORDER BY ao.created_at DESC LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Owner offboarding idempotency lookup is account-scoped; the scanner cannot prove the nested audit EXISTS relationship.",
  },
  {
    file: "src/lib/account-offboarding/keep-my-data.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT t.id AS token_id, t.token_hash, t.token_type, t.expires_at, t.consumed_at, t.revoked_at, ao.id, ao.account_id, ao.mode, ao.status, ao.teardown_completed_at, ao.purge_started_at, ao.purge_cancelled_at, ao.terminal_at FROM account_offboarding_tokens t JOIN account_offboardings ao ON ao.id = t.account_offboarding_id WHERE t.token_hash = ${tokenHash} AND t.token_type = 'keep_my_data' LIMIT 1 FOR UPDATE OF t, ao",
    category: 'pre-auth-token',
    reason: "Opaque keep-my-data token lookup must resolve the offboarding row before tenant scope is known; only hashed tokens are stored.",
  },
  {
    file: "src/lib/account-offboarding/keep-my-data.ts",
    table: "account_offboarding_tokens",
    sqlSnippet: "SELECT t.id AS token_id, t.token_hash, t.token_type, t.expires_at, t.consumed_at, t.revoked_at, ao.id, ao.account_id, ao.mode, ao.status, ao.teardown_completed_at, ao.purge_started_at, ao.purge_cancelled_at, ao.terminal_at FROM account_offboarding_tokens t JOIN account_offboardings ao ON ao.id = t.account_offboarding_id WHERE t.token_hash = ${tokenHash} AND t.token_type = 'keep_my_data' LIMIT 1 FOR UPDATE OF t, ao",
    category: 'pre-auth-token',
    reason: "Opaque keep-my-data token lookup must resolve the token row before tenant scope is known; only hashed tokens are stored.",
  },
  {
    file: "src/lib/account-offboarding/keep-my-data.ts",
    table: "account_audit_log",
    sqlSnippet: "SELECT ao.id, ao.mode, ao.status, ao.terminal_at FROM account_offboardings ao WHERE ao.account_id = ${accountId}::uuid AND ao.mode = 'delete_data' AND ao.purge_cancelled_at IS NOT NULL AND EXISTS ( SELECT 1 FROM account_audit_log aal WHERE aal.account_id = ${accountId}::uuid AND aal.account_id = ao.account_id AND aal.entity_type = 'account_offboarding' AND aal.entity_id = ao.id::text AND aal.event_type = 'account_offboarding_keep_my_data' AND aal.payload->>'idempotency_key_hash' = ${idempotencyKeyHash} ) ORDER BY ao.purge_cancelled_at DESC NULLS LAST, ao.created_at DESC LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Owner keep-my-data idempotency lookup is account-scoped; the scanner cannot prove the nested audit EXISTS relationship.",
  },
  {
    file: "src/lib/shared/writable-subscription.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT a.id, a.subscription_status, a.past_due_at, a.flags, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${businessId}::uuid ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Writable-subscription business gate follows a caller-resolved business id and joins to the active offboarding gate for that business account.",
  },
  {
    file: "src/lib/shared/writable-subscription.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT a.id, a.subscription_status, a.past_due_at, a.flags, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM accounts a JOIN businesses b ON b.account_id = a.id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${locationId} ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "Writable-subscription location gate follows a caller-resolved location id and joins to the active offboarding gate for that location account.",
  },
  {
    file: "worker/background/pollers/AccountOffboardingAccessEndPoller.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT id, account_id, mode, status, access_ends_at FROM account_offboardings WHERE mode = 'cancel_only' AND status = 'scheduled' AND access_ends_at IS NOT NULL AND access_ends_at <= NOW() AND reactivation_claimed_at IS NULL AND teardown_started_at IS NULL AND terminal_at IS NULL ORDER BY access_ends_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
    category: 'background-global-scan',
    reason: "Background scheduler scans scheduled owner-offboarding rows globally before claiming one row and enqueueing scoped teardown work transactionally.",
  },
  {
    file: "worker/background/pollers/AccountOffboardingPurgePoller.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT id, account_id, mode, status, purge_after FROM account_offboardings WHERE mode = 'delete_data' AND status = 'purge_scheduled' AND purge_after IS NOT NULL AND ( purge_after <= NOW() OR ( ${purgeWindowOverrideMs}::int IS NOT NULL AND purge_after <= NOW() + (${purgeWindowOverrideMs}::int * INTERVAL '1 millisecond') ) ) AND purge_cancelled_at IS NULL AND purge_started_at IS NULL AND terminal_at IS NULL AND ( teardown_completed_at IS NOT NULL OR EXISTS ( SELECT 1 FROM jsonb_array_elements(provider_dispositions) AS disposition(value) WHERE disposition.value->>'type' = 'admin_provider_disposition' AND disposition.value->>'provider' IN ('stripe', 'zernio', 'google', 'supabase_auth', 'other') AND NULLIF(BTRIM(disposition.value->>'resource_type'), '') IS NOT NULL AND NULLIF(BTRIM(disposition.value->>'scrubbed_resource_reference'), '') IS NOT NULL AND NULLIF(BTRIM(disposition.value->>'admin_actor_user_id'), '') IS NOT NULL AND NULLIF(BTRIM(disposition.value->>'reason'), '') IS NOT NULL AND NULLIF(BTRIM(disposition.value->>'recorded_at'), '') IS NOT NULL ) ) ORDER BY purge_after ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
    category: 'background-global-scan',
    reason: "Background scheduler scans purge-eligible owner-offboarding rows globally before claiming one row and enqueueing scoped purge work transactionally.",
  },
  {
    file: "worker/background/pollers/AccountOffboardingPurgeReminderPoller.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT id, account_id, mode, status, purge_after FROM account_offboardings WHERE mode = 'delete_data' AND status = 'purge_scheduled' AND purge_after IS NOT NULL AND purge_after > NOW() AND purge_after <= NOW() + (${REMINDER_LEAD_DAYS}::int * INTERVAL '1 day') AND purge_reminder_sent_at IS NULL AND purge_started_at IS NULL AND purge_cancelled_at IS NULL AND terminal_at IS NULL ORDER BY purge_after ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
    category: 'background-global-scan',
    reason: "Background scheduler scans purge-reminder-eligible owner-offboarding rows globally before claiming one row and enqueueing scoped reminder-email work transactionally.",
  },
  {
    file: "worker/background/pollers/AccountOffboardingReactivationResetPoller.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT id, account_id, stripe_subscription_id, reactivation_claim_token FROM account_offboardings WHERE mode = 'cancel_only' AND status = 'scheduled' AND terminal_at IS NULL AND reactivated_at IS NULL AND teardown_started_at IS NULL AND reactivation_claimed_at IS NOT NULL AND reactivation_claimed_at <= NOW() - make_interval(secs => ${staleSeconds}) ORDER BY reactivation_claimed_at ASC, id ASC LIMIT ${getBatchSize()}",
    category: 'background-global-scan',
    reason: "Background scheduler scans stale reactivation-claim rows globally before compensating Stripe and clearing each claim scoped by the row's account_id (M1).",
  },
  {
    file: "worker/background/pollers/AccountOffboardingTeardownRetryPoller.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT id, account_id, mode FROM account_offboardings WHERE status = 'failed' AND failed_step = 'teardown' AND terminal_at IS NULL AND retry_count < ${maxRetries} AND updated_at <= NOW() - make_interval(secs => ${cooldownSeconds}) ORDER BY updated_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
    category: 'background-global-scan',
    reason: "Background scheduler scans failed-teardown rows globally before claiming one row and re-enqueueing scoped teardown work transactionally (bounded re-drive).",
  },
  {
    file: "worker/jobs/account-offboarding/purge-helpers.ts",
    table: "businesses",
    sqlSnippet: "DELETE FROM ${tx(tableName)} WHERE business_id IN ( SELECT id FROM businesses WHERE account_id = ${accountId}::uuid )",
    category: 'tenant-root-lookup',
    reason: "Purge deletes account-owned rows by business; businesses is scoped by account_id inside the IN-subquery, which the scanner strips before predicate analysis.",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "notification_deliveries",
    sqlSnippet: "DELETE FROM notification_deliveries nd WHERE nd.account_id = ${row.account_id}::uuid OR nd.business_id IN ( SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid )",
    category: 'tenant-root-lookup',
    reason: "Purge deletes the account's notification deliveries; both branches are account-scoped (direct account_id, or business_id IN the account's businesses), but the scanner rejects OR predicates and strips the subquery.",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "businesses",
    sqlSnippet: "DELETE FROM notification_deliveries nd WHERE nd.account_id = ${row.account_id}::uuid OR nd.business_id IN ( SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid )",
    category: 'tenant-root-lookup',
    reason: "Purge deletes the account's notification deliveries; the businesses reference is the account-scoped business_id IN-subquery, which the scanner strips before predicate analysis.",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "businesses",
    sqlSnippet: "UPDATE analytics_events SET event_key = 'scrubbed:' || id::text, distinct_id = 'scrubbed:' || id::text, anonymous_id = NULL, account_id = NULL, user_id = NULL, business_id = NULL, properties = '{}'::jsonb, last_error = NULL WHERE account_id = ${row.account_id}::uuid OR business_id IN (SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid) OR user_id IN (SELECT id FROM users WHERE account_id = ${row.account_id}::uuid) OR distinct_id IN (${row.account_id}, ${`account:${row.account_id}`})",
    category: 'tenant-root-lookup',
    reason: "Purge scrubs the account's analytics events by FK or raw account distinct_id; every branch is account-scoped but the scanner rejects OR predicates and strips the business/user subqueries.",
  },
  {
    file: "worker/background/pollers/CancellationGracePoller.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.id AS account_id, COUNT(b.id) AS cancelled_count FROM accounts a JOIN businesses b ON b.account_id = a.id WHERE a.subscription_status = ${SubscriptionStatus.CANCELLED} AND a.cancelled_at IS NOT NULL AND a.cancelled_at < NOW() - INTERVAL '30 days' AND b.archived_at IS NULL AND NOT EXISTS ( SELECT 1 FROM account_offboardings ao WHERE ao.account_id = a.id ) GROUP BY a.id",
    category: 'background-global-scan',
    reason: "Background scheduler scans cancelled accounts globally, excluding accounts with active offboarding receipts before archiving expired locations.",
  },
  {
    file: "worker/background/pollers/CancellationGracePoller.ts",
    table: "businesses",
    sqlSnippet: "SELECT a.id AS account_id, COUNT(b.id) AS cancelled_count FROM accounts a JOIN businesses b ON b.account_id = a.id WHERE a.subscription_status = ${SubscriptionStatus.CANCELLED} AND a.cancelled_at IS NOT NULL AND a.cancelled_at < NOW() - INTERVAL '30 days' AND b.archived_at IS NULL AND NOT EXISTS ( SELECT 1 FROM account_offboardings ao WHERE ao.account_id = a.id ) GROUP BY a.id",
    category: 'background-global-scan',
    reason: "Background scheduler scans cancelled accounts globally, excluding accounts with active offboarding receipts before archiving expired locations.",
  },
  {
    file: "worker/background/pollers/CancellationGracePoller.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT a.id AS account_id, COUNT(b.id) AS cancelled_count FROM accounts a JOIN businesses b ON b.account_id = a.id WHERE a.subscription_status = ${SubscriptionStatus.CANCELLED} AND a.cancelled_at IS NOT NULL AND a.cancelled_at < NOW() - INTERVAL '30 days' AND b.archived_at IS NULL AND NOT EXISTS ( SELECT 1 FROM account_offboardings ao WHERE ao.account_id = a.id ) GROUP BY a.id",
    category: 'background-global-scan',
    reason: "Background scheduler scans cancelled accounts globally, excluding accounts with active offboarding receipts before archiving expired locations.",
  },
  {
    file: "worker/background/pollers/CancellationGracePoller.ts",
    table: "account_offboardings",
    sqlSnippet: "UPDATE businesses SET archived_at = NOW(), updated_at = NOW() WHERE account_id = ${account_id}::uuid AND archived_at IS NULL AND NOT EXISTS ( SELECT 1 FROM account_offboardings ao WHERE ao.account_id = ${account_id}::uuid ) RETURNING id, display_label, name",
    category: 'tenant-root-lookup',
    reason: "Cancellation grace archive rechecks the account-scoped offboarding exclusion inside the archival transaction.",
  },
  {
    file: "worker/ingress/stripe/subscription-deleted.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.id, a.subscription_status, a.stripe_subscription_id, CASE WHEN EXISTS ( SELECT 1 FROM account_offboardings ao WHERE ao.account_id = a.id AND ao.stripe_subscription_id = ${subscriptionId} AND ao.terminal_at IS NULL ) THEN ${subscriptionId} ELSE NULL END AS active_offboarding_subscription_id FROM accounts a WHERE a.stripe_customer_id = ${customerId}",
    category: 'provider-ingress',
    reason: "Stripe webhook resolves account and offboarding state from signed provider identifiers before tenant ids are available.",
  },
  {
    file: "worker/ingress/stripe/subscription-deleted.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT a.id, a.subscription_status, a.stripe_subscription_id, CASE WHEN EXISTS ( SELECT 1 FROM account_offboardings ao WHERE ao.account_id = a.id AND ao.stripe_subscription_id = ${subscriptionId} AND ao.terminal_at IS NULL ) THEN ${subscriptionId} ELSE NULL END AS active_offboarding_subscription_id FROM accounts a WHERE a.stripe_customer_id = ${customerId}",
    category: 'provider-ingress',
    reason: "Stripe webhook resolves account and offboarding state from signed provider identifiers before tenant ids are available.",
  },
  {
    file: "worker/ingress/stripe/subscription-updated.ts",
    table: "accounts",
    sqlSnippet: "WITH account_candidates AS ( SELECT a.id, a.stripe_subscription_id, NULL::text AS active_offboarding_subscription_id, 0 AS resolution_priority FROM accounts a WHERE a.stripe_customer_id = ${customerId} AND a.stripe_subscription_id = ${subscriptionId} UNION ALL SELECT a.id, a.stripe_subscription_id, ao.stripe_subscription_id AS active_offboarding_subscription_id, 1 AS resolution_priority FROM accounts a JOIN account_offboardings ao ON ao.account_id = a.id AND ao.stripe_subscription_id = ${subscriptionId} AND ao.terminal_at IS NULL WHERE a.stripe_customer_id = ${customerId} UNION ALL SELECT a.id, a.stripe_subscription_id, NULL::text AS active_offboarding_subscription_id, 2 AS resolution_priority FROM accounts a WHERE a.stripe_customer_id = ${customerId} AND a.stripe_subscription_id IS DISTINCT FROM ${subscriptionId} AND NOT EXISTS ( SELECT 1 FROM account_offboardings ao WHERE ao.account_id = a.id AND ao.stripe_subscription_id = ${subscriptionId} AND ao.terminal_at IS NULL ) ) SELECT id, stripe_subscription_id, active_offboarding_subscription_id FROM account_candidates ORDER BY resolution_priority ASC, id ASC LIMIT 1",
    category: 'provider-ingress',
    reason: "Stripe webhook resolves account and active-offboarding subscription lineage from signed provider identifiers without a row lock before tenant ids are available.",
  },
  {
    file: "worker/ingress/stripe/subscription-updated.ts",
    table: "account_offboardings",
    sqlSnippet: "WITH account_candidates AS ( SELECT a.id, a.stripe_subscription_id, NULL::text AS active_offboarding_subscription_id, 0 AS resolution_priority FROM accounts a WHERE a.stripe_customer_id = ${customerId} AND a.stripe_subscription_id = ${subscriptionId} UNION ALL SELECT a.id, a.stripe_subscription_id, ao.stripe_subscription_id AS active_offboarding_subscription_id, 1 AS resolution_priority FROM accounts a JOIN account_offboardings ao ON ao.account_id = a.id AND ao.stripe_subscription_id = ${subscriptionId} AND ao.terminal_at IS NULL WHERE a.stripe_customer_id = ${customerId} UNION ALL SELECT a.id, a.stripe_subscription_id, NULL::text AS active_offboarding_subscription_id, 2 AS resolution_priority FROM accounts a WHERE a.stripe_customer_id = ${customerId} AND a.stripe_subscription_id IS DISTINCT FROM ${subscriptionId} AND NOT EXISTS ( SELECT 1 FROM account_offboardings ao WHERE ao.account_id = a.id AND ao.stripe_subscription_id = ${subscriptionId} AND ao.terminal_at IS NULL ) ) SELECT id, stripe_subscription_id, active_offboarding_subscription_id FROM account_candidates ORDER BY resolution_priority ASC, id ASC LIMIT 1",
    category: 'provider-ingress',
    reason: "Stripe webhook resolves account and active-offboarding subscription lineage from signed provider identifiers without a row lock before tenant ids are available.",
  },
  {
    file: "worker/ingress/stripe/apply-subscription-state.ts",
    table: "accounts",
    sqlSnippet: "SELECT id FROM accounts WHERE id = ${ref.accountId}::uuid",
    category: 'provider-ingress',
    reason: "Stripe trial applier resolves the account by signed checkout client_reference_id (account id) before projecting Stripe subscription status. No tenant id is available except the one being resolved.",
  },
  {
    file: "worker/ingress/stripe/apply-subscription-state.ts",
    table: "accounts",
    sqlSnippet: "SELECT id FROM accounts WHERE stripe_customer_id = ${ref.stripeCustomerId} AND stripe_subscription_id = ${ref.stripeSubscriptionId}",
    category: 'provider-ingress',
    reason: "Stripe status applier resolves the account from signed provider customer and subscription identifiers without taking the account row before entitlement.",
  },
  {
    file: "worker/ingress/stripe/apply-subscription-state.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.id, a.subscription_status, a.stripe_customer_id, a.stripe_subscription_id, (SELECT b.id FROM businesses b WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL LIMIT 1) AS primary_business_id FROM accounts a WHERE a.id = ${accountId}::uuid FOR UPDATE",
    category: 'provider-ingress',
    reason: "After entitlement is held, the Stripe status applier locks only the previously resolved account and rechecks provider lineage from the locked row.",
  },
  {
    file: "worker/ingress/stripe/apply-subscription-state.ts",
    table: "businesses",
    sqlSnippet: "SELECT a.id, a.subscription_status, a.stripe_customer_id, a.stripe_subscription_id, (SELECT b.id FROM businesses b WHERE b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL LIMIT 1) AS primary_business_id FROM accounts a WHERE a.id = ${accountId}::uuid FOR UPDATE",
    category: 'provider-ingress',
    reason: "The locked account query reads only that account's primary business id for best-effort post-status backfill resume.",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "account_offboardings",
    sqlSnippet: "UPDATE account_offboardings SET zernio_accounts_step = 'success', updated_at = NOW() WHERE status = 'tearing_down' AND teardown_started_at IS NOT NULL AND teardown_completed_at IS NULL AND terminal_at IS NULL AND zernio_accounts_step <> 'success' AND cardinality(zernio_account_ids) = 1 AND ${accountId} = ANY(zernio_account_ids)",
    category: 'provider-ingress',
    reason: "Zernio webhook reconciles active owner-offboarding teardown from signed provider account identifiers before tenant ids are available.",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT id FROM account_offboardings WHERE status = 'tearing_down' AND teardown_started_at IS NOT NULL AND teardown_completed_at IS NULL AND terminal_at IS NULL AND zernio_accounts_step <> 'success' AND ${accountId} = ANY(zernio_account_ids) LIMIT 1",
    category: 'provider-ingress',
    reason: "Zernio webhook reconciles active owner-offboarding teardown from signed provider account identifiers before tenant ids are available.",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "businesses",
    sqlSnippet: "WITH account_businesses AS ( SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid ), onboarding_demo_scope AS ( SELECT od.id::text AS identifier FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id WHERE b.account_id = ${row.account_id}::uuid ), offboarding_scope AS ( SELECT id::text AS identifier FROM account_businesses UNION ALL SELECT identifier FROM onboarding_demo_scope UNION ALL SELECT ${row.account_id}::text UNION ALL SELECT ${row.id}::text UNION ALL SELECT ${row.auth_user_id ?? null}::text UNION ALL SELECT ${row.stripe_customer_id ?? null}::text UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[]) UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[]) UNION ALL SELECT auth_user_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND auth_user_id IS NOT NULL UNION ALL SELECT stripe_customer_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_customer_id IS NOT NULL UNION ALL SELECT stripe_subscription_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_subscription_id IS NOT NULL UNION ALL SELECT unnest(zernio_account_ids) FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_account_ids IS NOT NULL UNION ALL SELECT unnest(zernio_profile_ids) FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_profile_ids IS NOT NULL ) UPDATE inbound_events SET external_event_key = 'scrubbed:' || id::text, aggregate_key = NULL, payload = '{}'::jsonb, error_message = NULL WHERE EXISTS ( SELECT 1 FROM offboarding_scope s WHERE s.identifier IS NOT NULL AND length(btrim(s.identifier)) > 0 AND ( inbound_events.payload::text LIKE ('%' || s.identifier || '%') OR inbound_events.aggregate_key LIKE ('%' || s.identifier || '%') OR inbound_events.error_message LIKE ('%' || s.identifier || '%') ) )",
    category: 'worker-job-scoped',
    reason: "Owner offboarding purge uses an account-scoped deletion receipt to scrub payload-control rows whose references are stored outside tenant columns.",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "account_offboardings",
    sqlSnippet: "WITH account_businesses AS ( SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid ), onboarding_demo_scope AS ( SELECT od.id::text AS identifier FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id WHERE b.account_id = ${row.account_id}::uuid ), offboarding_scope AS ( SELECT id::text AS identifier FROM account_businesses UNION ALL SELECT identifier FROM onboarding_demo_scope UNION ALL SELECT ${row.account_id}::text UNION ALL SELECT ${row.id}::text UNION ALL SELECT ${row.auth_user_id ?? null}::text UNION ALL SELECT ${row.stripe_customer_id ?? null}::text UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[]) UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[]) UNION ALL SELECT auth_user_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND auth_user_id IS NOT NULL UNION ALL SELECT stripe_customer_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_customer_id IS NOT NULL UNION ALL SELECT stripe_subscription_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_subscription_id IS NOT NULL UNION ALL SELECT unnest(zernio_account_ids) FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_account_ids IS NOT NULL UNION ALL SELECT unnest(zernio_profile_ids) FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_profile_ids IS NOT NULL ) UPDATE inbound_events SET external_event_key = 'scrubbed:' || id::text, aggregate_key = NULL, payload = '{}'::jsonb, error_message = NULL WHERE EXISTS ( SELECT 1 FROM offboarding_scope s WHERE s.identifier IS NOT NULL AND length(btrim(s.identifier)) > 0 AND ( inbound_events.payload::text LIKE ('%' || s.identifier || '%') OR inbound_events.aggregate_key LIKE ('%' || s.identifier || '%') OR inbound_events.error_message LIKE ('%' || s.identifier || '%') ) )",
    category: 'worker-job-scoped',
    reason: "Owner offboarding purge uses an account-scoped deletion receipt to scrub payload-control rows whose references are stored outside tenant columns.",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "onboarding_demos",
    sqlSnippet: "WITH account_businesses AS ( SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid ), onboarding_demo_scope AS ( SELECT od.id::text AS identifier FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id WHERE b.account_id = ${row.account_id}::uuid ), offboarding_scope AS ( SELECT id::text AS identifier FROM account_businesses UNION ALL SELECT identifier FROM onboarding_demo_scope UNION ALL SELECT ${row.account_id}::text UNION ALL SELECT ${row.id}::text UNION ALL SELECT ${row.auth_user_id ?? null}::text UNION ALL SELECT ${row.stripe_customer_id ?? null}::text UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[]) UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[]) UNION ALL SELECT auth_user_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND auth_user_id IS NOT NULL UNION ALL SELECT stripe_customer_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_customer_id IS NOT NULL UNION ALL SELECT stripe_subscription_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_subscription_id IS NOT NULL UNION ALL SELECT unnest(zernio_account_ids) FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_account_ids IS NOT NULL UNION ALL SELECT unnest(zernio_profile_ids) FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_profile_ids IS NOT NULL ) UPDATE inbound_events SET external_event_key = 'scrubbed:' || id::text, aggregate_key = NULL, payload = '{}'::jsonb, error_message = NULL WHERE EXISTS ( SELECT 1 FROM offboarding_scope s WHERE s.identifier IS NOT NULL AND length(btrim(s.identifier)) > 0 AND ( inbound_events.payload::text LIKE ('%' || s.identifier || '%') OR inbound_events.aggregate_key LIKE ('%' || s.identifier || '%') OR inbound_events.error_message LIKE ('%' || s.identifier || '%') ) )",
    category: 'worker-job-scoped',
    reason: "Owner offboarding purge includes account-scoped onboarding demo ids before hard-deleting child demo rows so retained payload-control rows can be scrubbed.",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "businesses",
    sqlSnippet: "WITH account_businesses AS ( SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid ), onboarding_demo_scope AS ( SELECT od.id::text AS identifier FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id WHERE b.account_id = ${row.account_id}::uuid ), offboarding_scope AS ( SELECT id::text AS identifier FROM account_businesses UNION ALL SELECT identifier FROM onboarding_demo_scope UNION ALL SELECT ${row.account_id}::text UNION ALL SELECT ${row.id}::text UNION ALL SELECT ${row.auth_user_id ?? null}::text UNION ALL SELECT ${row.stripe_customer_id ?? null}::text UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[]) UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[]) ) SELECT id FROM job_outbox WHERE EXISTS ( SELECT 1 FROM offboarding_scope s WHERE s.identifier IS NOT NULL AND length(btrim(s.identifier)) > 0 AND ( job_outbox.payload::text LIKE ('%' || s.identifier || '%') OR job_outbox.aggregate_id::text = s.identifier OR job_outbox.last_error LIKE ('%' || s.identifier || '%') ) ) AND job_outbox.id <> ${currentOutboxId}::uuid",
    category: 'worker-job-scoped',
    reason: "Owner offboarding purge uses an account-scoped deletion receipt to scrub payload-control rows whose references are stored outside tenant columns.",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "onboarding_demos",
    sqlSnippet: "WITH account_businesses AS ( SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid ), onboarding_demo_scope AS ( SELECT od.id::text AS identifier FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id WHERE b.account_id = ${row.account_id}::uuid ), offboarding_scope AS ( SELECT id::text AS identifier FROM account_businesses UNION ALL SELECT identifier FROM onboarding_demo_scope UNION ALL SELECT ${row.account_id}::text UNION ALL SELECT ${row.id}::text UNION ALL SELECT ${row.auth_user_id ?? null}::text UNION ALL SELECT ${row.stripe_customer_id ?? null}::text UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[]) UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[]) ) SELECT id FROM job_outbox WHERE EXISTS ( SELECT 1 FROM offboarding_scope s WHERE s.identifier IS NOT NULL AND length(btrim(s.identifier)) > 0 AND ( job_outbox.payload::text LIKE ('%' || s.identifier || '%') OR job_outbox.aggregate_id::text = s.identifier OR job_outbox.last_error LIKE ('%' || s.identifier || '%') ) ) AND job_outbox.id <> ${currentOutboxId}::uuid",
    category: 'worker-job-scoped',
    reason: "Owner offboarding purge includes account-scoped onboarding demo ids before hard-deleting child demo rows so retained outbox rows can be scrubbed.",
  },
  {
    file: "worker/jobs/notification/context.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT b.name, b.display_label, b.owner_email_bounced, b.archived_at, a.id AS account_id, a.subscription_status, a.updated_at AS account_updated_at, a.past_due_at AS account_past_due_at, a.flags AS account_flags, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${input.businessId} ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Notification worker follows a durable job business id and joins to the active offboarding gate for that business account before dispatch.",
  },
  {
    file: "worker/jobs/auto-post-notice/context.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.id, resp.status, resp.approval_method, resp.business_id AS resp_business_id, resp.review_id, r.reviewer_name, r.star_rating, r.review_date FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.id = ${input.responseId}",
    category: 'background-global-scan',
    reason: "Auto-post FYI worker follows a durable job payload response id; tenant context fixed upstream by the publisher that enqueued the FYI.",
  },
  {
    file: "worker/jobs/auto-post-notice/context.ts",
    table: "responses",
    sqlSnippet: "SELECT resp.id, resp.status, resp.approval_method, resp.business_id AS resp_business_id, resp.review_id, r.reviewer_name, r.star_rating, r.review_date FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.id = ${input.responseId}",
    category: 'background-global-scan',
    reason: "Auto-post FYI worker follows a durable job payload response id; tenant context fixed upstream by the publisher that enqueued the FYI.",
  },
  {
    file: "worker/jobs/auto-post-notice/context.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT b.name, b.display_label, b.google_maps_url, b.archived_at, a.id AS account_id, a.subscription_status, a.past_due_at AS account_past_due_at, a.flags AS account_flags, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${input.businessId} ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Auto-post FYI worker follows a durable job business id and joins to the active offboarding gate for that business account before dispatch.",
  },
  {
    file: "worker/jobs/escalation-notice/context.ts",
    table: "review_escalations",
    sqlSnippet: "SELECT e.id, e.status, e.business_id AS esc_business_id, e.account_id, e.review_id, e.triage_severity, e.triage_source, e.triage_issues, r.reviewer_name, r.star_rating, r.review_text FROM review_escalations e JOIN reviews r ON r.id = e.review_id WHERE e.id = ${input.escalationId}",
    category: 'worker-job-scoped',
    reason: "Escalation-notice worker follows a durable job payload escalation id; tenant context fixed upstream by raiseEscalation, and the loader fails on a business_id mismatch before any send.",
  },
  {
    file: "worker/jobs/escalation-notice/context.ts",
    table: "reviews",
    sqlSnippet: "SELECT e.id, e.status, e.business_id AS esc_business_id, e.account_id, e.review_id, e.triage_severity, e.triage_source, e.triage_issues, r.reviewer_name, r.star_rating, r.review_text FROM review_escalations e JOIN reviews r ON r.id = e.review_id WHERE e.id = ${input.escalationId}",
    category: 'worker-job-scoped',
    reason: "Escalation-notice worker follows a durable job payload escalation id; tenant context fixed upstream by raiseEscalation, and the loader fails on a business_id mismatch before any send.",
  },
  {
    file: "worker/jobs/escalation-notice/context.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT b.name, b.display_label, b.owner_email_bounced, b.archived_at, a.id AS account_id, a.subscription_status, a.past_due_at AS account_past_due_at, a.flags AS account_flags, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${input.businessId} ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Escalation-notice worker follows a durable job business id and joins to the active offboarding gate for that business account before dispatch.",
  },
  {
    file: "worker/jobs/pending-post-notice/context.ts",
    table: "responses",
    sqlSnippet: "SELECT resp.id, resp.status, resp.approval_method, resp.business_id AS resp_business_id, resp.review_id, resp.approved_text, resp.auto_post_scheduled_at, (resp.auto_post_scheduled_at <= NOW()) AS deadline_passed, r.reviewer_name, r.star_rating, r.review_text FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.id = ${input.responseId}",
    category: 'worker-job-scoped',
    reason: "Pending-post-notice worker follows a durable job payload response id; tenant context fixed upstream by the auto-approval persist tx, and the loader fails on a business_id mismatch before any send.",
  },
  {
    file: "worker/jobs/pending-post-notice/context.ts",
    table: "reviews",
    sqlSnippet: "SELECT resp.id, resp.status, resp.approval_method, resp.business_id AS resp_business_id, resp.review_id, resp.approved_text, resp.auto_post_scheduled_at, (resp.auto_post_scheduled_at <= NOW()) AS deadline_passed, r.reviewer_name, r.star_rating, r.review_text FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.id = ${input.responseId}",
    category: 'worker-job-scoped',
    reason: "Pending-post-notice worker follows a durable job payload response id; tenant context fixed upstream by the auto-approval persist tx, and the loader fails on a business_id mismatch before any send.",
  },
  {
    file: "worker/jobs/pending-post-notice/context.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT b.name, b.display_label, b.owner_email_bounced, b.archived_at, a.id AS account_id, a.subscription_status, a.past_due_at AS account_past_due_at, a.flags AS account_flags, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${input.businessId} ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Pending-post-notice worker follows a durable job business id and joins to the active offboarding gate for that business account before dispatch.",
  },
  {
    file: "worker/jobs/escalation-notice/EscalationNoticeWorker.ts",
    table: "reviews",
    sqlSnippet: "SELECT id FROM reviews WHERE id = ${ctx.escalation.review_id} FOR UPDATE",
    category: 'worker-job-scoped',
    reason: "Lock-ordering statement (review row FOR UPDATE first, then the spine write); scope established by the context loader's business_id-mismatch guard on the same escalation in the same handler.",
  },
  {
    file: "src/lib/notifications/delivery.ts",
    table: "notification_deliveries",
    sqlSnippet: "UPDATE notification_deliveries SET external_message_id = ${externalMessageId}, sent_at = NOW() WHERE id = ${deliveryId}",
    category: 'worker-job-scoped',
    reason: "Finalizes the FYI claim row claimAutoPostNoticeDelivery INSERTed (account_id + business_id set on the claim); by-id update of a row owned by the auto_post_notice job.",
  },
  {
    file: "src/lib/notifications/delivery.ts",
    table: "notification_deliveries",
    sqlSnippet: "UPDATE notification_deliveries SET failed_at = NOW(), failure_reason = ${failureReason} WHERE id = ${deliveryId}",
    category: 'worker-job-scoped',
    reason: "Marks the FYI claim row claimAutoPostNoticeDelivery INSERTed as a terminal failed delivery; by-id update of a row owned by the auto_post_notice job.",
  },
  {
    file: "src/lib/notifications/delivery.ts",
    table: "notification_deliveries",
    sqlSnippet: "DELETE FROM notification_deliveries WHERE id = ${deliveryId} AND external_message_id IS NULL AND failed_at IS NULL",
    category: 'worker-job-scoped',
    reason: "Releases the FYI claim row claimAutoPostNoticeDelivery INSERTed on a retryable send failure; by-id delete of an un-finalized row owned by the auto_post_notice job.",
  },
  {
    file: "src/app/r/google/[responseId]/route.ts",
    table: "responses",
    sqlSnippet: "SELECT b.google_maps_url FROM responses resp JOIN businesses b ON b.id = resp.business_id WHERE resp.id = ${responseId} AND resp.status = 'posted' LIMIT 1",
    category: 'pre-auth-token',
    reason: "Public 'View on Google' redirect resolves a posted response by opaque id from the URL before any tenant scope is knowable; requires the response<->business join + status='posted', then redirects only to an allowlisted Google host.",
  },
  {
    file: "src/app/r/google/[responseId]/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.google_maps_url FROM responses resp JOIN businesses b ON b.id = resp.business_id WHERE resp.id = ${responseId} AND resp.status = 'posted' LIMIT 1",
    category: 'pre-auth-token',
    reason: "Public 'View on Google' redirect resolves a posted response by opaque id from the URL before any tenant scope is knowable; requires the response<->business join + status='posted', then redirects only to an allowlisted Google host.",
  },
  {
    file: "worker/ingress/conversational-seam.ts",
    table: "channel_enrollments",
    sqlSnippet: "SELECT a.subscription_status, a.past_due_at, a.flags FROM channel_enrollments ce JOIN accounts a ON a.id = ce.account_id WHERE ce.channel = ${channel} AND ce.handle = ${senderHandle} AND ce.status = 'verified' AND ce.archived_at IS NULL LIMIT 1",
    category: 'provider-ingress',
    reason: "Conversational-seam auth boundary resolves the sender's verified enrollment from the provider sender id (chat_id / phone) before tenant scope is knowable — same provider-identifier resolution as other webhook ingress.",
  },
  {
    file: "worker/ingress/conversational-seam.ts",
    table: "accounts",
    sqlSnippet: "SELECT a.subscription_status, a.past_due_at, a.flags FROM channel_enrollments ce JOIN accounts a ON a.id = ce.account_id WHERE ce.channel = ${channel} AND ce.handle = ${senderHandle} AND ce.status = 'verified' AND ce.archived_at IS NULL LIMIT 1",
    category: 'provider-ingress',
    reason: "Conversational-seam auth boundary resolves the sender's verified enrollment from the provider sender id (chat_id / phone) before tenant scope is knowable — same provider-identifier resolution as other webhook ingress.",
  },
  {
    file: "worker/jobs/publisher/load-context.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT b.id, b.account_id, b.name, b.archived_at, a.subscription_status, a.subscription_tier, a.updated_at AS account_updated_at, a.past_due_at AS account_past_due_at, a.flags AS account_flags, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${businessId} ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Publisher worker follows a durable job business id and joins to the active offboarding gate for that business account before publishing.",
  },
  {
    file: "worker/jobs/response-generation/load-context.ts",
    table: "account_offboardings",
    sqlSnippet: "SELECT b.id, b.account_id, b.name, b.category, b.tone, b.products_services, b.staff_names, b.highlight_facts, b.avoid_facts, b.sample_responses, b.archived_at, a.subscription_status, a.subscription_tier, a.past_due_at AS account_past_due_at, a.flags AS account_flags, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM businesses b JOIN accounts a ON a.id = b.account_id LEFT JOIN account_offboardings ao ON ao.account_id = a.id AND ao.terminal_at IS NULL WHERE b.id = ${businessId} ORDER BY ao.created_at DESC NULLS LAST LIMIT 1",
    category: 'worker-job-scoped',
    reason: "Response-generation worker follows a durable job business id and joins to the active offboarding gate for that business account before drafting.",
  },

  // ── deep-scan §4.1 — RLS on inbound_events / prospect_demos / google_connections ──
  // Migration 066 enables deny-all RLS on these three pre-existing tables and
  // adds them to TENANT_TABLES so ci:rls-audit guards them. None carry an
  // account/business column, so every read/mutation below is exempt for a
  // STRUCTURAL reason (provider event id, opaque demo slug, global retention,
  // admin role, or an offboarding job whose account scope is applied via an
  // account_id-derived subquery the audit cannot see through). Server reaches
  // all of them via the RLS-bypassing Postgres.js `postgres` role.
  // google_connections has no direct SQL touchpoint (all access flows through
  // identifier-interpolating purge helpers), so it needs no entry here.
  {
    file: "src/app/(public)/demo/[slug]/page.tsx",
    table: "prospect_demos",
    sqlSnippet: "SELECT id, business_name, generation_status, generation_error, reviews_snapshot, generated_responses, view_count, expires_at FROM prospect_demos WHERE demo_url_slug = ${slug}",
    category: 'pre-auth-token',
    reason: "Public demo viewer: the opaque demo_url_slug must resolve the prospect_demos row before any tenant scope is knowable. prospect_demos is not account/business-scoped (deny-all RLS, migration 066).",
  },
  {
    file: "src/app/(public)/demo/[slug]/page.tsx",
    table: "prospect_demos",
    sqlSnippet: "UPDATE prospect_demos SET view_count = view_count + 1, last_viewed_at = NOW() WHERE id = ${demo.id}",
    category: 'pre-auth-token',
    reason: "Public demo viewer: the view-count bump targets the prospect_demos id just resolved from the opaque slug in the same request; this table has no tenant column (deny-all RLS, migration 066).",
  },
  {
    file: "src/lib/admin/demos-service.ts",
    table: "prospect_demos",
    sqlSnippet: "SELECT id, demo_url_slug, business_name, generation_status, generation_error, view_count, generated_at, expires_at FROM prospect_demos ORDER BY generated_at DESC",
    category: 'admin-after-require-role',
    reason: "Admin-only sales-demo list performed after requireRole(admin); prospect_demos is a cross-tenant sales surface with no account/business column (deny-all RLS, migration 066).",
  },
  {
    file: "worker/background/pollers/ArchivalPoller.ts",
    table: "inbound_events",
    sqlSnippet: "WITH candidates AS ( SELECT id FROM inbound_events WHERE status = 'processed' AND processed_at < NOW() - INTERVAL '30 days' LIMIT 5000 ), deleted AS ( DELETE FROM inbound_events WHERE id IN (SELECT id FROM candidates) RETURNING id ) SELECT COUNT(*)::text AS count FROM deleted",
    category: 'background-global-scan',
    reason: "Global retention poller deletes processed webhook rows independent of tenant request scope; inbound_events has no account/business column (deny-all RLS, migration 066).",
  },
  {
    file: "worker/background/pollers/ArchivalPoller.ts",
    table: "prospect_demos",
    sqlSnippet: "WITH candidates AS ( SELECT id FROM prospect_demos WHERE expires_at < NOW() - INTERVAL '30 days' AND generation_status = 'completed' LIMIT 5000 ), deleted AS ( DELETE FROM prospect_demos WHERE id IN (SELECT id FROM candidates) RETURNING id ) SELECT COUNT(*)::text AS count FROM deleted",
    category: 'background-global-scan',
    reason: "Global retention poller deletes expired sales demos independent of tenant request scope; prospect_demos has no account/business column (deny-all RLS, migration 066).",
  },
  {
    file: "worker/background/pollers/CleanupAbandonedSignupsPoller.ts",
    table: "prospect_demos",
    sqlSnippet: "SELECT EXISTS (SELECT 1 FROM businesses WHERE onboarded_by = ${candidate.user_id}::uuid) AS has_onboarded, EXISTS (SELECT 1 FROM prospect_demos WHERE created_by = ${candidate.user_id}::uuid) AS has_prospect_demos",
    category: 'background-global-scan',
    reason: "Abandoned-signup cleanup defensively checks whether the user being deleted authored any prospect_demos before deletion; global lifecycle scan, prospect_demos has no account/business column (deny-all RLS, migration 066).",
  },
  {
    file: "worker/ingress/resend.ts",
    table: "inbound_events",
    sqlSnippet: "SELECT status FROM inbound_events WHERE external_event_key = ${svixId} LIMIT 1",
    category: 'provider-ingress',
    reason: "Webhook ingress reads the dedup row by provider event id (external_event_key) before tenant scope is available; inbound_events holds raw provider payloads (deny-all RLS, migration 066).",
  },
  {
    file: "worker/ingress/shared.ts",
    table: "inbound_events",
    sqlSnippet: "UPDATE inbound_events SET received_at = NOW(), status = 'received', error_message = NULL WHERE external_event_key = ${dedupKey} AND (status = 'failed' OR (status = 'received' AND received_at < NOW() - make_interval(mins => ${RECLAIM_AFTER_MINUTES}))) RETURNING id",
    category: 'provider-ingress',
    reason: "Webhook ingress claims/reclaims the dedup row by provider event id (external_event_key) before tenant scope is available; inbound_events holds raw provider payloads (deny-all RLS, migration 066).",
  },
  {
    file: "worker/ingress/shared.ts",
    table: "inbound_events",
    sqlSnippet: "UPDATE inbound_events SET status = 'processed', processed_at = NOW() WHERE external_event_key = ${dedupKey}",
    category: 'provider-ingress',
    reason: "Webhook ingress marks the dedup row processed by provider event id (external_event_key); inbound_events holds raw provider payloads, not a tenant id (deny-all RLS, migration 066).",
  },
  {
    file: "worker/ingress/shared.ts",
    table: "inbound_events",
    sqlSnippet: "UPDATE inbound_events SET status = 'failed', error_message = ${reason} WHERE external_event_key = ${dedupKey}",
    category: 'provider-ingress',
    reason: "Webhook ingress marks the dedup row failed by provider event id (external_event_key); inbound_events holds raw provider payloads, not a tenant id (deny-all RLS, migration 066).",
  },
  {
    file: "worker/ingress/stripe.ts",
    table: "inbound_events",
    sqlSnippet: "UPDATE inbound_events SET status = 'processed', processed_at = NOW() WHERE external_event_key = ${event.id}",
    category: 'provider-ingress',
    reason: "Stripe ingress marks the dedup row processed by Stripe event id (external_event_key); inbound_events holds raw provider payloads, not a tenant id (deny-all RLS, migration 066).",
  },
  {
    file: "worker/ingress/stripe.ts",
    table: "inbound_events",
    sqlSnippet: "UPDATE inbound_events SET status = 'failed', error_message = ${message} WHERE external_event_key = ${event.id}",
    category: 'provider-ingress',
    reason: "Stripe ingress marks the dedup row failed by Stripe event id (external_event_key); inbound_events holds raw provider payloads, not a tenant id (deny-all RLS, migration 066).",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "inbound_events",
    sqlSnippet: "UPDATE inbound_events SET status = 'processed', processed_at = NOW() WHERE external_event_key = ${eventId} AND source = 'zernio'",
    category: 'provider-ingress',
    reason: "Zernio ingress marks the dedup row processed by provider event id (external_event_key); inbound_events holds raw provider payloads, not a tenant id (deny-all RLS, migration 066).",
  },
  {
    file: "worker/ingress/zernio/zernio.ts",
    table: "inbound_events",
    sqlSnippet: "UPDATE inbound_events SET status = 'failed', error_message = ${message} WHERE external_event_key = ${eventId} AND source = 'zernio'",
    category: 'provider-ingress',
    reason: "Zernio ingress marks the dedup row failed by provider event id (external_event_key); inbound_events holds raw provider payloads, not a tenant id (deny-all RLS, migration 066).",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "prospect_demos",
    sqlSnippet: "DELETE FROM prospect_demos WHERE created_by IN ( SELECT id FROM users WHERE account_id = ${row.account_id}::uuid )",
    category: 'worker-job-scoped',
    reason: "Owner-offboarding purge worker following a durable job: the DELETE IS account-scoped via the users.account_id subquery, but the audit strips subqueries; prospect_demos has no direct account column (deny-all RLS, migration 066).",
  },
  {
    file: "worker/jobs/account-offboarding/purge-stages.ts",
    table: "inbound_events",
    sqlSnippet: "WITH account_businesses AS ( SELECT b.id::text AS id FROM businesses b WHERE b.account_id = ${row.account_id}::uuid ), onboarding_demo_scope AS ( SELECT od.id::text AS identifier FROM onboarding_demos od JOIN businesses b ON b.id = od.business_id WHERE b.account_id = ${row.account_id}::uuid ), offboarding_scope AS ( SELECT id::text AS identifier FROM account_businesses UNION ALL SELECT identifier FROM onboarding_demo_scope UNION ALL SELECT ${row.account_id}::text UNION ALL SELECT ${row.id}::text UNION ALL SELECT ${row.auth_user_id ?? null}::text UNION ALL SELECT ${row.stripe_customer_id ?? null}::text UNION ALL SELECT ${row.stripe_subscription_id ?? null}::text UNION ALL SELECT UNNEST(${row.zernio_account_ids ?? []}::text[]) UNION ALL SELECT UNNEST(${row.zernio_profile_ids ?? []}::text[]) UNION ALL SELECT auth_user_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND auth_user_id IS NOT NULL UNION ALL SELECT stripe_customer_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_customer_id IS NOT NULL UNION ALL SELECT stripe_subscription_id FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND stripe_subscription_id IS NOT NULL UNION ALL SELECT unnest(zernio_account_ids) FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_account_ids IS NOT NULL UNION ALL SELECT unnest(zernio_profile_ids) FROM account_offboardings WHERE id = ${row.id}::uuid AND account_id = ${row.account_id}::uuid AND zernio_profile_ids IS NOT NULL ) UPDATE inbound_events SET external_event_key = 'scrubbed:' || id::text, aggregate_key = NULL, payload = '{}'::jsonb, error_message = NULL WHERE EXISTS ( SELECT 1 FROM offboarding_scope s WHERE s.identifier IS NOT NULL AND length(btrim(s.identifier)) > 0 AND ( inbound_events.payload::text LIKE ('%' || s.identifier || '%') OR inbound_events.aggregate_key LIKE ('%' || s.identifier || '%') OR inbound_events.error_message LIKE ('%' || s.identifier || '%') ) )",
    category: 'worker-job-scoped',
    reason: "Owner-offboarding purge worker following a durable job: scrubs raw webhook payloads matching this account's identifier set (every identifier derived from account_id). inbound_events has no direct account column (deny-all RLS, migration 066).",
  },
  {
    file: "worker/background/pollers/billing-reconciliation/reconcile-account.ts",
    table: "accounts",
    sqlSnippet: "SELECT stripe_subscription_id FROM accounts WHERE stripe_customer_id = ${stripeCustomerId} AND id <> ${account.id}::uuid AND stripe_subscription_id = ANY(${activeIds}::text[])",
    category: 'background-global-scan',
    reason: "RECONCILE-F6: billing reconciliation poller scans OTHER accounts sharing the same Stripe customer id to exclude their subscriptions from the duplicate-subscription alert for this account. Intentionally cross-account: the query filters by stripe_customer_id (not account_id) to identify sibling accounts — a legitimate cross-account lookup for an observability-only check with no write side-effects.",
  },
  {
    file: "src/lib/responses/judge-store.ts",
    table: "agent_runs",
    sqlSnippet: "SELECT id FROM agent_runs WHERE kind = 'review_handler' AND subject_type = 'review' AND subject_id = ${reviewId} ORDER BY started_at DESC LIMIT 1",
    category: 'worker-job-scoped',
    reason: "JudgeWorker resolves the latest review-subject run only after its durable response payload is loaded and the review lane is anchored; any run status is eligible for the post-hoc verdict link.",
  },
  {
    file: "src/lib/responses/judge-store.ts",
    table: "judge_verdicts",
    sqlSnippet: JUDGE_SWEEP_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "JudgeSweepPoller uses a bounded global anti-join against verdicts to find only auto-posted responses that have not already been judged.",
  },
  {
    file: "src/lib/responses/judge-store.ts",
    table: "responses",
    sqlSnippet: JUDGE_SWEEP_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "JudgeSweepPoller intentionally scans the bounded 24-hour posted-auto-policy population before enqueueing tenant-scoped judge work.",
  },
  {
    file: "src/lib/responses/judge-store.ts",
    table: "businesses",
    sqlSnippet: JUDGE_SWEEP_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "JudgeSweepPoller joins each candidate to its billing parent while performing the bounded cross-tenant eligibility scan.",
  },
  {
    file: "src/lib/responses/judge-store.ts",
    table: "accounts",
    sqlSnippet: JUDGE_SWEEP_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "JudgeSweepPoller filters the bounded global candidate scan to canonical full-access subscription statuses before enqueueing work.",
  },
  {
    file: "src/lib/responses/judge-health.ts",
    table: "responses",
    sqlSnippet: JUDGE_HEALTH_STALENESS_SQL,
    category: 'background-global-scan',
    reason: "The publisher safety gate scans only the indexed, bounded 24-hour auto-policy population for stale unjudged replies before allowing any external post.",
  },
  {
    file: "src/lib/responses/judge-health.ts",
    table: "businesses",
    sqlSnippet: JUDGE_HEALTH_STALENESS_SQL,
    category: 'background-global-scan',
    reason: "The bounded Judge-health staleness scan joins response locations to their billing parents solely to apply canonical subscription eligibility.",
  },
  {
    file: "src/lib/responses/judge-health.ts",
    table: "accounts",
    sqlSnippet: JUDGE_HEALTH_STALENESS_SQL,
    category: 'background-global-scan',
    reason: "The bounded Judge-health staleness scan excludes ineligible subscriptions so cancelled accounts cannot pause fleet-wide auto-posting.",
  },
  {
    file: "src/lib/responses/judge-health.ts",
    table: "judge_verdicts",
    sqlSnippet: JUDGE_HEALTH_STALENESS_SQL,
    category: 'background-global-scan',
    reason: "The publisher safety gate uses a bounded verdict anti-join; any verdict, including error, counts as judged for staleness.",
  },
  {
    file: "src/lib/responses/judge-health.ts",
    table: "judge_verdicts",
    sqlSnippet: JUDGE_HEALTH_ERROR_DENSITY_SQL,
    category: 'background-global-scan',
    reason: "The publisher safety gate computes fleet-wide error density only over the indexed last-60-minute verdict window.",
  },
  {
    file: "src/lib/auto-approval/governor.ts",
    table: "auto_approval_policies",
    sqlSnippet: GOVERNOR_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "AutonomyGovernorScheduler performs one bounded cross-account scan for armed accounts whose account-default policy is not already suspended before evaluating tenant-scoped rates.",
  },
  {
    file: "src/lib/auto-approval/governor.ts",
    table: "account_audit_log",
    sqlSnippet: GOVERNOR_CANDIDATES_SQL,
    category: 'background-global-scan',
    reason: "The bounded governor scan joins autonomy_unsuspended audit events only to cap each account's rolling window and prevent immediate stale-data re-suspension.",
  },
  {
    file: "src/lib/auto-approval/governor.ts",
    table: "agent_outcomes",
    sqlSnippet: GOVERNOR_BATCH_OUTCOMES_SQL,
    category: 'admin-after-require-role',
    reason: "The Task 10 admin+AAL2 recovery list is the cross-account caller and passes at most 100 preselected windows; the scheduler calls this seam with one tenant-scoped account and needs no exemption.",
  },
  {
    file: "src/lib/auto-approval/governor.ts",
    table: "judge_verdicts",
    sqlSnippet: GOVERNOR_BATCH_VERDICTS_SQL,
    category: 'admin-after-require-role',
    reason: "The Task 10 admin+AAL2 recovery list is the cross-account caller and passes at most 100 preselected windows; ordinary governor calls supply one scheduler-selected account and remain tenant-scoped.",
  },
  {
    file: "src/lib/auto-approval/suspension.ts",
    table: "auto_approval_policies",
    sqlSnippet: SUSPENDED_POLICIES_SQL,
    category: 'admin-after-require-role',
    reason: "The admin+AAL2 autonomy recovery route requests a bounded cross-account list of only currently suspended policy rows.",
  },
  {
    file: "src/lib/auto-approval/suspension.ts",
    table: "accounts",
    sqlSnippet: SUSPENDED_POLICIES_SQL,
    category: 'admin-after-require-role',
    reason: "The admin+AAL2 recovery list joins billing-parent display names for operator identification; the result remains bounded to 100 suspended policies.",
  },
  {
    file: "src/lib/auto-approval/suspension.ts",
    table: "businesses",
    sqlSnippet: SUSPENDED_POLICIES_SQL,
    category: 'admin-after-require-role',
    reason: "The admin+AAL2 recovery list joins location display information for suspended location-scoped policies only.",
  },
  {
    file: "src/lib/auto-approval/suspension.ts",
    table: "account_audit_log",
    sqlSnippet: SUSPENDED_POLICIES_SQL,
    category: 'admin-after-require-role',
    reason: "The bounded admin recovery list joins autonomy audit rows only to compute the stale-data-safe governor window (unsuspended) and to surface the machine-readable trigger of the latest suspension (suspended payload).",
  },
  {
    file: "src/lib/auto-approval/suspension.ts",
    table: "judge_verdicts",
    sqlSnippet: SUSPENSION_FLAG_EVIDENCE_SQL,
    category: 'admin-after-require-role',
    reason: "The admin+AAL2 recovery list reads at most five indexed flag verdicts per account selected by the bounded suspended-policy query.",
  },
  {
    file: "src/lib/auto-approval/suspension.ts",
    table: "auto_approval_policies",
    sqlSnippet: "WITH target AS ( SELECT id, suspended_reason, auto_approve_min_star FROM auto_approval_policies WHERE account_id = ${input.accountId}::uuid AND location_id IS NULL AND persona = 'reply' AND action_class = 'posting' AND suspended_at IS NOT NULL FOR UPDATE ), updated AS ( UPDATE auto_approval_policies AS policy SET suspended_at = NULL, suspended_reason = NULL, updated_at = NOW() FROM target WHERE policy.id = target.id RETURNING target.suspended_reason AS previous_reason, target.auto_approve_min_star ) SELECT previous_reason, auto_approve_min_star FROM updated",
    category: 'tenant-root-lookup',
    reason: "Suspension domain callers supply one already-resolved accountId; the unsuspend CTE is directly account-scoped, but the auditor cannot propagate that scope through the UPDATE FROM target alias used to preserve the prior audit reason atomically.",
  },
  {
    file: "src/lib/agents/read.ts",
    table: "agent_run_steps",
    sqlSnippet: "SELECT s.agent_run_id, s.step_index, s.step_key, s.attributed_agent, s.status, s.detail, s.latency_ms, s.created_at FROM agent_run_steps s JOIN agent_runs ar ON ar.id = s.agent_run_id WHERE s.agent_run_id = ANY(${runIds}::uuid[]) AND ar.account_id = ${params.accountId} ORDER BY s.agent_run_id, s.step_index",
    category: 'tenant-root-lookup',
    reason: "Owner timeline read is scoped inline through the joined parent run (ar.account_id = params.accountId) and the run ids come from the preceding account-scoped bounded run query; agent_run_steps has no account_id column, and the audit evaluates its table scope independently of the parent alias.",
  },
  {
    file: "src/lib/agents/run-spine.ts",
    table: "agent_runs",
    sqlSnippet: "SELECT id FROM agent_runs WHERE kind = ${input.kind} AND subject_type = ${input.subjectType} AND subject_id = ${input.subjectId} AND status = 'running' FOR UPDATE",
    category: 'worker-job-scoped',
    reason: "Run-spine writers execute inside ingest/persist/publish transactions that already carry businessId from source connection resolution; runs are keyed by id/subject within that scoped tx (migration 071).",
  },
  {
    file: "src/lib/agents/run-spine.ts",
    table: "agent_runs",
    sqlSnippet: "SELECT id, account_id FROM agent_runs WHERE kind = 'review_handler' AND subject_type = 'review' AND subject_id = ${reviewId} AND status = 'running'",
    category: 'worker-job-scoped',
    reason: "Run-spine writers execute inside ingest/persist/publish transactions that already carry businessId from source connection resolution; runs are keyed by id/subject within that scoped tx (migration 071).",
  },
  {
    file: "src/lib/agents/run-spine.ts",
    table: "agent_runs",
    sqlSnippet: "SELECT 1 AS ok FROM agent_runs WHERE id = ${input.runId} FOR UPDATE",
    category: 'worker-job-scoped',
    reason: "Run-spine writers execute inside ingest/persist/publish transactions that already carry businessId from source connection resolution; runs are keyed by id/subject within that scoped tx (migration 071).",
  },
  {
    file: "src/lib/agents/run-spine.ts",
    table: "agent_run_steps",
    sqlSnippet: "SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index FROM agent_run_steps WHERE agent_run_id = ${input.runId}",
    category: 'worker-job-scoped',
    reason: "Run-spine writers execute inside ingest/persist/publish transactions that already carry businessId from source connection resolution; runs are keyed by id/subject within that scoped tx (migration 071).",
  },
  {
    file: "src/lib/agents/run-spine.ts",
    table: "agent_runs",
    sqlSnippet: "UPDATE agent_runs SET status = ${status}, ended_at = NOW(), error = ${error ? tx.json(error as never) : null} WHERE id = ${runId} AND status = 'running' RETURNING id",
    category: 'worker-job-scoped',
    reason: "Run-spine writers execute inside ingest/persist/publish transactions that already carry businessId from source connection resolution; runs are keyed by id/subject within that scoped tx (migration 071).",
  },
  {
    file: "src/lib/agents/run-spine.ts",
    table: "agent_runs",
    sqlSnippet: "SELECT status FROM agent_runs WHERE id = ${runId}",
    category: 'worker-job-scoped',
    reason: "Run-spine writers execute inside ingest/persist/publish transactions that already carry businessId from source connection resolution; runs are keyed by id/subject within that scoped tx (migration 071).",
  },
  {
    file: "src/lib/solicitation/suppression.ts",
    table: "solicitation_suppressions",
    sqlSnippet: "SELECT s.scope, s.source, s.suppressed_at FROM solicitation_suppressions s WHERE s.channel = ${channel} AND s.normalized_handle = ${handleColumn} AND ( s.scope = 'global' OR (s.scope = 'account' AND s.account_id = ${accountId}::uuid) ) ORDER BY (s.scope = 'global') DESC, s.suppressed_at ASC LIMIT 1",
    category: 'tenant-root-lookup',
    reason: "suppressionMatchSql is the single owner of the Suppression ledger's §1.2 lookup and takes accountId as a required parameter — the caller has already established owner scope, and that id IS the tenant boundary for the `account` arm. The `global` arm is deliberately unscoped and cannot be account-filtered: a global row records what the RECIPIENT (or the mail ecosystem on their behalf) revoked against the one shared sender identity, so it must match for every tenant. Scoping it would silently resume sending to someone who opted out. Read-only, returns only scope + source + suppressed_at — never the account_id provenance §7.4 forbids surfacing (#645 T3 added scope, which is what lets an owner surface tell their own reversible row from a global one).",
  },
  {
    file: "src/lib/solicitation/unsubscribe.ts",
    table: "solicitation_unsubscribe_tokens",
    sqlSnippet: "SELECT b.name AS business_name FROM solicitation_unsubscribe_tokens t LEFT JOIN businesses b ON b.id = t.business_id AND b.account_id = t.account_id WHERE t.token_hash = ${hashUnsubscribeToken(rawToken)} AND t.redeemed_at IS NULL",
    category: 'pre-auth-token',
    reason: "Unsubscribe landing-page read (#644 §5.3). The opaque token IS the only credential a recipient has — there is no session, no login and no account to scope by until this row resolves, which is exactly what §5.4 requires (unknown, malformed and already-redeemed must be indistinguishable). Gated first by isWellFormedUnsubscribeToken, so a forged string never reaches this statement.",
  },
  {
    file: "src/lib/solicitation/unsubscribe.ts",
    table: "businesses",
    sqlSnippet: "SELECT b.name AS business_name FROM solicitation_unsubscribe_tokens t LEFT JOIN businesses b ON b.id = t.business_id AND b.account_id = t.account_id WHERE t.token_hash = ${hashUnsubscribeToken(rawToken)} AND t.redeemed_at IS NULL",
    category: 'pre-auth-token',
    reason: "Same pre-auth token lookup; the businesses join is the cross-account FAIL-CLOSED guard rather than an unscoped read — the name resolves only when businesses.account_id equals the token's own account_id, so a token can never name another tenant's business (§5.5 permits naming exactly one, the sender).",
  },
  {
    file: "src/lib/solicitation/unsubscribe.ts",
    table: "solicitation_unsubscribe_tokens",
    sqlSnippet: "UPDATE solicitation_unsubscribe_tokens SET redeemed_at = NOW() WHERE token_hash = ${tokenHash} AND redeemed_at IS NULL RETURNING account_id, normalized_handle, channel",
    category: 'pre-auth-token',
    reason: "The redemption claim (#644 §1.3). Keyed on the unique token_hash, which is the credential; the account_id it would be scoped by is what this statement RETURNS, and after an offboarding purge that column is NULL by design — scoping on it would make a purged account's token unredeemable, breaking a statutory opt-out.",
  },
  {
    file: "src/lib/solicitation/unsubscribe.ts",
    table: "solicitation_unsubscribe_tokens",
    sqlSnippet: "SELECT redeemed_at, normalized_handle, channel FROM solicitation_unsubscribe_tokens WHERE token_hash = ${tokenHash}",
    category: 'pre-auth-token',
    reason: "loadTokenTarget — the single owner of the token→redemption-target read, shared by the claim's disambiguating branch (#644 §1.3) and the §1.8 render-time check. Same token credential, same absent tenant context, and it reads no provenance: only redeemed_at plus the handle/channel the ledger check needs.",
  },
  {
    file: "src/lib/solicitation/unsubscribe.ts",
    table: "solicitation_suppressions",
    sqlSnippet: "SELECT EXISTS ( SELECT 1 FROM solicitation_suppressions WHERE channel = ${target.channel} AND normalized_handle = ${target.normalizedHandle} AND scope = 'global' ) AS suppressed",
    category: 'pre-auth-token',
    reason: "hasLiveGlobalSuppression — the single owner of \"does the recipient's own global opt-out stand?\", shared by the spent branch and the §1.8 render-time check so the two can never disagree. Cross-tenant BY DESIGN and narrower than suppressionMatchSql on purpose: scope='global' rows key on (channel, normalized_handle) across every tenant, so an account filter would be meaningless, and the account-scoped arm is deliberately excluded because an owner's do-not-contact would satisfy that fragment while falsifying the §5.5 sentence. Read-only existence check, returns one boolean and no provenance.",
  },
  {
    file: "src/lib/admin/suppressions-service.ts",
    table: "solicitation_suppressions",
    sqlSnippet: ADMIN_SUPPRESSION_LOOKUP_SQL,
    category: 'admin-after-require-role',
    reason: "#645 §7.3/§8.2 admin suppression servicing — cross-tenant by design behind requireAdminWithAal2; a handle-keyed compliance record has no tenant to scope to.",
  },
  {
    file: "src/lib/admin/suppressions-service.ts",
    table: "accounts",
    sqlSnippet: ADMIN_SUPPRESSION_LOOKUP_SQL,
    category: 'admin-after-require-role',
    reason: "#645 §7.3/§8.2 admin suppression servicing — cross-tenant by design behind requireAdminWithAal2; a handle-keyed compliance record has no tenant to scope to.",
  },
  {
    file: "src/lib/admin/suppressions-service.ts",
    table: "solicitation_suppression_corrections",
    sqlSnippet: "SELECT id, suppression_id, scope, source, removed_by_user_id, reason, created_at::text FROM solicitation_suppression_corrections WHERE channel = 'email' AND normalized_handle = ${handle} ORDER BY created_at DESC LIMIT 20",
    category: 'admin-after-require-role',
    reason: "#645 §7.3 admin suppression servicing — the prior-corrections leg of the lookup, cross-tenant by design behind requireAdminWithAal2 and keyed on the Normalized handle, which is the only identifier a correction record shares with anything. Scoping it by account_id would hide exactly the records the servicing view exists to show: a `global` correction carries account_id only as provenance and may carry none at all. Read-only, and it returns no account_id.",
  },
  // #645 §8.2 Correction path. ONE data-modifying CTE (P-9) that both removes
  // the ledger row and writes its audit record, carrying the removed row's
  // account_id, created_by_user_id and note through to it (D-A11). Inline: the
  // audit attributes the statement to solicitation_suppressions only, so this
  // is its single entry — a hoisted constant here would imply a second one.
  {
    file: "src/lib/admin/suppressions-service.ts",
    table: "solicitation_suppressions",
    sqlSnippet: "WITH removed AS ( DELETE FROM solicitation_suppressions WHERE id = ${input.suppressionId}::uuid RETURNING id, channel, normalized_handle, scope, account_id, source, suppressed_at, created_by_user_id, note ) INSERT INTO solicitation_suppression_corrections (id, suppression_id, channel, normalized_handle, scope, account_id, source, suppressed_at, created_by_user_id, note, removed_by_user_id, reason) SELECT ${uuidv7()}, removed.id, removed.channel, removed.normalized_handle, removed.scope, removed.account_id, removed.source, removed.suppressed_at, removed.created_by_user_id, removed.note, ${input.adminUserId}::uuid, ${input.reason} FROM removed RETURNING suppression_id",
    category: 'admin-after-require-role',
    reason: "#645 §7.3/§8.2 admin suppression servicing — cross-tenant by design behind requireAdminWithAal2; a handle-keyed compliance record has no tenant to scope to.",
  },
];
