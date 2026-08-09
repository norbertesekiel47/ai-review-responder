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
  /**
   * A `generate_response` job whose persist was refused by the
   * content-freshness gate (ADR 0017): review content changed between the
   * worker's load and the persist boundary. Zero writes happened — the
   * (review_id, version) slot stays free for the colliding fresh job, which
   * owns the current-content draft. Read by operators — no poller, no alert
   * (the gate working is not an incident; the structured log line in
   * persist.ts carries the per-fire detail).
   */
  STALE_REVIEW_CONTENT: 'stale_review_content',
  /**
   * An `onboarding_drip` row refused by the **Drip staleness cap** in
   * `OnboardingDripWorker` — the drip's due date passed more than the grace
   * window ago, so it is never sent (#719).
   *
   * Exists because the cap's producer-side check in `OnboardingDripScheduler`
   * is not enforcement on its own: a re-driven row, a future second producer,
   * or a row minted just inside the boundary and stranded through a multi-day
   * worker outage all arrive here with that check long expired. Without a
   * durable marker, a refusal would be indistinguishable in SQL from a genuine
   * send once the log line ages out.
   *
   * Like IMPORT_CONSENT_BLOCKED: an operational-window signal, not an audit
   * record. Nothing reads it in code — no poller, no alert, no admin surface —
   * and `ArchivalPoller` deletes the completed row 7 days after `completed_at`.
   * What outlives that window is the absence of an `onboarding_drip_log.sent_at`
   * for the pair.
   */
  DRIP_TOO_STALE: 'drip_too_stale',
} as const;

/** Every value `job_outbox.completion_reason` may be written with. */
export type OutboxCompletionReason =
  (typeof OUTBOX_COMPLETION_REASON)[keyof typeof OUTBOX_COMPLETION_REASON];

// 4h age floor shared by the owner-unreachable health check + failover poller —
// the single source both bind their default to so a config change can't desync them.
export const OWNER_UNREACHABLE_AGE_FLOOR_SECONDS = 14400;
