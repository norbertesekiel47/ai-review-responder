// worker/jobs/pending-post-notice/errors.ts
//
// Retryable-vs-terminal classification for the veto-window "your reply will
// post automatically" notice send (WS4). RETRYABLE failures cause the claim to
// be RELEASED so a BullMQ retry can re-acquire and re-send (transient infra:
// rate limits, timeouts, network blips). TERMINAL failures write a failed
// delivery row and are never retried.
//
// Retryability is decided by the single-owner predicate
// `isTransientChannelSendError` (which provider errors are transient), NOT
// the approval dispatcher's enrollment-flip directives — the pending-post
// notice must not flip enrollment, and the approval directives' log messages
// assume an enrollment flip. Terminal here means recorded as a failed
// delivery and not retried: the notice is best-effort transparency (the
// publish fires at the deadline regardless) and must not churn retries on a
// likely-permanent error.

import { isTransientChannelSendError } from '../../../src/lib/notifications/channels/transient-send-error';

export interface PendingPostNoticeSendClassification {
  retryable: boolean;
  reason: string;
}

export function classifyPendingPostNoticeSendError(err: unknown): PendingPostNoticeSendClassification {
  const reason = err instanceof Error ? err.message : String(err);
  return { retryable: isTransientChannelSendError(err), reason };
}
