// Single authoritative owner for the job_outbox.completion_reason vocabulary.
// Import this constant wherever the marker value is written or read — never a
// bare 'owner_unreachable' string literal (repworth.md). Column added in 083.
export const OUTBOX_COMPLETION_REASON = {
  OWNER_UNREACHABLE: 'owner_unreachable',
} as const;

export type OutboxCompletionReason =
  (typeof OUTBOX_COMPLETION_REASON)[keyof typeof OUTBOX_COMPLETION_REASON];

// 4h age floor shared by the owner-unreachable health check + failover poller —
// the single source both bind their default to so a config change can't desync them.
export const OWNER_UNREACHABLE_AGE_FLOOR_SECONDS = 14400;
