export const ACCOUNT_OFFBOARDING_DISPOSITIONS = [
  'hard_delete',
  'scrub_in_place',
  'retain_deidentified',
  'retain_compliance_limited_pii',
  'not_applicable',
] as const;

export type AccountOffboardingDisposition =
  (typeof ACCOUNT_OFFBOARDING_DISPOSITIONS)[number];

export const ACCOUNT_OFFBOARDING_SCOPE_EVIDENCE = [
  'direct_account_id',
  'direct_business_id',
  'user_created_row',
  'offboarding_account_id',
  'payload_reference',
  'compliance_handle_hash',
  'admin_control_account_id',
  'not_applicable',
] as const;

export type AccountOffboardingScopeEvidence =
  (typeof ACCOUNT_OFFBOARDING_SCOPE_EVIDENCE)[number];

export const PURGE_VERIFICATION_MODES = [
  'must_be_absent',
  'must_be_scrubbed',
  'allowed_limited_retention',
  'not_checked',
] as const;

export type PurgeVerificationMode = (typeof PURGE_VERIFICATION_MODES)[number];

export const ALLOWED_PURGE_VERIFICATION_BY_DISPOSITION = {
  hard_delete: ['must_be_absent'],
  scrub_in_place: ['must_be_scrubbed'],
  retain_deidentified: ['must_be_scrubbed', 'allowed_limited_retention'],
  retain_compliance_limited_pii: ['allowed_limited_retention'],
  not_applicable: ['not_checked'],
} as const satisfies Record<
  AccountOffboardingDisposition,
  readonly PurgeVerificationMode[]
>;

export interface TableDisposition {
  table: string;
  disposition: AccountOffboardingDisposition;
  /**
   * Human-readable evidence only. PR6 purge/scrub SQL must use dedicated,
   * tested query modules instead of treating this inventory as executable SQL.
   */
  scopeEvidence: AccountOffboardingScopeEvidence;
  purgeVerification: PurgeVerificationMode;
  reason: string;
}

export const EXPLICIT_ACCOUNT_OFFBOARDING_TABLES = [
  'inbound_events',
  'job_outbox',
  'analytics_events',
  'flagged_responses',
  'impersonation_sessions',
] as const;

export const SPEC_ONLY_ACCOUNT_OFFBOARDING_TABLES = [
  'users',
  'google_connections',
  'prospect_demos',
] as const;

