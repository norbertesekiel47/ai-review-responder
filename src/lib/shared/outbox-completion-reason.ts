// Single authoritative owner for the job_outbox.completion_reason vocabulary.
// Import this constant wherever the marker value is written or read — never a
// bare 'owner_unreachable' string literal (repworth.md). Column added in 083.
export const OUTBOX_COMPLETION_REASON = {
  OWNER_UNREACHABLE: 'owner_unreachable',
} as const;

export type OutboxCompletionReason =
  (typeof OUTBOX_COMPLETION_REASON)[keyof typeof OUTBOX_COMPLETION_REASON];
