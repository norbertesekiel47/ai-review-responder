// worker/jobs/escalation-notice/errors.ts
//
// Retryable-vs-terminal classification for the Guardian escalation notice
// send (WS3). RETRYABLE failures cause the claim to be RELEASED so a BullMQ
// retry can re-acquire and re-send (transient infra: rate limits, timeouts,
// network blips). TERMINAL failures write a failed delivery row and are never
// retried.
//
// Retryability is decided by the single-owner predicate
// `isTransientChannelSendError` (which provider errors are transient), NOT
// the approval dispatcher's enrollment-flip directives — the escalation
// notice must not flip enrollment, and the approval directives' log messages
// assume an enrollment flip.

import { isTransientChannelSendError } from '../../../src/lib/notifications/channels/transient-send-error';

export interface EscalationNoticeSendClassification {
  retryable: boolean;
  reason: string;
}

export function classifyEscalationNoticeSendError(err: unknown): EscalationNoticeSendClassification {
  const reason = err instanceof Error ? err.message : String(err);
  return { retryable: isTransientChannelSendError(err), reason };
}