export const TABLE_DISPOSITIONS = [
  {
    table: 'accounts',
    disposition: 'retain_deidentified',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Billing parent is tombstoned so retained operational rows cannot identify the owner.',
  },
  {
    table: 'businesses',
    disposition: 'retain_deidentified',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Location parent rows are tombstoned while preserving relational integrity.',
  },
  {
    table: 'users',
    disposition: 'retain_deidentified',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'App user row is detached from Supabase Auth and tombstoned after auth deletion succeeds.',
  },
  {
    table: 'reviews',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Review content and reviewer metadata are customer data removed during purge.',
  },
  {
    table: 'responses',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Draft, edited, approved, and posted response content is removed during purge.',
  },
  {
    table: 'approval_links',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Approval-token metadata is invalid after offboarding and removed with response data.',
  },
  {
    table: 'approval_audit_log',
    disposition: 'scrub_in_place',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Approval forensics may be retained only after response text, token hashes, and identifiers are scrubbed.',
  },
  {
    table: 'account_audit_log',
    disposition: 'scrub_in_place',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Lifecycle audit history is retained in a deletion-safe allowlisted shape.',
  },
  {
    table: 'notification_deliveries',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Delivery evidence is removed during destructive purge because legacy rows retain business/account linkage.',
  },
  {
    table: 'channel_enrollments',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Owner notification channel handles are contact data and are removed.',
  },
  {
    table: 'zernio_connections',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Provider connection identifiers and tokens are removed after provider teardown.',
  },
  {
    table: 'zernio_finalize_incidents',
    disposition: 'scrub_in_place',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Finalize incident diagnostics may remain only after provider identifiers and payloads are scrubbed.',
  },
  {
    table: 'zernio_backfill_runs',
    disposition: 'scrub_in_place',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Backfill counters may remain only without provider ids, business labels, or review payloads.',
  },
  {
    table: 'weekly_summaries',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Owner-facing summary content is customer data and is removed.',
  },
  {
    table: 'monthly_impact_emails',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Owner-facing impact email content is customer data and is removed.',
  },
  {
    table: 'review_exceptions',
    disposition: 'scrub_in_place',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Exception diagnostics may remain only after review/provider payloads are scrubbed.',
  },
  {
    table: 'ranking_snapshots',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Location ranking history is account data and is removed.',
  },
  {
    table: 'competitor_snapshots',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Competitor pack ranking history is account data and is removed.',
  },
  {
    table: 'onboarding_drip_log',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Lifecycle email state tied to the owner/location is removed.',
  },
  {
    table: 'onboarding_demos',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Pre-pay demo snapshots contain reviews and generated responses and are removed.',
  },
  {
    table: 'satisfaction_responses',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Owner feedback response rows are removed to avoid retaining freeform customer signals.',
  },
  {
    table: 'auto_approval_policies',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Owner-configured policy rows are product settings and are removed.',
  },
  {
    table: 'api_costs',
    disposition: 'scrub_in_place',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Cost records may be retained for financial controls only after prompts, excerpts, and ids are scrubbed.',
  },
  {
    table: 'api_costs_daily_rollups',
    disposition: 'retain_deidentified',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'allowed_limited_retention',
    reason: 'Aggregate cost rollups may remain when no account, business, review, or response identifier remains.',
  },
  {
    table: 'analytics_events',
    disposition: 'scrub_in_place',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Analytics rows may remain only after identifiers, properties, and error details are scrubbed.',
  },
  {
    table: 'inbound_events',
    disposition: 'scrub_in_place',
    scopeEvidence: 'payload_reference',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Webhook replay rows may remain only after raw provider payloads and account identifiers are scrubbed.',
  },
  {
    table: 'job_outbox',
    disposition: 'scrub_in_place',
    scopeEvidence: 'payload_reference',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Outbox rows are terminalized and payloads are scrubbed so stale jobs cannot expose customer data.',
  },
  {
    table: 'flagged_responses',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Moderation-held response content and linked review metadata are removed.',
  },
  {
    table: 'impersonation_sessions',
    disposition: 'scrub_in_place',
    scopeEvidence: 'admin_control_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'Admin control-plane records may remain only after impersonated account/user references are scrubbed.',
  },
  {
    table: 'google_connections',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Google provider identifiers and tokens are removed during provider teardown.',
  },
  {
    table: 'prospect_demos',
    disposition: 'hard_delete',
    scopeEvidence: 'user_created_row',
    purgeVerification: 'must_be_absent',
    reason: 'Prospect demo snapshots may contain review and generated response content and are removed when linked to the account.',
  },
  {
    table: 'agent_runs',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Agent run attribution rows carry subject ids of deleted reviews and have no retention rationale.',
  },
  {
    table: 'agent_run_steps',
    disposition: 'hard_delete',
    scopeEvidence: 'not_applicable',
    purgeVerification: 'must_be_absent',
    reason: 'Step detail references deleted response ids; rows have no tenant column and hard-delete via the agent_runs ON DELETE CASCADE FK.',
  },
  {
    table: 'agent_outcomes',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Per-agent outcome facts are account attribution data referencing deleted reviews/responses and are removed.',
  },
  {
    table: 'review_escalations',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Guardian escalation state (WS3) references deleted reviews/runs; account attribution data with no retention rationale.',
  },
  {
    table: 'judge_verdicts',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Judge verdict attribution has no retention rationale and is removed by the response/review FK cascades during content purge.',
  },
  {
    table: 'account_offboardings',
    disposition: 'scrub_in_place',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_scrubbed',
    reason: 'The lifecycle receipt row remains only after recipient, auth, and provider snapshot fields are scrubbed.',
  },
  {
    table: 'account_offboarding_tokens',
    disposition: 'hard_delete',
    scopeEvidence: 'offboarding_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Keep-my-data token metadata is invalid after purge starts and is removed.',
  },
  {
    table: 'contact_csv_uploads',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Upload metadata + consent attestation reference owner-supplied customer PII context and are removed.',
  },
  {
    table: 'solicitation_contacts',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Owner-uploaded customer contact PII (names, emails, phones) is removed entirely.',
  },
  {
    table: 'solicitation_visits',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Visit ledger rows carry customer activity notes and are removed with their contacts.',
  },
  {
    table: 'solicitation_batches',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Solicitation batch lifecycle rows are customer workflow data and cascade from their source upload.',
  },
  {
    table: 'solicitation_asks',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Authoritative per-contact solicitation decisions are customer data and cascade from their batch.',
  },
  {
    table: 'solicitation_outreach',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_account_id',
    purgeVerification: 'must_be_absent',
    reason: 'Physical send attempts carry rendered contact-facing bodies and provider results, and cascade from their batch.',
  },
  {
    table: 'solicitation_consent',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Consent fails closed (DR1): ledger rows are residual records of owner-uploaded customers and leave with the business via the businesses(id) cascade.',
  },
] as const satisfies readonly TableDisposition[];

export const ACCOUNT_OFFBOARDING_TABLES = Object.freeze(
  TABLE_DISPOSITIONS.map((entry) => entry.table),
);

function needsPurgeVerification(entry: TableDisposition): boolean {
  return entry.purgeVerification !== 'not_checked';
}

export const PURGE_VERIFICATION_TABLES = Object.freeze(
  TABLE_DISPOSITIONS.filter(needsPurgeVerification),
);
