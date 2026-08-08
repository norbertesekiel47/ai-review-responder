// Single authoritative owner for the job_outbox.completion_reason vocabulary.
// Import this constant wherever the marker value is written or read — never a
// bare 'owner_unreachable' string literal (repworth.md). Column added in 083.
export const OUTBOX_COMPLETION_REASON = {
  OWNER_UNREACHABLE: 'owner_unreachable',
  /**
   * A `zernio_initial_backfill` row refused by `guardImportConsent` — the
   * Import consent state was anything other than `accepted`, or the
   * `businesses` row was gone (#695). One marker, not one per state: it records
   * THAT a refusal happened, and the state that caused it lives only in the
   * guard's structured log line — a later read of `businesses` can disagree (a
   * `pending` refusal the owner then accepts) or find nothing (the `missing`
   * case), so a per-state column would be a point-in-time fact readers would
   * compare against current state.
   *
   * Read by operators, not by code — deliberately no poller and no alert
   * (unlike OWNER_UNREACHABLE). A refusal is the guard working, not an
   * incident; the query that makes it useful is in ADR 0016.
   */
  IMPORT_CONSENT_BLOCKED: 'import_consent_blocked',
} as const;

/** Every value `job_outbox.completion_reason` may be written with. */
export type OutboxCompletionReason =
  (typeof OUTBOX_COMPLETION_REASON)[keyof typeof OUTBOX_COMPLETION_REASON];

// 4h age floor shared by the owner-unreachable health check + failover poller —
// the single source both bind their default to so a config change can't desync them.
export const OWNER_UNREACHABLE_AGE_FLOOR_SECONDS = 14400;
